/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Live identities compile as edits. The bridge receives closures so its write walk need not
// import the edit orchestration that already depends on the bridge.
//
// A tree's live nodes are scheduled together at the gate, like an editMany batch (edit-apply.ts
// scheduleLiveTree): the walk attaches each node and lands its attach-time words, and its geometry
// and children land in the order the whole tree's dependencies give.
import { liveSublayerId } from "@framelink/core";
import type { WriteNode, LiveRef, WriteLayout, ComponentPropertyBinding } from "./ir.js";
import { compileEditPlan, preflightEditPlan, authorizeEditPlan, withoutContainerWords } from "./edit-plan.js";
import { recordObligations } from "./obligation.js";
import {
  deriveEditObligations, deriveLiveEntryObligations, deriveParentageObligations, liveObligationSite, obligationsOnTarget, realizeOnlyChecksOf,
} from "./obligation-derivation.js";
import { gateCallObligations } from "./call-obligations.js";
import { realizeAtWritePoint } from "./write-point.js";
import type { LoadedLiveTree } from "./verb-resources.js";
import { scheduleLiveTree, landAttachedLiveNode, type EditEntryShape, type LiveTreeLanding } from "./edit-apply.js";
import { childTreeNodes } from "./compile-tree.js";
import { provenInstanceMains, definitionsEditedAt, type OperationRef } from "./operation-schedule.js";
import { planInstanceEdit, overrideRealizeOnlyChecks, instanceGeometryWrites, withoutRetargetHeldChecks, instanceStillShows } from "./instance.js";
import { planComponentEdit, projectedBinderValue, releaseRewiredBindings } from "./component-edit.js";
import { BINDING_FIELD_WIRE_KEYS } from "./component-properties.js";
import { assertNodeStillOnCanvas } from "./freshness.js";
import { instanceContextOf, instanceContextUnder, writeKey, isInheritedSlotContent, slotOwnerOf } from "./identity.js";
import { assertInstanceRootLayoutMode, mintAuthorizedLiveLayout } from "./instance-write-authorization.js";
import { layoutModeOf } from "./layout-mode.js";
import { FlcmError, describeNodeIdentity } from "./flcm-error.js";
import { assertLiveNodeLandsUnderParent, liveParentAttachFacts, attachBuiltChild, attachLiveNode, resettleMovedNode, applyVectorPath, carriedFillAxes } from "./bridge.js";
import type { RenderCtx, RenderResources } from "./bridge.js";
import { holdPivot, settlePivot } from "./apply-span.js";
import { beginMutatingApply } from "./verb-error.js";
import { recordLiveMoveIntoNewNode } from "./moved-out-diagnostics.js";

// Inherited slot content moves only into another slot of its own instance, where Figma copies it
// and placement returns the copy's id. Anywhere else Figma leaves a node that renders but throws on
// every read and can't be removed, so that move is refused before it is written.
export function assertInheritedSlotContentStays(at: string, node: SceneNode, parent: BaseNode & ChildrenMixin): void {
  if (!isInheritedSlotContent(node)) return;
  const owner = slotOwnerOf(node, false)!;
  if (parent.type !== "PAGE" && slotOwnerOf(parent as SceneNode, true)?.id === owner.id) return;
  throw new FlcmError(
    "figma",
    "this layer is inherited slot content: an enclosing component's definition put it in a slot of " + describeNodeIdentity(owner) +
      ", not an override on the instance. Figma can move it only into another slot of that instance; anywhere else it leaves a layer that renders but can't be read or removed. " +
      "To put it elsewhere, copy it with flcm.clone(" + JSON.stringify(node.id) + ", destination); the slot keeps the original.",
    { path: at, node: { type: node.type, name: node.name, id: node.id } },
  );
}

// The live nodes a tree places under a parent other than the one they sit in: under a node it
// builds, or a live parent or destination that isn't theirs. Slot content's parent is a sublayer
// the walk resolves, so it is never counted as moved here.
function collectMovedLiveNodes(wn: WriteNode, parent: BaseNode | "built" | undefined, live: LoadedLiveTree, out: Set<WriteNode>): void {
  const node = wn.liveId === undefined ? undefined : live.entries.get(wn)?.node;
  if (node && parent !== undefined && (parent === "built" || parent !== node.parent)) out.add(wn);
  for (const child of wn.children ?? []) collectMovedLiveNodes(child, node ?? "built", live, out);
}

/** A live node as the gate resolved it — the one authority for what the call makes of it. */
export interface LiveTreeNode {
  node: SceneNode;
  component?: ComponentNode | null;
  /** Its delta's layout words: what it says about the parent it lands under. */
  layout?: WriteLayout;
  /** The binding bag it carries, if any. */
  refs?: ComponentPropertyBinding;
  /** What it shows once its words land — the value a property default is judged by (component.ts). */
  shows: { visible: boolean; text?: string };
  /** Attach it under `parent` and land its attach-time words. */
  place(parent: BaseNode & ChildrenMixin, place: (node: SceneNode) => void, ctx: RenderCtx): SceneNode;
}

