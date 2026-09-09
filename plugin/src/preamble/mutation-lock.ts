// mutation-lock — the single entry point every mutating verb takes (plan invariant 4): render, edit,
// editMany, the component verbs, and the structural verbs. Three jobs, one place — serialize verbs,
// enforce cancellation, own the undo scaffold (the seal/commit/rollback shape lives on
// enterMutatingVerb, exactly once, never per verb):
//
//   • Serialize mutating verbs WITHIN a run — the WHOLE verb, preparation included. Agent code can
//     legally Promise.all two verbs, and every verb awaits internally (fonts, targets, images), so
//     an unserialized preparation would resolve its targets and load its resources against a
//     canvas an earlier queued verb is about to change. The chain slot is reserved synchronously
//     at call time, so verbs run in invocation order. Per-run state — the preamble is eval'd fresh
//     inside each run's wrapper; exclusion BETWEEN runs is the host's writeChain (code.ts
//     enqueueWrite).
//
//   • Enforce cancellation during execution: once the host records this run's CANCEL, no further
//     verb STARTS — checked as each verb's turn arrives AND again after its preparation (the
//     font/image awaits are the run's long suspension points; a cancel that lands during them
//     refuses before the entry seal), so a zombie run can never mutate a canvas the agent was
//     already told is unchanged. The full policy and its other refusal points live on the host's
//     registry (plugin/src/run-cancellation.ts).
//
// Verbs are non-reentrant BY DESIGN: a verb that awaits another public verb inside its body would
// deadlock on its own chain. No runtime guard is possible — QuickJS has no async context, so a
// nested call is indistinguishable from a legal concurrent one (Promise.all) — so the enforcement
// is the rule itself: a batch verb (editMany) takes the lock once and drives the commit-free
// internal appliers, never the public verbs (invariant 4).

import { beginAnnotationMutation, removeFailedAnnotationCategories } from "./annotation-categories.js";
import { hostRunCancelled } from "./host.js";

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

// Dev Mode's plugin API is read-only — every node create/delete/property write throws. Figma's own
// refusal names the setter ("in set_fills: …") and never the mode, so an agent that hits it has no
// way to learn the real cause: the human flipped the file to Dev Mode. The manifest declares "dev"
// so the bridge SURVIVES that flip (a session outliving a mode switch is the point), which makes
// this refusal reachable by design rather than an edge case.
//
// The mode is a live fact like any other, so it is read where every live fact is read: in the sync
// stretch before the seal, never cached. A flip during the resource loads is caught here, and a
// Dev Mode run leaves zero undo residue.
function refuseIfDevMode(verb: string): void {
  if (figma.editorType === "dev") {
    throw new Error(
      "flcm." + verb + ": Figma is in Dev Mode, where the plugin API is read-only — this write " +
        "cannot run. Switch the file back to Design mode to author. Reads are unaffected.",
    );
  }
}

function refuseIfCancelled(verb: string): void {
  if (hostRunCancelled()) {
    throw new Error(
      "flcm." + verb + ": this run was cancelled by the server (its deadline passed) — no further " +
        "mutating verbs start. The canvas holds what completed before the cancellation.",
    );
  }
}

/**
 * Run one mutating verb under the lock, in three phases that share the verb's single queue slot.
 * The rule that splits them is FRESHNESS: nothing decides anything about the document until there
 * is no await left between the decision and the write.
 *
 *   prepare — async, and DOCUMENT-BLIND in what it decides: shape-check the input, resolve every
 *   target the input names to a live node (read.ts createResolvedTargets — the one read that has
 *   to be async under dynamic-page), load fonts and image bytes, resolve the annotation categories
 *   the input names. It MAY read the document to learn what to load (which fonts a text edit's live
 *   font implies), and a planner run for that hint may refuse early — the same refusal the gate
 *   would make a moment later, against the document as it stood then. Nothing prepare concludes
 *   from a live property is what lands. A throw exits with ZERO undo calls. The one thing prepare
 *   can leave behind is a file-scoped annotation category, which Figma keeps out of the undo stack
 *   entirely; a failure removes those by hand (removeFailedAnnotationCategories), which is why the
 *   cleanup wraps all three phases.
 *
 *   gate — SYNCHRONOUS, run immediately before the entry seal: every legality decision that reads
 *   the document (a parent's layout mode, a text's live font and wrap, a component's definitions,
 *   an instance ancestor, a destination's child list) is made here, against the document as it
 *   stands at this instant, and the plans that apply will write are built here from the fresh
 *   answers. A throw exits like a prepare throw: zero undo calls, no stamp, nothing to roll back.
 *   No await can sit between a gate's read and apply's write, so a stale check is impossible by
 *   construction — which is why no verb re-checks anything. The one decision apply makes for itself
 *   is about what does not exist before the seal: a sublayer this span's own retarget produces
 *   (instance.ts applyOverridePlans). A refusal there is a rollback, the price of that fact.
 *
 *   apply — the mutating span, wrapped in the invariant-2/4 undo scaffold:
 *     entry seal → stamp → apply → success commit          (the verb is exactly one undo step)
 *     entry seal → stamp → apply throws → commit + trigger (seal the partial writes, pop that step)
 *
 * gate and apply are SYNCHRONOUS BY TYPE: neither can suspend, so nothing can interleave between a
 * gate's read, the seal, and apply's commit. Anything a verb wants to await belongs in prepare.
 *
 * The failure path's commit is LOAD-BEARING, not a bookkeeping nicety: figma.triggerUndo() reverts
 * the last COMMITTED step and swallows uncommitted trailing writes with it (hand-verified
 * 2026-08-07; scripts/probe-commit-undo.mjs is the standing runbook). Bare triggerUndo over the
 * failed verb's writes would eat the previous step too. The entry seal plus the stamp are what
 * bound the pop: whatever preceded the verb — earlier verbs, raw figma.* writes, a human's edit —
 * is already sealed into its own step, and the stamp guarantees THIS verb's step exists, so
 * rollback can only ever erase the failed verb's own writes. See stampUndoStep for why the seal
 * alone is not enough.
 *
 * A verb IS a single call to this function — its public entry does nothing before it (even pure
 * input checks live in prepare). The invocation-order guarantee is the slot reservation happening
 * before the caller ever yields; an await upstream of this call would let two verbs' prepares
 * interleave, which whole-verb serialization exists to prevent.
 */
