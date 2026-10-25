/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// verb-error — the invariant-2 POINTER ERROR, one shape for every mutating verb. When a write
// fails after validation passed, the agent is blind: it can't see the canvas, and re-downloading
// the design to work out where it is costs more than the edit did. So the error is a pointer, not
// a puzzle — it names the verb, how much of the run still stands, the target's identity in the
// same fields a `find` hit carries (so the agent re-targets without re-reading), and Figma's own
// reason. Deliberately NO applied/not-applied ledger: the verb rolled back, so the canvas plus
// this message is the whole story.
//
// Lives in its own module because both edit-plan.ts and structure.ts throw it and neither should
// import the other; the message shape is the contract, so one home is what keeps them identical.

import type { BuiltNode, Identity } from "./ir.js";
import { identityOf, instanceContextOf } from "./identity.js";
import { FlcmError, describeFailureWithinCall, failureKindOf, isFigmaRefusal, locateFailure, type FlcmErrorKind, type FlcmErrorSite } from "./flcm-error.js";

// Mutating verbs that ran to their success commit this run (the lock records each). The pointer
// error tells the agent "the N mutating calls before this one committed and stand" instead of making
// it re-read the canvas to find out where it is. Per-run state: the preamble is evaluated per run.
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
 * Open a mutating verb's sealed apply span and get back the failure builder for it. Call this as
 * the FIRST line of the apply, before any write: the identity is snapshotted here, which is the
 * whole point of the two-step shape. A verb that renamed a node and then hit a refusal would
 * otherwise report the NEW name — the one the rollback is about to erase — and the agent would go
 * looking for a node that never existed. Making the snapshot the cost of obtaining `fail` is what
 * keeps that ordering from being prose every verb has to remember.
 *
 *   const fail = beginMutatingApply("edit", node);
 *   try { …writes… } catch (cause) { throw fail(cause); }
 */
export function beginMutatingApply(verb: string, node: SceneNode): (cause: unknown) => FlcmError {
  const identity = identityOf(node);
  // Only a locked layer earns the edit-the-component note; slot content is the instance's own.
  const ancestor = instanceContextOf(node).ownWritesLockedBy?.node;
  const instance = ancestor ? { id: ancestor.id, name: ancestor.name } : null;
  return (cause) => mutatingVerbError(verb, identity, cause, instance);
}

// Tagged so a verb error raised inside another verb's apply (slot content placed during a build)
// surfaces as-is instead of being re-wrapped under the enclosing node.
export class MutatingVerbError extends FlcmError {}

/**
 * A refusal decided before its node is written, whether in a verb's gate or partway through its
 * apply. Its site already names where it happened, so it skips the mid-apply wrapper; the tail is
 * true either way, since the seal rolls back anything earlier in the same call.
 */
export function refusedBeforeWrite(kind: FlcmErrorKind, reason: string, site: FlcmErrorSite): MutatingVerbError {
  return new MutatingVerbError(
    kind,
    reason + " Nothing in this call was applied; the " + committedVerbCount() + " mutating call(s) before it in this run committed and stand.",
    site,
  );
}

// Failures the build walk located on the node it was building. A built node has no identity worth
// naming — the rollback erases its id — so the pointer names it by spec path instead.
const builtNodeFailures = new WeakSet<FlcmError>();

/** Place a build-walk failure on the node being built, innermost first. */
export function locateBuiltNodeFailure(cause: unknown, wn: BuiltNode): FlcmError {
  const error = locateFailure(cause, { path: wn.sourcePath, node: { type: wn.type, name: wn.name } });
  builtNodeFailures.add(error);
  return error;
}

// Only Figma's own throw (by type) reads "Figma refused" and earns the edit-the-component note: a
// Figma limit flcm detected is figma-kind too, but flcm knows what it is and says so itself.
function mutatingVerbError(verb: string, identity: Identity, cause: unknown, instance: { id: string; name: string } | null): FlcmError {
  if (cause instanceof MutatingVerbError) return cause;
  const kind = failureKindOf(cause);
  // A live node placed inside a verb is named by its spec path, which already carries the prefix.
  const call = verb.startsWith("flcm.") ? verb : "flcm." + verb;
  const built = cause instanceof FlcmError && builtNodeFailures.has(cause) ? cause : null;
  // A built node's path is said in `who`, so only its call (when it isn't this one) leads the reason.
  const message = built ? (built.call === undefined || built.call === call ? "" : built.call + ": ") + built.reason : describeFailureWithinCall(cause, call);
  const subject =
    identity.type + " " + JSON.stringify(identity.name) + " (id " + JSON.stringify(identity.id) +
    (identity.key ? ", key " + JSON.stringify(identity.key) : "") + ")";
  const builtNode = built?.node ? built.node.type + (built.node.name === undefined ? "" : " " + JSON.stringify(built.node.name)) + " " : "";
  const who = built ? builtNode + "at " + built.path + ", being built into " + subject : subject;
  const refusedByFigma = isFigmaRefusal(cause);
  const refusal = refusedByFigma ? "Figma refused a write on " : "failed mid-apply on ";
  const instanceHost = refusedByFigma ? instance : null;
  const instanceNote = instanceHost
    ? " The target lives inside instance " + JSON.stringify(instanceHost.name) + " (id " + JSON.stringify(instanceHost.id) +
      ") — Figma restricts what can be changed on an instance's children; edit the component it comes from (flcm never auto-detaches)."
    : "";
  return new MutatingVerbError(
    kind,
    refusal + who + " — " + message + ". " +
      "This call rolled back to its entry seal (the canvas holds none of it); the " + committedVerbCount() +
      " mutating call(s) before it in this run committed and stand." + instanceNote,
    // No path: the reason already places a built node, and the message leads with the call alone.
    { call, node: built?.node ?? { type: identity.type, name: identity.name, id: identity.id } },
  );
}
