// __connKey identifies one socket generation, assigned by ui.html. Ports are reusable;
// this identity is not. Old settlement can only release the old generation's run.
export interface RunRef {
  id: string;
  connKey: number | undefined;
}

/**
 * Where an outstanding run stands in THIS plugin's queue. There is no third member for a finished
 * run: settlement deletes the row, and "no row" is what makes a cancel answer `unknown`.
 */
type RunPhase = "queued" | "running";

/**
 * What the plugin knew about a run the instant a CANCEL for it landed — the answer the server turns
 * into the caller's rejection, which is why it is definitive rather than hedged:
 *   • never-executed — still queued behind work ahead of it; the dequeue will skip it, canvas untouched.
 *   • was-running — executing, so verbs before the cancel already landed.
 *   • unknown — not tracked here: it settled before the CANCEL arrived, or was never a run at all
 *     (the server CANCELs any stalled request, including its own handshake ones).
 * Mirrored by CancelDisposition in the server's bridge.ts; the two are one wire word and move together.
 */
export type CancelDisposition = "never-executed" | "was-running" | "unknown";

function runKey(connKey: number | undefined, runId: string): string {
  return String(connKey) + ":" + runId;
}

/**
 * The cancellation policy, and the run phase it has to read to answer one. Cancellation is the only
 * consumer of the phase — the refusal points all ask "is this run cancelled?", and a CANCEL asks
 * "what was it doing?" — so both live here rather than as loose booleans across code.ts.
 */
export function createRunCancellationRegistry() {
  // One row per outstanding run, from acceptance to settlement — exactly the window in which a
  // cancel answer can be anything but `unknown`.
  const runs = new Map<string, { phase: RunPhase; cancelled: boolean }>();
  return {
    enqueue(ref: RunRef): void {
      runs.set(runKey(ref.connKey, ref.id), { phase: "queued", cancelled: false });
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
    recordCancellation(connKey: number | undefined, runId: string): CancelDisposition {
      const run = runs.get(runKey(connKey, runId));
      if (!run) return "unknown";
      run.cancelled = true;
      return run.phase === "queued" ? "never-executed" : "was-running";
    },
    takeCancellation(ref: RunRef): boolean {
      const run = runs.get(runKey(ref.connKey, ref.id));
      if (!run?.cancelled) return false;
      run.cancelled = false;
      return true;
    },
    isCancelled(ref: RunRef): boolean {
      return runs.get(runKey(ref.connKey, ref.id))?.cancelled === true;
    },
    cancelConnection(connKey: number): void {
      const prefix = String(connKey) + ":";
      for (const [key, run] of runs) if (key.startsWith(prefix)) run.cancelled = true;
    },
  };
}
