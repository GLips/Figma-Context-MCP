/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Runs what a granted server submits — agent code and screenshots — one at a time, against the
// live document, and owns everything a run carries: its status and cancellation, its mid-run server
// calls, the late-change watch, and the agents' session stores. Each run's course goes to the
// activity feed.
import type { ActivityFeed } from "./activity-feed.js";
import type { AgentSession, AgentSessions } from "./agent-sessions.js";
import { captureScreenshot, type CaptureOptions } from "./screenshot-capture.js";
import { resolveWireSnapshot, serializeForWire, snapshotForWire, type IsFigmaNode, type WireSnapshot } from "./serialize.js";
import { resolveScreenshotTarget, type ScreenshotTarget } from "./screenshot-target.js";
import { createRunRegistry, type ConnectionCancelCause, type ExternalCancelCause, type RunLabel, type RunRef } from "./run-registry.js";
import { observeDocumentChanges, type DocumentChangeObserver } from "./document-changes.js";
import { createServerCallTable } from "./server-calls.js";
import type { FigmaPauseWatch } from "./figma-pause.js";
import { reply, toServer, type ReplyTo } from "./outbound.js";
import type { ConnKey } from "./panel.js";
import { RUN_INACTIVITY_DEADLINE_MS, RUN_STATUS_INTERVAL_MS, type NotGrantedReason, type ServerFrame } from "./protocol.js";
// TYPE-ONLY on purpose: this is the one shared declaration binding the host half of the flcm
// interface to the preamble half, and it must stay erasable — a value import from preamble/ would
// drag the whole std-lib back into this bundle, which is exactly what ADR-0010 removed.
import type { FlcmHost, RunCancelCause } from "./preamble/host.js";
// Likewise type-only: the factory result types both agent bindings without bundling their implementation.
import type * as SandboxRuntime from "./preamble/sandbox.js";
// The one value import from preamble/: flcm-error imports only types, so it bundles alone.
import { FlcmError, formatFailureForAgent, wrapAgentCode } from "./preamble/flcm-error.js";

// What a run cancelled before it started tells its (late) reply, by cause.
const CANCELLED_WHILE_QUEUED: Record<ExternalCancelCause, string> = {
  server: "this run was cancelled by the server while it was still queued",
  disconnected: "this run's server disconnected while the run was still queued",
  revoked: "the human revoked this project's grant on the file while the run was still queued",
};
const WITHDRAWN_WHILE_QUEUED = "this run was withdrawn by its server while it was still queued";

// What ended a run whose code or node lookup was still pending, by cause.
const RUN_CANCELLED_BY: Record<RunCancelCause, string> = {
  server: "the server cancelled this run",
  disconnected: "this run's server disconnected",
  revoked: "the human revoked this project's grant on the file",
  unresponsive: `the plugin ran no timer for ${RUN_INACTIVITY_DEADLINE_MS / 1000}s during this run and stopped it`,
};
// Microtask hops before the run's own cancel rejection lands. A turn of the timer queue would be
// simpler, but Figma can stall timers while it still delivers the CANCEL.
const CANCEL_REJECTION_HOPS = 16;

// The reply owed to a request whose run never started, by kind.
const codeNotRun = (to: ReplyTo, reason: string): void =>
  reply(to, { type: "EXECUTE_CODE_RESULT", result: null, console: [], errors: `${reason}, so none of your code ran.`, documentChanged: false });
const screenshotNotTaken = (to: ReplyTo, reason: string): void =>
  reply(to, { type: "SCREENSHOT_RESULT", errors: `${reason}, so no screenshot was taken.` });

/** A queued run's work. Withdrawn, it lets go of its payload and leaves only its late reply. */
interface QueuedJob {
  start: () => Promise<void>;
  withdraw: () => () => void;
}

// Why a connection's suspended server calls were abandoned, by cause.
const CALLS_ABANDONED: Record<ConnectionCancelCause, string> = {
  disconnected: "the server disconnected mid-run, so the request to it was abandoned and the script stops here.",
  revoked:
    "the human revoked this project's grant in Figma, so the request to the server was abandoned and the script stops here.",
};

