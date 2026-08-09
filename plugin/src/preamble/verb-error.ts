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
import { committedVerbCount } from "./mutation-lock.js";

// The nearest INSTANCE ancestor, or null. Figma restricts what may change on an instance's
// children — some props can't be overridden, and the tree shape can't change at all — and the fix
// is always "edit the component it comes from", so both the structural gates and this error walk
// the same chain. Stops at the page: an instance is always inside one.
export function instanceAncestorOf(node: SceneNode): SceneNode | null {
  for (let p = (node as { parent?: BaseNode | null }).parent; p && p.type !== "PAGE"; p = p.parent) {
    if (p.type === "INSTANCE") return p as SceneNode;
  }
  return null;
}

// Build the pointer error for a post-validation failure inside `verb`'s sealed apply span. A Figma
// refusal names its own setter ("in set_fills: …"); an flcm-prefixed cause is our own throw, so
// don't pin it on Figma. `identity` is snapshotted BEFORE the first write on purpose — a delta
// that renames and then hits a refusal would otherwise point at the NEW name, which the rollback
// is about to remove.
export function mutatingVerbError(verb: string, identity: Identity, cause: unknown, node: SceneNode): Error {
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
