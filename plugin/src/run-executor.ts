/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Runs what a granted server submits — agent code and screenshots — one at a time, against the
// live document, and owns everything a run carries: its phase and cancellation, its mid-run server
// calls, the late-change watch, and the agents' session stores.
import { createAgentSessions, type AgentSession } from "./agent-sessions.js";
import { captureScreenshot, type CaptureOptions } from "./screenshot-capture.js";
import { safeSerialize, guardReturnValue } from "./serialize.js";
import { resolveScreenshotTarget, type ScreenshotTarget } from "./screenshot-target.js";
import { createRunCancellationRegistry } from "./run-cancellation.js";
import { observeDocumentChanges, type DocumentChangeObserver } from "./document-changes.js";
import { createServerCallTable } from "./server-calls.js";
import { reply, toServer, type ReplyTo } from "./outbound.js";
import type { ConnKey } from "./panel.js";
import type {
  HostTraceStage,
  NativeOperation,
  NotGrantedReason,
  RunPhase,
  ServerFrame,
  SessionRequest,
} from "./protocol.js";
// TYPE-ONLY on purpose: this is the one shared declaration binding the host half of the flcm
// interface to the preamble half, and it must stay erasable — a value import from preamble/ would
// drag the whole std-lib back into this bundle, which is exactly what ADR-0010 removed.
import type { FlcmHost, RunCancelCause } from "./preamble/host.js";
// Likewise type-only: the factory result types both agent bindings without bundling their implementation.
import type * as SandboxRuntime from "./preamble/sandbox.js";

// What a run cancelled before it started tells its (late) reply, by cause.
const CANCELLED_WHILE_QUEUED: Record<RunCancelCause, string> = {
  server: "this run was cancelled by the server while it was still queued",
  disconnected: "this run's server disconnected while the run was still queued",
  revoked: "the human revoked this project's grant on the file while the run was still queued",
};

// Why a connection's suspended server calls were abandoned, by cause.
const CALLS_ABANDONED: Record<Exclude<RunCancelCause, "server">, string> = {
  disconnected: "flcm: the server disconnected mid-run — the server call was abandoned and the script stops here.",
  revoked:
    "flcm: the human revoked this project's grant in Figma — the server call was abandoned and the script stops here.",
};

