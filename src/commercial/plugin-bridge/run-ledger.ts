/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { randomUUID } from "node:crypto";
import { Logger } from "~/utils/logger.js";
import { pluginDisconnectedNotSubmittedText } from "./blocked-call-guidance.js";
import { figmaPausedReason } from "./figma-paused.js";
import type { RelayConnection } from "./relay-connection.js";
import type { RequestTrace } from "./request-trace.js";
import {
  RUN_INACTIVITY_DEADLINE_MS,
  RUN_REQUEST_TYPES,
  parseReply,
  type CancelDisposition,
  type PluginEvent,
  type PluginReply,
  type RunPhase,
  type ServerRequest,
  type ServerRequestType,
} from "@framelink/plugin/protocol";
import type { FigmaService } from "~/services/figma.js";
import type { FigmaFileKey } from "~/utils/figma-url.js";
import type { LocalImageReader } from "./images.js";

/**
 * Server-owned facts about the run a channel request serves, fixed when the run was submitted and
 * never read from the plugin — a payload could name anyone. `figma` is the Figma client of the request
 * that started the run, so a mid-run fetch spends that caller's token; on a multi-user HTTP server the
 * process-wide config belongs to nobody in particular. Null when no such request exists (the CLI).
 */
export interface ChannelRunContext {
  figma: FigmaService | null;
  /**
   * The file key the run's plugin reported for its document. Null for a request that is no run, or a
   * plugin build that reports none: comments.pins then has nothing to read.
   */
  fileKey: FigmaFileKey | null;
  /** Upload handles the submitted code names literally — the only ones this run may redeem. */
  uploadHandles: ReadonlySet<string>;
  /** flcm.image's read of the operator's asset root. Null: this run may read no local file. */
  readLocalImage: LocalImageReader | null;
}

export const NO_RUN_CONTEXT: ChannelRunContext = {
  figma: null,
  fileKey: null,
  uploadHandles: new Set(),
  readLocalImage: null,
};

export interface LedgerSubmitOptions {
  /** The run's execution id. Omitted for a request that is no run. */
  id?: string;
  signal?: AbortSignal;
  runContext?: ChannelRunContext;
}

export type RequestPhase = "submitted" | RunPhase;