// The type-level teeth behind "gate and apply are synchronous": a plain `(p: P) => T` would happily
// infer T = Promise<X> for an async callback — which returns at its FIRST await, letting the seal
// land on an unfinished gate or the success commit run mid-writes. Resolving to `never` makes that
// a compile error (pinned by a @ts-expect-error test).
type SyncOnly<T> = T extends PromiseLike<unknown> ? never : T;

// The seal alone does not bound the rollback. figma.commitUndo() with nothing written since the
// last commit mints NO step (live-verified 2026-09-09: seal → category creation, which is outside
// the undo stack → seal → triggerUndo popped the PREVIOUS execution's work). So a verb whose apply
// throws before its first canvas write would seal an empty step and the pop would reach the last
// committed verb's writes, or the human's. One guaranteed write right after the entry seal makes
// this verb's step exist no matter what apply does next. Plugin data on the document root is the
// write: undoable (live-verified), invisible on the canvas, page-independent, and it must CHANGE
// value — a same-value write is not a mutation — so it toggles. It stays after a success as part
// of the step: clearing it would make a no-op verb a net-zero step whose coalescing behaviour is
// unproven, and the value itself means nothing.
const UNDO_STEP_STAMP_KEY = "flcm/undo-step";
function stampUndoStep(): void {
  const previous = figma.root.getPluginData(UNDO_STEP_STAMP_KEY);
  figma.root.setPluginData(UNDO_STEP_STAMP_KEY, previous === "1" ? "0" : "1");
}

export function enterMutatingVerb<P, G, T>(
  verb: string,
  prepare: () => Promise<P>,
  gate: (prepared: P) => SyncOnly<G>,
  apply: (gated: G) => SyncOnly<T>,
): Promise<T> {
  const turn = verbChain.then(async () => {
    refuseIfCancelled(verb);
    // The verb's annotation-category slate, opened here rather than by prepare because its other
    // half is the failure path below: what a prepare created must be removable from a catch that
    // never sees the prepared value (annotation-categories.ts).
    beginAnnotationMutation();
    try {
      const prepared = await prepare();
      // Prepare's awaits are the run's suspension points — a CANCEL that arrived during them must
      // fail closed here, before the seal, not mutate on a dead run's behalf; a Dev Mode flip
      // during them is the same kind of fact, read at the same place.
      refuseIfCancelled(verb);
      refuseIfDevMode(verb);
      const gated = gate(prepared);
      figma.commitUndo();
      // Outside the rollback-protected block on purpose: a stamp that fails to write has put
      // nothing of this verb's on the canvas, and a triggerUndo here would be exactly the
      // overreach into the previous step the stamp exists to prevent.
      stampUndoStep();
      try {
        const result = apply(gated);
        figma.commitUndo();
        committedVerbs++;
        return result;
      } catch (err) {
        figma.commitUndo();
        figma.triggerUndo();
        throw err;
      }
    } catch (err) {
      // Wraps every phase: a category is created during the resource loads, so a gate that refuses
      // after them (or a write that fails inside the seal) both leave one to remove.
      throw removeFailedAnnotationCategories(err);
    }
  });
  // A failed verb must not poison the chain — the failure belongs to its caller (via `turn`);
  // later verbs proceed against the rolled-back (or, on a prepare/gate reject, untouched) canvas.
  // (Same swallow as the host's writeChain, code.ts enqueueWrite.)
  verbChain = turn.catch(() => {});
  return turn;
}
