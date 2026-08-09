// structure — the tree-shape verbs (sibling to edit.ts, the field-level one). Position is the
// VERB, DOM-style: `append`/`prepend` take the parent, `insertBefore`/`insertAfter` take a sibling
// and infer the parent from it. There is no options bag and no index argument — an index is a
// number an agent has to derive from a read it would otherwise not need.
//
// Each placement verb takes EITHER a constructor spec or a live target, and DOM semantics decide
// what that means: placing a spec builds it, placing an already-attached node MOVES it. The two
// paths differ in what they must guarantee, not in where they land:
//
//   • a SPEC rides attachSpecChild — the same attach-then-size entry the create walk uses, so an
//     inserted subtree is settled exactly as a rendered one is (invariant 3: attach BEFORE sizing,
//     because "fill"/"hug" are only legal once the node is inside the parent that resolves them).
//   • a LIVE node re-consults the layout authority against its DESTINATION and then re-aims its
//     flow marks there — its layout was legal where it sat, not necessarily where it lands.
//
// ORCHESTRATION, like edit.ts: the writes this module makes ITSELF are the tree-shape calls a
// structural verb is named for — one appendChild/insertChild, one remove(), one clone(). Nothing
// that INTERPRETS a layout word is written here; every one of those lands through the bridge's
// appliers, so there is still exactly one place that knows what "fill" means. The undo scaffold
// (entry seal / success commit / commit-then-undo rollback) is the lock's — each verb is a single
// enterMutatingVerb expression, so its queue slot is reserved before it can yield.

import { WriteNode, WriteLayout, Target, Handle, InsertResult, MoveResult, CloneResult, RemoveResult } from "./ir.js";
import { resolveTarget } from "./read.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import {
  attachSpecChild, mintHandle, settleHandles, resolvePercents, RenderCtx, RenderResources,
  liveParentSpecFacts, assertLiveNodeLandsUnderParent, assertSpecRootLandsUnderParent, resettleMovedNode,
} from "./bridge.js";
import { assertConstructorBuiltTree, isConstructorBuilt, isReadSpec } from "./provenance.js";
import { loadTreeResources } from "./flcm.js";
import { clearKeysDeep, instanceAncestorOf } from "./identity.js";
import { beginMutatingApply } from "./verb-error.js";

// Where a placement verb puts its subject inside the destination. `place` is deliberately a
// closure evaluated in the APPLY span: an index read in prepare would be stale by the time the
// awaits (target resolution, fonts, images) resolve.
interface Destination {
  parent: any;
  place: (node: any) => void;
}

// ---- prepare-phase gates. Every one of these fires with ZERO writes (invariant 2). ----

// A container is a node with Figma's ChildrenMixin — the structural test, not a type allow-list,
// so a container type we've never heard of works and a leaf fails with the same message.
function assertDestinationIsContainer(subject: string, node: any): void {
  if (typeof node.appendChild !== "function") {
    throw new Error(
      subject + ": a " + node.type + ' ("' + node.name + '") holds no children, so nothing can be placed inside it. ' +
        "Target a frame, group, section, or page.",
    );
  }
}

// Figma forbids changing an instance's CHILDREN — they come from its main component, and the only
// real fix is editing that component (flcm never auto-detaches: detaching churns every id, killing
// the handles the agent is holding). The restriction is exactly that, so the two roles ask
// different questions and this is the whole reason the role is a parameter:
//
//   • a DESTINATION fails if it IS an instance or sits inside one — either way the child would
//     land in an instance's child list.
//   • a SUBJECT fails only if it sits inside one. An instance is an ordinary scene node in ITS
//     parent, so moving or deleting the instance itself is not just legal but routine, and this
//     gate must not stand in the way of it.
function assertInstanceChildListUntouched(subject: string, node: any, role: "destination" | "subject"): void {
  const host = role === "destination" && node.type === "INSTANCE" ? node : instanceAncestorOf(node);
  if (!host) return;
  const what = role === "destination" ? "destination" : "node being moved or removed";
  throw new Error(
    subject + ": the " + what + " is inside component instance " + JSON.stringify(host.name) + " (id " +
      JSON.stringify(host.id) + "), whose child list Figma won't let a plugin change. Edit the main " +
      "component it comes from (flcm never auto-detaches an instance).",
  );
}

