// mutation-lock — the single entry point every mutating verb takes (plan invariant 4): render
// today; edit/editMany and the structural verbs enter through it as they land. Two jobs, one chain:
//
//   • Serialize mutating verbs WITHIN a run. Agent code can legally Promise.all two verbs, and every
//     verb awaits internally (fonts, targets, images), so unserialized verbs would interleave at
//     those awaits — moving the shared undo checkpoint (the commitUndo entry seal, invariant 2) out
//     from under each other's rollback. The preamble is eval'd fresh inside each run's wrapper, so
//     this chain is per-run state; exclusion BETWEEN runs is the host's writeChain (code.ts
//     enqueueWrite).
//
//   • Enforce cancellation during execution: once the host records this run's CANCEL, no further
//     verb STARTS — checked below as each verb's turn arrives, so a zombie run can never mutate a
//     canvas the agent was already told is unchanged. The full policy and its other refusal points
//     live on the host's registry (plugin/src/run-cancellation.ts).
//
// Verbs are non-reentrant BY DESIGN: a verb that awaits another public verb inside its body would
// deadlock on its own chain. No runtime guard is possible — QuickJS has no async context, so a
// nested call is indistinguishable from a legal concurrent one (Promise.all) — so the enforcement
// is the rule itself: a batch verb (editMany) takes the lock once and drives the commit-free
// internal appliers, never the public verbs (invariant 4).
//
// DECIDED (slice 2.1): once probe-commit-undo grounds the undo contract, the invariant-2
// seal/commit/rollback scaffold moves INTO enterMutatingVerb — entry seal (figma.commitUndo) →
// body → success commit; failure → figma.triggerUndo — so verbs pass only their body and the
// scaffold exists exactly once. If the probe shows adjacent commits mint empty undo steps, the
// adaptation happens here, in one place, not per verb.

// Host-installed cancellation flag — code.ts binds it to this run's CANCEL state. Like
// __flcmRequestImages it arrives as a PARAMETER of the eval'd wrapper (build.mjs pins the pairing);
// the typeof guard keeps the harness and unit tests (which run in global scope and may not install
// it) alive.
declare const __flcmRunCancelled: (() => boolean) | undefined;

let verbChain: Promise<unknown> = Promise.resolve();

function runCancelled(): boolean {
  return typeof __flcmRunCancelled === "function" && __flcmRunCancelled();
}

/**
 * Run one mutating verb's body under the lock: queued behind every earlier verb in this run, and
 * refused — fail closed, before any canvas write — if the run was cancelled by the time its turn
 * arrives.
 */
export function enterMutatingVerb<T>(verb: string, body: () => Promise<T>): Promise<T> {
  const turn = verbChain.then(() => {
    if (runCancelled()) {
      throw new Error(
        "flcm." + verb + ": this run was cancelled by the server (its deadline passed) — no further " +
          "mutating verbs start. The canvas holds what completed before the cancellation.",
      );
    }
    return body();
  });
  // A failed verb must not poison the chain — the failure belongs to its caller (via `turn`);
  // later verbs proceed against whatever canvas state the failed verb's own error path left.
  // (Same swallow as the host's writeChain, code.ts enqueueWrite.)
  verbChain = turn.catch(() => {});
  return turn;
}
