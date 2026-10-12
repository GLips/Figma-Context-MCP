/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { compileBindingBag, bindingFieldsForType } from "./flcm.js";
import { normalizePathData, normalizeVectorPaths } from "./path.js";
// Live identities compile as edits. The bridge receives closures so its write walk need not
// import the edit orchestration that already depends on the bridge.
import type { WriteNode } from "./ir.js";
import { treeNodes, childTreeNodes } from "./compile-tree.js";
import { resolveTarget, createResolvedTargets } from "./read.js";
import { createStandingState } from "./standing-state.js";
import { compileEditPlan, loadEditResources, assertEditPlanLands, applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions, holdEditPlanPivot } from "./edit-plan.js";
import { resolveInstanceEditTargets, planInstanceEdit, applyInstanceRetarget, applyInstanceOverrides } from "./instance.js";
import { planComponentEdit, applyComponentDefinitionEdit, applyComponentBindingEdit, projectedBinderValue, releaseRewiredBindings } from "./component-edit.js";
import { BINDING_FIELD_WIRE_KEYS } from "./component.js";
import { assertNodeStillOnCanvas } from "./freshness.js";
import { childListClosingInstanceOf, writeKey, isInheritedSlotContent, slotOwnerOf, describeNodeIdentity } from "./identity.js";
import { assertLiveNodeLandsUnderParent, liveParentAttachFacts, attachBuiltChild, attachLiveNode, resettleMovedNode, applyVectorPath } from "./bridge.js";
import type { RenderCtx, RenderResources } from "./bridge.js";
import { NO_TOKENS } from "./tokens.js";
import { holdUnrotatedCorner, settleCentrePivot } from "./pivot.js";
import { beginMutatingApply, refusedBeforeWrite } from "./verb-error.js";
import { recordLiveMoveIntoNewNode } from "./moved-out-diagnostics.js";
import type { EditDelta } from "./schema.js";

function assertSceneNode(node: BaseNode): asserts node is SceneNode {
  if (node.type === "PAGE" || node.type === "DOCUMENT") throw new Error("a page or document cannot be placed as a scene node.");
}

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

// Live nodes whose spec parent this verb builds: a new node's children, or a new instance's slot
// content. Taken across every tree a verb loads, because an edit's slot content lists a nested new
// instance's slot content again as a root of its own.
export function liveChildrenOfNewNodes(trees: readonly WriteNode[]): Set<WriteNode> {
  return new Set(trees.flatMap(treeNodes).flatMap(wn => wn.liveId ? [] : childTreeNodes(wn)));
}

