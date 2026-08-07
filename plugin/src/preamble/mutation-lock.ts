// mutation-lock — the single entry point every mutating verb takes (plan invariant 4): render and
// edit today; editMany and the structural verbs enter through it as they land. Three jobs, one
// place — serialize verbs, enforce cancellation, own the undo scaffold (the seal/commit/rollback
// shape lives on enterMutatingVerb, exactly once, never per verb):
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

// Host-installed cancellation flag — code.ts binds it to this run's CANCEL state. Like
// __flcmRequestImages it arrives as a PARAMETER of the eval'd wrapper (build.mjs pins the pairing);
// the typeof guard keeps the harness and unit tests (which run in global scope and may not install
// it) alive.
declare const __flcmRunCancelled: (() => boolean) | undefined;

let verbChain: Promise<unknown> = Promise.resolve();

// Mutating verbs that ran to their success commit this run — the pointer-error contract (invariant
// 2) tells the agent "the N mutating calls before this one committed and stand" instead of making
// it re-read the canvas to find out where it is. Per-run state, like the chain.
let committedVerbs = 0;

// How many mutating verbs committed before the currently-failing one — read inside a verb's catch,
// where this verb hasn't (and won't) increment.
export function committedVerbCount(): number {
  return committedVerbs;
}

function runCancelled(): boolean {
  return typeof __flcmRunCancelled === "function" && __flcmRunCancelled();
}

/**
 * Run one mutating verb's body under the lock: queued behind every earlier verb in this run,
 * refused — fail closed, before any canvas write — if the run was cancelled by the time its turn
 * arrives, and wrapped in the invariant-2/4 undo scaffold:
 *
 *   entry seal → body → success commit          (the verb is exactly one undo step)
 *   entry seal → body throws → commit + trigger (seal the partial writes, pop exactly that step)
 *
 * The failure path's commit is LOAD-BEARING, not a bookkeeping nicety: figma.triggerUndo() reverts
 * the last COMMITTED step and swallows uncommitted trailing writes with it (hand-verified
 * 2026-08-07; scripts/probe-commit-undo.mjs is the standing runbook). Bare triggerUndo over the
 * failed verb's writes would eat the previous step too. The entry seal is what bounds the pop:
 * whatever preceded the verb — earlier verbs, raw figma.* writes, a human's edit — is already
 * sealed into its own step, so rollback can only ever erase the failed verb's own writes.
 */
export function enterMutatingVerb<T>(verb: string, body: () => Promise<T>): Promise<T> {
  const turn = verbChain.then(async () => {
    if (runCancelled()) {
      throw new Error(
        "flcm." + verb + ": this run was cancelled by the server (its deadline passed) — no further " +
          "mutating verbs start. The canvas holds what completed before the cancellation.",
      );
    }
    figma.commitUndo();
    try {
      const result = await body();
      figma.commitUndo();
      committedVerbs++;
      return result;
    } catch (err) {
      figma.commitUndo();
      figma.triggerUndo();
      throw err;
    }
  });
  // A failed verb must not poison the chain — the failure belongs to its caller (via `turn`);
  // later verbs proceed against the rolled-back canvas the scaffold left. (Same swallow as the
  // host's writeChain, code.ts enqueueWrite.)
  verbChain = turn.catch(() => {});
  return turn;
}
