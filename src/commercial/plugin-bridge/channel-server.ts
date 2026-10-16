/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { Logger } from "~/utils/logger.js";
import { channelFailure } from "./channel-failure.js";
import { MAX_CHANNEL_BYTES } from "./relay-listener.js";
import type { RelayConnection } from "./relay-connection.js";
import type { ChannelRunContext, RunLedger } from "./run-ledger.js";
import type { PluginEvent } from "@framelink/plugin/protocol";

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
      "flcm: the channel request was missing its run id or capability — it was refused.",
    );
  }

  serve(
    connection: RelayConnection,
    request: Extract<PluginEvent, { type: "CHANNEL_REQUEST" }>,
  ): void {
    const { id, runId } = request;
    const { send, refuse } = this.responder(connection, id);
    const run = this.ledger.get(runId);
    if (!run || run.connection !== connection) {
      refuse(
        "RUN_INACTIVE",
        `flcm: run ${runId} is no longer active on this server (cancelled, timed out, or already finished) — the channel request was refused.`,
      );
      return;
    }
    // Only a code run may call the server. Every server-issued request (HELLO, INTRODUCE,
    // GRANT_STATUS, …) is in the ledger under an id the link was sent, so without this gate a
    // link could burn server work — and hold a suspension — against a request that is no run.
    if (run.payloadType !== "EXECUTE_CODE") {
      refuse(
        "INVALID_INPUT",
        `flcm: run ${runId} is not a code run — only EXECUTE_CODE runs may call server capabilities.`,
      );
      return;
    }
    const handler = this.capabilities.get(request.capability);
    if (!handler) {
      refuse("UNKNOWN_CAPABILITY", "flcm: unknown server capability.");
      return;
    }
    if (run.services >= MAX_INFLIGHT_SERVICES_PER_RUN) {
      refuse(
        "TOO_MANY_REQUESTS",
        `flcm: run ${runId} already has ${run.services} channel requests in flight — this one was refused.`,
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
            `flcm: run ${runId} is no longer active on this server — the channel reply was withheld.`,
          );
          return;
        }
        send({ type: "CHANNEL_RESPONSE", ok: true, payload });
      })
      .catch((err: unknown) => {
        if (run.servicesAbort.signal.aborted) {
          refuse("CANCELLED", "flcm: the run ended; server work was cancelled.");
          return;
        }
        try {
          send({ type: "CHANNEL_RESPONSE", ok: false, error: channelFailure(err) });
        } catch {
          refuse("SERIALIZATION_FAILED", "flcm: server failure could not be encoded as JSON.");
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
    refuse: (code: string, message: string) => void;
  } {
    const send = (body: Record<string, unknown>): void => {
      if (!this.isCurrent(connection) || !connection.isOpen) return;
      const failure = (code: string, message: string): string =>
        JSON.stringify({ type: "CHANNEL_RESPONSE", id, ok: false, error: { code, message } });
      let encoded: string;
      try {
        // Encoding can fail for non-JSON handler output, including cycles or excessive depth.
        encoded = JSON.stringify({ ...body, id });
        if (Buffer.byteLength(encoded) > MAX_CHANNEL_BYTES) {
          encoded = failure(
            "RESPONSE_TOO_LARGE",
            "flcm: server response exceeds the channel size cap.",
          );
        }
      } catch {
        encoded = failure(
          "SERIALIZATION_FAILED",
          "flcm: server response could not be encoded as JSON.",
        );
      }
      try {
        connection.socket.send(encoded);
      } catch {
        Logger.log("Could not send channel response");
      }
    };
    const refuse = (code: string, message: string): void => {
      send({ type: "CHANNEL_RESPONSE", ok: false, error: { code, message } });
    };
    return { send, refuse };
  }
}
