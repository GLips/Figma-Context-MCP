/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { randomUUID } from "node:crypto";
import { Logger } from "~/utils/logger.js";
import { pluginDisconnectedNotSubmittedText } from "./blocked-call-guidance.js";
import type { RelayConnection } from "./relay-connection.js";
import type { RequestTrace } from "./request-trace.js";
import {
  RUN_INACTIVITY_DEADLINE_MS,
  RUN_REQUEST_TYPES,
  RUN_STATUS_INTERVAL_MS,
  parseReply,
  type CancelAnswer,
  type PluginReply,
  type QueueWait,
  type RunPhase,
  type RunStatus,
  type ServerFrame,
  type ServerRequest,
  type ServerRequestType,
  type WithdrawAnswer,
  type WithdrawOutcome,
} from "@framelink/plugin/protocol";
import {
  NO_CANCEL_ANSWER,
  stoppedRunText,
  withdrawnRunText,
  type RunStopCause,
} from "./run-outcome-text.js";
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

export interface LedgerSubmitOptions extends RunWatch {
  /** The run's execution id. Omitted for a request that is no run. */
  id?: string;
  signal?: AbortSignal;
  runContext?: ChannelRunContext;
}

/** A queued run's latest place in the plugin's queue, and the caller's one way to give up on it. */
export interface RunWaiting {
  wait: QueueWait;
  /**
   * Drop the run if it still hasn't started; the submission then rejects as not-submitted. A run that
   * has started is left alone ("running") and the caller keeps waiting for its reply.
   */
  withdraw(): Promise<WithdrawOutcome>;
}

/**
 * How a caller waits on a run: mechanism only, so the policy (how long, and whether to wait behind an
 * abandoned run) stays with the caller that owns the budget.
 */
export interface RunWatch {
  /** Stop waiting this long after submission, cancelling the run. Omitted: no limit but inactivity. */
  budgetMs?: number;
  /** Each RUN_STATUS while the run is queued, on arrival; never after it starts running. */
  onWaiting?: (waiting: RunWaiting) => void;
}

type RequestPhase = "submitted" | RunPhase;

