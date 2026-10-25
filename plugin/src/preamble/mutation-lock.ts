/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { warnings } from "./warnings.js";
import { registerResult } from "./egress.js";
import { sceneFigma as figma, invalidateSceneAccess } from "./scene-access.js";
import { beginSizingDiagnostics, concedeSizeBoundClamps, finishSizingDiagnostics, retargetSizingDiagnostics } from "./sizing-diagnostics.js";
import { beginMovedOutDiagnostics, finishMovedOutDiagnostics, retargetMovedOutDiagnostics } from "./moved-out-diagnostics.js";
// mutation-lock — the single entry point every mutating verb takes (plan invariant 4): render, edit,
// editMany, the component verbs, and the structural verbs. Three jobs, one place — serialize verbs,
// enforce cancellation, own the undo scaffold (the seal/finalize/commit/rollback shape lives on
// enterMutatingVerb, exactly once, never per verb):
//
//   • Serialize mutating verbs WITHIN a run — the WHOLE verb, preparation included. Agent code can
//     legally Promise.all two verbs, and every verb awaits internally (fonts, targets, images), so
//     an unserialized preparation would resolve its targets and load its resources against a
//     canvas an earlier queued verb is about to change. The chain slot is reserved synchronously
//     at call time, so verbs run in invocation order. Per-run state — the preamble is eval'd fresh
//     inside each run's wrapper; exclusion BETWEEN runs is the host's writeChain (run-executor.ts
//     enqueueWrite). The queue can outlive the agent's code, so it also says when it is empty —
//     mutationQueueIdle, which the host drains before it replies.
//
//   • Enforce cancellation during execution: once the host records this run's CANCEL — or the
//     run's own clock says the server's deadline passed (server-deadline.ts) — no further verb
//     STARTS. Checked as each verb's turn arrives AND again after its preparation (the font/image
//     awaits are the run's long suspension points; a cancel that lands during them refuses before
//     the entry seal), so a zombie run can never mutate a canvas the agent was
//     already told is unchanged. The full policy and its other refusal points live on the host's
//     registry (plugin/src/run-cancellation.ts).
//
// Verbs are non-reentrant BY DESIGN: a verb that awaits another public verb inside its body would
// deadlock on its own chain. No runtime guard is possible — QuickJS has no async context, so a
// nested call is indistinguishable from a legal concurrent one (Promise.all) — so the enforcement
// is the rule itself: a batch verb (editMany) takes the lock once and drives the commit-free
// internal appliers, never the public verbs (invariant 4).

import { beginAnnotationMutation, removeFailedAnnotationCategories } from "./annotation-categories.js";
import { CANCELLED_BECAUSE, hostDeadlinePassed, hostRunCancellation, refuseIfRunFinished, traceVerb } from "./host.js";
import { RUN_INACTIVITY_DEADLINE_MS } from "../protocol.js";
import { openApplySpan, retargetSpanNode, type ApplySpan } from "./apply-span.js";
import { settleApplySpan } from "./bridge.js";
import { recordCommittedVerb } from "./verb-error.js";
import { beginObligationLedger, retargetObligationNode } from "./obligation.js";
import { finalizeMutatingCall, type VerifiedStyleLinks } from "./call-finalizer.js";

let verbChain: Promise<unknown> = Promise.resolve();

// Verbs whose turn has ended, success or failure. Only ever read as a delta across a drain, which
// is what answers "how much landed after the agent stopped awaiting" (mutationQueueIdle).
let settledVerbs = 0;

/**
 * Resolves once every verb reserved so far has settled, answering how many settled during the wait.
 * The host awaits this before it replies: a slot is reserved SYNCHRONOUSLY at call time, so a
 * rejected `Promise.all` — or a verb the agent never awaited — leaves writes queued behind code
 * that has already returned. Replying over them would report a canvas that is still moving.
 *
 * Re-reads the chain until it stops growing, since a draining verb can queue the next one. Never
 * rejects: a verb's failure belongs to the caller that invoked it, not to the drain.
 */
export async function mutationQueueIdle(): Promise<number> {
  const before = settledVerbs;
  let drained: Promise<unknown> | undefined;
  while (drained !== verbChain) {
    drained = verbChain;
    await drained;
  }
  return settledVerbs - before;
}

const compensatedFailures = new WeakSet<Error>();
/** An applier may mark a failure only after restoring every write in its own span. */
export function compensatedMutationFailure(cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  compensatedFailures.add(error);
  return error;
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
  const cause = hostRunCancellation();
  if (cause) {
    throw new Error(
      "flcm." + verb + ": " + CANCELLED_BECAUSE[cause] + " — no further mutating verbs start. The " +
        "canvas holds what completed before the cancellation.",
    );
  }
  // Worded apart from the CANCEL: with the thread held, the run can't know whether the server has
  // given up yet (a run that waited in the queue may have reported "running" late, starting the
  // server's clock late). Refusing anyway keeps one rule: a run that holds the plugin past the
  // deadline writes nothing more.
  if (hostDeadlinePassed()) {
    throw new Error(
      "flcm." + verb + ": this run held the plugin for " + RUN_INACTIVITY_DEADLINE_MS / 1000 +
        "s without reaching the server, past the server's inactivity deadline — no further mutating verbs start. The canvas holds what " +
        "completed before this point. Split long synchronous work across calls.",
    );
  }
}