/** Every live node of `trees`, gated, and the schedule their writes land in. */
export interface GatedLiveTrees {
  nodes: Map<LiveRef, LiveTreeNode>;
  landing: LiveTreeLanding;
}

/**
 * Gate every live node `trees` name against the document at the seal, and schedule their
 * operations across all of them. `path` locates a refusal of words that depend on each other in a
 * cycle; every refusal here leaves zero writes. `destination` is where a tree's root lands, when
 * the verb places it.
 */
export function gateLiveTrees(trees: readonly LoadedLiveTree[], resources: RenderResources, path: string, destination?: BaseNode): GatedLiveTrees {
  const entries = trees.flatMap((live) => [...live.entries.values()].map((entry) => ({ entry, dependencies: live.dependencies })));
  const moved = new Set<WriteNode>();
  for (const live of trees) collectMovedLiveNodes(live.tree, destination, live, moved);
  const indexOf = new Map<WriteNode, number>(entries.map(({ entry }, i) => [entry.ref, i]));
  const attachedBy: (OperationRef | undefined)[] = entries.map(() => undefined);
  // The operation that attaches each live node: its nearest live ancestor's children, or the slot
  // content of that ancestor's override path. A node with none is attached by the walk itself.
  const attachUnder = (trees: readonly WriteNode[], by: OperationRef) => {
    for (const wn of trees) {
      const i = indexOf.get(wn);
      if (i === undefined) attachUnder(childTreeNodes(wn), by);
      else attachedBy[i] = by;
    }
  };
  const mains = provenInstanceMains(new Map(trees.flatMap((live) => [...live.mains])), instanceStillShows);
  // Every main component a live node's words edit: what an instance layer elsewhere in the trees inherits.
  const defines = new Set(entries.flatMap(({ entry }) => [...definitionsEditedAt(entry.node)]));
  const nodes = new Map<LiveRef, LiveTreeNode>();
  const shapes: EditEntryShape[] = [];
  const holder: { landing?: LiveTreeLanding } = {};
  entries.forEach(({ entry, dependencies }, index) => {
    const { ref, node, key, refs, pathData, targets, current, intoNewNode } = entry;
    const { changes } = entry;
    const carried = moved.has(ref) ? carriedFillAxes(node, changes) : undefined;
    const at = ref.sourcePath;
    assertNodeStillOnCanvas(node, at);
    const context = instanceContextOf(node);
    const site = { path: at, node: { type: node.type, name: node.name, id: node.id } };
    const locked = context.ownWritesLockedBy?.node;
    if (locked) {
      throw new FlcmError("figma",
        "this layer is inside " + describeNodeIdentity(locked) + ", and Figma won't let a plugin move an instance's sublayer. Edit the main component it comes from, or detach the instance with flcm.detach.",
        site,
      );
    }
    const closed = context.childListClosedBy?.node;
    if (ref.children?.length && closed) {
      throw new FlcmError("figma",
        "Figma won't let a plugin change the children of " + (closed === node ? "an instance" : "a layer inside " + describeNodeIdentity(closed)) +
          ". Edit the main component it comes from, or detach the instance with flcm.detach.",
        { ...site, path: at + ".children" },
      );
    }
    if (ref.children?.length && !("appendChild" in node)) {
      throw new FlcmError("authoring", "a " + node.type + " has no children. Drop `children` here.", { ...site, path: at + ".children" });
    }
    const plan = entry.hint ? compileEditPlan(node, changes, at) : undefined;
    const planning = { targets, gate: resources };
    const instance = plan?.instanceWords ? planInstanceEdit(node, plan.instanceWords, current, planning, at) : undefined;
    const component = plan?.componentWords ? planComponentEdit(node, plan.componentWords, at, (field) => projectedBinderValue(field, node, plan, instance, current, at)) : undefined;
    // Placement validates against the destination. Font coverage, node-local legality and the
    // instance write policy still run here, with parent-relative words withheld until that
    // destination exists; the root's direction is judged against the component it will show.
    const local = plan && { ...plan, patch: { ...plan.patch, layout: undefined } };
    const realizeOnly = local ? preflightEditPlan(local, resources, at, context).realizeOnly : undefined;
    const shown = instance?.becomes ?? current;
    if (node.type === "INSTANCE" && shown) assertInstanceRootLayoutMode(at, node, plan?.patch.layout?.mode, layoutModeOf(shown));
    if (instance) for (const [tree, instancePlan] of instance.needs.plans) (resources.instances as Map<WriteNode, typeof instancePlan>).set(tree, instancePlan);
    const shows = {
      visible: projectedBinderValue("visible", node, plan, instance, current, at) as boolean,
      text: node.type === "TEXT" ? projectedBinderValue("text", node, plan, instance, current, at) as string : undefined,
    };
    const owed = obligationsOnTarget([
      ...(plan ? deriveEditObligations(plan, instance, resources, liveObligationSite(node)) : []),
      ...deriveLiveEntryObligations(key as string | undefined, pathData, refs),
    ], { node }, at);
    gateCallObligations({
      obligations: owed,
      dependencies,
      checks: [
        ...(local && realizeOnly ? withoutRetargetHeldChecks(realizeOnlyChecksOf(local, realizeOnly, resources, liveObligationSite(node), at, context), instance) : []),
        ...(instance ? overrideRealizeOnlyChecks(instance.overrides, resources, at) : []),
      ],
      writes: instance && plan ? instanceGeometryWrites(node, plan.patch, instance) : [],
      defines,
      mains,
    }, at);
    attachUnder(ref.children ?? [], { entry: index, layer: node.id, phase: "after-binding" });
    for (const o of instance?.overrides ?? []) if (o.slotContent) attachUnder(o.slotContent, { entry: index, layer: liveSublayerId(node.id, o.path), phase: "slot-content" });
    const vector = pathData !== undefined && node.type === "VECTOR";
    shapes.push({
      node, patch: plan?.patch, unwritten: new Set(realizeOnly?.keys() ?? []), instance, component, vectorPath: vector, afterBinding: true, tag: at, obligations: owed,
      turned: !!plan && !plan.instanceWords && !!((node as { rotation?: number }).rotation || plan.patch.rotation),
    });
    nodes.set(ref, { node, component: instance?.becomes ?? current, layout: plan?.patch.layout, refs, shows, place(parent, place, ctx) {
      assertInheritedSlotContentStays(at, node, parent);
      // Inherited slot content lands as Figma's copy, leaving the original where it was: not a move.
      const from = intoNewNode && !isInheritedSlotContent(node) ? node.parent : null;
      const fail = beginMutatingApply(node, { path: at });
      try {
        for (let p: BaseNode | null = parent; p; p = p.parent) if (p === node) throw new FlcmError("authoring", "a node cannot move inside itself or its descendant.", { path: at });
        const becomes = instance?.becomesContainer;
        const placement = plan?.patch.layout && withoutContainerWords(plan.patch.layout);
        const words = mintAuthorizedLiveLayout(at, node, assertLiveNodeLandsUnderParent(node, parent, at, placement, becomes, carried), instanceContextUnder(parent, node));
        attachLiveNode(parent, words, place);
        // Recorded once it sits where it lands: what its words oblige reads that parent.
        recordObligations(obligationsOnTarget([
          ...(plan ? deriveEditObligations(plan, instance, ctx, liveObligationSite(node)) : []),
          ...deriveLiveEntryObligations(key as string | undefined, pathData, refs),
          ...deriveParentageObligations(parent),
        ], { node }, at));
        // After the attach: the plan's layout words resolve against the parent the node now sits in.
        const authorized = plan ? authorizeEditPlan(plan, ctx, at, { becomes }) : undefined;
        if (from) recordLiveMoveIntoNewNode(node, from, parent);
        // Before anything below can resize the node — retarget, attached children, the plan's writes.
        holdPivot(ctx.span, node);
        // Before the node's own writes, so none lands on a property it is leaving (see releaseRewiredBindings).
        // Only the fields whose binding doesn't hold now: one that holds is not rewritten.
        if (refs) {
          const rebinds = realizeAtWritePoint(node, Object.keys(refs).map((field) => `word:binding:${field}` as const)).writes;
          releaseRewiredBindings(node, Object.keys(refs).filter((field) => rebinds.has(`word:binding:${field}`)).map((field) => BINDING_FIELD_WIRE_KEYS[field].wire));
        }
        landAttachedLiveNode(holder.landing!, index, {
          node, fail, plan: authorized, instance, component, site: { path: at }, tag: at,
          vectorPath: !vector ? undefined : () => {
            const at = realizeAtWritePoint(node, ["prop:vector"]);
            if (!at.writes.size) return;
            applyVectorPath(node, pathData!, words);
            at.landed();
          },
          afterBinding() {
            const keyed = key === undefined ? undefined : realizeAtWritePoint(node, ["prop:key"]);
            if (keyed?.writes.size) { writeKey(node, key as string); keyed.landed(); }
            if (refs) {
              if (!ctx.bindings) throw new FlcmError("authoring", "componentPropertyReferences binds a layer to a property of the component it is in, and this layer won't be inside a component. Drop componentPropertyReferences, or place the layer inside a component.", { ...site, path: at + ".componentPropertyReferences" });
              ctx.bindings.push({ node, refs });
            }
            if ("appendChild" in node) for (const child of ref.children ?? []) attachBuiltChild(node, child, ctx, liveParentAttachFacts(node, child.sourcePath ?? at), c => node.appendChild(c));
            resettleMovedNode(words, ctx);
            // A delta's positions settle its pivot; a bare move's is settled here.
            if (!plan) settlePivot(ctx.span, node, words.child.layout);
          },
        }, ctx);
        // Inherited slot content lands as Figma's copy, which the node now reads as (scene-access.ts).
        ctx.placedIds.set(ref.source, node.id);
        return node;
      } catch (cause) { throw fail(cause); }
    } });
  });
  // After every node is gated: an ancestor's slot paths are known only once its instance half is planned.
  holder.landing = scheduleLiveTree(shapes.map((shape, i) => ({ ...shape, attachedBy: attachedBy[i] })), path, mains);
  return { nodes, landing: holder.landing };
}