export class BridgeRequestError extends Error {
  constructor(
    message: string,
    // What the caller may DO about it, not where it happened: `not-submitted` means nothing ran and
    // the call can be retried as-is; `unconfirmed` means the document may have been touched.
    readonly outcome: "not-submitted" | "unconfirmed",
    /** Why the server stopped waiting, when it did: the edge words its own advice from it. */
    readonly stoppedBy?: RunStopCause,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

// The per-request INACTIVITY deadline, not a hard cap: every fresh RUN_STATUS re-arms it, and the
// plugin answers each RUN_STATUS_REQUEST (sent every RUN_STATUS_INTERVAL_MS) with one at once while
// its thread is free, so a run dies here only when the plugin's thread has been held for this long.
// The plugin latches the same deadline between the requests it handles, refusing the run's next
// verb or figma.* access.
export const DEFAULT_TIMEOUT_MS = RUN_INACTIVITY_DEADLINE_MS;

// How long the caller's rejection waits for the plugin's CANCEL_RESULT, and a withdrawal for its
// WITHDRAW_RESULT, before reading the answer as unknown. The plugin answers from state it already
// holds, so what spends this is a plugin that CAN'T answer (socket dying, main thread held).
const PLUGIN_ANSWER_MS = 1_000;

// Only runs can have their cancellation answered. Everything else (handshake, grant polling)
// never reaches the document, so its cancellation rejects on the spot.
const RUN_REQUESTS = new Set<ServerRequestType>(RUN_REQUEST_TYPES);

/**
 * When a status stamped `at` was true, from the server's clock. The frame leaves the plugin only once
 * its thread goes idle, so it can arrive seconds late; counting from arrival would let a run that held
 * the thread outlive the deadline the plugin counts from its own timer. Comparing the two clocks is
 * sound because the relay listens on loopback only. Clamped, so a skewed stamp can neither land in
 * the future nor spend more than the whole deadline.
 */
function stampedAt(at: number, timeoutMs: number, now: number): number {
  return now - Math.min(Math.max(now - at, 0), timeoutMs);
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
  /** The plugin's latest RUN_STATUS for the run, by its own stamp; the rejection is worded from it. */
  status: RunStatus | null;
  readonly startedAt: number;
  /**
   * Server services running for this run right now, for the per-run concurrency cap. Liveness never
   * reads it: a run awaiting a server call has a free thread, so its heartbeat keeps coming.
   */
  services: number;
  /** When the inactivity deadline fires, and its timer. */
  deadlineAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  readonly budgetTimer: ReturnType<typeof setTimeout> | null;
  readonly onWaiting: RunWatch["onWaiting"];
  readonly cleanup: () => void;
  readonly resolve: (value: PluginReply) => void;
  readonly reject: (err: Error) => void;
}

export interface RunLedgerOptions {
  requestTimeoutMs: number;
  trace: RequestTrace;
  /** How long the plugin has been gone, for the wording of a non-run request its drop cut short. */
  disconnectedDurationMs(): number | null;
}

/** A frame the ledger is holding something for, until the link it went out on answers it. */
interface AwaitedAnswer<T> {
  connection: RelayConnection;
  settle: (answer: T) => void;
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
  private readonly cancelsAwaitingAnswer = new Map<string, AwaitedAnswer<CancelAnswer>>();
  // Runs with a WITHDRAW on the wire. Unlike a cancel, the run stays an entry: a run that started
  // first is left running, and its caller keeps waiting for the reply.
  private readonly withdrawalsAwaitingAnswer = new Map<
    string,
    AwaitedAnswer<WithdrawAnswer> & { answered: Promise<WithdrawOutcome> }
  >();

  // One heartbeat per link with runs on it. The server paces it because the plugin can't: a hidden
  // Figma window throttles the plugin's chained timers to about one tick a minute, but still hands
  // it each message within milliseconds.
  private readonly statusRequests = new Map<RelayConnection, ReturnType<typeof setInterval>>();

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
    {
      id = randomUUID(),
      signal,
      runContext = NO_RUN_CONTEXT,
      budgetMs,
      onWaiting,
    }: LedgerSubmitOptions = {},
  ): Promise<PluginReply> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const cancel = () => this.cancel(id, "caller");
      signal?.addEventListener("abort", cancel, { once: true });
      const entry: LedgerEntry = {
        id,
        connection,
        payloadType: payload.type,
        runContext,
        servicesAbort: new AbortController(),
        phase: "submitted",
        status: null,
        startedAt: Date.now(),
        services: 0,
        deadlineAt: 0,
        timer: null,
        budgetTimer:
          budgetMs === undefined
            ? null
            : setTimeout(() => this.timeout(id, "budget", budgetMs), budgetMs),
        onWaiting,
        cleanup: () => signal?.removeEventListener("abort", cancel),
        resolve,
        reject,
      };
      this.entries.set(id, entry);
      this.armInactivityDeadline(entry, entry.startedAt + this.options.requestTimeoutMs);
      if (RUN_REQUESTS.has(payload.type)) {
        this.trace.start(id, connection);
        this.requestStatusWhileRunsOn(connection);
      }
      // `id` last: the caller's id is authoritative and a payload field must never
      // overwrite it, or the reply could never be matched to this entry.
      connection.send({ ...payload, id });
    });
  }

  /**
   * Settle the entry a reply names, admitted by the protocol's parser for that request type — the one
   * place a reply is parsed. Only a reply sent on the entry's own connection settles it; one for an
   * entry that is gone (its caller gave up) is traced and dropped.
   */
  settleReply(connection: RelayConnection, id: string, msg: Record<string, unknown>): void {
    const entry = this.entries.get(id);
    if (!entry) {
      this.trace.record(id, connection, "late-reply");
      return;
    }
    if (entry.connection !== connection) return;
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
      return;
    }
    this.trace.record(
      id,
      connection,
      reply.type === "EXECUTE_CODE_RESULT" && reply.errors ? "error" : "result",
    );
    Logger.log(`Bridge request ${id}: finished after ${Date.now() - entry.startedAt}ms`);
    entry.resolve(reply);
  }

  /**
   * The plugin's latest word about a run on the connection that owns it: the sign of life that
   * re-arms its deadline, from the status's own stamp, and what a queued run's caller is shown.
   */
  runStatus(connection: RelayConnection, status: RunStatus): void {
    const entry = this.entries.get(status.executionId);
    if (entry?.connection !== connection) return;
    this.trace.recordStatus(status.executionId, connection, status);
    // Overtaken by one the plugin stamped later: it says nothing newer about the run.
    if (entry.status && status.at < entry.status.at) return;
    if (entry.phase !== status.phase)
      Logger.log(
        `Bridge request ${entry.id}: ${status.phase} after ${Date.now() - entry.startedAt}ms`,
      );
    entry.status = status;
    entry.phase = status.phase;
    const now = Date.now();
    this.armInactivityDeadline(
      entry,
      stampedAt(status.at, this.options.requestTimeoutMs, now) + this.options.requestTimeoutMs,
    );
    if (status.phase === "queued")
      entry.onWaiting?.({ wait: status.wait, withdraw: () => this.withdraw(entry) });
  }

  /**
   * Deliver the plugin's cancel answer to the caller waiting on it, once. Answers arriving on a
   * link other than the one the CANCEL went out on are dropped: one link must not narrate another
   * link's runs.
   */
  settleCancelAnswer(id: string, answer: CancelAnswer, connection?: RelayConnection): void {
    const awaiting = this.cancelsAwaitingAnswer.get(id);
    if (!awaiting || (connection && awaiting.connection !== connection)) return;
    this.cancelsAwaitingAnswer.delete(id);
    Logger.log(`Bridge request ${id}: cancelled, plugin reports ${answer.disposition}`);
    awaiting.settle(answer);
  }

  /** Deliver the plugin's withdraw answer, once, and only from the link the WITHDRAW went out on. */
  settleWithdrawAnswer(id: string, answer: WithdrawAnswer, connection?: RelayConnection): void {
    const awaiting = this.withdrawalsAwaitingAnswer.get(id);
    if (!awaiting || (connection && awaiting.connection !== connection)) return;
    this.withdrawalsAwaitingAnswer.delete(id);
    Logger.log(`Bridge request ${id}: withdraw answered ${answer.outcome}`);
    awaiting.settle(answer);
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
        ),
      );
    }
    // Anything held there has lost the only mouth that could answer it — say so now rather than
    // holding its caller for a round trip that cannot complete.
    for (const [id, awaiting] of this.cancelsAwaitingAnswer)
      if (!connection || awaiting.connection === connection)
        this.settleCancelAnswer(id, NO_CANCEL_ANSWER);
    for (const [id, awaiting] of this.withdrawalsAwaitingAnswer)
      if (!connection || awaiting.connection === connection)
        this.settleWithdrawAnswer(id, { outcome: "unknown" });
  }

  /**
   * Ask the plugin to drop a queued run. A `withdrawn` answer rejects the submission as not-submitted;
   * any other leaves the run (and its caller's wait) as it was. One WITHDRAW per run at a time.
   */
  private withdraw(entry: LedgerEntry): Promise<WithdrawOutcome> {
    const inFlight = this.withdrawalsAwaitingAnswer.get(entry.id);
    if (inFlight) return inFlight.answered;
    if (!this.isLive(entry) || !entry.connection.isOpen) return Promise.resolve("unknown");
    let settle!: (answer: WithdrawAnswer) => void;
    const answered = new Promise<WithdrawOutcome>((resolve) => {
      const giveUp = setTimeout(
        () => this.settleWithdrawAnswer(entry.id, { outcome: "unknown" }),
        PLUGIN_ANSWER_MS,
      );
      settle = ({ outcome, blocker }) => {
        clearTimeout(giveUp);
        if (outcome === "withdrawn" && this.take(entry.id)) {
          this.trace.record(entry.id, entry.connection, "withdrawn");
          const waitedOn = entry.status?.phase === "queued" ? entry.status.wait.blocker : undefined;
          entry.reject(
            new BridgeRequestError(
              withdrawnRunText(entry.payloadType, blocker ?? waitedOn),
              "not-submitted",
            ),
          );
        }
        resolve(outcome);
      };
    });
    this.withdrawalsAwaitingAnswer.set(entry.id, {
      connection: entry.connection,
      settle,
      answered,
    });
    entry.connection.send({ type: "WITHDRAW", executionId: entry.id });
    return answered;
  }

  /** Remove an entry and stop its clocks — every settle path funnels through here. */
  private take(id: string): LedgerEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.cleanup();
    clearTimeout(entry.timer ?? undefined);
    clearTimeout(entry.budgetTimer ?? undefined);
    this.entries.delete(id);
    entry.servicesAbort.abort();
    if (!this.hasRunsOn(entry.connection)) {
      clearInterval(this.statusRequests.get(entry.connection));
      this.statusRequests.delete(entry.connection);
    }
    return entry;
  }

  private hasRunsOn(connection: RelayConnection): boolean {
    for (const entry of this.entries.values())
      if (entry.connection === connection && RUN_REQUESTS.has(entry.payloadType)) return true;
    return false;
  }

  /** Ask `connection` for its runs' statuses each interval, until it has none (take() stops it). */
  private requestStatusWhileRunsOn(connection: RelayConnection): void {
    if (this.statusRequests.has(connection)) return;
    this.statusRequests.set(
      connection,
      setInterval(() => {
        if (connection.isOpen)
          connection.send({ type: "RUN_STATUS_REQUEST" } satisfies ServerFrame);
      }, RUN_STATUS_INTERVAL_MS),
    );
  }

  /**
   * Move an entry's inactivity deadline to `deadlineAt`, never earlier: a status that arrives after a
   * fresher one, or stamped long before it arrived, must not cut the run's time short either.
   */
  private armInactivityDeadline(entry: LedgerEntry, deadlineAt: number): void {
    if (entry.timer !== null && deadlineAt <= entry.deadlineAt) return;
    clearTimeout(entry.timer ?? undefined);
    entry.deadlineAt = deadlineAt;
    entry.timer = setTimeout(
      () => this.timeout(entry.id, "inactivity", this.options.requestTimeoutMs),
      Math.max(deadlineAt - Date.now(), 0),
    );
  }

  private timeout(id: string, cause: "inactivity" | "budget", limitMs: number): void {
    const entry = this.entries.get(id);
    if (entry) this.trace.record(id, entry.connection, `timeout-${cause}`);
    this.cancel(id, cause, limitMs);
  }

  /**
   * Cancel a request and reject its caller with the most definitive sentence available.
   *
   * The run dies here — it leaves the ledger, so channel requests naming it are refused and no reply
   * can settle it. Plugin-side the CANCEL is enforced: a still-queued run is refused at dequeue, an
   * executing run before its next mutating verb or figma.* access, a suspended await is rejected.
   * Don't add a second enforcement path here. The frame is id-less, deliberately not a request: a
   * CANCEL that awaited a correlated reply could itself time out and cancel, recursively.
   *
   * What is held for one round trip is only the WORDING: "never executed; retry as-is" and "was
   * executing; inspect the canvas" are different instructions to the agent reading them.
   */
  /** `limitMs` is the deadline or budget that ran out; a caller's cancel has none. */
  private cancel(id: string, cause: RunStopCause, limitMs = 0): void {
    const entry = this.take(id);
    if (!entry) return;
    if (cause === "caller") this.trace.record(id, entry.connection, "caller-cancelled");
    const open = entry.connection.isOpen;
    if (open) entry.connection.send({ type: "CANCEL", executionId: id });
    const reject = (answer: CancelAnswer): void => {
      const { message, outcome } = stoppedRunText({
        payloadType: entry.payloadType,
        cause,
        limitMs,
        answer,
        latest: entry.status,
        now: Date.now(),
      });
      entry.reject(new BridgeRequestError(message, outcome, cause));
    };
    // Three requests have no answer worth waiting for: one on a dead socket, a non-run one (the plugin
    // tracks no phase for it), and one the CALLER cancelled — it is no longer reading.
    if (!open || cause === "caller" || !RUN_REQUESTS.has(entry.payloadType)) {
      reject(NO_CANCEL_ANSWER);
      return;
    }
    const giveUp = setTimeout(
      () => this.settleCancelAnswer(id, NO_CANCEL_ANSWER),
      PLUGIN_ANSWER_MS,
    );
    this.cancelsAwaitingAnswer.set(id, {
      connection: entry.connection,
      settle: (answer) => {
        clearTimeout(giveUp);
        reject(answer);
      },
    });
  }
}
