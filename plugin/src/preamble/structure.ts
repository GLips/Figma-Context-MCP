import { registerRead } from "./host.js";
import type { WarningRecord } from "./warnings.js";
import { describeRootOverlap } from "./root-overlap.js";
import { sceneFigma as figma } from "./scene-access.js";
import { compileTree, treeNodes } from "./compile-tree.js";
import type { NodeSpec, AuthoredTree } from "./schema.js";
// structure — the tree-shape verbs (sibling to edit.ts, the field-level one). Position is the
// VERB, DOM-style: `append`/`prepend` take the parent, `insertBefore`/`insertAfter` take a sibling
// and infer the parent from it. There is no options bag and no index argument — an index is a
// number an agent has to derive from a read it would otherwise not need.
//
// Each placement verb compiles a plain spec. Per node, id decides whether to move or create.
// Both paths validate layout against the destination:
//
//   • a new node rides attachBuiltChild — the same attach-then-size entry the create walk uses, so an
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

import { WriteNode, WriteLayout, Target, Handle, CloneResult, RemoveResult } from "./ir.js";
import { resolveTarget } from "./read.js";
import { assertNodeStillOnCanvas, LoadedPages, createLoadedPages, loadPageForWrite, assertPageLoaded } from "./freshness.js";
import { enterMutatingVerb, compensatedMutationFailure } from "./mutation-lock.js";
import {
  attachBuiltChild, settleSiblingOrder, mintHandle, resolvePercents, beginRenderWalk, RenderResources,
  liveParentAttachFacts, assertLiveNodeLandsUnderParent, assertBuiltRootLandsUnderParent, resettleMovedNode,
} from "./bridge.js";
import { loadTreeResources, gateTreeResources, LoadedTreeResources } from "./render.js";
import { prepareInsertBindings, applyInsertBindings, InsertBindingPlan } from "./component-edit.js";
import { clearKeysDeep, childListClosingInstanceOf } from "./identity.js";
import { applyExposures } from "./instance-exposure.js";
import { captureCloneBindings, restoreCloneBindings, removeFailedClone, type CreatedCloneProperties } from "./clone-bindings.js";
import { growImplicitGridRows } from "./layout-native.js";
import { replacementTree } from "./structure-layout.js";
import type { EditDelta } from "./schema.js";
import { compileEditPlan, loadEditResources, gateEditResources, assertEditPlanLands,
  applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions } from "./edit-plan.js";
import { beginMutatingApply } from "./verb-error.js";

// Where a placement verb puts its subject inside the destination. `place` is a closure evaluated
// in the APPLY span, right after the gate that built it — the sibling's index is read at the
// moment of the insert, never carried.
interface Destination {
  parent: any;
  place: (node: any) => void;
}

// ---- gate-phase refusals. Every one of these fires with ZERO writes (invariant 2), in the verb's
// synchronous gate (mutation-lock.ts), against the document as it stands at the seal. ----

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
// the handles the agent is holding) — with one opening: a SLOT's content is the instance's own,
// and the list under it is as open as any frame's, however deep. The rule that decides is
// identity.childListClosingInstanceOf (first SLOT or INSTANCE up the chain wins), and the two
// roles ask it different questions — this is the whole reason the role is a parameter:
//
//   • a DESTINATION counts itself: an INSTANCE destination is closed, a SLOT destination open.
//   • a SUBJECT starts at its parent. An instance is an ordinary scene node in ITS parent, so
//     moving or deleting the instance itself is not just legal but routine, and this gate must
//     not stand in the way of it; the SLOT node itself is a sublayer, so it stays put.
function assertInstanceChildListUntouched(subject: string, node: any, role: "destination" | "subject"): void {
  const host = childListClosingInstanceOf(node, role === "destination");
  if (!host) return;
  const what = role === "destination" ? "destination" : "node being moved or removed";
  throw new Error(
    subject + ": the " + what + " is inside component instance " + JSON.stringify(host.name) + " (id " +
      JSON.stringify(host.id) + "), whose child list Figma won't let a plugin change. Edit the main " +
      "component it comes from (flcm never auto-detaches an instance)" + slotsOpenIn(host, role) + ".",
  );
}

// The SLOTs a refused destination's instance HAS, named — the one open door, listed rather than
// hinted at. Nothing for a subject: what moves or goes is not looking for somewhere to land.
function slotsOpenIn(host: any, role: "destination" | "subject"): string {
  if (role !== "destination") return "";
  const slots = host.findAll((n: any) => n.type === "SLOT") as any[];
  if (!slots.length) return "";
  return " — or place into one of its SLOTs, whose content is the instance's own: " +
    slots.map((s) => JSON.stringify(s.name) + " (id " + JSON.stringify(s.id) + ")").join(", ") +
    ". Stating the content whole is flcm.edit(instance, { overrides: { \"<slotPath>\": { children: [ … ] } } })";
}

