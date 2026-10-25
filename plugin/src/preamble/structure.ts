/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { registerRead } from "./egress.js";
import type { WarningRecord } from "./warnings.js";
import { sceneFigma as figma } from "./scene-access.js";
import { compileTree, treeNodes, placedTreeOf } from "./compile-tree.js";
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

import { WriteNode, Target, Handle, RemoveResult } from "./ir.js";
import { resolveTarget, isTargetShaped } from "./target.js";
import { assertNodeStillOnCanvas, LoadedPages, createLoadedPages, loadPageForWrite, assertPageLoaded } from "./freshness.js";
import { enterMutatingVerb, compensatedMutationFailure, type VerbResultBuilder } from "./mutation-lock.js";
import {
  mintHandle, beginRenderWalk, RenderResources,
  assertLiveNodeLandsUnderParent, assertBuiltRootLandsUnderParent, foldBuiltRootForDestination, attachLiveNode, resettleMovedNode,
} from "./bridge.js";
import { landTree } from "./land-tree.js";
import { loadTreeResources, gateTreeResources, loadEditResources, gateEditResources } from "./verb-resources.js";
import { recordObligations } from "./obligation.js";
import { deriveConcurrentEditObligations, deriveEditPlanObligations, liveObligationSite, obligationsOnTarget, realizeOnlyChecksOf } from "./obligation-derivation.js";
import { captureReadDependencies, gateCallObligations, NO_READ_DEPENDENCIES } from "./call-obligations.js";
import { layoutModeOf } from "./layout-mode.js";
import { prepareInsertBindings, applyInsertBindings, InsertBindingPlan } from "./component-edit.js";
import { clearKeysDeep, instanceContextOf, instanceContextUnder, instanceAncestorOf, isComponentDefinition, describeNodeIdentity } from "./identity.js";
import { mintAuthorizedLiveLayout, preflightInstanceWrites, type AuthorizedLiveLayout } from "./instance-write-authorization.js";
import { applyExposures } from "./instance-exposure.js";
import { captureCloneBindings, restoreCloneBindings, removeFailedClone, type CreatedCloneProperties } from "./clone-bindings.js";
import { assertInheritedSlotContentStays } from "./live-tree.js";
import { replacementTree } from "./structure-layout.js";
import type { EditDelta } from "./schema.js";
import { compileEditPlan, emptyEditPlan, preflightEditPlan, authorizeEditPlan } from "./edit-plan.js";
import { scheduleEditEntries, runEditOperations, type EditApplyEntry } from "./edit-apply.js";
import { beginMutatingApply } from "./verb-error.js";
import { recordVerbRemovedNode } from "./moved-out-diagnostics.js";
import { showValue } from "./validate.js";
import { FlcmError, appendToFailure, describeFailure } from "./flcm-error.js";
import { unrotatedCornerOf } from "./pivot.js";
import { holdPivot, settlePivot, type ApplySpan } from "./apply-span.js";

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
    throw new FlcmError(
      "authoring",
      "a " + node.type + ' ("' + node.name + '") holds no children, so nothing can be placed inside it. ' +
        "Target a frame, group, section, or page.",
      { call: subject },
    );
  }
}