// A node cannot land inside itself or inside its own subtree — Figma refuses the cycle, and its
// own error names neither node. Checked here so the refusal names both.
function assertNoCycle(subject: string, node: any, destination: any): void {
  for (let p: any = destination; p; p = p.parent) {
    if (p !== node) continue;
    throw new Error(
      subject + ": " + JSON.stringify(node.name) + " (id " + JSON.stringify(node.id) + ") can't be placed inside " +
        (node === destination ? "itself" : "its own descendant " + JSON.stringify(destination.name)) + ".",
    );
  }
}

// A `get` result must never be mistaken for a target. It carries a live string `id` exactly as a
// handle does — deliberate, one vocabulary at the agent boundary — so shape can't tell them apart,
// and guessing wrong MOVES the node the agent asked to copy: silently wrong, the one outcome flcm
// never ships. Object identity CAN tell them apart, so the primary test is the read-side brand
// (provenance.markReadSpec). The field sniff behind it is the fallback for a spec that lost its
// identity crossing JSON — a heuristic on purpose, and only ever additive to the brand.
const READ_SPEC_FIELDS = ["children", "fills", "strokes", "effects", "textStyle", "designedWidth", "designedHeight"];

function assertNotReadSpec(subject: string, thing: Record<string, unknown>): void {
  if (!isReadSpec(thing) && !READ_SPEC_FIELDS.some((f) => f in thing)) return;
  throw new Error(
    subject + ": that is a `get` result, and a read spec is not authoring input on its own — placing it " +
      "would MOVE the node you read, not copy it. Wrap it to say you mean a COPY: " +
      subject + "(…, flcm.fromRead(spec)). To duplicate a live node whole (instances, paint stacks, " +
      "anything a spec can't rebuild) use flcm.clone(target, parent) instead.",
  );
}

// The object target forms: flcm.id(id), or any handle. (A bare id/key string is handled before
// this is ever reached.)
function isTargetShaped(thing: object): boolean {
  const t = thing as { id?: unknown; __flcmId?: unknown };
  return typeof t.id === "string" || typeof t.__flcmId === "string";
}

/**
 * Spec or live target? Decided by PROVENANCE first (ADR-0012 — the constructors are the only
 * authoring dialect), never by shape alone: a constructor-minted tree is the spec, and a name for
 * a live node is left to read.ts's `resolveTarget`, the one place the target grammar lives. Shape
 * cannot lead here — a handle and a `get` result both carry a string `id` — so every other object
 * has to be sorted by which MISTAKE it is, each with its own remedy.
 */
function classifyPlaceable(subject: string, thing: unknown): "spec" | "target" {
  if (typeof thing === "string") return "target";
  if (isConstructorBuilt(thing as object)) return "spec";
  if (Array.isArray(thing)) {
    throw new Error(subject + ": place one node per call — call it once per child, or wrap them in a flcm.frame().");
  }
  if (thing && typeof thing === "object") {
    assertNotReadSpec(subject, thing as Record<string, unknown>);
    if (isTargetShaped(thing)) return "target";
    // Shaped like a spec but not minted by a constructor: the provenance walk owns that message.
    if (typeof (thing as WriteNode).type === "string") assertConstructorBuiltTree(thing as WriteNode);
  }
  throw new Error(
    subject + ": the second argument is the thing to place — a node from the flcm constructors " +
      "(flcm.frame/text/rect/ellipse/line/svg/path), or a target naming a live node to move (an flcm/key, " +
      "a node id, flcm.id(id), or a handle). Got " + JSON.stringify(thing) + ".",
  );
}

// ---- destination resolution ----

