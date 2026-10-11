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
import { resolveTarget, createResolvedTargets, readStandingState } from "./read.js";
import { stableStringify, type SimplifiedNode } from "@framelink/core";
import { compileEditPlan, loadEditResources, assertEditPlanLands, applyEditPlanWrites, settleEditPlanSizes, settleEditPlanPositions, holdEditPlanPivot } from "./edit-plan.js";
import { resolveInstanceEditTargets, planInstanceEdit, applyInstanceRetarget, applyInstanceOverrides, liveSublayerIdOf } from "./instance.js";
import { planComponentEdit, applyComponentDefinitionEdit, applyComponentBindingEdit } from "./component-edit.js";
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
  const standing = new Map<string, SimplifiedNode[]>();
  const parentOf = new Map(treeNodes(tree).flatMap(parent => childTreeNodes(parent).map(child => [child, parent] as const)));
  const reflowing = new Set<WriteNode>();
  for (const wn of treeNodes(tree)) {
    if (!wn.liveId) continue;
    const at = wn.sourcePath!;
    try {
      const node = await resolveTarget({ id: wn.liveId });
      assertSceneNode(node);
      if (wn.authoring!.svg !== undefined) throw new Error("svg has no live geometry edit: importing markup can change node types and child identities. Move with { id }, or omit the id to import new artwork.");
      if (wn.source?.type !== undefined && wn.source.type !== "IMAGE-SVG" && wn.source.type !== node.type) throw new Error("type " + wn.source.type + " does not match live " + node.type + ".");
      wn.type = node.type;
      // Pre-order, so a live root's one read covers every live descendant pasted with it. A node
      // stating no words (a bare { id } move) has nothing to compare and costs no read. Judged here,
      // not at the seal: a user edit landing in between keeps the user's value for a restated word.
      const stated = Object.keys(wn.authoring!).length > 0;
      if (stated && !standing.has(node.id)) for (const [id, reads] of await readStandingState(node)) standing.set(id, reads);
      const parent = parentOf.get(wn);
      const words = changedWords(wn.authoring!, standing.get(node.id) ?? [], parent && reflowing.has(parent) ? PARENT_RELATIVE_WORDS : NO_WORDS);
      const swapped = node.type === "INSTANCE" && retargets(node, words);
      const { key, d, vectorPaths, componentPropertyReferences, ...delta } = swapped ? { ...wn.authoring! } : words;
      if (node.type === "INSTANCE" && !swapped && delta.overrides) delta.overrides = changedOverrides(node.id, delta.overrides, standing);
      if (isBag(delta.layout) ? delta.layout.mode !== undefined : "layout" in delta) reflowing.add(wn);
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
    } catch (cause) { throw new Error(at + ": " + String(cause)); }
  }
  const loaded = entries.length ? await loadEditResources(entries.flatMap(e => [...(e.hint ? [e.hint] : []), ...(e.instance?.overrides.map(o => o.plan) ?? [])]), entries.flatMap(e => e.instance ? [e.instance.needs] : [])) : { fonts: {}, images: {}, tokens: NO_TOKENS };
  return { entries, loaded };
}

// A live identity's words are a delta against the node as it stands: a word equal to what a read of
// it reports is no change, so a pasted read states nothing (an echoed binding declares nothing). A
// null is the read's word for a field at its default, so it equals absence. `held` are words whose
// context this call changes, so the read no longer describes them: they stay.
function changedWords(words: Record<string, unknown>, standing: readonly SimplifiedNode[], held: ReadonlySet<string>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [word, value] of Object.entries(words)) {
    const reads = standing.map(read => (read as unknown as Record<string, unknown>)[word]);
    if (!held.has(word) && reads.some(read => sameReadValue(read, value))) continue;
    changed[word] = PARTIAL_BAGS.has(word) && isBag(value) ? changedBagWords(value, reads.filter(isBag), held) : value;
  }
  return changed;
}

function sameReadValue(read: unknown, authored: unknown): boolean {
  return stableStringify(read ?? null) === stableStringify(authored ?? null);
}

// Bags an edit writes word by word, so a spread read with one word changed restates the rest, and
// each restated word is no change too. Re-sent, `alignItems` would un-stretch every fill child.
const PARTIAL_BAGS = new Set(["layout", "textStyle", "componentProperties", "componentPropertyReferences"]);

// A font is one identity: changing one member re-resolves the others (edit-plan.ts
// enrichFontIdentity), so a restated family beside a new weight anchors the change.
const FONT_IDENTITY_WORDS = ["fontFamily", "fontWeight", "fontStyle", "fontVariantName"];

// A child's words about its parent's flow. When the same call re-flows that parent, the read
// described the old flow, so restating them is a write.
const PARENT_RELATIVE_WORDS: ReadonlySet<string> = new Set([
  "width", "height", "position", "left", "top", "right", "bottom", "alignSelf", "justifySelf", "gridColumn", "gridRow", "zIndex",
]);
const NO_WORDS: ReadonlySet<string> = new Set();

function isBag(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function changedBagWords(bag: Record<string, unknown>, standing: readonly Record<string, unknown>[], held: ReadonlySet<string>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [word, value] of Object.entries(bag)) {
    if (held.has(word) || !standing.some(read => sameReadValue(read[word], value))) changed[word] = value;
  }
  if (FONT_IDENTITY_WORDS.some(word => word in changed)) for (const word of FONT_IDENTITY_WORDS) if (word in bag) changed[word] = bag[word];
  return changed;
}

// A swap or a variant change replaces what the instance is, so its read describes the component it
// is leaving: none of its words or overrides can be judged against it.
function retargets(instance: InstanceNode, words: Record<string, unknown>): boolean {
  if (words.componentId !== undefined) return true;
  const properties = isBag(words.componentProperties) ? Object.keys(words.componentProperties) : [];
  return properties.some(name => instance.componentProperties[name]?.type === "VARIANT");
}

// The same rule one level down: each override path is a delta against the live sublayer it names,
// so a pasted instance's echoed children (lifted into overrides by compile-tree.ts) don't pin their
// inherited values as overrides.
function changedOverrides(instanceId: string, overrides: unknown, standing: ReadonlyMap<string, SimplifiedNode[]>): unknown {
  if (!isBag(overrides)) return overrides;
  const changed: Record<string, unknown> = {};
  for (const [path, delta] of Object.entries(overrides)) {
    const sublayer = standing.get(liveSublayerIdOf(instanceId, path));
    if (!sublayer || !isBag(delta)) { changed[path] = delta; continue; }
    const words = changedWords(delta, sublayer, NO_WORDS);
    if (Object.keys(words).length) changed[path] = words;
  }
  return Object.keys(changed).length ? changed : undefined;
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
    const component = plan?.componentWords ? planComponentEdit(node, plan.componentWords, at) : undefined;
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