export async function loadLiveTree(tree: WriteNode, intoNewNode = liveChildrenOfNewNodes([tree])): Promise<LoadedLiveTree> {
  const entries = [];
  const standing = createStandingState();
  const parentOf = new Map(treeNodes(tree).flatMap(parent => childTreeNodes(parent).map(child => [child, parent] as const)));
  const live: { wn: WriteNode; node: SceneNode }[] = [];
  for (const wn of treeNodes(tree)) {
    if (!wn.liveId) continue;
    try {
      const node = await resolveTarget({ id: wn.liveId });
      assertSceneNode(node);
      if (wn.authoring!.svg !== undefined) throw new Error("svg has no live geometry edit: importing markup can change node types and child identities. Move with { id }, or omit the id to import new artwork.");
      if (wn.source?.type !== undefined && wn.source.type !== "IMAGE-SVG" && wn.source.type !== node.type) throw new Error("type " + wn.source.type + " does not match live " + node.type + ".");
      wn.type = node.type;
      // Pre-order, so a live root's one read covers every live descendant pasted with it. A node
      // stating no words (a bare { id } move) has nothing to compare and costs no read.
      if (Object.keys(wn.authoring!).length) await standing.load(node);
      live.push({ wn, node });
    } catch (cause) { throw new Error(wn.sourcePath! + ": " + (cause instanceof Error ? cause.message : String(cause))); }
  }
  // A new parent has no live id; its source path keys its children as siblings all the same.
  const parentKey = (wn: WriteNode): string | undefined => {
    const parent = parentOf.get(wn);
    return parent && (parent.liveId ?? parent.sourcePath);
  };
  const changed = standing.changesInCall(
    live.map(({ wn, node }) => ({ node, words: wn.authoring!, parent: parentKey(wn) })),
    treeNodes(tree).flatMap(wn => {
      const parent = parentKey(wn);
      return !wn.liveId && wn.layout?.zIndex !== undefined && parent ? [parent] : [];
    }),
  );
  for (const [i, { wn, node }] of live.entries()) {
    const at = wn.sourcePath!;
    try {
      const { key, d, vectorPaths, componentPropertyReferences, ...delta } = changed[i];
      if (componentPropertyReferences !== undefined) {
        wn.componentPropertyReferences = compileBindingBag(componentPropertyReferences, bindingFieldsForType(node.type), at);
      }
      let pathData: VectorPaths | undefined;
      if (d !== undefined) {
        if (node.type !== "VECTOR") throw new Error("d is a VECTOR geometry word.");
        if (typeof d !== "string" || !d.trim()) throw new Error("d must be a non-empty SVG path string.");
        pathData = [{ data: normalizePathData(d), windingRule: "NONZERO" }];
      }
      if (vectorPaths !== undefined) {
        if (node.type !== "VECTOR" || d !== undefined) throw new Error("vectorPaths requires a VECTOR and cannot be combined with d.");
        pathData = normalizeVectorPaths(vectorPaths);
      }
      if (key !== undefined && typeof key !== "string") throw new Error("key must be a string.");
      const changes = delta as EditDelta;
      const hint = Object.keys(delta).some(k => delta[k] !== undefined) ? compileEditPlan(node, changes, at) : undefined;
      wn.layout = hint?.patch.layout;
      const targets = createResolvedTargets();
      const current = node.type === "INSTANCE" ? await resolveInstanceEditTargets(node, hint?.instanceWords ?? {}, targets) : null;
      const instance = hint?.instanceWords ? planInstanceEdit(node, hint.instanceWords, current, { targets }, at) : undefined;
      entries.push({ wn, node, changes, key, pathData, hint, targets, current, instance, intoNewNode: intoNewNode.has(wn) });
    } catch (cause) { throw new Error(at + ": " + (cause instanceof Error ? cause.message : String(cause))); }
  }
  const loaded = entries.length ? await loadEditResources(entries.flatMap(e => [...(e.hint ? [e.hint] : []), ...(e.instance?.overrides.map(o => o.plan) ?? [])]), entries.flatMap(e => e.instance ? [e.instance.needs] : [])) : { fonts: {}, images: {}, tokens: NO_TOKENS };
  return { entries, loaded };
}

export interface LoadedLiveTree {
  loaded: import("./edit-plan.js").LoadedResources;
  entries: {
    wn: WriteNode; node: SceneNode; changes: EditDelta; key: unknown; pathData?: VectorPaths;
    hint: import("./edit-plan.js").EditPlan | undefined;
    targets: ReturnType<typeof createResolvedTargets>;
    current: Awaited<ReturnType<typeof resolveInstanceEditTargets>> | null;
    instance: ReturnType<typeof planInstanceEdit> | undefined;
    intoNewNode: boolean;
  }[];
}
export interface LiveTreeNode {
  node: SceneNode;
  component?: ComponentNode | null;
  place(parent: BaseNode & ChildrenMixin, place: (node: SceneNode) => void, ctx: RenderCtx): SceneNode;
}

