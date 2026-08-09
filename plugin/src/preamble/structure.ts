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
// ORCHESTRATION ONLY, like edit.ts: every write lands through the bridge's appliers, and the undo
// scaffold (entry seal / success commit / commit-then-undo rollback) is the lock's — each verb is
// a single enterMutatingVerb expression, so its queue slot is reserved before it can yield.

import { WriteNode, WriteLayout, Target, Handle, InsertResult, MoveResult } from "./ir.js";
import { resolveTarget } from "./read.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import {
  attachSpecChild, SpecParentFacts, mintHandle, settleHandles, resolvePercents, RenderCtx,
  RenderResources, parentHugFacts, isRowColumnAutoLayout, assertLayoutLandsUnderParent,
  liveParentRelativeWords, resettleMovedNode,
} from "./bridge.js";
import { assertConstructorBuiltTree } from "./provenance.js";
import { loadTreeResources } from "./flcm.js";
import { identityOf } from "./identity.js";
import { mutatingVerbError, instanceAncestorOf } from "./verb-error.js";

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

// Figma forbids changing an instance's tree shape — an instance's children come from its main
// component, and the only real fix is editing that component (flcm never auto-detaches: detaching
// churns every id, killing the handles the agent is holding). Covers both directions: the
// destination being (or sitting inside) an instance, and a subject being lifted out of one.
function assertOutsideInstance(subject: string, node: any, role: string): void {
  const host = node.type === "INSTANCE" ? node : instanceAncestorOf(node);
  if (host) {
    throw new Error(
      subject + ": the " + role + " is inside component instance " + JSON.stringify(host.name) + " (id " +
        JSON.stringify(host.id) + "), whose tree shape Figma won't let a plugin change. Edit the main " +
        "component it comes from (flcm never auto-detaches an instance).",
    );
  }
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

// The thing being placed is a constructor SPEC or a live TARGET, told apart by shape: every target
// form carries an id (a bare id/key string, flcm.id(id), or any handle), and no WriteNode does.
// Anything else routes to the spec path, whose provenance walk owns the hand-built-IR message.
function isTargetShaped(thing: unknown): thing is Target {
  if (typeof thing === "string") return true;
  if (!thing || typeof thing !== "object") return false;
  const t = thing as { id?: unknown; __flcmId?: unknown };
  return typeof t.id === "string" || typeof t.__flcmId === "string";
}

function assertPlaceableSpec(subject: string, thing: unknown): asserts thing is WriteNode {
  if (Array.isArray(thing)) {
    throw new Error(subject + ": place one node per call — call it once per child, or wrap them in a flcm.frame().");
  }
  if (!thing || typeof thing !== "object" || typeof (thing as WriteNode).type !== "string") {
    throw new Error(
      subject + ": the second argument is the thing to place — a node from the flcm constructors " +
        "(flcm.frame/text/rect/ellipse/line/svg/path), or a target naming a live node to move (an flcm/key, " +
        "a node id, flcm.id(id), or a handle). Got " + JSON.stringify(thing) + ".",
    );
  }
  assertConstructorBuiltTree(thing as WriteNode);
}

// ---- destination resolution ----

async function resolveDestination(subject: string, anchor: Target, placement: Placement): Promise<Destination> {
  const anchorNode: any = await resolveTarget(anchor);
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
      // The sibling's index is read at APPLY time: insertChild interprets it against the
      // pre-removal array when the node is already this parent's child (Figma compensates for the
      // node's own slot), which is exactly what makes a same-parent reorder land where the verb
      // name says it does.
      place: (node) => parent.insertChild(parent.children.indexOf(anchorNode) + offset, node),
    };
  }
  assertDestinationIsContainer(subject, anchorNode);
  return {
    parent: anchorNode,
    place: placement === "start" ? (node) => anchorNode.insertChild(0, node) : (node) => anchorNode.appendChild(node),
  };
}

// ---- the two apply paths ----

