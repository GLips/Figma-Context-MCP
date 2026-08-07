// run-cancellation — the plugin-side registry that makes the server's run-scoped CANCEL real
// (plan invariant 4's enforcement point). The CANONICAL policy statement lives here; every other
// site points at this file rather than restating it:
//
//   A run is tracked from ACCEPT (enqueued behind the write chain) to SETTLE (its handler
//   finished). It becomes cancelled when the server says so — a CANCEL frame (its deadline
//   fired), or its socket closing (the server rejects every in-flight caller on disconnect, so
//   the agent has already been told those runs failed). A cancelled run is refused wherever it
//   next surfaces: at DEQUEUE, when its queued turn arrives (the sharp case — a run that timed
//   out while queued must not later execute in full), and DURING execution, before each mutating
//   verb starts (the preamble's mutation lock reads `isCancelled` through the __flcmRunCancelled
//   eval-wrapper parameter). A run suspended at its mid-run image await is additionally killed
//   there (code.ts rejectImagesFetches); the server's own half refuses image requests naming a
//   dead run.
//
// Keys pair the source port with the run id: correlation ids are per-server counters, so two
// connected servers can mint colliding ids — and a NEW server on a reused port restarts its
// counter, which is why a port's entries are swept on connect. The sweep SKIPS outstanding runs
// (queued or executing): their cancellation must survive a socket blip (close → ~1s redial →
// reconnect), or a cancelled run would revive — queued, it would execute in full; executing, it
// would keep writing. The mirror-image cost is accepted as fail-closed: a new server whose
// colliding id lands while the old server's same-id run is still outstanding gets that one run
// wrongly refused. Cancels for handshake requests (SESSION_INFO/GET_VERSION time out server-side
// too) never reach a dequeue and are reclaimed only by the sweep.
//
// Negative space — the millisecond CANCEL race is deliberately open: the server rejects the
// agent's call immediately after SENDING the frame, so a run dequeuing in the frame's short
// WS→iframe→sandbox flight can still execute. Closing it needs the run to carry its own deadline
// at dispatch (local expiry), new protocol surface this slice doesn't add — the same
// accepted-deferral shape as the pre-handshake skew-gate window. Revisit only if live use hits it.

export interface RunRef {
  id: string;
  connKey: number | undefined;
}

function runKey(connKey: number | undefined, runId: string): string {
  return String(connKey) + ":" + runId;
}

export function createRunCancellationRegistry() {
  const cancelled = new Set<string>();
  const outstanding = new Set<string>();

  return {
    /** The run was accepted and queued behind the write chain. From here until settle, its
     * cancellation (if any) has a live reader and must survive the port sweep. */
    enqueue(ref: RunRef): void {
      outstanding.add(runKey(ref.connKey, ref.id));
    },
    /** The run's handler finished (executed, refused, or threw) — release its tracking and
     * consume any cancellation that raced its reply. */
    settle(ref: RunRef): void {
      const key = runKey(ref.connKey, ref.id);
      outstanding.delete(key);
      cancelled.delete(key);
    },
    /** A CANCEL frame arrived for this run. */
    recordCancellation(connKey: number | undefined, runId: string): void {
      cancelled.add(runKey(connKey, runId));
    },
    /** The dequeue gate: true CONSUMES the cancellation — the caller refuses the run instead of
     * executing it (mirror of the server bridge's takePending: check and reclaim in one step). */
    takeCancellation(ref: RunRef): boolean {
      return cancelled.delete(runKey(ref.connKey, ref.id));
    },
    /** The live mid-run flag, read before each mutating verb by the sandbox's mutation lock. */
    isCancelled(ref: RunRef): boolean {
      return cancelled.has(runKey(ref.connKey, ref.id));
    },
    /** The port's socket closed: cancel every outstanding run it accepted — the server already
     * told each of their callers the run failed (it rejects all pending on disconnect), so a run
     * that kept going would be the zombie this registry exists to stop. */
    cancelPort(connKey: number): void {
      const prefix = String(connKey) + ":";
      for (const key of outstanding) {
        if (key.indexOf(prefix) === 0) cancelled.add(key);
      }
    },
    /** A fresh socket on this port may be a NEW server whose id counter restarts — its runs must
     * not inherit the old server's cancellations. Outstanding runs keep theirs (see header). */
    sweepPort(connKey: number): void {
      const prefix = String(connKey) + ":";
      for (const key of cancelled) {
        if (key.indexOf(prefix) === 0 && !outstanding.has(key)) cancelled.delete(key);
      }
    },
  };
}
