/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { Logger } from "~/utils/logger.js";
import { channelFailure } from "./channel-failure.js";
import { MAX_CHANNEL_BYTES } from "./relay-listener.js";
import type { RelayConnection } from "./relay-connection.js";
import type { ChannelRunContext, RunLedger } from "./run-ledger.js";
import type { FlcmErrorKind, PluginEvent } from "@framelink/plugin/protocol";

/** Opaque JSON payloads. Only explicitly registered names can be called. */
export type CapabilityHandler = (
  payload: unknown,
  context: { signal: AbortSignal; run: ChannelRunContext },
) => Promise<unknown>;

// How many channel services one run may have in flight. Excess requests are refused, not queued,
// to bound work from a runaway or hostile plugin link. The run ceiling bounds the total service window.
const MAX_INFLIGHT_SERVICES_PER_RUN = 4;

/**
 * The reverse direction: the plugin calls a server capability mid-run (CHANNEL_REQUEST), answered by
 * CHANNEL_RESPONSE in the plugin's own id namespace. Traffic-as-heartbeat: the run's inactivity
 * deadline is suspended while the server is the side working, and never the run ceiling.
 *
 * A request naming a run the ledger no longer tracks (timed out, cancelled, already resolved) is
 * refused instead of served: the refusal rejects the run's suspended await plugin-side, so a zombie
 * run can never resume into canvas writes after the agent was told nothing happened. That refusal is
 * the server's half of the policy; the plugin's run-cancellation registry enforces the rest.
 */
export class ChannelServer {
  // The allowlist is fixed at construction. No dynamic lookup or fallback handler.
  private readonly capabilities: ReadonlyMap<string, CapabilityHandler>;

  constructor(
    capabilities: ReadonlyMap<string, CapabilityHandler>,
    private readonly ledger: RunLedger,
    /** Whether `connection` is still an authenticated open link — a dropped link's result must not leak. */
    private readonly isCurrent: (connection: RelayConnection) => boolean,
  ) {
    this.capabilities = new Map(capabilities);
  }

  /** A CHANNEL_REQUEST the parser refused still carries the plugin's id, and its call is suspended on it. */
  refuseMalformed(connection: RelayConnection, id: string): void {
    this.responder(connection, id).refuse(
      "INVALID_INPUT",
      "internal",
      "the plugin's request to the server was missing its execution id or capability, so the server refused it.",
    );
  }

  serve(
    connection: RelayConnection,
    request: Extract<PluginEvent, { type: "CHANNEL_REQUEST" }>,
  ): void {
    const { id, executionId } = request;
    const { send, refuse } = this.responder(connection, id);
    const run = this.ledger.get(executionId);
    if (!run || run.connection !== connection) {
      refuse(
        "RUN_INACTIVE",
        "run-ended",
        "this run is no longer active on the server (it was cancelled, timed out or already finished), so the server refused the plugin's request.",
      );
      return;
    }
    // Only a code run may call the server. Every server-issued request (HELLO, INTRODUCE,
    // GRANT_STATUS, …) is in the ledger under an id the link was sent, so without this gate a
    // link could burn server work — and hold a suspension — against a request that is no run.
    if (run.payloadType !== "EXECUTE_CODE") {
      refuse(
        "INVALID_INPUT",
        "internal",
        "the plugin asked the server for help outside a script run, so the server refused it.",
      );
      return;
    }
    const handler = this.capabilities.get(request.capability);
    if (!handler) {
      refuse(
        "UNKNOWN_CAPABILITY",
        "internal",
        "the plugin asked for an unknown server capability.",
      );
      return;
    }
    if (run.services >= MAX_INFLIGHT_SERVICES_PER_RUN) {
      // Mutating verbs run one at a time and each makes one request, so reaching the cap is flcm's bug.
      refuse(
        "TOO_MANY_REQUESTS",
        "internal",
        `this run already has ${run.services} requests to the server in flight, so the server refused another.`,
      );
      return;
    }
    // Counted until the work actually settles, cleanup included, even past the run's death.
    const release = this.ledger.suspend(run);
    void Promise.resolve()
      .then(() => {
        run.servicesAbort.signal.throwIfAborted();
        return handler(request.payload, { signal: run.servicesAbort.signal, run: run.runContext });
      })
      .then((payload) => {
        if (!this.ledger.isLive(run)) {
          // The run died during service; withhold the result rather than resume a zombie.
          refuse(
            "RUN_INACTIVE",
            "run-ended",
            "this run ended on the server while it worked, so the server withheld its reply.",
          );
          return;
        }
        send({ type: "CHANNEL_RESPONSE", ok: true, payload });
      })
      .catch((err: unknown) => {
        if (run.servicesAbort.signal.aborted) {
          refuse(
            "CANCELLED",
            "run-ended",
            "the run ended, so the server stopped the work it was doing for it.",
          );
          return;
        }
        try {
          send({ type: "CHANNEL_RESPONSE", ok: false, error: channelFailure(err) });
        } catch {
          refuse(
            "SERIALIZATION_FAILED",
            "internal",
            "the server's failure could not be encoded as JSON.",
          );
        }
      })
      .finally(release);
  }

  /** Reply on the link a request arrived on, and only while it is still authenticated and open. */
  private responder(
    connection: RelayConnection,
    id: string,
  ): {
    send: (body: Record<string, unknown>) => void;
    refuse: (code: string, kind: FlcmErrorKind, message: string) => void;
  } {
    // Every refusal says whose failure it is, as a capability's failure does (CapabilityFailure).
    const refusal = (
      code: string,
      kind: FlcmErrorKind,
      message: string,
    ): Record<string, unknown> => ({
      type: "CHANNEL_RESPONSE",
      ok: false,
      error: { code, message, kind },
    });
    const encode = (body: Record<string, unknown>): string => JSON.stringify({ ...body, id });
    const send = (body: Record<string, unknown>): void => {
      if (!this.isCurrent(connection) || !connection.isOpen) return;
      let encoded: string;
      try {
        // Encoding can fail for non-JSON handler output, including cycles or excessive depth.
        encoded = encode(body);
        if (Buffer.byteLength(encoded) > MAX_CHANNEL_BYTES) {
          encoded = encode(
            refusal(
              "RESPONSE_TOO_LARGE",
              "internal",
              "the server's reply was over the channel's size cap.",
            ),
          );
        }
      } catch {
        encoded = encode(
          refusal(
            "SERIALIZATION_FAILED",
            "internal",
            "the server's reply could not be encoded as JSON.",
          ),
        );
      }
      try {
        connection.socket.send(encoded);
      } catch {
        Logger.log("Could not send channel response");
      }
    };
    const refuse = (code: string, kind: FlcmErrorKind, message: string): void => {
      send(refusal(code, kind, message));
    };
    return { send, refuse };
  }
}