// A container's post-op handle — the geometry an agent would otherwise re-read, because a hug
// parent reflows whenever its children change. Absent for the page (no box to measure) and for a
// node with no parent at all.
function containerHandle(parent: any): Handle | undefined {
  return parent && parent.type !== "PAGE" ? mintHandle(parent) : undefined;
}

interface PreparedInsert { kind: "insert"; dest: Destination; spec: WriteNode; resources: RenderResources }
interface PreparedMove { kind: "move"; dest: Destination; node: any; words: WriteLayout }

function applyInsert(verb: string, { dest, spec, resources }: PreparedInsert): InsertResult {
  const ctx: RenderCtx = { keyed: {}, fonts: resources.fonts, images: resources.images, pending: [] };
  // crossStretch is FALSE against a live destination, and stays a stated rule rather than a
  // derivation: Figma stores no container-level `alignItems: "stretch"`, and a child already
  // carrying STRETCH is indistinguishable from one that asked for counter-axis "fill" itself. So
  // an inserted child does not inherit a stretch container's stretch — re-assert it with
  // edit(parent, { layout: { alignItems: "stretch" } }), which re-synthesizes the marks over every
  // child including the new one.
  const facts: SpecParentFacts = { ...parentHugFacts(dest.parent), crossStretch: false, subject: "flcm." + verb };
  const identity = identityOf(dest.parent);
  let root: any;
  try {
    root = attachSpecChild(dest.parent, spec, ctx, facts, dest.place);
    resolvePercents(ctx);
  } catch (cause) {
    throw mutatingVerbError(verb, identity, cause, dest.parent);
  }
  const settled = settleHandles(root, ctx.keyed);
  return { root: settled.root, keyed: settled.keyed, parent: containerHandle(dest.parent) };
}

function applyMove(verb: string, { dest, node, words }: PreparedMove): MoveResult {
  const identity = identityOf(node);
  const from = node.parent;
  try {
    dest.place(node);
    resettleMovedNode(node, words);
  } catch (cause) {
    throw mutatingVerbError(verb, identity, cause, node);
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

// The one body behind append/prepend/insertBefore/insertAfter: the four differ only in how their
// anchor names a destination. A single enterMutatingVerb expression on purpose — the queue slot is
// reserved before anything can yield, which is the lock's invocation-order guarantee.
function placeVerb(verb: string, anchor: Target, thing: unknown, placement: Placement): Promise<InsertResult | MoveResult> {
  const subject = "flcm." + verb;
  return enterMutatingVerb(
    verb,
    async (): Promise<PreparedInsert | PreparedMove> => {
      const dest = await resolveDestination(subject, anchor, placement);
      assertOutsideInstance(subject, dest.parent, "destination");
      if (isTargetShaped(thing)) {
        const node: any = await resolveTarget(thing);
        assertOutsideInstance(subject, node, "node being moved");
        assertNoCycle(subject, node, dest.parent);
        // The moved node's parent-relative intent, read BEFORE the reparent — under the old
        // parent's axes, which is the frame of reference the words were written in.
        const words = liveParentRelativeWords(node);
        assertLayoutLandsUnderParent(dest.parent, node.type, words, isRowColumnAutoLayout(node), words.position === "absolute", subject);
        return { kind: "move", dest, node, words };
      }
      assertPlaceableSpec(subject, thing);
      const layout = thing.layout || {};
      // The spec ROOT is the only node that meets the destination; its interior children are
      // checked against their own (authored) parents inside the build walk, exactly as at create.
      assertLayoutLandsUnderParent(dest.parent, thing.type, layout, layout.mode === "row" || layout.mode === "column", layout.position === "absolute", subject);
      return { kind: "insert", dest, spec: thing, resources: await loadTreeResources(thing) };
    },
    (prepared) => (prepared.kind === "insert" ? applyInsert(verb, prepared) : applyMove(verb, prepared)),
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