export function createRunExecutor({
  isConnected,
  refusalAtDequeue,
}: {
  isConnected: (key: ConnKey) => boolean;
  /** The grant gate, asked again at dequeue: null admits. */
  refusalAtDequeue: (key: ConnKey, fileKey: string) => Promise<NotGrantedReason | null>;
}) {
  const serverCalls = createServerCallTable(isConnected);
  // The policy, the run phase it reads, and the key semantics live on run-cancellation.ts.
  const cancelledRuns = createRunCancellationRegistry();
  // The last execution whose reply said "no change", still watching for a change that lands after it
  // (document-changes.ts watchLate). Bounded by the next run's start and by the window its
  // EXECUTE_CODE carried — the server's number, since the server is what holds the run open for it.
  let lateChangeWatch: DocumentChangeObserver | null = null;
  // One store per session handle, kept across socket generations and pages for this plugin run.
  const sessions = createAgentSessions();

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
  function enqueueWrite(run: () => Promise<void>): void {
    writeChain = writeChain.then(run).catch(() => {});
  }

  /** Announce a run's phase on its connection. Returns the stamp it carries. */
  function runState(to: ReplyTo, phase: RunPhase): number {
    // `at` because the frame only leaves once this thread goes idle: a run that opens with seconds of
    // synchronous work delivers "running" seconds late, and the server would start its deadline then.
    const at = Date.now();
    toServer(to.connKey, { type: "RUN_STATE", runId: to.id, phase, at });
    return at;
  }

  /**
   * Accept a run: track it from this moment — a run can be cancelled while it still sits in the
   * queue — and tell its server. Phase transitions are announced and recorded together, here and in
   * beginRun only: the server's copy drives its deadlines, ours answers its CANCELs, and a run whose
   * two copies disagree is exactly how a caller gets told the wrong thing.
   */
  function acceptRun(to: ReplyTo): void {
    cancelledRuns.enqueue(to);
    runState(to, "queued");
  }

  /**
   * The run reached the front of the write chain and is about to touch the document. The previous
   * execution's late-change watch ends first, so nothing this run does is charged to that one.
   */
  function beginRun(to: ReplyTo): number {
    lateChangeWatch?.stop();
    lateChangeWatch = null;
    cancelledRuns.markRunning(to);
    return runState(to, "running");
  }

  /**
   * The dequeue refusals, in order: the grant first, so a CANCEL landing while storage settles is
   * still honoured; then the queued-zombie case (run-cancellation.ts) — a run cancelled while it sat
   * queued must not execute now, mutating a canvas the agent was told is unchanged. Nothing waits on
   * that reply (the CANCEL was answered when it landed), but the frozen envelope promises one per
   * request, and the server files it as a late reply. True when the run may start.
   */
  async function admitAtDequeue(
    to: ReplyTo,
    fileKey: string,
    refuseQueued: (reason: string) => void,
  ): Promise<boolean> {
    const refusal = await refusalAtDequeue(to.connKey, fileKey);
    const cancelled = cancelledRuns.cancellation(to);
    if (cancelled) {
      cancelledRuns.settle(to);
      refuseQueued(CANCELLED_WHILE_QUEUED[cancelled]);
      return false;
    }
    if (refusal) {
      cancelledRuns.settle(to);
      reply(to, { type: "NOT_GRANTED", reason: refusal });
      return false;
    }
    return true;
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
    fileKey: string,
    agentSession: AgentSession,
    code: string,
    preamble: string,
    lateChangeWindowMs: number,
  ): Promise<void> {
    const admitted = await admitAtDequeue(to, fileKey, (reason) =>
      reply(to, {
        type: "EXECUTE_CODE_RESULT",
        result: null,
        console: [],
        errors: `flcm: ${reason} — no code was executed.`,
        documentChanged: false,
      }),
    );
    if (!admitted) {
      sessions.release(agentSession);
      return;
    }
    const runStartedAt = beginRun(to);
    const traceStarted = Date.now();
    const trace = (stage: HostTraceStage, operation?: NativeOperation) => {
      try {
        toServer(to.connKey, { type: "RUN_TRACE", runId: to.id, stage, operation, elapsedMs: Date.now() - traceStarted });
      } catch { /* A diagnostic must never change execution or cleanup. */ }
    };
    trace("eval-start");
    const consoleLog: string[] = [];
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };

    // Capture the agent's console output so it round-trips back as feedback. Each call takes the
    // result's egress (one projection for the whole line) and node-aware serializer, so logging a live
    // node yields `{id,name,type}` instead of an opaque failure.
    const capture = (level: string) => (...args: unknown[]) => {
      const line = runtime ? (runtime.projectForEgress(args, "console") as unknown[]) : args;
      consoleLog.push(`[${level}] ${line.map(stringifyArg).join(" ")}`);
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
      // than serve a runtime the agent kept past its reply. Tracing goes quiet instead: a diagnostic
      // that refused would change execution.
      const host: FlcmHost = {
        getSession: (initialize) => {
          agentSession.store ??= initialize();
          return agentSession.store;
        },
        traceNative: (stage, operation) => { if (!settled) trace(stage, operation); },
        // A finished runtime is refused in the preamble, before it asks (refuseIfRunFinished).
        callServer: (capability: string, payload: unknown) => serverCalls.call(to, capability, payload),
        runCancellation: () => cancelledRuns.cancellation(to),
        isRunFinished: () => settled,
        runStartedAt,
      };
      const built = (eval(preamble) as (host: FlcmHost) => typeof SandboxRuntime)(host);
      // Checked HERE, not in the finally that drains: a std-lib that cannot be drained must fail as a
      // run error the agent sees, never as a throw out of the finally — that would cost the run its
      // reply, and the frozen envelope promises one for every request.
      if (
        typeof built.mutationQueueIdle !== "function" ||
        typeof built.committedVerbCount !== "function" ||
        typeof built.projectForEgress !== "function"
      ) {
        throw new Error(
          "the flcm std-lib the server sent doesn't match this plugin — it lacks the mutation queue " +
            "or the read egress this host drives. Update the server (`npx figma-developer-mcp@latest`) " +
            "and the plugin, then restart.",
        );
      }
      runtime = built;
      const { flcm, session } = built;
      // Indirect eval gives agent code global scope, never this function's host/transport locals.
      const raw = await (0, eval)("(async function(flcm, session){ " + code + "\n })")(flcm, session);
      // Return-path node guard: a returned live node would otherwise collapse to
      // { id } and silently drop everything else. Make that loud instead of lossy.
      guardReturnValue(raw);
      result = safeSerialize(runtime.projectForEgress(raw, "result"));
      // Session capture is optional; its narrower data contract must not reject a valid wire result.
      try { session.last = raw; } catch { session.last = undefined; }
    } catch (err) {
      errorMessage = formatError(err);
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
        ((await documentChanges?.changedSoFar()) ?? false) || (runtime?.committedVerbCount() ?? 0) > 0;
      if (documentChanged) documentChanges?.stop();
      else if (documentChanges) {
        // Run-scoped and id-less, like CANCEL_RESULT; at most one RUN_CHANGED per run, and the server
        // records the Write under the run's execution, so a duplicate is harmless.
        documentChanges.watchLate(
          {
            onChange: () => toServer(to.connKey, { type: "RUN_CHANGED", runId: to.id }),
            onSettled: () => toServer(to.connKey, { type: "RUN_SETTLED", runId: to.id }),
          },
          lateChangeWindowMs,
        );
        lateChangeWatch = documentChanges;
      }
      trace("eval-end");
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      settled = true;
      cancelledRuns.settle(to);
    }
    if (landedAfterReturn > 0) {
      runtime!.warnings.add({ id: null, message:
        `${landedAfterReturn} write(s) finished after your code returned — flcm reserves a ` +
          `verb's slot the moment it is called, so an unawaited verb (or a sibling of one that ` +
          `rejected in Promise.all) still lands. This reply waited for them; await every verb to keep ` +
          `your result and the canvas in step.`,
      });
    }
    if (runtime) consoleLog.push(...runtime.warnings.summary());
    // After `last` is captured and the run settled, so the budgets see everything the run kept.
    const sessionNotice = sessions.release(agentSession);
    if (sessionNotice) consoleLog.push(`[warn] ${sessionNotice}`);

    reply(to, { type: "EXECUTE_CODE_RESULT", result, console: consoleLog, errors: errorMessage, documentChanged });
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
    fileKey: string,
    target: ScreenshotTarget,
    options: CaptureOptions,
  ): Promise<void> {
    const admitted = await admitAtDequeue(to, fileKey, (reason) =>
      reply(to, { type: "SCREENSHOT_RESULT", errors: `flcm: ${reason} — no screenshot was taken.` }),
    );
    if (!admitted) return;
    beginRun(to);
    try {
      const node = await resolveScreenshotTarget(target);
      const bytes = await captureScreenshot(node, options, () => cancelledRuns.cancellation(to) !== null);
      reply(to, { type: "SCREENSHOT_RESULT", image: figma.base64Encode(bytes) });
    } catch (err) {
      reply(to, { type: "SCREENSHOT_RESULT", errors: formatError(err) });
    } finally {
      cancelledRuns.settle(to);
    }
  }

  return {
    /**
     * Pin the session a run arriving under grant scope `scope` names. Checked on arrival only: the
     * pin keeps the session until the run settles.
     */
    admitSession(scope: string, request: SessionRequest) {
      return sessions.admit(scope, request);
    },

    holdsSession(scope: string, handle: string): boolean {
      return sessions.holds(scope, handle);
    },

    /**
     * Queue an admitted EXECUTE_CODE for `fileKey`, the document it was admitted for, in its pinned
     * session. Queued, not awaited, so another server's write can't interleave.
     */
    runCode(
      to: ReplyTo,
      fileKey: string,
      session: AgentSession,
      code: string,
      preamble: string,
      lateChangeWindowMs: number,
    ): void {
      acceptRun(to);
      enqueueWrite(() => executeCode(to, fileKey, session, code, preamble, lateChangeWindowMs));
    },

    runScreenshot(to: ReplyTo, fileKey: string, target: ScreenshotTarget, options: CaptureOptions): void {
      acceptRun(to);
      enqueueWrite(() => screenshot(to, fileKey, target, options));
    },

    /**
     * The server gave up on a run. Answer FIRST, from what is already known: the server is holding
     * its caller for this one frame, and a queued run's own refusal only fires once the run ahead
     * finishes. Rejecting its pending server calls then kills a run suspended at its await right now.
     */
    cancel(connKey: ConnKey, runId: string): void {
      toServer(connKey, { type: "CANCEL_RESULT", runId, disposition: cancelledRuns.recordCancellation(connKey, runId) });
      serverCalls.reject(
        (call) => call.runId === runId && call.connKey === connKey,
        "flcm: this run was cancelled by the server (its deadline passed) — the script stops here.",
      );
    },

    /**
     * End every run of one connection: its queued runs never start, its running one writes nothing
     * more, and a server call it is suspended on is abandoned. Cooperative — a raw figma.* write
     * already in flight can't be stopped, only every verb and await after it.
     */
    cancelConnection(connKey: ConnKey, cause: Exclude<RunCancelCause, "server">): void {
      serverCalls.reject((call) => call.connKey === connKey, CALLS_ABANDONED[cause]);
      cancelledRuns.cancelConnection(connKey, cause);
    },

    settleServerCall(msg: Extract<ServerFrame, { type: "CHANNEL_RESPONSE" }>, connKey: ConnKey): void {
      serverCalls.settle(msg, connKey);
    },
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ? `${err.name}: ${err.message}\n${err.stack}` : `${err.name}: ${err.message}`;
  }
  return String(err);
}

function stringifyArg(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = safeSerialize(value);
  return typeof serialized === "string" ? serialized : JSON.stringify(serialized);
}