export class BridgeRequestError extends Error {
  constructor(
    message: string,
    // What the caller may DO about it, not where it happened: `not-submitted` means nothing ran and
    // the call can be retried as-is; `unconfirmed` means the document may have been touched.
    readonly outcome: "not-submitted" | "unconfirmed",
    readonly phase?: RequestPhase,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

// The per-request INACTIVITY deadline, not a hard cap: run-scoped traffic — servicing the run's
// mid-run channel request — suspends and re-arms it, so a run only dies when neither side is doing its
// work. It measures SILENCE, which is why a queued run has none at all (armInactivityDeadline). The
// run mirrors the default on its own clock, to refuse verbs while its CANCEL is still queued behind a
// blocked thread (server-deadline.ts).
export const DEFAULT_TIMEOUT_MS = RUN_INACTIVITY_DEADLINE_MS;

// The absolute wall-clock ceiling on one request, cancellation included — the backstop the
// inactivity deadline deliberately isn't. Without it, a cold-cache many-image render could
// legitimately re-arm the inactivity deadline for minutes while the MCP client abandoned the call at
// its own ~60s default — the agent told "failed" about a canvas still being written. Sized to fit the
// client's 60s budget in the common (already-granted) case.
export const DEFAULT_RUN_CEILING_MS = 45_000;

// How long the caller's rejection waits for the plugin's CANCEL_RESULT before falling back to the
// hedged "completion is unconfirmed" text. The plugin answers from state it already holds, so the
// honest cost is one postMessage hop plus one socket hop; what actually spends it is a plugin that
// CAN'T answer (socket dying, main thread wedged), which is precisely when the hedge is true.
const CANCEL_ANSWER_MS = 1_000;

// Only runs can have their cancellation answered. Everything else (handshake, grant polling)
// never reaches the document, so its cancellation rejects on the spot.
const RUN_REQUESTS = new Set<ServerRequestType>(RUN_REQUEST_TYPES);

/**
 * How long ago the plugin entered the phase a RUN_STATE announces, from its `at` stamp. The frame
 * leaves the plugin only once its thread goes idle, so a run that opens with seconds of synchronous
 * work announces "running" seconds late; counting from arrival would let it outlive the deadline the
 * run itself counts from that stamp (server-deadline.ts). Comparing the two clocks is sound because
 * the relay listens on loopback only. Clamped, so a skewed stamp can neither push the deadline past
 * the frame's arrival nor spend more than all of it.
 */
function phaseAge(at: number, timeoutMs: number): number {
  return Math.min(Math.max(Date.now() - at, 0), timeoutMs);
}

/** One request in flight: correlated by id, owned by the connection it went out on. */
export interface LedgerEntry {
  readonly id: string;
  readonly connection: RelayConnection;
  readonly payloadType: ServerRequestType;
  readonly runContext: ChannelRunContext;
  /** Aborted the moment the entry leaves the ledger: services stop starting work for a dead run. */
  readonly servicesAbort: AbortController;
  phase: RequestPhase;
  readonly startedAt: number;
  /** Server services running for this run right now. Inactivity stays suspended while any is. */
  services: number;
  /** The inactivity deadline — null while suspended or QUEUED (see armInactivityDeadline). */
  timer: ReturnType<typeof setTimeout> | null;
  readonly ceilingTimer: ReturnType<typeof setTimeout>;
  readonly cleanup: () => void;
  readonly resolve: (value: PluginReply) => void;
  readonly reject: (err: Error) => void;
}

export interface RunLedgerOptions {
  requestTimeoutMs: number;
  runCeilingMs: number;
  trace: RequestTrace;
  /** How long the plugin has been gone, for the wording of a non-run request its drop cut short. */
  disconnectedDurationMs(): number | null;
}

/**
 * Every server→plugin request in flight, and the clocks that bound it. `submit` sends a request under
 * the id its caller chose — a run's execution id, or a fresh correlation id — and resolves when a
 * reply carrying that same id arrives; replies without a matching entry are dropped. A deadline never
 * silently abandons a request: it sends the id-less CANCEL and words the caller's rejection from the
 * plugin's CANCEL_RESULT (see cancel()).
 */
export class RunLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  // Runs whose CANCEL is on the wire with the caller's rejection held for one round trip. They are no
  // longer entries — the run is dead to the rest of the bridge the instant it is cancelled; all that
  // is outstanding is which SENTENCE the caller gets.
  private readonly cancelsAwaitingAnswer = new Map<
    string,
    {
      connection: RelayConnection;
      settle: (disposition: CancelDisposition, figmaPausedMs?: number) => void;
    }
  >();

  constructor(private readonly options: RunLedgerOptions) {}

  get trace(): RequestTrace {
    return this.options.trace;
  }

  /** The live entry for an execution id, if any. */
  get(id: string): LedgerEntry | undefined {
    return this.entries.get(id);
  }

  /** Whether `entry` is still the live entry for its id — false once it settled, died or was cancelled. */
  isLive(entry: LedgerEntry): boolean {
    return this.entries.get(entry.id) === entry;
  }

  /**
   * Send the payload under `id`, and resolve when the reply carrying that id lands. A request that is
   * no run omits `id` and gets a fresh correlation id.
   */
  submit(
    connection: RelayConnection,
    payload: ServerRequest,
    { id = randomUUID(), signal, runContext = NO_RUN_CONTEXT }: LedgerSubmitOptions = {},
  ): Promise<PluginReply> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const cancel = () => this.cancel(id, "caller cancelled");
      signal?.addEventListener("abort", cancel, { once: true });
      const entry: LedgerEntry = {
        id,
        connection,
        payloadType: payload.type,
        runContext,
        servicesAbort: new AbortController(),
        phase: "submitted",
        startedAt: Date.now(),
        services: 0,
        timer: null,
        ceilingTimer: setTimeout(() => this.timeout(id, "ceiling"), this.options.runCeilingMs),
        cleanup: () => signal?.removeEventListener("abort", cancel),
        resolve,
        reject,
      };
      this.entries.set(id, entry);
      this.armInactivityDeadline(entry);
      if (payload.type === "EXECUTE_CODE") this.trace.start(id, connection);
      // `id` last: the caller's id is authoritative and a payload field must never
      // overwrite it, or the reply could never be matched to this entry.
      connection.send({ ...payload, id });
    });
  }

  /**
   * Settle the entry a reply names, admitted by the protocol's parser for that request type — the one
   * place a reply is parsed. Returns `settled` only for a reply that matched a live entry sent on this
   * same connection (malformed or not: it still proves the holder speaks the envelope), `late` when
   * no entry exists any more, and `foreign` for an entry another connection owns.
   */
  settleReply(
    connection: RelayConnection,
    id: string,
    msg: Record<string, unknown>,
  ): "settled" | "late" | "foreign" {
    const entry = this.entries.get(id);
    if (!entry) {
      this.trace.record(id, connection, "late-reply");
      return "late";
    }
    if (entry.connection !== connection) return "foreign";
    this.take(id);
    const reply = parseReply(entry.payloadType, msg);
    // Frozen-envelope error path: a plugin replies ERROR to any message type it doesn't recognize —
    // the case a newer server hits against an older, un-updatable plugin. A reply that isn't the
    // shape its request is owed is refused the same way, never handed on.
    if (reply === null || reply.type === "ERROR") {
      this.trace.record(id, connection, "error");
      entry.reject(
        new Error(
          reply?.error ??
            `The Figma plugin answered ${entry.payloadType} with a reply this server can't read.`,
        ),
      );
      return "settled";
    }
    this.trace.record(
      id,
      connection,
      reply.type === "EXECUTE_CODE_RESULT" && reply.errors ? "error" : "result",
    );
    Logger.log(`Bridge request ${id}: finished after ${Date.now() - entry.startedAt}ms`);
    entry.resolve(reply);
    return "settled";
  }

  /** A run entered a phase on the connection that owns it: record it and re-arm its deadline. */
  runState(connection: RelayConnection, event: Extract<PluginEvent, { type: "RUN_STATE" }>): void {
    const entry = this.entries.get(event.executionId);
    if (entry?.connection !== connection) return;
    entry.phase = event.phase;
    this.trace.record(event.executionId, connection, event.phase);
    Logger.log(
      `Bridge request ${event.executionId}: ${event.phase} after ${Date.now() - entry.startedAt}ms`,
    );
    this.armInactivityDeadline(entry, phaseAge(event.at, this.options.requestTimeoutMs));
  }

  /**
   * Suspend a run's inactivity deadline while the SERVER is the side working on it. The returned
   * release re-arms it only when the run's LAST service settles — with concurrent services, the first
   * reply must not restart the clock while a second is still ours to finish — and never revives the
   * clock of a run that died meanwhile.
   */
  suspend(entry: LedgerEntry): () => void {
    entry.services++;
    clearTimeout(entry.timer ?? undefined);
    entry.timer = null;
    return () => {
      entry.services--;
      if (entry.services === 0 && this.isLive(entry)) this.armInactivityDeadline(entry);
    };
  }

  /**
   * Deliver the plugin's cancel answer to the caller waiting on it, once. Answers arriving on a
   * link other than the one the CANCEL went out on are dropped: one link must not narrate another
   * link's runs.
   */
  settleCancelAnswer(
    id: string,
    disposition: CancelDisposition,
    connection?: RelayConnection,
    figmaPausedMs?: number,
  ): void {
    const awaiting = this.cancelsAwaitingAnswer.get(id);
    if (!awaiting || (connection && awaiting.connection !== connection)) return;
    this.cancelsAwaitingAnswer.delete(id);
    Logger.log(`Bridge request ${id}: cancelled, plugin reports ${disposition}`);
    awaiting.settle(disposition, figmaPausedMs);
  }

  /**
   * Reject everything sent on `connection` (or everything, with none) — it can never be answered.
   * A request that isn't a run is worded as the outage it is: nothing was submitted.
   */
  fail(reason: string, connection?: RelayConnection): void {
    for (const [id, entry] of this.entries) {
      if (connection && entry.connection !== connection) continue;
      this.trace.record(id, entry.connection, "disconnected");
      const waiting = !RUN_REQUESTS.has(entry.payloadType);
      this.take(id)?.reject(
        new BridgeRequestError(
          waiting
            ? pluginDisconnectedNotSubmittedText(this.options.disconnectedDurationMs())
            : reason,
          waiting ? "not-submitted" : "unconfirmed",
          entry.phase,
        ),
      );
    }
    // Anything cancelled there has lost the only mouth that could answer it — say so now rather
    // than holding its caller for a round trip that cannot complete.
    for (const [id, awaiting] of this.cancelsAwaitingAnswer)
      if (!connection || awaiting.connection === connection) this.settleCancelAnswer(id, "unknown");
  }

  /** Remove an entry and stop its clocks — every settle path funnels through here. */
  private take(id: string): LedgerEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.cleanup();
    clearTimeout(entry.timer ?? undefined);
    clearTimeout(entry.ceilingTimer);
    this.entries.delete(id);
    entry.servicesAbort.abort();
    return entry;
  }

  /**
   * (Re)arm an entry's inactivity deadline — or leave it deliberately disarmed while the run is QUEUED
   * or a server service is running for it.
   *
   * A queued run is not silent, it is WAITING: the plugin serializes writes, so a run behind a slower
   * one produces no traffic for as long as that one takes. The absolute ceiling still bounds it — the
   * caller's own budget, not a guess about silence. `submitted` and `running` are real silence.
   */
  private armInactivityDeadline(entry: LedgerEntry, alreadySilentMs = 0): void {
    clearTimeout(entry.timer ?? undefined);
    entry.timer =
      entry.phase === "queued" || entry.services > 0
        ? null
        : setTimeout(
            () => this.timeout(entry.id, "inactivity"),
            this.options.requestTimeoutMs - alreadySilentMs,
          );
  }

  private timeout(id: string, cause: "inactivity" | "ceiling"): void {
    const lastStep = this.trace.lastHostStep(id);
    const why =
      (cause === "inactivity"
        ? `saw no traffic for ${this.options.requestTimeoutMs}ms`
        : `exceeded the absolute ${this.options.runCeilingMs}ms run ceiling`) +
      (lastStep ? ` (the plugin's last reported step: ${lastStep})` : "");
    const entry = this.entries.get(id);
    if (entry)
      this.trace.record(
        id,
        entry.connection,
        cause === "inactivity" ? "timeout-inactivity" : "timeout-ceiling",
      );
    this.cancel(id, why);
  }

  /**
   * Cancel a request and reject its caller with the most definitive sentence available.
   *
   * The run dies here — it leaves the ledger, so channel requests naming it are refused and no reply
   * can settle it. Plugin-side the CANCEL is enforced: a still-queued run is refused at dequeue, an
   * executing run before its next mutating verb (the preamble mutation lock), a suspended await is
   * rejected. Don't add a second enforcement path here. The frame is id-less, deliberately not a
   * request: a CANCEL that awaited a correlated reply could itself time out and cancel, recursively.
   *
   * What is held for one round trip is only the WORDING: "never executed; retry as-is" and "was
   * executing; inspect the canvas" are different instructions to the agent reading them.
   */
  private cancel(id: string, why: string): void {
    const entry = this.take(id);
    if (!entry) return;
    const callerWithdrew = why === "caller cancelled";
    if (callerWithdrew) this.trace.record(id, entry.connection, "caller-cancelled");
    const open = entry.connection.isOpen;
    if (open) entry.connection.send({ type: "CANCEL", executionId: id });
    const reject = (disposition: CancelDisposition, figmaPausedMs?: number): void =>
      entry.reject(cancelRejection(entry, why, disposition, figmaPausedMs));
    // Three requests have no answer worth waiting for: one on a dead socket, a non-run one (the plugin
    // tracks no phase for it), and one the CALLER withdrew — it is no longer reading.
    if (!open || callerWithdrew || !RUN_REQUESTS.has(entry.payloadType)) {
      reject("unknown");
      return;
    }
    const giveUp = setTimeout(() => this.settleCancelAnswer(id, "unknown"), CANCEL_ANSWER_MS);
    this.cancelsAwaitingAnswer.set(id, {
      connection: entry.connection,
      settle: (disposition, figmaPausedMs) => {
        clearTimeout(giveUp);
        reject(disposition, figmaPausedMs);
      },
    });
  }
}