/**
 * Run one mutating verb under the lock, in four phases that share the verb's single queue slot.
 * The rule that splits them is FRESHNESS: nothing decides anything about the document until there
 * is no await left between the decision and the write.
 *
 *   prepare — async, and DOCUMENT-BLIND in what it decides: shape-check the input, resolve every
 *   target the input names to a live node (target.ts createResolvedTargets — the one read that has
 *   to be async under dynamic-page), load fonts and image bytes, resolve the annotation categories
 *   the input names. It MAY read the document to learn what to load (which fonts a text edit's live
 *   font implies), and a planner run for that hint may refuse early — the same refusal the gate
 *   would make a moment later, against the document as it stood then. Nothing prepare concludes
 *   from a live property is what lands. A throw exits with ZERO undo calls. The one thing prepare
 *   can leave behind is a file-scoped annotation category, which Figma keeps out of the undo stack
 *   entirely; a failure removes those by hand (removeFailedAnnotationCategories), which is why the
 *   cleanup wraps every phase.
 *
 *   gate — SYNCHRONOUS, run immediately before the entry seal: it decides admission (a parent's
 *   layout mode, a text's live font and wrap, a component's definitions, an instance ancestor, a
 *   destination's child list) against the document as it stands at this instant, builds the plans
 *   apply will write, and records the call's obligations (obligation.ts) into the ledger the lock
 *   opens just before it. A throw exits like a prepare throw: zero undo calls, no stamp.
 *
 *   apply — the mutating span, wrapped in the invariant-2/4 undo scaffold. It receives the verb's
 *   ApplySpan (apply-span.ts) and writes the plans. Each field is decided at its write point
 *   (write-point.ts): a word the node already holds there is skipped, and the rest is re-authorized
 *   against the node as it stands then. It returns a BUILDER for the verb's result, not the result:
 *   a handle measures geometry, and the geometry is final only after the style links.
 *
 *   finalize — after apply and the span's settle, BEFORE the style links: observe every obligation
 *   (a queued link counts as linked) and fail the call if any authored word didn't land as asked
 *   (call-finalizer.ts). So every failure flcm can know of rolls back with no await behind it.
 *
 *     entry seal → stamp → apply → settle span → finalize → style links → build → success commit   (one undo step)
 *     entry seal → stamp → any of those throws → commit + trigger (seal the partial writes, pop that step)
 *
 * gate and apply are SYNCHRONOUS BY TYPE, and so is the builder: none can suspend, so nothing can
 * interleave between a gate's read, the seal, and apply's writes. Anything a verb wants to await
 * belongs in prepare.
 *
 * The ONE await inside the sealed span is linkVerifiedStyles: linking a style is async-only under
 * dynamic-page (the sync setters throw). It writes only links apply decided, onto nodes already
 * holding the style's values. While it suspends, a human edit or un-awaited agent figma.* writes
 * can land inside this verb's undo step — the price of the link — and once one has, Figma's undo
 * reverts none of the step (live-verified 2026-10-24). Hence the finalizer runs before it: only a
 * link that throws can fail the verb after the await, and that rollback is checked by the stamp
 * (UnrolledVerbError). An edit made during the await that changes an authored word wins; the
 * result, built after it, shows it.
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

/** What apply hands back: builds the verb's result once the finalizer has verified the call. */
export type VerbResultBuilder<T> = () => SyncOnly<T>;

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
// Where this verb's warnings start in the registry; set by enterMutatingVerb before apply runs.
let verbWarningCheckpoint = 0;

/**
 * Hand everything this verb queued against `from` to `to`, for an apply that replaced `from`
 * (createComponentFromNode). Live, every read of the replaced node but `id` and `removed` throws
 * "does not exist", so each per-verb accumulator that holds a node must follow the replacement
 * here, before the lock reads it after apply. A new accumulator holding nodes belongs in this list.
 */
export function retargetReplacedNode(span: ApplySpan, from: any, to: any): void {
  retargetSpanNode(span, from, to);
  retargetSizingDiagnostics(from, to);
  retargetMovedOutDiagnostics(from, to);
  retargetObligationNode(from, to);
  warnings.retargetNode(from.id, to.id, verbWarningCheckpoint);
}

