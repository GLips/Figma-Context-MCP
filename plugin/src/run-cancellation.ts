/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { CancelDisposition, RunPhase } from "./protocol.js";
import type { RunCancelCause } from "./preamble/host.js";

// connKey identifies one socket generation, assigned by the relay iframe (ui.ts) and never reused,
// so an old generation's settlement can only release its own run.
export interface RunRef {
  id: string;
  connKey: number;
}

function runKey(connKey: number, executionId: string): string {
  return String(connKey) + ":" + executionId;
}

/**
 * The cancellation policy, and the run phase it has to read to answer one. Cancellation is the only
 * consumer of the phase — the refusal points all ask "is this run cancelled, and why?", and a CANCEL
 * asks "what was it doing?" — so both live here rather than as loose booleans across the host.
 *
 * There is no phase for a finished run: settlement deletes the row, and "no row" is what makes a
 * cancel answer `unknown`.
 */
export function createRunCancellationRegistry() {
  // One row per outstanding run, from acceptance to settlement — exactly the window in which a
  // cancel answer can be anything but `unknown`. The first cause sticks: it is what happened first.
  const runs = new Map<string, { phase: RunPhase; cancelled: RunCancelCause | null }>();
  return {
    enqueue(ref: RunRef): void {
      runs.set(runKey(ref.connKey, ref.id), { phase: "queued", cancelled: null });
    },
    /** The run reached the front of the queue. Recorded BEFORE its first verb, so a CANCEL racing
     * the start is answered "was running" — the safe side of that race. */
    markRunning(ref: RunRef): void {
      const run = runs.get(runKey(ref.connKey, ref.id));
      if (run) run.phase = "running";
    },
    settle(ref: RunRef): void { runs.delete(runKey(ref.connKey, ref.id)); },
    /**
     * Record the server's CANCEL and answer it from what is already known — no await, no canvas
     * work. Immediacy is the point: a run cancelled while queued only reaches its own dequeue
     * refusal once the run AHEAD of it finishes, and the server cannot wait that long to tell its
     * caller what happened.
     *
     * Transport delivery is ordered, so a cancel either follows this run's enqueue or names one that
     * already settled. The latter is retained by nobody, which is what keeps the table from leaking
     * a row per socket generation.
     */
    recordCancellation(connKey: number, executionId: string): CancelDisposition {
      const run = runs.get(runKey(connKey, executionId));
      if (!run) return "unknown";
      run.cancelled ??= "server";
      return run.phase === "queued" ? "never-executed" : "was-running";
    },
    /** Why the run was cancelled, or null while it wasn't. */
    cancellation(ref: RunRef): RunCancelCause | null {
      return runs.get(runKey(ref.connKey, ref.id))?.cancelled ?? null;
    },
    /** Cancel every outstanding run of one connection: its socket closed, or the human revoked it. */
    cancelConnection(connKey: number, cause: Exclude<RunCancelCause, "server">): void {
      const prefix = String(connKey) + ":";
      for (const [key, run] of runs) if (key.startsWith(prefix)) run.cancelled ??= cause;
    },
  };
}
