// edit — the mutate verb: apply a partial delta to an existing live node (sibling to read.ts, the
// way render's live work lives in bridge.ts). ORCHESTRATION ONLY: validate → resolve → gate → apply
// → mint the updated Handle. The delta compiles through the same leaf parsers create uses
// (flcm.compileNodeLocalProps → css.ts) — never the constructors, whose job is to inject creation
// defaults (flcm.frame({ fill }) emits layout.mode "none"; riding it would turn a recolor into an
// auto-layout kill) — and every write lands through the bridge's exported appliers, never a second
// application path. The undo scaffold (entry seal / success commit / commit-then-undo rollback) is
// the lock's, not ours: see enterMutatingVerb in mutation-lock.ts.
//
// NOT exactly-once: the lock is run-scoped, and the server can re-send a run whose reply was lost
// after a first PENDING_APPROVAL — a resend is a new run that re-applies the delta. The delta
// vocabulary is ABSOLUTE values (a fill, an opacity — never "+10"), so a duplicate apply converges
// to the same canvas; the residue is a duplicate undo step, not divergent state. Keep it that way:
// a relative delta word would turn that accepted race into canvas corruption.

import { WriteProps, WriteType, Target, Handle } from "./ir.js";
import { resolveTarget } from "./read.js";
import { enterMutatingVerb, committedVerbCount } from "./mutation-lock.js";
import { applyPaint, applySceneProps, mintHandle } from "./bridge.js";
import { toFigmaEffects } from "./effects.js";
import { identityOf } from "./identity.js";
import { rejectUnknownKeys } from "./validate.js";
import { KNOWN_KEYS, compileNodeLocalProps, fetchTreeImages } from "./flcm.js";
import type { EditDelta } from "./schema.js";

const EDIT_KEYS: ReadonlySet<string> = new Set(KNOWN_KEYS.edit);

// A create-verb's word groups, intersected with the current edit surface. The intersection is what
// makes later slices additive: when a word group's members join KNOWN_KEYS.edit (size/layout in 2.4,
// text in 2.5), each type's gate widens to create's exact shape with no edits here.
function editableWords(...groups: readonly (readonly string[])[]): ReadonlySet<string> {
  return new Set(groups.flat().filter((k) => EDIT_KEYS.has(k)));
}

// What each node type's delta may name — the SAME group compositions as flcm.ts's per-verb key sets
// (FRAME_KEYS/TEXT_KEYS/…), so edit accepts on a node exactly the words create accepts for its type
// (invariant 1: one vocabulary, no permissive edit dialect — `fill` on a LINE rejects here the way
// flcm.line rejects it, instead of landing on a property Figma never renders). Keyed by WriteType so
// TS pins this to the same createable set as bridge's BUILDERS table — neither can drift alone.
// VECTOR uses flcm.path's words: an svg-born vector shares the type, but path's words are the only
// authored vocabulary the type has.
const DELTA_KEYS_BY_TYPE: Record<WriteType, ReadonlySet<string>> = {
  FRAME: editableWords(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.appearance, KNOWN_KEYS.frame),
  TEXT: editableWords(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.text),
  RECTANGLE: editableWords(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.appearance),
  ELLIPSE: editableWords(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.appearance),
  LINE: editableWords(KNOWN_KEYS.shared, KNOWN_KEYS.line),
  VECTOR: editableWords(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.path),
};

// A node type flcm can't create (GROUP, INSTANCE, COMPONENT, …) takes the shared words (minus `key`,
// which isn't editable anywhere). Deliberately a conservative floor, not a mixin-derived ceiling:
// effects/rotation on a GROUP would land but wait for a deliberate widening.
const SHARED_DELTA_KEYS = editableWords(KNOWN_KEYS.shared);
// A SLICE is the one SceneNode with no MinimalBlendMixin — opacity/mixBlendMode don't exist on it,
// so accepting them would commit an undo step that changed nothing (the silent no-op the surface
// rejects everywhere else). The appliers' `in node` guards are belt for the same fact.
const SLICE_DELTA_KEYS = editableWords(["name", "visible", "locked"]);

