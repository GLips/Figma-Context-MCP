/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// verb-error — what a mutating verb's failure says about where it happened. When a write fails
// after validation passed, the agent is blind: it can't see the canvas, and re-downloading the
// design to work out where it is costs more than the edit did. So the failure names the layer in
// the same fields a `find` hit carries (so the agent re-targets without re-reading) and, when Figma
// refused, Figma's own reason. What of the run still stands is the lock's to say (sayWhatWasKept).
//
// Lives in its own module because both edit-plan.ts and structure.ts throw through it and neither
// should import the other.

import type { BuiltNode } from "./ir.js";
import { instanceContextOf } from "./identity.js";
import { FlcmError, describeFigmaRefusal, isFigmaRefusal, locateFailure, type FlcmLocation } from "./flcm-error.js";

// Mutating verbs that ran to their success commit this run (the lock records each). Per-run state:
// the preamble is evaluated per run.
let committedVerbs = 0;

export function recordCommittedVerb(): void {
  committedVerbs++;
}

// How many mutating verbs committed so far this run. Read inside a verb's catch, it is the count
// before the failing one (which hasn't and won't increment); read by the host after the drain, it is
// the run's total, one of the host's two signals that the document changed (run-executor.ts executeCode).
export function committedVerbCount(): number {
  return committedVerbs;
}

/**
 * Open a mutating verb's write to `node` and get back the failure builder for it. Call this as the
 * FIRST line of the write, before any change: the identity is snapshotted here, which is the whole
 * point of the two-step shape. A verb that renamed a node and then hit a refusal would otherwise
 * report the NEW name — the one the rollback is about to erase — and the agent would go looking for
 * a node that never existed.
 *
 *   const fail = beginMutatingApply(node);   // or (node, { path }) for a live node placed in a spec
 *   try { …writes… } catch (cause) { throw fail(cause); }
 */
export function beginMutatingApply(node: SceneNode, at: FlcmLocation = {}): (cause: unknown) => FlcmError {
  const site = { ...at, node: { type: node.type, name: node.name, id: node.id } };
  // Only a locked layer earns the edit-the-component note; slot content is the instance's own.
  const ancestor = instanceContextOf(node).ownWritesLockedBy?.node;
  const instanceNote = ancestor
    ? " The layer is inside instance " + JSON.stringify(ancestor.name) + " (id " + JSON.stringify(ancestor.id) +
      "), and Figma restricts what can change on an instance's layers: edit the component it comes from instead, or detach the instance with flcm.detach."
    : "";
  return (cause) => {
    // A failure flcm raised says what went wrong itself; it only learns where. The innermost site
    // wins, so a node built inside this one keeps its own name and spec path.
    if (!isFigmaRefusal(cause)) return locateFailure(cause, site);
    return new FlcmError("figma", describeFigmaRefusal(cause, "a change to this layer") + instanceNote + " " + REFUSAL_NEXT_STEP, site);
  };
}

const REFUSAL_NEXT_STEP = "Change or drop the property Figma names, then re-run the call. If Figma named none, set the values in a separate call to find the one it refuses.";

/** Place a build-walk failure on the node being built, innermost first. A built node has no id worth naming — the rollback erases it — so it is named by its spec path. */
export function locateBuiltNodeFailure(cause: unknown, wn: BuiltNode): FlcmError {
  if (!isFigmaRefusal(cause)) return locateFailure(cause, { path: wn.sourcePath, node: { type: wn.type, name: wn.name } });
  return new FlcmError("figma", describeFigmaRefusal(cause, "a change to this layer") + " " + REFUSAL_NEXT_STEP, { path: wn.sourcePath, node: { type: wn.type, name: wn.name } });
}