// Under the manifest's `documentAccess: dynamic-page`, a PageNode's `children`/`appendChild`/
// `insertChild` all throw until the page is loaded — [verified, plugin-typings 1.133: the note on
// each of those members]. Every other destination is a scene node the target resolution already
// materialized. Nothing is written here, so this belongs in prepare with the rest of the reads.
async function loadPageDestination(node: any): Promise<void> {
  if (node && node.type === "PAGE") await node.loadAsync();
}

async function resolveDestination(subject: string, anchor: Target, placement: Placement): Promise<Destination> {
  const anchorNode: any = await resolveTarget(anchor);
  await loadPageDestination(placement === "before" || placement === "after" ? anchorNode.parent : anchorNode);
  if (placement === "before" || placement === "after") {
    const parent = anchorNode.parent;
    if (!parent) {
      throw new Error(
        subject + ": " + JSON.stringify(anchorNode.name) + " (id " + JSON.stringify(anchorNode.id) +
          ") has no parent to insert beside. Use flcm.append(parent, …) instead.",
      );
    }
    const offset = placement === "after" ? 1 : 0;
    return {
      parent,
      // The sibling's index is read at APPLY time, never in prepare: the awaits between the two
      // (target resolution, fonts, images) can leave a prepare-time index pointing anywhere.
      // The same-parent case rides Figma compensating for the node's own slot — [directional],
      // undefined in the typings and on the live checklist; a reorder is what would expose it.
      place: (node) => parent.insertChild(parent.children.indexOf(anchorNode) + offset, node),
    };
  }
  assertDestinationIsContainer(subject, anchorNode);
  return {
    parent: anchorNode,
    place: placement === "start" ? (node) => anchorNode.insertChild(0, node) : (node) => anchorNode.appendChild(node),
  };
}

// A destination that appends at the end — what `move`, `clone` and `append` all place into. Kept
// beside resolveDestination so the two ways to name a destination stay one concept.
function endOf(parent: any): Destination {
  return { parent, place: (node) => parent.appendChild(node) };
}

// ---- the two apply paths ----

// A container's post-op handle — the geometry an agent would otherwise re-read, because a hug
// parent reflows whenever its children change. Absent for the page (no box to measure) and for a
// node with no parent at all.
function containerHandle(parent: any): Handle | undefined {
  return parent && parent.type !== "PAGE" ? mintHandle(parent) : undefined;
}

interface PreparedInsert { kind: "insert"; dest: Destination; spec: WriteNode; resources: RenderResources }
// `words` is the subject's parent-relative intent read BEFORE the reparent — under the OLD parent's
// axes, the frame of reference the words were written in. Reading it in apply would be too late.
interface PreparedPlacement { kind: "placement"; dest: Destination; node: any; words: WriteLayout }

function applyInsert(verb: string, { dest, spec, resources }: PreparedInsert): InsertResult {
  const ctx: RenderCtx = { keyed: {}, fonts: resources.fonts, images: resources.images, pending: [] };
  const fail = beginMutatingApply(verb, dest.parent);
  let root: any;
  try {
    root = attachSpecChild(dest.parent, spec, ctx, liveParentSpecFacts(dest.parent, "flcm." + verb), dest.place);
    resolvePercents(ctx);
  } catch (cause) {
    throw fail(cause);
  }
  const settled = settleHandles(root, ctx.keyed);
  return { root: settled.root, keyed: settled.keyed, to: containerHandle(dest.parent) };
}

// Put a live node into a destination and settle it there. `move` and `clone` share this: a clone is
// a move of a node that was born one instruction ago, and the place-then-resettle ORDER is the part
// that must not be written twice (resettling before the attach would aim `fill` at the old parent).
function applyPlacement(verb: string, { dest, node, words }: PreparedPlacement): MoveResult {
  const fail = beginMutatingApply(verb, node);
  const from = node.parent;
  try {
    dest.place(node);
    resettleMovedNode(node, words);
  } catch (cause) {
    throw fail(cause);
  }
  return {
    node: mintHandle(node),
    // A reorder inside one parent reports it once, as `to`.
    from: from !== dest.parent ? containerHandle(from) : undefined,
    to: containerHandle(dest.parent),
  };
}