async function linkVerifiedStyles(links: VerifiedStyleLinks): Promise<void> {
  for (const { node, slot, styleId } of links) {
    if (slot === "fill") await node.setFillStyleIdAsync(styleId);
    else if (slot === "stroke") await node.setStrokeStyleIdAsync(styleId);
    else if (slot === "effect") await node.setEffectStyleIdAsync(styleId);
    else await node.setTextStyleIdAsync(styleId);
  }
}

const UNDO_STEP_STAMP_KEY = "flcm/undo-step";
function stampUndoStep(): string {
  const stamp = figma.root.getPluginData(UNDO_STEP_STAMP_KEY) === "1" ? "0" : "1";
  figma.root.setPluginData(UNDO_STEP_STAMP_KEY, stamp);
  return stamp;
}

/**
 * A failed verb whose rollback didn't take: an edit made in Figma while the verb awaited its style
 * links joined its undo step, and Figma then undid none of it. Its writes are still on the canvas.
 */
export class UnrolledVerbError extends Error {
  constructor(verb: string, cause: unknown) {
    super(
      "flcm." + verb + " failed after it wrote, and rolling it back didn't work: an edit made in Figma while it linked styles " +
        "joined its undo step, so its writes are still on the canvas. Undo in Figma reverts them together with that edit. " +
        "The failure: " + (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

export function enterMutatingVerb<P, G, T>(
  verb: string,
  prepare: () => Promise<P>,
  gate: (prepared: P) => SyncOnly<G>,
  apply: (gated: G, span: ApplySpan) => SyncOnly<VerbResultBuilder<T>>,
): Promise<T> {
  const turn = verbChain.then(async () => {
    refuseIfRunFinished("flcm." + verb);
    refuseIfCancelled(verb);
    traceVerb("verb-start", verb);
    // The verb's annotation-category slate, opened here rather than by prepare because its other
    // half is the failure path below: what a prepare created must be removable from a catch that
    // never sees the prepared value (annotation-categories.ts).
    beginAnnotationMutation();
    try {
      const prepared = await prepare();
      traceVerb("verb-prepared", verb);
      // Prepare's awaits are the run's suspension points — a CANCEL that arrived during them must
      // fail closed here, before the seal, not mutate on a dead run's behalf; a Dev Mode flip
      // during them is the same kind of fact, read at the same place.
      refuseIfRunFinished("flcm." + verb);
      refuseIfCancelled(verb);
      refuseIfDevMode(verb);
      invalidateSceneAccess();
      beginObligationLedger();
      const gated = gate(prepared);
      figma.commitUndo();
      // Outside the rollback-protected block on purpose: a stamp that fails to write has put
      // nothing of this verb's on the canvas, and a triggerUndo here would be exactly the
      // overreach into the previous step the stamp exists to prevent.
      const stamp = stampUndoStep();
      const warningCheckpoint = warnings.records.length;
      verbWarningCheckpoint = warningCheckpoint;
      try {
        beginSizingDiagnostics();
        beginMovedOutDiagnostics();
        // One span per verb, so a failed verb's queue can never land on the next verb's behalf.
        const span = openApplySpan();
        const build = apply(gated, span);
        // The backstop: whatever geometry the verb didn't settle itself, before any style links.
        settleApplySpan(span);
        traceVerb("verb-applied", verb);
        // Before the await on purpose: a failure here rolls back over writes nothing else has touched.
        concedeSizeBoundClamps();
        const verified = finalizeMutatingCall(verb, span.styleLinks);
        await linkVerifiedStyles(verified);
        const result = build();
        figma.commitUndo();
        recordCommittedVerb();
        finishSizingDiagnostics(verb);
        finishMovedOutDiagnostics(verb);
        registerResult(result);
        traceVerb("verb-end", verb);
        return result;
      } catch (err) {
        warnings.discardFrom(warningCheckpoint);
        figma.commitUndo();
        // Explicit clone compensation already restored its writes; undo would reverse that cleanup.
        if (err instanceof Error && compensatedFailures.has(err)) throw err;
        figma.triggerUndo();
        // The stamp is this step's first write, so it reverts only if the whole step did.
        if (figma.root.getPluginData(UNDO_STEP_STAMP_KEY) === stamp) throw new UnrolledVerbError(verb, err);
        throw err;
      }
    } catch (err) {
      // Wraps every phase: a category is created during the resource loads, so a gate that refuses
      // after them (or a write that fails inside the seal) both leave one to remove.
      traceVerb("verb-error", verb);
      throw removeFailedAnnotationCategories(err);
    }
  });
  // A failed verb must not poison the chain — the failure belongs to its caller (via `turn`);
  // later verbs proceed against the rolled-back (or, on a prepare/gate reject, untouched) canvas.
  // (Same swallow as the host's writeChain, run-executor.ts enqueueWrite.)
  const settle = (): void => { settledVerbs++; };
  verbChain = turn.then(settle, settle);
  return turn;
}
