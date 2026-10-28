/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The plugin's one row per outstanding run, from acceptance to settlement, and everything a run's
// status and its cancellation are read from: its phase and place in the write chain, why it may not
// continue, the calls its code has pending, and when its server's heartbeat last reached it. "No row" is what
// makes a cancel or a withdrawal answer `unknown`.
import { isCallOperation, queueWaitKey, type CallOperation, type CancelAnswer, type QueueWait, type RunActivity, type WithdrawAnswer } from "./protocol.js";
import type { CallToken, RunCancelCause } from "./preamble/host.js";
import { inactivityExpired, queueWait, runActivity, type QueueRow } from "./run-status.js";

// connKey identifies one socket generation, assigned by the relay iframe (ui.ts) and never reused,
// so an old generation's settlement can only release its own run.
export interface RunRef {
  id: string;
  connKey: number;
}

function runKey(connKey: number, executionId: string): string {
  return String(connKey) + ":" + executionId;
}

/** What a run was submitted as: shown to a caller queued behind it. A screenshot has no session. */
export interface RunLabel {
  kind: "code" | "screenshot";
  intent: string;
  session: string | null;
}

/** The causes that come from outside the run, so the only ones that can stop it while it is queued. */
export type ExternalCancelCause = Exclude<RunCancelCause, "unresponsive">;
export type ConnectionCancelCause = Exclude<ExternalCancelCause, "server">;

type Run = QueueRow & {
  // Why the run may not continue; the first cause sticks. "unresponsive" is latched by the watchdog,
  // which arms only once the run executes.
  cause: RunCancelCause | null;
  cancelListeners: Set<(cause: RunCancelCause) => void>;
  // The watchdog's clock: null until the run executes.
  lastTickAt: number | null;
  // The change key of what this queued run was last told.
  sentWaitKey: string | null;
};

/**
 * `onQueueChange` hears every transition that can move what a queued run waits on: a run joining,
 * reaching the front, leaving, or being cancelled.
 */