// Figma forbids changing an instance's CHILDREN — they come from its main component, and the only
// real fix is editing that component (flcm never auto-detaches: detaching churns every id, killing
// the handles the agent is holding) — with one opening: a SLOT's content is the instance's own,
// and the list under it is as open as any frame's, however deep. The rule that decides is
// identity.instanceContextOf (first SLOT or INSTANCE up the chain wins), and the two roles read
// different facts of it — this is the whole reason the role is a parameter:
//
//   • a DESTINATION counts itself: an INSTANCE destination is closed, a SLOT destination open.
//   • a SUBJECT starts at its parent. An instance is an ordinary scene node in ITS parent, so
//     moving or deleting the instance itself is not just legal but routine, and this gate must
//     not stand in the way of it; the SLOT node itself is a sublayer, so it stays put.
function assertInstanceChildListUntouched(subject: string, node: any, role: "destination" | "subject"): void {
  const context = instanceContextOf(node);
  const host = (role === "destination" ? context.childListClosedBy : context.ownWritesLockedBy)?.node as any;
  if (!host) return;
  const what = role === "destination" ? "destination" : "node being moved or removed";
  throw new FlcmError(
    "figma",
    "the " + what + " is inside component instance " + JSON.stringify(host.name) + " (id " +
      JSON.stringify(host.id) + "), whose child list Figma won't let a plugin change. Edit the main " +
      "component it comes from (flcm never auto-detaches an instance)" + slotsOpenIn(host, role) + ".",
    { call: subject },
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
  throw new FlcmError(
    "authoring",
    JSON.stringify(parent.name) + " (id " + JSON.stringify(parent.id) + ") is a COMPONENT_SET, and a set's children are its VARIANTS — " +
      "a built node would be a plain frame among them. There is no add-to-an-existing-set form yet: flcm.variants builds a set from standalone components. " +
      "To change what every variant holds, insert into each variant.",
    { call: subject },
  );
}

// A node cannot land inside itself or inside its own subtree — Figma refuses the cycle, and its
// own error names neither node. Checked here so the refusal names both.
function assertNoCycle(subject: string, node: any, destination: any): void {
  for (let p: any = destination; p; p = p.parent) {
    if (p !== node) continue;
    throw new FlcmError(
      "authoring",
      JSON.stringify(node.name) + " (id " + JSON.stringify(node.id) + ") can't be placed inside " +
        (node === destination ? "itself" : "its own descendant " + JSON.stringify(destination.name)) + ".",
      { call: subject },
    );
  }
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
      throw new FlcmError(
        "authoring",
        JSON.stringify(anchorNode.name) + " (id " + JSON.stringify(anchorNode.id) +
          ") has no parent to insert beside. Use flcm.append(parent, …) instead.",
        { call: subject },
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

// `noteOverlap`: render's root lands on the page unseen, so it is told when it buried something (root-overlap.ts).
interface PreparedInsert { kind: "insert"; dest: Destination; tree: WriteNode; resources: RenderResources; bindings?: InsertBindingPlan[]; noteOverlap: boolean }
// `layout` is the subject's parent-relative intent read BEFORE the reparent — under the OLD parent's
// axes, the frame of reference the words were written in — authorized where it lands.
interface PreparedPlacement { kind: "placement"; dest: Destination; layout: AuthorizedLiveLayout }

function applyInsert(verb: string, { dest, tree, resources, bindings, noteOverlap }: PreparedInsert, span: ApplySpan): VerbResultBuilder<AuthoredTree> {
  // `bindings` is opted into ONLY for an insert landing inside a component (see RenderCtx.bindings):
  // without the list, buildNode throws on a bound node rather than dropping the authoring word.
  const ctx = beginRenderWalk({ ...resources, span }, { bindings: !!bindings });
  const fail = beginMutatingApply(verb, dest.parent);
  try {
    landTree(dest.parent, dest.place, tree, ctx, "flcm." + verb, noteOverlap);
    // After the tree is attached and settled: the property references (and the slot properties this
    // insert declares) land in the same sealed span, so a bound layer is never on the canvas unbound.
    if (bindings) applyInsertBindings(bindings, ctx.bindings!);
    applyExposures(ctx.exposures);
  } catch (cause) {
    throw fail(cause);
  }
  return () => placedTreeOf(tree.source!, ctx.placedIds);
}

// Put a live node into a destination and settle it there. `move` and `clone` share this: a clone is
// a move of a node that was born one instruction ago, and the place-then-resettle ORDER is the part
// that must not be written twice (resettling before the attach would aim `fill` at the old parent).
function applyPlacement(verb: string, { dest, layout }: PreparedPlacement, span: ApplySpan): void {
  const node: any = layout.node;
  const fail = beginMutatingApply(verb, node);
  try {
    attachLiveNode(dest.parent, layout, dest.place);
    holdPivot(span, node);
    resettleMovedNode(layout, { span });
    settlePivot(span, node, layout.child.layout);
  } catch (cause) {
    throw fail(cause);
  }
}

// ---- the placement verbs ----

type Placement = "end" | "start" | "before" | "after";

// render's anchor is the current page; every other placement verb names its anchor as a required argument.
type PlacementAnchor = "currentPage" | { arg: "parent" | "sibling"; target: Target };

// An explicitly passed `undefined`/`null` target is almost always an unset variable (`copy.id` off a value
// with no id). A verb with an omitted-argument default must not read it as an omission: that default would
// act on a node the agent never named.
function refuseNullishTarget(subject: string, arg: string, value: unknown, remedy: string): void {
  if (value == null) {
    throw new FlcmError("authoring", arg + " is " + showValue(value) + " — pass a target (id, flcm/key or a handle)" + remedy + ".", { call: subject });
  }
}

function placeVerb(verb: string, anchor: PlacementAnchor, spec: NodeSpec, placement: Placement): Promise<AuthoredTree> {
  const subject = "flcm." + verb;
  return enterMutatingVerb(verb, async () => {
    if (anchor !== "currentPage") refuseNullishTarget(subject, anchor.arg, anchor.target, ", or use flcm.render to place on the current page");
    const tree = compileTree(spec, subject + ".spec");
    const pages = createLoadedPages();
    const anchorNode = anchor === "currentPage" ? figma.currentPage : await resolveAnchor(anchor.target, placement, pages);
    if (anchor === "currentPage") await loadPageForWrite(anchorNode, pages);
    return { tree, anchorNode, pages, loaded: await loadTreeResources(tree) };
  }, ({ tree, anchorNode, pages, loaded }): PreparedInsert => {
    const dest = destinationOf(subject, anchorNode, placement, pages);
    assertInstanceChildListUntouched(subject, dest.parent, "destination");
    if (tree.liveId === undefined) {
      assertBuiltInsertNotIntoSet(subject, dest.parent);
      foldBuiltRootForDestination(dest.parent, tree);
      assertBuiltRootLandsUnderParent(dest.parent, tree, subject);
    }
    const resources = gateTreeResources(tree, loaded, subject, { destination: dest.parent });
    for (const entry of loaded.live.entries.values()) assertNoCycle(entry.ref.sourcePath, entry.node, dest.parent);
    if (tree.liveId !== undefined) {
      // Also checked as each live node is placed; here it refuses the common case before the seal.
      const liveRoot = resources.live.get(tree)!;
      assertInheritedSlotContentStays(tree.sourcePath, liveRoot.node, dest.parent);
      assertLiveNodeLandsUnderParent(liveRoot.node, dest.parent, subject, liveRoot.layout);
    }
    const bindings = prepareInsertBindings(subject, dest.parent, tree, resources);
    return { kind: "insert", dest, tree, resources, bindings, noteOverlap: verb === "render" };
  }, (prepared, span) => applyInsert(verb, prepared, span));
}

export function render(spec: NodeSpec): Promise<AuthoredTree> {
  return placeVerb("render", "currentPage", spec, "end");
}
export function append(parent: Target, spec: NodeSpec): Promise<AuthoredTree> {
  return placeVerb("append", { arg: "parent", target: parent }, spec, "end");
}
export function prepend(parent: Target, spec: NodeSpec): Promise<AuthoredTree> {
  return placeVerb("prepend", { arg: "parent", target: parent }, spec, "start");
}
export function insertBefore(sibling: Target, spec: NodeSpec): Promise<AuthoredTree> {
  return placeVerb("insertBefore", { arg: "sibling", target: sibling }, spec, "before");
}
export function insertAfter(sibling: Target, spec: NodeSpec): Promise<AuthoredTree> {
  return placeVerb("insertAfter", { arg: "sibling", target: sibling }, spec, "after");
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
      return () => ({ removedId, from: containerHandle(from) });
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
export function clone(target: Target, parent?: Target): Promise<Handle>;
export function clone(target: Target, props: EditDelta, parent?: Target): Promise<Handle>;
export function clone(target: Target, propsOrParent?: EditDelta | Target, parent?: Target): Promise<Handle> {
  // Only an ABSENT argument takes the beside-the-original default; arguments.length is what tells them apart.
  // A nullish `props` beside a named parent is just "no edits" (the edit-delta rule), so it isn't refused.
  if (arguments.length >= 2) {
    try {
      if (arguments.length === 2) refuseNullishTarget("flcm.clone", "the second argument (props or parent)", propsOrParent, ", or omit it to copy beside the original");
      else refuseNullishTarget("flcm.clone", "parent", parent, ", or omit it to copy beside the original");
    } catch (error) {
      return Promise.reject(error);
    }
  }
  const isDestination = typeof propsOrParent === "string" || isTargetShaped(propsOrParent);
  const props = isDestination ? undefined : propsOrParent as EditDelta | undefined;
  const destination = isDestination ? propsOrParent as Target : parent;
  return enterMutatingVerb(
    "clone",
    async () => {
      const pages = createLoadedPages();
      const node: any = await resolveTarget(target);
      const hint = props === undefined ? undefined : compileCloneProps(node, props);
      let dependencies = NO_READ_DEPENDENCIES;
      // Read off the original: the copy is made from it at the seal, so a change to it under the loads is the copy's too.
      const loaded = await loadEditResources(hint ? [hint] : [], [], (tokens) => {
        if (hint) dependencies = captureReadDependencies(deriveConcurrentEditObligations(hint, undefined, tokens, liveObligationSite(node), "flcm.clone"));
      });
      const anchorNode = destination != null ? await resolveAnchor(destination, "end", pages) : undefined;
      if (!anchorNode) await loadPageForWrite(node.parent, pages);
      return { node, anchorNode, pages, loaded, dependencies };
    },
    ({ node, anchorNode, pages, loaded, dependencies }) => {
      assertNodeStillOnCanvas(node, "flcm.clone");
      const dest = anchorNode !== undefined ? destinationOf("flcm.clone", anchorNode, "end", pages) : endOf(node.parent);
      if (!dest.parent) {
        throw new FlcmError(
          "authoring",
          JSON.stringify(node.name) + " (id " + JSON.stringify(node.id) +
            ") has no parent for the copy to land in — name one: flcm.clone(target, parent).",
          { call: "flcm.clone" },
        );
      }
      assertPageLoaded(dest.parent, pages, "flcm.clone");
      assertInstanceChildListUntouched("flcm.clone", dest.parent, "destination");
      // The ORIGINAL's parent-relative intent: the copy is born carrying the same flow marks, and
      // they mean the old parent's axes exactly as a move's do. No cycle check — the copy did not
      // exist a moment ago, so it can't contain its own destination.
      const edit = props === undefined ? undefined : compileCloneProps(node, props);
      // Font coverage is checked on the source; placement legality belongs to the destination, and
      // both halves meet the instance write policy where the copy will sit.
      const resolved = assertLiveNodeLandsUnderParent(node, dest.parent, "flcm.clone", edit?.patch.layout);
      const context = instanceContextUnder(dest.parent, node);
      const placed = preflightInstanceWrites("flcm.clone", emptyEditPlan(node), resolved, context);
      const local = edit && preflightEditPlan({ ...edit, patch: { ...edit.patch, layout: undefined } }, loaded, "flcm.clone", context);
      // Derived here, against the destination the copy will sit in; recorded once the copy exists.
      const site = { instance: context, parentMode: layoutModeOf(dest.parent), onPage: dest.parent.type === "PAGE" };
      const owed = edit ? deriveEditPlanObligations(edit, loaded, site) : [];
      // The original stands in for the copy: until the apply makes it, they are the same layer.
      gateCallObligations({
        obligations: edit ? obligationsOnTarget(deriveEditPlanObligations(edit, loaded, liveObligationSite(node)), { node }, "flcm.clone") : [],
        dependencies,
        checks: edit ? realizeOnlyChecksOf(edit, new Map([...placed.realizeOnly, ...(local?.realizeOnly ?? [])]), loaded, site, "flcm.clone", context) : [],
      }, "flcm.clone");
      return { node, dest, resolved, edit, owed, resources: gateEditResources(loaded, [], "flcm.clone"), bindings: captureCloneBindings(node) };
    },
    ({ node, dest, resolved, edit, owed, resources, bindings }, span) => {
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
        recordObligations(obligationsOnTarget(owed, { node: copy }, "flcm.clone"));
        // From here the copy is the subject, and placing it is exactly a move.
        const layout = mintAuthorizedLiveLayout("flcm.clone", copy, resolved, instanceContextUnder(dest.parent, copy));
        applyPlacement("clone", { kind: "placement", dest, layout }, span);
        try { restoreCloneBindings(copy, bindings, created); } catch (cause) { throw fail(cause); }
        if (edit) {
          // After the placement: the copy's own words resolve against the parent it now sits in.
          const plan = authorizeEditPlan({ ...edit, node: copy }, resources, "flcm.clone");
          // The clone's failure, which names the original: the copy is not the layer the agent named.
          const entry: EditApplyEntry = { node: copy, plan, subject: "clone", tag: "flcm.clone", fail };
          runEditOperations([entry], scheduleEditEntries([entry], "flcm.clone"), beginRenderWalk({ ...resources, span }));
        }
        // The cleanup reaches only this span. A failure after it (the lock's settle, a style link,
        // the finalizer) takes the ordinary rollback, which undoes the copy with the rest.
        return () => mintHandle(copy);
      } catch (cause) {
        if (!copy) throw cause;
        try { removeFailedClone(copy, created); }
        catch (cleanup) { throw appendToFailure(cause, "Cleanup also failed: " + describeFailure(cleanup)); }
        throw compensatedMutationFailure(cause);
      }
    },
  );
}

function compileCloneProps(node: any, props: EditDelta) {
  if (props && typeof props === "object" && !Array.isArray(props) && Object.keys(props).length === 0) return undefined;
  const plan = compileEditPlan(node, props, "flcm.clone");
  if (plan.instanceWords || plan.componentWords) throw new FlcmError("authoring", "overrides are ordinary root properties; edit component properties, bindings, or nested overrides on the returned copy separately. Nothing was applied.", { call: "flcm.clone" });
  return plan;
}

/** Numeric geometry in Figma's x/y frame: the containing frame or page, which skips GROUP and BOOLEAN_OPERATION parents. */
export async function measure(target: Target): Promise<{ x: number; y: number; width: number; height: number; warnings?: WarningRecord[] }> {
  const node: any = await resolveTarget(target);
  assertNodeStillOnCanvas(node, "flcm.measure");
  if (![node.x, node.y, node.width, node.height].every(Number.isFinite)) throw new FlcmError("authoring", "target has no measurable scene geometry.", { call: "flcm.measure" });
  const corner = unrotatedCornerOf(node);
  const measured = { x: corner.x, y: corner.y, width: node.width, height: node.height };
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
    const { parent } = destinationOf("flcm.replace", node, "before", pages);
    // Every live node the replacement keeps, the original included, leaves `parent` while the
    // replacement is built and before it lands. So land before the first later sibling that stays.
    const kept = new Set(treeNodes(tree).map(n => n.liveId).filter(Boolean));
    const siblings: any[] = parent.children;
    const after = siblings.slice(siblings.indexOf(node) + 1).find(sibling => !kept.has(sibling.id));
    const dest: Destination = {
      parent,
      place: (built) => after ? parent.insertChild(parent.children.indexOf(after), built) : parent.appendChild(built),
    };
    assertInstanceChildListUntouched("flcm.replace", dest.parent, "destination");
    if (tree.liveId === undefined) {
      assertBuiltInsertNotIntoSet("flcm.replace", dest.parent);
      Object.assign(tree, replacementTree(node, tree));
      foldBuiltRootForDestination(dest.parent, tree);
      assertBuiltRootLandsUnderParent(dest.parent, tree, "flcm.replace");
    }
    const resources = gateTreeResources(tree, loaded, "flcm.replace", { destination: dest.parent });
    for (const entry of loaded.live.entries.values()) assertNoCycle(entry.ref.sourcePath, entry.node, dest.parent);
    // The original leaves unless the replacement keeps it, and its descendants leave with it unless kept.
    const removes = (layer: any): boolean => {
      for (let p = layer; p; p = p.parent) {
        if (kept.has(p.id)) return false;
        if (p === node) return true;
      }
      return false;
    };
    return { kind: "insert", original: node, dest, tree, resources, bindings: prepareInsertBindings("flcm.replace", dest.parent, tree, resources, removes), noteOverlap: false };
  }, (prepared, span) => {
    const build = applyInsert("replace", prepared, span);
    if (!treeNodes(prepared.tree).some(node => node.liveId === prepared.original.id)) {
      const fail = beginMutatingApply("replace", prepared.original);
      recordVerbRemovedNode(prepared.original);
      try { prepared.original.remove(); } catch (cause) { throw fail(cause); }
    }
    return build;
  });
}

// ---- detach ----

const DETACH_SUBJECT = "flcm.detach";

/**
 * flcm.detach(target) — break an instance's link to its component. The subtree becomes ordinary
 * layers under a FRAME with a NEW id (every sublayer id changes with it), returned as that frame's
 * handle with fresh geometry. One-way: nothing re-attaches it, so the old ids and any flcm/key
 * addressing them are worth re-reading after.
 */
// A single expression on purpose: the queue slot is reserved before detach() can possibly yield,
// which is the lock's invocation-order guarantee (see enterMutatingVerb) — don't add work above it.
export function detach(target: Target): Promise<Handle> {
  return enterMutatingVerb(
    "detach",
    () => resolveTarget(target),
    (node: any) => {
      assertNodeStillOnCanvas(node, DETACH_SUBJECT);
      if (node.type !== "INSTANCE") {
        throw new FlcmError(
          "authoring",
          describeNodeIdentity(node) + " is not an instance — there is no component link to break. " +
            (isComponentDefinition(node)
              ? "This is the component itself; detach an INSTANCE of it."
              : "flcm.find({ type: \"INSTANCE\" }) locates the instances on the page."),
          { call: DETACH_SUBJECT },
        );
      }
      // Figma does NOT refuse a nested detach — it WIDENS it: detachInstance on an instance inside
      // another instance "also detaches all ancestors nodes that are instances" (plugin typings).
      // So asking to detach one instance would silently detach three, which is exactly the kind of
      // unasked-for mutation this surface refuses. Gated here so the agent gets the node to act on
      // rather than a canvas it has to reconstruct.
      const host = instanceAncestorOf(node);
      if (host) {
        throw new FlcmError(
          "authoring",
          describeNodeIdentity(node) + " is nested inside instance " + JSON.stringify(host.name) + " (id " + JSON.stringify(host.id) +
            "). Figma's detach on a nested instance ALSO detaches every enclosing instance up the chain, so flcm refuses rather than widen the mutation silently. Detach " +
            JSON.stringify(host.id) + " (the whole outer instance becomes editable layers) if that is what you mean, or edit the component the nested instance comes from.",
          { call: DETACH_SUBJECT },
        );
      }
      return node;
    },
    (node) => {
      const fail = beginMutatingApply("detach", node);
      try {
        const frame = node.detachInstance();
        return () => mintHandle(frame);
      } catch (cause) {
        throw fail(cause);
      }
    },
  );
}