export function createRunExecutor({
  figmaPause,
  isConnected,
  refusalAtDequeue,
  sessions,
  activity,
}: {
  /** Named on a CANCEL's answer: a run Figma paused is stuck, not slow. */
  figmaPause: FigmaPauseWatch;
  isConnected: (key: ConnKey) => boolean;
  /** The grant gate, asked again at dequeue: null admits. */
  refusalAtDequeue: (key: ConnKey, documentId: string) => Promise<NotGrantedReason | null>;
  /** Where each run's pinned session is released when it settles, ran or not. */
  sessions: AgentSessions;
  activity: ActivityFeed;
}) {
  const serverCalls = createServerCallTable(isConnected);
  // Every run's row, and what its status and cancellation are read from (run-registry.ts).
  const runs = createRunRegistry({
    onQueueChange: () => {
      publishQueue(false);
      if (runs.isIdle() && statusBeat !== undefined) {
        clearTimeout(statusBeat);
        statusBeat = undefined;
      }
    },
  });
  // The status heartbeat, armed while any run is tracked (scheduleStatusBeat).
  let statusBeat: ReturnType<typeof setTimeout> | undefined;
  // The last execution whose reply said "no change", still watching for a change that lands after it
  // (document-changes.ts watchLate). Bounded by the next run's start and by the window its
  // EXECUTE_CODE carried — the server's number, since the server is what holds the run open for it.
  let lateChangeWatch: DocumentChangeObserver | null = null;

  /**
   * One writer at a time (Invariant) — enforced by SERIALIZING writes rather than refusing the
   * non-driving server. Without this chain two granted agents' executions would interleave at every
   * `await` inside the document (loadFontAsync, exportAsync).
   *
   * The `catch` is not defensive noise: one rejection anywhere in the chain would poison it and
   * silently brick EVERY later write for the life of the plugin. Both runners reply on their own
   * error paths, so swallowing here loses nothing a caller could act on.
   */
  let writeChain: Promise<void> = Promise.resolve();
  // Each queued run's job until the chain reaches it; a withdrawn one is just its late reply.
  const queuedJobs = new Map<string, QueuedJob | (() => void)>();
  const jobKey = (to: RunRef) => `${to.connKey}:${to.id}`;
  function enqueueWrite(to: ReplyTo, job: QueuedJob): void {
    const key = jobKey(to);
    queuedJobs.set(key, job);
    writeChain = writeChain
      .then(() => {
        const next = queuedJobs.get(key)!;
        queuedJobs.delete(key);
        return typeof next === "function" ? next() : next.start();
      })
      .catch(() => {});
  }

  // Every status is stamped `at` when posted: a frame only leaves once this thread goes idle, so it
  // can arrive seconds late, and the server must not take a late one as fresh.
  function sendRunning(to: RunRef): void {
    const at = Date.now();
    toServer(to.connKey, { type: "RUN_STATUS", executionId: to.id, at, phase: "running", activity: runs.activity(to, at) });
  }

  /** Tell each queued run where it stands: `all` on a heartbeat, else only those whose wait changed. */
  function publishQueue(all: boolean): void {
    const at = Date.now();
    for (const { ref, wait } of runs.dueQueueStatuses(at, all))
      toServer(ref.connKey, { type: "RUN_STATUS", executionId: ref.id, at, phase: "queued", wait });
  }

  /**
   * The heartbeat: every tracked run's status, each interval while any is tracked, since the server
   * stops waiting on any run it hears nothing about, queued ones included. It only fires when the
   * thread yields, so silence means the thread is held. Each beat is also the running run's watchdog.
   */
  function scheduleStatusBeat(): void {
    statusBeat ??= setTimeout(() => {
      statusBeat = undefined;
      const running = runs.heartbeat();
      if (running) sendRunning(running);
      publishQueue(true);
      if (!runs.isIdle()) scheduleStatusBeat();
    }, RUN_STATUS_INTERVAL_MS);
  }

  /** Accept a run: tracked from this moment, since a run can be cancelled or withdrawn while queued. */
  function acceptRun(to: ReplyTo, label: RunLabel): void {
    runs.enqueue(to, label);
    scheduleStatusBeat();
    activity.advance(to.id, "queued", label.session);
  }

  /**
   * The run reached the front of the write chain and is about to touch the document. The previous
   * execution's late-change watch ends first, so nothing this run does is charged to that one.
   */
  function beginRun(to: ReplyTo): void {
    lateChangeWatch?.stop();
    lateChangeWatch = null;
    runs.markRunning(to);
    activity.advance(to.id, "running");
    sendRunning(to);
  }

  /**
   * The dequeue refusals, in order: the grant first, so a CANCEL landing while storage settles is
   * still honoured; then the queued-zombie case — a run withdrawn while its grant was read, or
   * cancelled while it sat queued, must not execute now, mutating a canvas the agent was told is
   * unchanged. Nothing waits on that reply (the WITHDRAW or CANCEL was answered when it landed), but
   * the frozen envelope promises one per request, and the server files it as a late reply. True when
   * the run may start.
   */
  async function admitAtDequeue(
    to: ReplyTo,
    documentId: string,
    refuseQueued: (reason: string) => void,
  ): Promise<boolean> {
    runs.markAtFront(to);
    const refusal = await refusalAtDequeue(to.connKey, documentId);
    if (!runs.isTracked(to)) {
      refuseQueued(WITHDRAWN_WHILE_QUEUED);
      return false;
    }
    const cancelled = runs.queuedCancellation(to);
    if (cancelled) {
      runs.settle(to);
      activity.advance(to.id, "cancelled");
      refuseQueued(CANCELLED_WHILE_QUEUED[cancelled]);
      return false;
    }
    if (refusal) {
      runs.settle(to);
      activity.advance(to.id, "refused");
      reply(to, { type: "NOT_GRANTED", reason: refusal });
      return false;
    }
    return true;
  }

  /**
   * `work`, unless the run is cancelled first, whatever the cause: the agent's own awaits (a figma.on
   * promise, a node export, a promise that never settles) and the host's node lookups are no call the
   * preamble can race, and the run must still end so the queue moves. Code left running is refused at
   * its next figma.* access or verb. `pending` says what was still going on.
   */
  function untilRunCancelled<T>(to: RunRef, work: PromiseLike<T>, pending: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Deferred, so a refusal that names what was pending (awaitNative, a server call) reaches the
      // agent first; this only ends work that nothing else will.
      const unsubscribe = runs.onCancelled(to, (cause) => {
        let hops = Promise.resolve();
        for (let hop = 0; hop < CANCEL_REJECTION_HOPS; hop++) hops = hops.then();
        void hops.then(() => reject(new FlcmError("run-ended", `${pending} when ${RUN_CANCELLED_BY[cause]}, so the run stops here.`)));
      });
      work.then(
        (value) => { unsubscribe(); resolve(value); },
        (error: unknown) => { unsubscribe(); reject(error); },
      );
    });
  }

  /**
   * Runs the agent's raw code string against the live figma.* API and posts back
   * `{ id, result, console, errors }`. The agent's code is never bundled or transformed — it arrives
   * as a string and is eval'd here, in the sandbox.
   *
   * The async IIFE wrapper is mandatory: Figma's QuickJS sandbox blocks the AsyncFunction constructor
   * but permits `eval` + `await` inside an IIFE, so this is what buys the agent `await`.
   */
  async function executeCode(
    to: ReplyTo,
    documentId: string,
    agentSession: AgentSession,
    code: string,
    preamble: string,
    lateChangeWindowMs: number,
  ): Promise<void> {
    const admitted = await admitAtDequeue(to, documentId, (reason) => codeNotRun(to, reason));
    if (!admitted) {
      sessions.release(agentSession);
      return;
    }
    beginRun(to);
    const isFigmaNode = isFigmaNodeAsking((id) =>
      untilRunCancelled(to, figma.getNodeByIdAsync(id), "Figma was still looking up a node your code logged or returned"),
    );
    // How the run ended, kept for its host once the row goes (agent-figma.ts refuses on it).
    let endedBy: RunCancelCause | null = null;
    try {
      const logged: { level: string; args: WireSnapshot }[] = [];
      const originalConsole = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
      };

      // Capture the agent's console output so it round-trips back as feedback. Each call takes the
      // result's egress (one projection for the whole line) and is snapshotted as it is logged, Figma
      // asked then about any object that could be a node; its answers arrive asynchronously, so those
      // objects resolve to `{id,name,type}` before the reply.
      const capture = (level: string) => (...args: unknown[]) => {
        const line = runtime ? runtime.projectForEgress(args, "console") : args;
        logged.push({ level, args: snapshotForWire(line, isFigmaNode) });
      };
      console.log = capture("log");
      console.info = capture("info");
      console.warn = capture("warn");
      console.error = capture("error");

      let result: unknown;
      let errorMessage: string | null = null;
      // Flipped once this run has nothing left to do — after the queue drain below, so a verb that was
      // legitimately queued by this run's code is not refused as another run's leftover. Every host
      // method reads it, which is what contains a runtime the agent stored across calls.
      let settled = false;
      let runtime: typeof SandboxRuntime | undefined;
      let landedAfterReturn = 0;
      let documentChanged = false;
      let documentChanges: DocumentChangeObserver | undefined;
      try {
        // Watching starts before anything of the agent's can run, and ends after the drain below.
        documentChanges = observeDocumentChanges();
        // Two evals, and the split is the point. The server's std-lib is a FACTORY expression
        // (src/preamble/index.mjs): called with the host, it returns { flcm, session }, which the
        // agent's code receives as named parameters. The agent's own wrapper keeps its line numbers.
        //
        // The host answers for THIS run (`to`), so each service refuses once the run has settled rather
        // than serve a runtime the agent kept past its reply. Call reports go quiet instead: the row is
        // gone, and a report that refused would change execution.
        const host: FlcmHost = {
          getSession: (initialize) => {
            agentSession.store ??= initialize();
            return agentSession.store;
          },
          callStarted: (operation) => runs.callStarted(to, operation),
          callSettled: (token) => runs.callSettled(to, token),
          // A finished runtime is refused in the preamble, before it asks (refuseIfRunFinished).
          callServer: (capability: string, payload: unknown) => serverCalls.call(to, capability, payload),
          // Past settlement the row is gone, and the cause the run ended with still answers.
          runCancellation: () => endedBy ?? runs.cancellation(to),
          onCancelled: (listener) => runs.onCancelled(to, listener),
          isRunFinished: () => settled,
        };
        const built = (eval(preamble) as (host: FlcmHost) => typeof SandboxRuntime)(host);
        // Checked HERE, not in the finally that drains: a std-lib that cannot be drained must fail as a
        // run error the agent sees, never as a throw out of the finally — that would cost the run its
        // reply, and the frozen envelope promises one for every request.
        if (
          typeof built.mutationQueueIdle !== "function" ||
          typeof built.committedVerbCount !== "function" ||
          typeof built.projectForEgress !== "function" ||
          typeof built.agentFigma !== "function"
        ) {
          throw new FlcmError(
            "run-ended",
            "the flcm the server sent doesn't fit this version of the Figma plugin, so none of your code ran. " +
              "Update the server (`npx figma-developer-mcp@latest`) and the plugin, then restart.",
          );
        }
        runtime = built;
        const { flcm, session } = built;
        // Indirect eval gives agent code global scope, never this function's host/transport locals.
        // Its `figma` is the preamble's (agent-figma.ts), shadowing the global: the one the run's
        // cancellation can stop.
        const raw = await untilRunCancelled(
          to,
          (0, eval)(wrapAgentCode(code))(flcm, session, built.agentFigma()),
          "your code was still awaiting",
        );
        // A live node anywhere in the result is refused here, with its path (serialize.ts).
        result = await serializeForWire(runtime.projectForEgress(raw, "result"), isFigmaNode, "result");
        // Session capture is optional; its narrower data contract must not reject a valid wire result.
        try { session.last = raw; } catch { session.last = undefined; }
      } catch (err) {
        errorMessage = formatFailureForAgent(err);
      } finally {
        // Drain before anything else in here, and the order of the three is load-bearing:
        //   • BEFORE the console restore, so a queued verb's warnings still reach the agent's reply;
        //   • BEFORE settle(), which drops this run's cancellation — a CANCEL landing mid-drain must
        //     still refuse the verbs behind it (mutation-lock refuseIfCancelled);
        //   • BEFORE `settled`, or the run's own queued verbs would be refused as a stale runtime's.
        // A preamble that never evaluated leaves no queue to drain.
        if (runtime) landedAfterReturn = await runtime.mutationQueueIdle();
        // After the drain, so writes that landed after the agent's code returned count too. A committed
        // flcm verb is a change by construction; it is OR'd in because it is known synchronously,
        // while change events arrive in asynchronous batches (document-changes.ts). A "no" is only
        // provisional: the observer keeps watching past the reply and reports a late change on its own.
        documentChanged =
          (documentChanges?.changedSoFar() ?? false) || (runtime?.committedVerbCount() ?? 0) > 0;
        if (documentChanged) documentChanges?.stop();
        else if (documentChanges) {
          // Run-scoped and id-less, like CANCEL_RESULT; at most one RUN_CHANGED per run, and the server
          // records the Write under the run's execution, so a duplicate is harmless.
          documentChanges.watchLate(
            {
              onChange: () => toServer(to.connKey, { type: "RUN_CHANGED", executionId: to.id }),
              onSettled: () => toServer(to.connKey, { type: "RUN_SETTLED", executionId: to.id }),
            },
            lateChangeWindowMs,
          );
          lateChangeWatch = documentChanges;
        }
        console.log = originalConsole.log;
        console.info = originalConsole.info;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
        settled = true;
      }
      if (landedAfterReturn > 0) {
        runtime!.warnings.add({ id: null, message:
          `${landedAfterReturn} write(s) finished after your code returned: a write is queued the moment ` +
            `its verb is called, so an unawaited verb (or a sibling of one that rejected in Promise.all) ` +
            `still lands. This reply waited for them; await every verb to keep your result and the canvas in step.`,
        });
      }
      const consoleLog: string[] = [];
      for (const { level, args } of logged) {
        try {
          const line = (await resolveWireSnapshot(args, "console")) as unknown[];
          consoleLog.push(`[${level}] ${line.map(stringifyArg).join(" ")}`);
        } catch (err) {
          // A cycle through an object Figma disowned is only found now, past the console.log it would
          // have thrown from, so it fails the run the way that throw would have. A lookup the run's
          // cancel abandoned drops just its line; the lines already resolved still go out.
          errorMessage ??= formatFailureForAgent(err);
        }
      }
      if (runtime) consoleLog.push(...runtime.warnings.summary());
      // After `last` is captured and the run settled, so the budgets see everything the run kept.
      const sessionNotice = sessions.release(agentSession);
      if (sessionNotice) consoleLog.push(`[warn] ${sessionNotice}`);

      activity.advance(to.id, runs.cancellation(to) !== null ? "cancelled" : errorMessage === null ? "done" : "failed");
      reply(to, { type: "EXECUTE_CODE_RESULT", result, console: consoleLog, errors: errorMessage, documentChanged });
    } finally {
      // Only now: until the reply the run still holds the write chain, so it keeps its status, its
      // cancel answer, and its place as the blocker, though its code finished long before.
      endedBy = runs.cancellation(to);
      runs.settle(to);
    }
  }

  /**
   * Exports a node as PNG and posts back exactly one of `{ id, image }` (a base64 string) or
   * `{ id, errors }`. With no target, snapshots the whole current page.
   *
   * The base64 encoding MUST happen here, not on the server: the relay (ui.ts) JSON.stringifies every
   * outbound frame, which turns a raw Uint8Array into a useless `{"0":..}` blob. QuickJS has no
   * Buffer, so the sandbox's own `figma.base64Encode` gets a clean string across the wire.
   */
  async function screenshot(
    to: ReplyTo,
    documentId: string,
    target: ScreenshotTarget,
    options: CaptureOptions,
  ): Promise<void> {
    const admitted = await admitAtDequeue(to, documentId, (reason) => screenshotNotTaken(to, reason));
    if (!admitted) return;
    beginRun(to);
    try {
      const node = await resolveScreenshotTarget(target);
      const bytes = await captureScreenshot(node, options, () => runs.cancellation(to) !== null);
      activity.advance(to.id, "done");
      reply(to, { type: "SCREENSHOT_RESULT", image: figma.base64Encode(bytes) });
    } catch (err) {
      activity.advance(to.id, runs.cancellation(to) !== null ? "cancelled" : "failed");
      reply(to, { type: "SCREENSHOT_RESULT", errors: formatFailureForAgent(err) });
    } finally {
      runs.settle(to);
    }
  }

  return {
    /**
     * Queue an admitted EXECUTE_CODE for `documentId`, the document it was admitted for, in its pinned
     * session, under the call's intent. Queued, not awaited, so another server's write can't interleave.
     */
    runCode(
      to: ReplyTo,
      documentId: string,
      session: AgentSession,
      intent: string,
      code: string,
      preamble: string,
      lateChangeWindowMs: number,
    ): void {
      acceptRun(to, { kind: "code", intent, session: session.handle });
      enqueueWrite(to, {
        start: () => executeCode(to, documentId, session, code, preamble, lateChangeWindowMs),
        withdraw: () => {
          sessions.release(session);
          return () => codeNotRun(to, WITHDRAWN_WHILE_QUEUED);
        },
      });
    },

    runScreenshot(to: ReplyTo, documentId: string, intent: string, target: ScreenshotTarget, options: CaptureOptions): void {
      acceptRun(to, { kind: "screenshot", intent, session: null });
      enqueueWrite(to, {
        start: () => screenshot(to, documentId, target, options),
        withdraw: () => () => screenshotNotTaken(to, WITHDRAWN_WHILE_QUEUED),
      });
    },

    /** Resolves once every run queued so far has settled, ran or refused. */
    idle: (): Promise<void> => writeChain,

    /**
     * The server gave up on a run. Answer FIRST, from what is already known: the server is holding
     * its caller for this one frame, and a queued run's own refusal only fires once the run ahead
     * finishes. Rejecting its pending server calls then kills a run suspended at its await right now.
     */
    cancel(connKey: ConnKey, executionId: string): void {
      const figmaPausedMs = figmaPause.pausedForMs() ?? undefined;
      toServer(connKey, {
        type: "CANCEL_RESULT",
        executionId,
        ...runs.recordCancellation(connKey, executionId),
        figmaPausedMs,
      });
      serverCalls.reject(
        (call) => call.executionId === executionId && call.connKey === connKey,
        "the server cancelled this run, so its request to the server was abandoned and the script stops here.",
      );
    },

    /**
     * The caller no longer wants a run that hasn't started. A queued one is dropped at once, with its
     * payload and session, and answered later as never run, when the chain reaches it; a running one
     * is left alone.
     */
    withdraw(connKey: ConnKey, executionId: string): void {
      const answer = runs.withdraw(connKey, executionId);
      toServer(connKey, { type: "WITHDRAW_RESULT", executionId, ...answer });
      if (answer.outcome !== "withdrawn") return;
      activity.advance(executionId, "withdrawn");
      // Absent when the run is already at the front, awaiting its dequeue checks: those let it go.
      const key = jobKey({ connKey, id: executionId });
      const job = queuedJobs.get(key);
      if (typeof job === "object") queuedJobs.set(key, job.withdraw());
    },

    /**
     * End every run of one connection: its queued runs never start, its running one writes nothing
     * more, and a server call it is suspended on is abandoned. Cooperative — a raw figma.* write
     * already in flight can't be stopped, only every verb and await after it.
     */
    cancelConnection(connKey: ConnKey, cause: ConnectionCancelCause): void {
      serverCalls.reject((call) => call.connKey === connKey, CALLS_ABANDONED[cause]);
      runs.cancelConnection(connKey, cause);
    },

    settleServerCall(msg: Extract<ServerFrame, { type: "CHANNEL_RESPONSE" }>, connKey: ConnKey): void {
      serverCalls.settle(msg, connKey);
    },
  };
}


// Figma hands back the identical object for a live node. getNodeByIdAsync stalls ~10s and then
// throws for an id Figma doesn't hold now (a node removed in this run, one that never was), so the
// object's own `removed` decides whether to ask: true is a node Figma removed, false a node Figma
// should hold, and an object with neither is no node. Read again after the answer: the script runs on
// while Figma is asked, and a node it removes meanwhile is answered null.
const isFigmaNodeAsking = (lookup: (id: string) => Promise<BaseNode | null>): IsFigmaNode => async (value) => {
  const removed = (): unknown => value.removed;
  if (removed() !== false) return removed() === true;
  return (await lookup(value.id)) === value || removed() === true;
};

function stringifyArg(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