export function gateLiveTree(live: LoadedLiveTree, resources: RenderResources): Map<WriteNode, LiveTreeNode> {
  const plans = new Map<WriteNode, LiveTreeNode>();
  for (const entry of live.entries) {
    const { wn, node, changes, key, pathData, targets, current, intoNewNode } = entry;
    const at = wn.sourcePath!;
    assertNodeStillOnCanvas(node, at);
    if (childListClosingInstanceOf(node, false)) throw new Error(at + ": cannot move a component instance's sublayer; edit its main component.");
    if (wn.children?.length && (!("appendChild" in node) || childListClosingInstanceOf(node, true))) throw new Error(at + ".children: this live node's child list cannot be authored.");
    const plan = entry.hint ? compileEditPlan(node, changes, at) : undefined;
    wn.layout = plan?.patch.layout;
    const instance = plan?.instanceWords ? planInstanceEdit(node, plan.instanceWords, current, { targets, fonts: resources.fonts }, at) : undefined;
    const component = plan?.componentWords ? planComponentEdit(node, plan.componentWords, at, (field) => projectedBinderValue(field, plan, instance, current, at)) : undefined;
    // Placement validates against the destination. Font coverage and node-local legality still
    // use the edit gate, with parent-relative words withheld until that destination exists.
    if (plan) assertEditPlanLands({ ...plan, patch: { ...plan.patch, layout: undefined } }, resources.fonts, at);
    if (instance) for (const [tree, instancePlan] of instance.needs.plans) (resources.instances as Map<WriteNode, typeof instancePlan>).set(tree, instancePlan);
    // What the node shows once its words land: the value a property default is judged by, whether
    // this node binds the property or is already bound to it (component.ts, component-edit.ts).
    wn.visible = plan?.patch.visible ?? node.visible;
    if (node.type === "TEXT") {
      wn.text = plan?.patch.runs ? undefined : plan?.patch.text ?? node.characters;
      wn.runs = plan?.patch.runs;
    }
    plans.set(wn, { node, component: instance?.becomes ?? current, place(parent, place, ctx) {
      assertInheritedSlotContentStays(at, node, parent);
      // Inherited slot content lands as Figma's copy, leaving the original where it was: not a move.
      const from = intoNewNode && !isInheritedSlotContent(node) ? node.parent : null;
      const fail = beginMutatingApply(at, node);
      try {
        for (let p: BaseNode | null = parent; p; p = p.parent) if (p === node) throw new Error(at + ": a node cannot move inside itself or its descendant.");
        const words = assertLiveNodeLandsUnderParent(node, parent, at, plan?.patch.layout);
        attachLiveNode(parent, node, words, place);
        if (from) recordLiveMoveIntoNewNode(node, from, parent);
        // Before anything below can resize the node — retarget, attached children, the plan's writes.
        const pivotHold = plan ? holdEditPlanPivot(plan) : holdUnrotatedCorner(node);
        // Before the node's own writes, so none lands on a property it is leaving (see releaseRewiredBindings).
        if (wn.componentPropertyReferences) releaseRewiredBindings(node, Object.keys(wn.componentPropertyReferences).map((field) => BINDING_FIELD_WIRE_KEYS[field].wire));
        if (instance) applyInstanceRetarget(fail, node, instance);
        if (component?.definitions) applyComponentDefinitionEdit(fail, node, component.definitions);
        if (pathData !== undefined && node.type === "VECTOR") applyVectorPath(node, pathData);
        if (plan) applyEditPlanWrites(fail, plan, ctx);
        if (component?.binding) applyComponentBindingEdit(fail, node, component.binding);
        if (key !== undefined) writeKey(node, key as string);
        if (wn.componentPropertyReferences) {
          if (!ctx.bindings) throw new Error(at + ": componentPropertyReferences has no declaring component.");
          ctx.bindings.push({ node, refs: wn.componentPropertyReferences });
        }
        if ("appendChild" in node) for (const child of wn.children ?? []) attachBuiltChild(node, child, ctx, liveParentAttachFacts(node, child.sourcePath ?? at), c => node.appendChild(c));
        resettleMovedNode(node, words, ctx);
        if (plan) { settleEditPlanSizes(fail, plan); settleEditPlanPositions(fail, plan); }
        else settleCentrePivot(node, pivotHold, words);
        if (instance) applyInstanceOverrides(node, instance, ctx, at);
        if (wn.source) wn.source.id = node.id;
        return node;
      } catch (cause) { throw fail(cause); }
    } });
  }
  return plans;
}