export function createRunRegistry({ onQueueChange }: { onQueueChange: () => void }) {
  // Insertion order is write-chain order: a run is enqueued here as it joins the chain.
  const runs = new Map<string, Run>();
  // Shared by every run, so a token from one run can never name a call of another.
  let nextToken: CallToken = 0;

  const runOf = (ref: RunRef) => runs.get(runKey(ref.connKey, ref.id));
  // The first cause sticks: it is what happened first.
  const cancel = (run: Run, cause: RunCancelCause): void => {
    if (run.cause) return;
    run.cause = cause;
    run.cancelledAt = Date.now();
    const listeners = [...run.cancelListeners];
    run.cancelListeners.clear();
    for (const listener of listeners) listener(cause);
    onQueueChange();
  };
  const waitOf = (run: Run, now: number) => queueWait([...runs.values()], run, now);

  return {
    enqueue(ref: RunRef, label: RunLabel): void {
      runs.set(runKey(ref.connKey, ref.id), {
        id: ref.id,
        connKey: ref.connKey,
        ...label,
        phase: "queued",
        frontAt: null,
        cause: null,
        cancelledAt: null,
        calls: null,
        cancelListeners: new Set(),
        lastTickAt: null,
        sentWaitKey: null,
      });
      onQueueChange();
    },
    /** Still tracked: false once it settled, or was withdrawn before it ran. */
    isTracked: (ref: RunRef): boolean => runOf(ref) !== undefined,
    /** The run reached the front of the chain and its dequeue checks begin. */
    markAtFront(ref: RunRef): void {
      const run = runOf(ref);
      if (!run) return;
      run.frontAt = Date.now();
      onQueueChange();
    },
    /** The run executes from here: a CANCEL is answered "was-running", and its watchdog arms. */
    markRunning(ref: RunRef): void {
      const run = runOf(ref);
      if (!run) return;
      run.phase = "running";
      run.lastTickAt = Date.now();
      if (run.kind === "code") run.calls = { pending: new Map(), settled: 0 };
    },
    isIdle: (): boolean => runs.size === 0,
    /**
     * `connKey`'s server asked for status: tick the watchdog of the running run on that link and name
     * it, or null with none. The gap is checked before the clock moves, so the first request handled
     * after a long block latches the run rather than reviving it.
     */
    heartbeat(connKey: number): RunRef | null {
      // The write chain runs one at a time, so at most one row is running.
      for (const run of runs.values()) {
        if (run.lastTickAt === null || run.connKey !== connKey) continue;
        const now = Date.now();
        if (inactivityExpired(now, run.lastTickAt)) cancel(run, "unresponsive");
        run.lastTickAt = now;
        return { id: run.id, connKey: run.connKey };
      }
      return null;
    },
    /** A call the run's status names while pending. An unknown name is counted, never named. */
    callStarted(ref: RunRef, operation: CallOperation): CallToken {
      const token = ++nextToken;
      runOf(ref)?.calls?.pending.set(token, { operation: isCallOperation(operation) ? operation : null, since: Date.now() });
      return token;
    },
    /** Only the run's own pending token counts, and only once. */
    callSettled(ref: RunRef, token: CallToken): void {
      const calls = runOf(ref)?.calls;
      if (calls?.pending.delete(token)) calls.settled++;
    },
    activity(ref: RunRef, now: number): RunActivity {
      return runActivity(runOf(ref)?.calls ?? null, now);
    },
    settle(ref: RunRef): void {
      if (runs.delete(runKey(ref.connKey, ref.id))) onQueueChange();
    },
    /**
     * Record the server's CANCEL and answer it from what is already known — no await, no canvas
     * work. A run cancelled while queued only reaches its own dequeue refusal once the run AHEAD of
     * it finishes, and the server cannot wait that long to tell its caller what happened.
     *
     * Transport delivery is ordered, so a cancel either follows this run's enqueue or names one that
     * already settled. The latter is retained by nobody, so the table never leaks a row.
     */
    recordCancellation(connKey: number, executionId: string): CancelAnswer {
      const run = runs.get(runKey(connKey, executionId));
      if (!run) return { disposition: "unknown" };
      const { blocker } = waitOf(run, Date.now());
      cancel(run, "server");
      if (run.phase === "running") return { disposition: "was-running" };
      return blocker ? { disposition: "never-executed", blocker } : { disposition: "never-executed" };
    },
    /**
     * Drop a run that hasn't started, in one step, so its dequeue finds no row and skips it. A run
     * at the front whose dequeue checks are still awaiting counts as not started.
     */
    withdraw(connKey: number, executionId: string): WithdrawAnswer {
      const key = runKey(connKey, executionId);
      const run = runs.get(key);
      if (!run) return { outcome: "unknown" };
      if (run.phase === "running") return { outcome: "running" };
      const { blocker } = waitOf(run, Date.now());
      runs.delete(key);
      onQueueChange();
      return blocker ? { outcome: "withdrawn", blocker } : { outcome: "withdrawn" };
    },
    /**
     * May this run continue? Why not, or null. Past the inactivity deadline since its last heartbeat
     * tick it latches "unresponsive": a blocking call's continuation can run before the overdue tick.
     */
    cancellation(ref: RunRef): RunCancelCause | null {
      const run = runOf(ref);
      if (!run) return null;
      if (run.lastTickAt !== null && inactivityExpired(Date.now(), run.lastTickAt)) cancel(run, "unresponsive");
      return run.cause;
    },
    /** Why a run still queued was cancelled, or null: only a cause from outside reaches one. */
    queuedCancellation(ref: RunRef): ExternalCancelCause | null {
      const cause = runOf(ref)?.cause ?? null;
      return cause === "unresponsive" ? null : cause;
    },
    /**
     * Hear the run's cancellation, as the CANCEL message is handled or the watchdog latches — the one
     * thing that still happens when Figma stalls a call the run awaits. Returns the unsubscribe.
     */
    onCancelled(ref: RunRef, listener: (cause: RunCancelCause) => void): () => void {
      const run = runOf(ref);
      if (!run || run.cause) {
        if (run?.cause) listener(run.cause);
        return () => {};
      }
      run.cancelListeners.add(listener);
      return () => run.cancelListeners.delete(listener);
    },
    /** Cancel every outstanding run of one connection: its socket closed, or the human revoked it. */
    cancelConnection(connKey: number, cause: ConnectionCancelCause): void {
      for (const run of runs.values()) if (run.connKey === connKey) cancel(run, cause);
    },
    /** The queued runs whose wait changed since they were last told, and every one on `askedBy`. */
    dueQueueStatuses(now: number, askedBy: number | null): { ref: RunRef; wait: QueueWait }[] {
      const due = [];
      for (const run of runs.values()) {
        if (run.phase !== "queued") continue;
        const wait = waitOf(run, now);
        const key = queueWaitKey(wait);
        if (run.connKey !== askedBy && run.sentWaitKey === key) continue;
        run.sentWaitKey = key;
        due.push({ ref: { id: run.id, connKey: run.connKey }, wait });
      }
      return due;
    },
  };
}