// ---- the placement verbs ----

type Placement = "end" | "start" | "before" | "after";

// Everything a live subject owes its destination before it may be placed there. Shared by the move
// branch and by `clone`, so a gate added here reaches both — they are the same operation on a node
// that already exists, differing only in whether that node was born a moment ago. Synchronous by
// type on purpose: every fact it reads is live, so it must run after its caller's LAST await.
function prepareLivePlacement(subject: string, dest: Destination, node: any): PreparedPlacement {
  assertInstanceChildListUntouched(subject, dest.parent, "destination");
  assertInstanceChildListUntouched(subject, node, "subject");
  assertNoCycle(subject, node, dest.parent);
  return { kind: "placement", dest, node, words: assertLiveNodeLandsUnderParent(node, dest.parent, subject) };
}

// The one body behind append/prepend/insertBefore/insertAfter. The verbs differ only in how their
// anchor names a destination. A single enterMutatingVerb expression on purpose — the queue slot is
// reserved before anything can yield, which is the lock's invocation-order guarantee.
function placeVerb(verb: string, anchor: Target, thing: unknown, placement: Placement): Promise<InsertResult | MoveResult> {
  const subject = "flcm." + verb;
  return enterMutatingVerb(
    verb,
    async (): Promise<PreparedInsert | PreparedPlacement> => {
      if (classifyPlaceable(subject, thing) === "target") {
        const node: any = await resolveTarget(thing as Target);
        return prepareLivePlacement(subject, await resolveDestination(subject, anchor, placement), node);
      }
      // Whole tree, before the resource round-trip: a hand-built child rejects without a font or
      // image fetch, and a sealed tree can't change between here and the build (ADR-0012).
      const spec = thing as WriteNode;
      assertConstructorBuiltTree(spec);
      // Resources BEFORE the destination, and this order is load-bearing: fonts and images are the
      // long await in this prepare, and the user has the document open the whole time. Every live
      // fact the gates below read — the parent's layout mode, its hug axes, its instance ancestry —
      // must be read AFTER the last yield, or the verb validates against a canvas that has moved on.
      const resources = await loadTreeResources(spec);
      const dest = await resolveDestination(subject, anchor, placement);
      assertInstanceChildListUntouched(subject, dest.parent, "destination");
      assertSpecRootLandsUnderParent(dest.parent, spec, subject);
      return { kind: "insert", dest, spec, resources };
    },
    (prepared) => (prepared.kind === "insert" ? applyInsert(verb, prepared) : applyPlacement(verb, prepared)),
  );
}

/**
 * flcm.append(parent, thing) — place `thing` as the LAST child of `parent`. `thing` is either a
 * constructor spec (built and inserted) or a target naming a live node (moved, DOM-style).
 */
export function append(parent: Target, thing: WriteNode | Target): Promise<InsertResult | MoveResult> {
  return placeVerb("append", parent, thing, "end");
}

/** flcm.prepend(parent, thing) — the same, as the FIRST child. */
export function prepend(parent: Target, thing: WriteNode | Target): Promise<InsertResult | MoveResult> {
  return placeVerb("prepend", parent, thing, "start");
}

/** flcm.insertBefore(sibling, thing) — place `thing` immediately before `sibling`, in its parent. */
export function insertBefore(sibling: Target, thing: WriteNode | Target): Promise<InsertResult | MoveResult> {
  return placeVerb("insertBefore", sibling, thing, "before");
}

/** flcm.insertAfter(sibling, thing) — place `thing` immediately after `sibling`, in its parent. */
export function insertAfter(sibling: Target, thing: WriteNode | Target): Promise<InsertResult | MoveResult> {
  return placeVerb("insertAfter", sibling, thing, "after");
}