// The pure, document-blind half of validation (invariant 2's validate-then-mutate: this runs before
// the target is even resolved, so a misspelled word reads "unknown prop" no matter what it targets).
// `key` and bare `x`/`y` get steering messages ahead of the generic closed-set reject — they're the
// two mistakes an agent is most likely to make, and "unknown prop" would misdiagnose both.
function rejectNonDeltaWords(changes: EditDelta): void {
  if (changes == null || typeof changes !== "object") {
    throw new Error("flcm.edit: changes must be an object of props to apply — got " + JSON.stringify(changes) + ".");
  }
  if ("key" in changes) {
    throw new Error(
      "flcm.edit: `key` is not editable — keys are set at creation and are how later calls address this node; re-keying could mint a duplicate address. Set `key` in the render that creates a node.",
    );
  }
  if ("x" in changes || "y" in changes) {
    throw new Error(
      "flcm.edit: position and layout words are not on edit yet (they land in a later slice) — this delta takes appearance and scene words only. When position lands it will be spelled `absolute: { x, y }` / `pin`, the create-side words, not bare x/y.",
    );
  }
  rejectUnknownKeys(changes, EDIT_KEYS, "flcm.edit");
  if (Object.keys(changes).length === 0) {
    throw new Error(
      "flcm.edit: the changes object is empty — nothing to apply (an empty edit would still mint an undo step). Editable words: " +
        [...EDIT_KEYS].join(", ") + ".",
    );
  }
}

// The per-type legality gate (runs after resolve, before the lock, so an illegal word rejects with
// zero writes). Returns the type's word set so the compile step can flag radius/clip from it.
function assertDeltaLegalForType(node: SceneNode, changes: EditDelta): ReadonlySet<string> {
  const legal =
    (DELTA_KEYS_BY_TYPE as Record<string, ReadonlySet<string>>)[node.type] ||
    (node.type === "SLICE" ? SLICE_DELTA_KEYS : SHARED_DELTA_KEYS);
  for (const prop of Object.keys(changes)) {
    if (!legal.has(prop)) {
      throw new Error(
        "flcm.edit: `" + prop + "` is not a " + node.type + " word — a " + node.type + " edit takes only " +
          [...legal].join(", ") + ".",
      );
    }
  }
  return legal;
}

// Compile the delta to a typed patch through create's own parsers, then pre-flight the one compiled
// form those parsers don't fully close: a raw EffectSpec[] passes normalizeEffects untouched, and an
// unknown kind would otherwise surface mid-apply as a fake "Figma refused". toFigmaEffects is pure
// (figma-free), so running it here keeps every vocabulary failure ahead of the first canvas write.
function compileDeltaPatch(changes: EditDelta, legal: ReadonlySet<string>): WriteProps {
  const patch: WriteProps = {};
  compileNodeLocalProps(patch, changes, { radius: legal.has("borderRadius"), clip: legal.has("clip") });
  if (patch.effects) toFigmaEffects(patch.effects);
  // Every named word compiled to nothing (all values null/undefined) — same hazard as `{}`: the
  // verb would mint an undo step for zero writes.
  if (Object.keys(patch).length === 0) {
    throw new Error("flcm.edit: the delta compiled to nothing — every value was null/undefined. Pass a real value, or omit the prop.");
  }
  return patch;
}

// The invariant-2 pointer error: the verb, how much of the run stands, the target's identity (the
// same fields a find hit carries, so the agent re-targets without re-reading), and the cause. A
// Figma refusal names its own setter ("in set_fills: …"); an flcm-prefixed cause is our own throw,
// so don't pin it on Figma.
function editPointerError(identity: ReturnType<typeof identityOf>, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  const who =
    identity.type + " " + JSON.stringify(identity.name) + " (id " + JSON.stringify(identity.id) +
    (identity.key ? ", key " + JSON.stringify(identity.key) : "") + ")";
  const refusal = message.startsWith("flcm") ? "failed mid-apply on " : "Figma refused a write on ";
  return new Error(
    "flcm.edit: " + refusal + who + " — " + message + ". " +
      "This edit rolled back to its entry seal (the canvas holds none of it); the " + committedVerbCount() +
      " mutating call(s) before it in this run committed and stand.",
  );
}

/**
 * flcm.edit(target, changes) — nudge an existing node. Resolves the target (key | id | flcm.id() |
 * handle), validates the whole delta before the first write, applies it through the bridge's
 * appliers under the mutation lock (one undo step; a Figma refusal rolls back commit-then-undo),
 * and returns the node's updated Handle with fresh geometry.
 */
export async function edit(target: Target, changes: EditDelta): Promise<Handle> {
  rejectNonDeltaWords(changes);
  const node = await resolveTarget(target);
  const legal = assertDeltaLegalForType(node, changes);
  const patch = compileDeltaPatch(changes, legal);
  // An image fill in the delta needs bytes before the mutating span — the fetch is read-only and
  // stays outside the lock, like render's.
  const images = await fetchTreeImages(patch);
  return enterMutatingVerb("edit", async () => {
    // Snapshot identity before the first write: a delta that renames and then hits a refusal would
    // otherwise point at the NEW name — which the rollback is about to remove from the canvas.
    const identity = identityOf(node);
    try {
      applyPaint(node, patch, { fonts: {}, images });
      applySceneProps(node, patch);
    } catch (cause) {
      throw editPointerError(identity, cause);
    }
    return mintHandle(node);
  });
}