/**
 * The caller's rejection for a cancelled request, worded from the plugin's own answer. Every sentence
 * is an instruction to an agent, so the hedge is kept for exactly the case that earns it — a plugin
 * that could not tell us.
 */
function cancelRejection(
  entry: LedgerEntry,
  why: string,
  disposition: CancelDisposition,
  figmaPausedMs?: number,
): BridgeRequestError {
  // A paused plugin is the reason the run went silent, so it leads what the run's outcome says.
  const paused =
    figmaPausedMs === undefined ? "" : `${figmaPausedReason(figmaPausedMs, "this file")} `;
  const head = `Bridge request ${entry.id} (${entry.payloadType}, last phase ${entry.phase}, ${Date.now() - entry.startedAt}ms) ${why}. ${paused}`;
  if (!RUN_REQUESTS.has(entry.payloadType))
    return new BridgeRequestError(
      head + "No answer was received; no code was submitted.",
      "not-submitted",
      entry.phase,
    );
  if (disposition === "never-executed")
    return new BridgeRequestError(
      head +
        "The plugin confirms this run never executed — it was still queued behind another one, and " +
        "the queue will skip it. Nothing on the canvas changed; retry as-is.",
      "not-submitted",
      entry.phase,
    );
  if (disposition === "was-running")
    return new BridgeRequestError(
      head +
        "The plugin confirms this run was executing when it was cancelled, so writes before the " +
        "cancellation landed. Inspect affected nodes before retrying.",
      "unconfirmed",
      entry.phase,
    );
  return new BridgeRequestError(
    head +
      "Completion is unconfirmed: cancellation was requested and the plugin did not confirm what " +
      "became of the run. Raw code may still finish. Inspect affected nodes before retrying.",
    "unconfirmed",
    entry.phase,
  );
}