/**
 * flcm.move(target, parent) — the plain reparent: the node lands as `parent`'s last child. The same
 * placement `append` does, with the subject named first (the way the sentence reads) and creating
 * left to `append` — which is why this returns a MoveResult flat, with no union to narrow.
 */
export function move(target: Target, parent: Target): Promise<MoveResult> {
  return enterMutatingVerb(
    "move",
    async () => {
      if (isConstructorBuilt(target as object)) {
        throw new Error(
          "flcm.move moves a node that already exists — its first argument is a target (an flcm/key, a node id, " +
            "flcm.id(id), or a handle), not a spec. To CREATE a node inside a parent, use flcm.append(parent, spec).",
        );
      }
      const node: any = await resolveTarget(target);
      return prepareLivePlacement("flcm.move", await resolveDestination("flcm.move", parent, "end"), node);
    },
    (prepared) => applyPlacement("move", prepared),
  );
}

/**
 * flcm.remove(target) — delete a node and its subtree. Returns the id it deleted (so the agent can
 * scrub any handle it still holds) plus the vacated parent's fresh geometry, since a hug parent
 * reflows the moment a child leaves.
 */
export function remove(target: Target): Promise<RemoveResult> {
  return enterMutatingVerb(
    "remove",
    async () => {
      const node: any = await resolveTarget(target);
      assertInstanceChildListUntouched("flcm.remove", node, "subject");
      return { node, from: node.parent };
    },
    ({ node, from }) => {
      const fail = beginMutatingApply("remove", node);
      const removedId = node.id;
      try {
        node.remove();
      } catch (cause) {
        throw fail(cause);
      }
      return { removedId, from: containerHandle(from) };
    },
  );
}

/**
 * flcm.clone(target, parent?) — a faithful duplicate, landing at the end of `parent` (the
 * original's own parent when omitted). This is the copy path for a subtree a spec REBUILD can't
 * reproduce — anything holding an INSTANCE, which is most real content — because it duplicates the
 * live node rather than re-authoring it.
 *
 * It is also why agents shouldn't reach for `node.clone()` themselves: a raw clone copies the
 * original's `flcm/key` and quietly mints a duplicate address (see clearKeysDeep). The copy comes
 * back key-less; key it yourself if you want to address it later.
 *
 * In an auto-layout destination the copy lands after the original; in a FREE-FORM one it lands at
 * the original's exact coordinates — directly on top of it. That's the faithful-duplicate contract,
 * not an oversight: `edit` the copy's left/top to separate them.
 */
export function clone(target: Target, parent?: Target): Promise<CloneResult> {
  return enterMutatingVerb(
    "clone",
    async () => {
      const node: any = await resolveTarget(target);
      let dest: Destination;
      if (parent != null) {
        dest = await resolveDestination("flcm.clone", parent, "end");
      } else {
        await loadPageDestination(node.parent);
        dest = endOf(node.parent);
      }
      if (!dest.parent) {
        throw new Error(
          "flcm.clone: " + JSON.stringify(node.name) + " (id " + JSON.stringify(node.id) +
            ") has no parent for the copy to land in — name one: flcm.clone(target, parent).",
        );
      }
      assertInstanceChildListUntouched("flcm.clone", dest.parent, "destination");
      // The ORIGINAL's parent-relative intent: the copy is born carrying the same flow marks, and
      // they mean the old parent's axes exactly as a move's do. No cycle check — the copy did not
      // exist a moment ago, so it can't contain its own destination.
      return { node, dest, words: assertLiveNodeLandsUnderParent(node, dest.parent, "flcm.clone") };
    },
    ({ node, dest, words }) => {
      const fail = beginMutatingApply("clone", node);
      let copy: any;
      try {
        copy = node.clone();
        clearKeysDeep(copy);
      } catch (cause) {
        throw fail(cause);
      }
      // From here the copy is the subject, and placing it is exactly a move.
      const placed = applyPlacement("clone", { kind: "placement", dest, node: copy, words });
      return { node: placed.node, to: placed.to };
    },
  );
}
