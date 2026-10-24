/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Live identities compile as edits. The bridge receives closures so its write walk need not
// import the edit orchestration that already depends on the bridge.
import type { WriteNode, LiveRef, WriteLayout, ComponentPropertyBinding } from "./ir.js";
import { compileEditPlan, preflightEditPlan, authorizeEditPlan } from "./edit-plan.js";
import type { LoadedLiveTree } from "./verb-resources.js";
import { applyEditStages } from "./edit-apply.js";
import { planInstanceEdit } from "./instance.js";
import { planComponentEdit, projectedBinderValue, releaseRewiredBindings } from "./component-edit.js";
import { BINDING_FIELD_WIRE_KEYS } from "./component-properties.js";
import { assertNodeStillOnCanvas } from "./freshness.js";
import { instanceContextOf, instanceContextUnder, writeKey, isInheritedSlotContent, slotOwnerOf, describeNodeIdentity } from "./identity.js";
import { assertInstanceRootLayoutMode, mintAuthorizedLiveLayout } from "./instance-write-authorization.js";
import { layoutModeOf } from "./layout-mode.js";
import { assertLiveNodeLandsUnderParent, liveParentAttachFacts, attachBuiltChild, attachLiveNode, resettleMovedNode, applyVectorPath } from "./bridge.js";
import type { RenderCtx, RenderResources } from "./bridge.js";
import { holdPivot, settlePivot } from "./apply-span.js";
import { beginMutatingApply, refusedBeforeWrite } from "./verb-error.js";
import { recordLiveMoveIntoNewNode } from "./moved-out-diagnostics.js";

// Inherited slot content moves only into another slot of its own instance, where Figma copies it
// and placement returns the copy's id. Anywhere else Figma leaves a node that renders but throws on
// every read and can't be removed, so that move is refused before it is written.
export function assertInheritedSlotContentStays(at: string, node: SceneNode, parent: BaseNode & ChildrenMixin): void {
  if (!isInheritedSlotContent(node)) return;
  const owner = slotOwnerOf(node, false)!;
  if (parent.type !== "PAGE" && slotOwnerOf(parent as SceneNode, true)?.id === owner.id) return;
  throw refusedBeforeWrite(
    at + ": " + describeNodeIdentity(node) + " is inherited slot content: an enclosing component's definition put it in a slot of instance " +
      JSON.stringify(owner.name) + " (id " + JSON.stringify(owner.id) + "), not an override on the instance. Figma can move it only into another slot of " +
      JSON.stringify(owner.name) + "; anywhere else it leaves a node that renders but can't be read or removed. To put it elsewhere, copy it with flcm.clone(" +
      JSON.stringify(node.id) + ", destination); the slot keeps the original.",
  );
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
  place(parent: BaseNode & ChildrenMixin, place: (node: SceneNode) => void, ctx: RenderCtx): SceneNode;
}

export function gateLiveTree(live: LoadedLiveTree, resources: RenderResources): Map<LiveRef, LiveTreeNode> {
  const plans = new Map<LiveRef, LiveTreeNode>();
  for (const entry of live.entries.values()) {
    const { ref, node, changes, key, refs, pathData, targets, current, intoNewNode } = entry;
    const at = ref.sourcePath;
    assertNodeStillOnCanvas(node, at);
    const context = instanceContextOf(node);
    if (context.ownWritesLockedBy) throw new Error(at + ": cannot move a component instance's sublayer; edit its main component.");
    if (ref.children?.length && (!("appendChild" in node) || context.childListClosedBy)) throw new Error(at + ".children: this live node's child list cannot be authored.");
    const plan = entry.hint ? compileEditPlan(node, changes, at) : undefined;
    const instance = plan?.instanceWords ? planInstanceEdit(node, plan.instanceWords, current, { targets, gate: resources }, at) : undefined;
    const component = plan?.componentWords ? planComponentEdit(node, plan.componentWords, at, (field) => projectedBinderValue(field, node, plan, instance, current, at)) : undefined;
    // Placement validates against the destination. Font coverage, node-local legality and the
    // instance write policy still run here, with parent-relative words withheld until that
    // destination exists; the root's direction is judged against the component it will show.
    if (plan) preflightEditPlan({ ...plan, patch: { ...plan.patch, layout: undefined } }, resources, at, context);
    const shown = instance?.becomes ?? current;
    if (node.type === "INSTANCE" && shown) assertInstanceRootLayoutMode(at, node, plan?.patch.layout?.mode, layoutModeOf(shown));
    if (instance) for (const [tree, instancePlan] of instance.needs.plans) (resources.instances as Map<WriteNode, typeof instancePlan>).set(tree, instancePlan);
    const shows = {
      visible: projectedBinderValue("visible", node, plan, instance, current, at) as boolean,
      text: node.type === "TEXT" ? projectedBinderValue("text", node, plan, instance, current, at) as string : undefined,
    };
    plans.set(ref, { node, component: instance?.becomes ?? current, layout: plan?.patch.layout, refs, shows, place(parent, place, ctx) {
      assertInheritedSlotContentStays(at, node, parent);
      // Inherited slot content lands as Figma's copy, leaving the original where it was: not a move.
      const from = intoNewNode && !isInheritedSlotContent(node) ? node.parent : null;
      const fail = beginMutatingApply(at, node);
      try {
        for (let p: BaseNode | null = parent; p; p = p.parent) if (p === node) throw new Error(at + ": a node cannot move inside itself or its descendant.");
        const becomes = instance?.becomesContainer;
        const words = mintAuthorizedLiveLayout(at, node, assertLiveNodeLandsUnderParent(node, parent, at, plan?.patch.layout, becomes), instanceContextUnder(parent, node), resources.tokens);
        attachLiveNode(parent, words, place);
        // After the attach: the plan's layout words resolve against the parent the node now sits in.
        const authorized = plan ? authorizeEditPlan(plan, ctx, at, { becomes }) : undefined;
        if (from) recordLiveMoveIntoNewNode(node, from, parent);
        // Before anything below can resize the node — retarget, attached children, the plan's writes.
        holdPivot(ctx.span, node);
        // Before the node's own writes, so none lands on a property it is leaving (see releaseRewiredBindings).
        if (refs) releaseRewiredBindings(node, Object.keys(refs).map((field) => BINDING_FIELD_WIRE_KEYS[field].wire));
        applyEditStages([{
          node, fail, plan: authorized, instance, component, subject: at,
          beforeWrites() { if (pathData !== undefined && node.type === "VECTOR") applyVectorPath(node, pathData, words); },
          afterBinding() {
            if (key !== undefined) writeKey(node, key as string);
            if (refs) {
              if (!ctx.bindings) throw new Error(at + ": componentPropertyReferences has no declaring component.");
              ctx.bindings.push({ node, refs });
            }
            if ("appendChild" in node) for (const child of ref.children ?? []) attachBuiltChild(node, child, ctx, liveParentAttachFacts(node, child.sourcePath ?? at), c => node.appendChild(c));
            resettleMovedNode(words, ctx);
          },
        }], ctx);
        // A delta's positions settle its pivot; a bare move's is settled here.
        if (!plan) settlePivot(ctx.span, node, words.child.layout);
        // Inherited slot content lands as Figma's copy, under a new id.
        ctx.placedIds.set(ref.source, node.id);
        return node;
      } catch (cause) { throw fail(cause); }
    } });
  }
  return plans;
}
