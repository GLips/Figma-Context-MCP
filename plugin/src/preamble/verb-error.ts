// verb-error — the invariant-2 POINTER ERROR, one shape for every mutating verb. When a write
// fails after validation passed, the agent is blind: it can't see the canvas, and re-downloading
// the design to work out where it is costs more than the edit did. So the error is a pointer, not
// a puzzle — it names the verb, how much of the run still stands, the target's identity in the
// same fields a `find` hit carries (so the agent re-targets without re-reading), and Figma's own
// reason. Deliberately NO applied/not-applied ledger: the verb rolled back, so the canvas plus
// this message is the whole story.
//
// Lives in its own module because both edit.ts and structure.ts throw it and neither should
// import the other; the message shape is the contract, so one home is what keeps them identical.

import { Identity } from "./ir.js";
import { identityOf, instanceAncestorOf } from "./identity.js";
import { committedVerbCount } from "./mutation-lock.js";

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
export function beginMutatingApply(verb: string, node: SceneNode): (cause: unknown) => Error {
  const identity = identityOf(node);
  return (cause) => mutatingVerbError(verb, identity, cause, node);
}

// A Figma refusal names its own setter ("in set_fills: …"); an flcm-prefixed cause is our own
// throw, so don't pin it on Figma.
function mutatingVerbError(verb: string, identity: Identity, cause: unknown, node: SceneNode): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  const who =
    identity.type + " " + JSON.stringify(identity.name) + " (id " + JSON.stringify(identity.id) +
    (identity.key ? ", key " + JSON.stringify(identity.key) : "") + ")";
  const isFigmaRefusal = !message.startsWith("flcm");
  const refusal = isFigmaRefusal ? "Figma refused a write on " : "failed mid-apply on ";
  const instanceHost = isFigmaRefusal ? instanceAncestorOf(node) : null;
  const instanceNote = instanceHost
    ? " The target lives inside instance " + JSON.stringify(instanceHost.name) + " (id " + JSON.stringify(instanceHost.id) +
      ") — Figma restricts what can be changed on an instance's children; edit the component it comes from (flcm never auto-detaches)."
    : "";
  return new Error(
    "flcm." + verb + ": " + refusal + who + " — " + message + ". " +
      "This call rolled back to its entry seal (the canvas holds none of it); the " + committedVerbCount() +
      " mutating call(s) before it in this run committed and stand." + instanceNote,
  );
}
