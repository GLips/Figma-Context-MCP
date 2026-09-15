import { compileBindingBag, bindingFieldsForType } from "./flcm.js";
import { normalizePathData } from "./path.js";
// Live identities compile as edits. The bridge receives closures so its write walk need not
// import the edit orchestration that already depends on the bridge.
import type { WriteNode } from "./ir.js";
import { treeNodes } from "./compile-tree.js";
import { resolveTarget, createResolvedTargets } from "./read.js";
import { compileEditPlan, loadEditResources, assertEditPlanLands, applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions } from "./edit-plan.js";
import { resolveInstanceEditTargets, planInstanceEdit, applyInstanceRetarget, applyInstanceOverrides } from "./instance.js";
import { resolveComponentEditTargets, planComponentEdit, applyComponentDefinitionEdit, applyComponentBindingEdit } from "./component-edit.js";
import { assertNodeStillOnCanvas } from "./freshness.js";
import { childListClosingInstanceOf, writeKey } from "./identity.js";
import { assertLiveNodeLandsUnderParent, liveParentAttachFacts, attachBuiltChild, resettleMovedNode, applyVectorPath } from "./bridge.js";
import type { RenderCtx, RenderResources } from "./bridge.js";
import { beginMutatingApply } from "./verb-error.js";
import type { EditDelta } from "./schema.js";

function assertSceneNode(node: BaseNode): asserts node is SceneNode {
  if (node.type === "PAGE" || node.type === "DOCUMENT") throw new Error("a page or document cannot be placed as a scene node.");
}

export async function loadLiveTree(tree: WriteNode): Promise<LoadedLiveTree> {
  const entries = [];
  for (const wn of treeNodes(tree)) {
    if (!wn.liveId) continue;
    const at = wn.sourcePath!;
    try {
      const node = await resolveTarget({ id: wn.liveId });
      assertSceneNode(node);
      if (wn.authoring!.svg !== undefined) throw new Error("svg has no live geometry edit: importing markup can change node types and child identities. Move with { id }, or omit the id to import new artwork.");
      if (wn.source?.type !== undefined && wn.source.type !== "IMAGE-SVG" && wn.source.type !== node.type) throw new Error("type " + wn.source.type + " does not match live " + node.type + ".");
      wn.type = node.type;
      const { key, d, componentPropertyReferences, ...delta } = wn.authoring!;
      if (componentPropertyReferences !== undefined) {
        wn.componentPropertyReferences = compileBindingBag(componentPropertyReferences, bindingFieldsForType(node.type), at);
      }
      let pathData: string | undefined;
      if (d !== undefined) {
        if (node.type !== "VECTOR") throw new Error("d is a VECTOR geometry word.");
        if (typeof d !== "string" || !d.trim()) throw new Error("d must be a non-empty SVG path string.");
        pathData = normalizePathData(d);
      }
      if (key !== undefined && typeof key !== "string") throw new Error("key must be a string.");
      const changes = delta as EditDelta;
      const hint = Object.keys(delta).some(k => delta[k] !== undefined) ? compileEditPlan(node, changes, at) : undefined;
      wn.layout = hint?.patch.layout;
      const targets = createResolvedTargets();
      const current = node.type === "INSTANCE" ? await resolveInstanceEditTargets(node, hint?.instanceWords ?? {}, targets) : null;
      if (hint?.componentWords) await resolveComponentEditTargets(node, hint.componentWords, targets);
      const instance = hint?.instanceWords ? planInstanceEdit(node, hint.instanceWords, current, { targets }, at) : undefined;
      entries.push({ wn, node, changes, key, pathData, hint, targets, current, instance });
    } catch (cause) { throw new Error(at + ": " + String(cause)); }
  }
  const loaded = entries.length ? await loadEditResources(entries.flatMap(e => [...(e.hint ? [e.hint] : []), ...(e.instance?.overrides.map(o => o.plan) ?? [])]), entries.flatMap(e => e.instance ? [e.instance.needs] : [])) : { fonts: {}, images: {} };
  return { entries, loaded };
}

export interface LoadedLiveTree {
  loaded: import("./edit-plan.js").LoadedResources;
  entries: {
    wn: WriteNode; node: SceneNode; changes: EditDelta; key: unknown; pathData?: string;
    hint: import("./edit-plan.js").EditPlan | undefined;
    targets: ReturnType<typeof createResolvedTargets>;
    current: Awaited<ReturnType<typeof resolveInstanceEditTargets>> | null;
    instance: ReturnType<typeof planInstanceEdit> | undefined;
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
    const { wn, node, changes, key, pathData, targets, current } = entry;
    const at = wn.sourcePath!;
    assertNodeStillOnCanvas(node, at);
    if (childListClosingInstanceOf(node, false)) throw new Error(at + ": cannot move a component instance's sublayer; edit its main component.");
    if (wn.children?.length && (!("appendChild" in node) || childListClosingInstanceOf(node, true))) throw new Error(at + ".children: this live node's child list cannot be authored.");
    const plan = entry.hint ? compileEditPlan(node, changes, at) : undefined;
    wn.layout = plan?.patch.layout;
    const instance = plan?.instanceWords ? planInstanceEdit(node, plan.instanceWords, current, { targets, fonts: resources.fonts }, at) : undefined;
    const component = plan?.componentWords ? planComponentEdit(node, plan.componentWords, targets, at) : undefined;
    // Placement validates against the destination. Font coverage and node-local legality still
    // use the edit gate, with parent-relative words withheld until that destination exists.
    if (plan) assertEditPlanLands({ ...plan, patch: { ...plan.patch, layout: undefined } }, resources.fonts, at);
    if (instance) for (const [tree, instancePlan] of instance.needs.plans) (resources.instances as Map<WriteNode, typeof instancePlan>).set(tree, instancePlan);
    if (wn.componentPropertyReferences) {
      wn.visible = plan?.patch.visible ?? node.visible;
      if (node.type === "TEXT") {
        wn.text = plan?.patch.runs ? undefined : plan?.patch.text ?? node.characters;
        wn.runs = plan?.patch.runs;
      }
    }
    plans.set(wn, { node, component: instance?.swapTo ?? current, place(parent, place, ctx) {
      const fail = beginMutatingApply(at, node);
      try {
        for (let p: BaseNode | null = parent; p; p = p.parent) if (p === node) throw new Error(at + ": a node cannot move inside itself or its descendant.");
        const words = assertLiveNodeLandsUnderParent(node, parent, at, plan?.patch.layout);
        place(node);
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
        resettleMovedNode(node, words);
        if (plan) { settleEditPlanSizes(fail, plan); settleEditPlanPositions(fail, plan); }
        if (instance) applyInstanceOverrides(node, instance, ctx, at);
        if (wn.source) wn.source.id = node.id;
        return node;
      } catch (cause) { throw fail(cause); }
    } });
  }
  return plans;
}