// A COMPONENT_SET's children are its VARIANTS — every one a COMPONENT, all sharing the set's axes.
// A node built into one would be a plain frame among them, which Figma either refuses or turns into
// a malformed member. Named here, with the absence stated: nothing adds to an existing set yet.
function assertBuiltInsertNotIntoSet(subject: string, parent: any): void {
  if (parent.type !== "COMPONENT_SET") return;
  throw new Error(
    subject + ": " + JSON.stringify(parent.name) + " (id " + JSON.stringify(parent.id) + ") is a COMPONENT_SET, and a set's children are its VARIANTS — " +
      "a built node would be a plain frame among them. There is no add-to-an-existing-set form yet: flcm.variants builds a set from standalone components. " +
      "To change what every variant holds, insert into each variant.",
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

function isTargetShaped(thing: object): boolean {
  return "id" in thing || "__flcmId" in thing;
}

// ---- destination resolution ----

// The async half of a destination: the anchor, resolved, and the page it names loaded (the
// anchor's own page for a sibling placement — a hint of where the seal will find it; freshness.ts
// on why the gate proves it).
async function resolveAnchor(anchor: Target, placement: Placement, pages: LoadedPages): Promise<any> {
  const anchorNode: any = await resolveTarget(anchor);
  await loadPageForWrite(placement === "before" || placement === "after" ? anchorNode.parent : anchorNode, pages);
  return anchorNode;
}

// The sync half, in the gate: the anchor still on the canvas, its parent (a live fact — the
// sibling can have moved, and onto a page prepare never loaded) and the container check.
function destinationOf(subject: string, anchorNode: any, placement: Placement, pages: LoadedPages): Destination {
  assertNodeStillOnCanvas(anchorNode, subject);
  if (placement === "before" || placement === "after") {
    const parent = anchorNode.parent;
    if (!parent) {
      throw new Error(
        subject + ": " + JSON.stringify(anchorNode.name) + " (id " + JSON.stringify(anchorNode.id) +
          ") has no parent to insert beside. Use flcm.append(parent, …) instead.",
      );
    }
    assertPageLoaded(parent, pages, subject);
    const offset = placement === "after" ? 1 : 0;
    return {
      parent,
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
// beside destinationOf so the two ways to name a destination stay one concept.
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

interface PreparedInsert { kind: "insert"; dest: Destination; tree: WriteNode; resources: RenderResources; bindings?: InsertBindingPlan }
// `words` is the subject's parent-relative intent read BEFORE the reparent — under the OLD parent's
// axes, the frame of reference the words were written in. Reading it in apply would be too late.
interface PreparedPlacement { kind: "placement"; dest: Destination; node: any; words: WriteLayout }

function applyInsert(verb: string, { dest, tree, resources, bindings }: PreparedInsert): AuthoredTree {
  // `bindings` is opted into ONLY for an insert landing inside a component (see RenderCtx.bindings):
  // without the list, buildNode throws on a bound node rather than dropping the authoring word.
  const ctx = beginRenderWalk(resources, { bindings: !!bindings });
  const fail = beginMutatingApply(verb, dest.parent);
  let root: any;
  try {
    root = attachBuiltChild(dest.parent, tree, ctx, liveParentAttachFacts(dest.parent, "flcm." + verb), dest.place);
    resolvePercents(ctx);
    if (verb === "render") { const overlap = describeRootOverlap(root); if (overlap) console.log(overlap); }
    // After the tree is attached and settled: the property references (and the slot properties this
    // insert declares) land in the same sealed span, so a bound layer is never on the canvas unbound.
    if (bindings) applyInsertBindings(bindings, ctx.bindings!);
    applyExposures(ctx.exposures);
  } catch (cause) {
    throw fail(cause);
  }
  return tree.source as AuthoredTree;
}

// Put a live node into a destination and settle it there. `move` and `clone` share this: a clone is
// a move of a node that was born one instruction ago, and the place-then-resettle ORDER is the part
// that must not be written twice (resettling before the attach would aim `fill` at the old parent).
function applyPlacement(verb: string, { dest, node, words }: PreparedPlacement): void {
  const fail = beginMutatingApply(verb, node);
  const from = node.parent;
  try {
    growImplicitGridRows(dest.parent, words);
    dest.place(node);
    resettleMovedNode(node, words);
  } catch (cause) {
    throw fail(cause);
  }

}

// ---- the placement verbs ----

type Placement = "end" | "start" | "before" | "after";

function placeVerb(verb: string, anchor: Target | undefined, spec: NodeSpec, placement: Placement): Promise<AuthoredTree> {
  const subject = "flcm." + verb;
  return enterMutatingVerb(verb, async () => {
    const tree = compileTree(spec, subject + ".spec");
    const pages = createLoadedPages();
    const anchorNode = anchor === undefined ? figma.currentPage : await resolveAnchor(anchor, placement, pages);
    if (anchor === undefined) await loadPageForWrite(anchorNode, pages);
    return { tree, anchorNode, pages, loaded: await loadTreeResources(tree) };
  }, ({ tree, anchorNode, pages, loaded }): PreparedInsert => {
    const dest = destinationOf(subject, anchorNode, placement, pages);
    assertInstanceChildListUntouched(subject, dest.parent, "destination");
    if (!tree.liveId) {
      assertBuiltInsertNotIntoSet(subject, dest.parent);
      assertBuiltRootLandsUnderParent(dest.parent, tree, subject);
    }
    const resources = gateTreeResources(tree, loaded, { destination: dest.parent });
    for (const entry of loaded.live.entries) assertNoCycle(entry.wn.sourcePath!, entry.node, dest.parent);
    const liveRoot = resources.live?.get(tree);
    if (liveRoot) assertLiveNodeLandsUnderParent(liveRoot.node, dest.parent, subject, tree.layout);
    const bindings = prepareInsertBindings(subject, dest.parent, tree);
    return { kind: "insert", dest, tree, resources, bindings };
  }, prepared => applyInsert(verb, prepared));
}

export function render(spec: NodeSpec): Promise<AuthoredTree> {
  return placeVerb("render", undefined, spec, "end");
}
export function append(parent: Target, spec: NodeSpec): Promise<AuthoredTree> {
  return placeVerb("append", parent, spec, "end");
}
export function prepend(parent: Target, spec: NodeSpec): Promise<AuthoredTree> {
  return placeVerb("prepend", parent, spec, "start");
}
export function insertBefore(sibling: Target, spec: NodeSpec): Promise<AuthoredTree> {
  return placeVerb("insertBefore", sibling, spec, "before");
}
export function insertAfter(sibling: Target, spec: NodeSpec): Promise<AuthoredTree> {
  return placeVerb("insertAfter", sibling, spec, "after");
}

/**
 * flcm.remove(target) — delete a node and its subtree. Returns the id it deleted (so the agent can
 * scrub any handle it still holds) plus the vacated parent's fresh geometry, since a hug parent
 * reflows the moment a child leaves.
 */
export function remove(target: Target): Promise<RemoveResult> {
  return enterMutatingVerb(
    "remove",
    () => resolveTarget(target),
    (node: any) => {
      assertNodeStillOnCanvas(node, "flcm.remove");
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
 * original's own parent when omitted). This is the copy path for a subtree a REBUILD can't
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
export function clone(target: Target, parent?: Target): Promise<CloneResult>;
export function clone(target: Target, props: EditDelta, parent?: Target): Promise<CloneResult>;
export function clone(target: Target, propsOrParent?: EditDelta | Target, parent?: Target): Promise<CloneResult> {
  const isDestination = typeof propsOrParent === "string" || !!propsOrParent && typeof propsOrParent === "object" && isTargetShaped(propsOrParent);
  const props = isDestination ? undefined : propsOrParent as EditDelta | undefined;
  const destination = isDestination ? propsOrParent as Target : parent;
  return enterMutatingVerb(
    "clone",
    async () => {
      const pages = createLoadedPages();
      const node: any = await resolveTarget(target);
      const hint = props === undefined ? undefined : compileCloneProps(node, props);
      const loaded = await loadEditResources(hint ? [hint] : []);
      const anchorNode = destination != null ? await resolveAnchor(destination, "end", pages) : undefined;
      if (!anchorNode) await loadPageForWrite(node.parent, pages);
      return { node, anchorNode, pages, loaded };
    },
    ({ node, anchorNode, pages, loaded }) => {
      assertNodeStillOnCanvas(node, "flcm.clone");
      const dest = anchorNode !== undefined ? destinationOf("flcm.clone", anchorNode, "end", pages) : endOf(node.parent);
      if (!dest.parent) {
        throw new Error(
          "flcm.clone: " + JSON.stringify(node.name) + " (id " + JSON.stringify(node.id) +
            ") has no parent for the copy to land in — name one: flcm.clone(target, parent).",
        );
      }
      assertPageLoaded(dest.parent, pages, "flcm.clone");
      assertInstanceChildListUntouched("flcm.clone", dest.parent, "destination");
      // The ORIGINAL's parent-relative intent: the copy is born carrying the same flow marks, and
      // they mean the old parent's axes exactly as a move's do. No cycle check — the copy did not
      // exist a moment ago, so it can't contain its own destination.
      const edit = props === undefined ? undefined : compileCloneProps(node, props);
      // Font coverage is checked on the source; placement legality belongs to the destination.
      if (edit) assertEditPlanLands({ ...edit, patch: { ...edit.patch, layout: undefined } }, loaded.fonts, "flcm.clone");
      return { node, dest, words: assertLiveNodeLandsUnderParent(node, dest.parent, "flcm.clone", edit?.patch.layout),
        edit, resources: gateEditResources(loaded, []), bindings: captureCloneBindings(node) };
    },
    ({ node, dest, words, edit, resources, bindings }) => {
      const fail = beginMutatingApply("clone", node);
      let copy: any;
      const created: CreatedCloneProperties = [];
      try {
        try {
          copy = node.clone();
          clearKeysDeep(copy);
        } catch (cause) {
          throw fail(cause);
        }
        // From here the copy is the subject, and placing it is exactly a move.
        applyPlacement("clone", { kind: "placement", dest, node: copy, words });
        try { restoreCloneBindings(copy, bindings, created); } catch (cause) { throw fail(cause); }
        if (edit) {
          const plan = { ...edit, node: copy };
          applyEditPlanWrites(fail, plan, resources);
          settleSiblingOrder(resources);
          settleEditPlanSizes(fail, plan);
          settleEditPlanPositions(fail, plan);
        }
        return { node: mintHandle(copy), to: containerHandle(dest.parent) };
      } catch (cause) {
        if (!copy) throw cause;
        try { removeFailedClone(copy, created); }
        catch (cleanup) { throw new Error(String(cause) + " Cleanup also failed: " + String(cleanup)); }
        throw compensatedMutationFailure(cause);
      }
    },
  );
}

function compileCloneProps(node: any, props: EditDelta) {
  if (props && typeof props === "object" && !Array.isArray(props) && Object.keys(props).length === 0) return undefined;
  const plan = compileEditPlan(node, props, "flcm.clone");
  if (plan.instanceWords || plan.componentWords) throw new Error("flcm.clone: overrides are ordinary root properties; edit component properties, bindings, or nested overrides on the returned copy separately. Nothing was applied.");
  return plan;
}

/** Numeric geometry relative to the immediate parent, including the page. */
export async function measure(target: Target): Promise<{ x: number; y: number; width: number; height: number; warnings?: WarningRecord[] }> {
  const node: any = await resolveTarget(target);
  assertNodeStillOnCanvas(node, "flcm.measure");
  if (![node.x, node.y, node.width, node.height].every(Number.isFinite)) throw new Error("flcm.measure: target has no measurable scene geometry.");
  const measured = { x: node.x, y: node.y, width: node.width, height: node.height };
  registerRead(measured, () => measured, node.id);
  return measured;
}

/** Keep the original until its replacement has settled. */
export function replace(target: Target, spec: NodeSpec): Promise<AuthoredTree> {
  return enterMutatingVerb("replace", async () => {
    const tree = compileTree(spec, "flcm.replace.spec");
    const node: any = await resolveTarget(target);
    const pages = createLoadedPages();
    await loadPageForWrite(node.parent, pages);
    return { node, tree, pages, loaded: await loadTreeResources(tree) };
  }, ({ node, tree, pages, loaded }): PreparedInsert & { original: any } => {
    assertNodeStillOnCanvas(node, "flcm.replace");
    assertInstanceChildListUntouched("flcm.replace", node, "subject");
    const dest = destinationOf("flcm.replace", node, "before", pages);
    assertInstanceChildListUntouched("flcm.replace", dest.parent, "destination");
    if (!tree.liveId) {
      assertBuiltInsertNotIntoSet("flcm.replace", dest.parent);
      Object.assign(tree, replacementTree(node, tree));
      assertBuiltRootLandsUnderParent(dest.parent, tree, "flcm.replace");
    }
    const resources = gateTreeResources(tree, loaded, { destination: dest.parent });
    for (const entry of loaded.live.entries) assertNoCycle(entry.wn.sourcePath!, entry.node, dest.parent);
    return { kind: "insert", original: node, dest, tree, resources, bindings: prepareInsertBindings("flcm.replace", dest.parent, tree) };
  }, prepared => {
    const result = applyInsert("replace", prepared);
    if (!treeNodes(prepared.tree).some(node => node.liveId === prepared.original.id)) {
      const fail = beginMutatingApply("replace", prepared.original);
      try { prepared.original.remove(); } catch (cause) { throw fail(cause); }
    }
    return result;
  });
}
