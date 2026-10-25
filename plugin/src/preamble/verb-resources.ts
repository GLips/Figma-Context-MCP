/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// verb-resources — what every mutating verb loads in prepare and resolves in its gate, before the
// seal: a compiled tree's (render, the inserts, flcm.component), an edit delta's (edit, editMany,
// clone), and the live nodes either names. One module because the loads recurse — an edit's slot
// content is a tree whose live nodes are edits again — and because it sits ABOVE the stages it
// drives (edit-plan, instance, live-tree's gate), which never import it back.

import { requestAnnotationCategories, requestTreeAnnotationCategories, resolveAnnotationCategories } from "./annotation-categories.js";
import type { WriteNode, LiveRef, ComponentPropertyBinding } from "./ir.js";
import { gateLiveTrees } from "./live-tree.js";
import { loadFontsForTree, loadFontsForTextEdits, type EditFontNeed, type FontMap } from "./fonts.js";
import { collectTokenRefs, resolveTokenRefs, mergeResolvedTokens, NO_TOKENS, type ResolvedTokens } from "./tokens.js";
import { assertExposureTree, type ExposureContext } from "./instance-exposure.js";
import { assertBuiltInteriorLegal, type InstancePlan, type InstancePlans, type RenderResources } from "./bridge.js";
import { fetchImagesForTrees } from "./image-prefetch.js";
import { resolveInstanceTreeTargets, planInstanceTree, resolveInstanceEditTargets, planInstanceEdit } from "./instance.js";
import { compileEditPlan, type EditPlan, type InstanceNeeds } from "./edit-plan.js";
import { resolveTarget, createResolvedTargets, type ResolvedTargets } from "./target.js";
import { treeNodes, childTreeNodes } from "./compile-tree.js";
import { captureReadDependencies, NO_READ_DEPENDENCIES, type ReadDependencies } from "./call-obligations.js";
import { deriveBuiltNodeObligations, deriveBuiltStretchObligations, deriveConcurrentEditObligations, deriveLiveEntryObligations, liveObligationSite, obligationsOnTarget } from "./obligation-derivation.js";
import { recordObligations } from "./obligation.js";
import { compileBindingBag } from "./compile-component-words.js";
import { bindableFieldsOf } from "./vocabulary.js";
import { normalizePathData, normalizeVectorPaths } from "./path.js";
import type { EditDelta } from "./schema.js";
import { resolveInstanceMains, type InstanceMains } from "./operation-schedule.js";
import { liveSublayerId } from "@framelink/core";
import { FlcmError, locateFailure } from "./flcm-error.js";

/** What a tree's prepare loaded, for its gate to finish: the resources, plus the targets its instances name. */
export interface LoadedTreeResources extends LoadedResources {
  targets: ResolvedTargets;
  live: LoadedLiveTree;
}

// The resource loads a tree needs before ANY node is created — every target its INSTANCE nodes
// name (component + swap values, the reads that have to be async), then fonts and image bytes in
// parallel (neither depends on the other, and they're a run's two slowest awaits), then the
// annotation categories its notes name. Shared by render, flcm.component and the structural insert
// verbs, which owe the same guarantee: a blocked url, an oversize image, an unknown component or
// an unreachable host aborts with zero mutations. Only the categories can outlive a failure, and
// the lock removes those (mutation-lock.ts).
//
// The instance plans are made TWICE: here, as the HINT of what to load (an override's text delta
// decides which live fonts to load, so the font load depends on it — a chain of in-document
// lookups, never a host round trip), and again in the verb's gate (gateTreeResources), against the
// document as it stands at the seal, which is the plan the build walk gets.
//
// Fonts and images both settle BEFORE this resolves or rejects (hand-rolled: the tsconfig lib pins
// the QuickJS floor below ES2020's allSettled). A fail-fast Promise.all would release the verb's
// queue slot while the sibling await is still in flight — the next verb's prepare could then issue
// a second image request beside the orphaned one, breaking "one in-flight fetch per run" (the host
// comment relies on it). A separate `failed` flag, not a sentinel on the reason: a promise can
// legally reject with undefined, and mistaking that for success would carry a missing resource map
// into the SEALED apply span. Both catch handlers attach before either await — attaching the second
// only after the first settles would leave an early font rejection briefly unhandled and mis-order
// which failure wins.
export async function loadTreeResources(tree: WriteNode): Promise<LoadedTreeResources> {
  const live = await loadLiveTree(tree);
  const targets = createResolvedTargets();
  await resolveInstanceTreeTargets(tree, targets);
  const needs = planInstanceTree(tree, { targets });
  // The tree and every slot content tree its instances fill: one image request, one font load.
  const trees = [tree, ...needs.slotContentTrees];
  trees.forEach(requestTreeAnnotationCategories);
  for (const { patch } of needs.fontNeeds) requestAnnotationCategories(patch.annotations);
  // Tokens before fonts: a font variable's mode values and a text style's font are font needs too.
  const tokens = mergeResolvedTokens(
    live.loaded.tokens,
    await resolveTokenRefs(collectTokenRefs([...trees, ...needs.fontNeeds.map((n) => n.patch)])),
  );
  let failed = false;
  let firstFailure: unknown;
  const settled = <V>(p: Promise<V>) =>
    p.catch((err: unknown) => {
      if (!failed) {
        failed = true;
        firstFailure = err;
      }
      return undefined as unknown as V;
    });
  const settledImages = settled(fetchImagesForTrees(trees));
  const settledFonts = settled(loadAllFonts());
  const images = await settledImages;
  const fonts = await settledFonts;
  if (failed) throw firstFailure;
  // Categories last of the three: resolving one can CREATE a file-scoped category, so a tree whose
  // image or font load was going to fail anyway never creates one to be cleaned up again.
  await resolveAnnotationCategories();
  return { images: { ...live.loaded.images, ...images }, fonts: { ...live.loaded.fonts, ...fonts }, tokens, targets, live };

  // The tree's own text fonts (and its slot content's), plus every override delta's (an override
  // retypes a live sublayer — the same live-then-authored load an edit makes). Keyed by (family,
  // weight, italic) on both sides, so the merge can't collide on a different meaning.
  async function loadAllFonts() {
    const own = await loadFontsForTree(trees.length === 1 ? tree : { type: "FRAME", children: trees }, tokens);
    if (!needs.fontNeeds.length) return own;
    return { ...own, ...(await loadFontsForTextEdits(needs.fontNeeds, [], tokens)) };
  }
}

/**
 * The GATE half of loadTreeResources, sync, immediately before the verb's seal: plan every INSTANCE
 * node against the document as it stands now — the component's definitions, its variant, its
 * layout mode, the sublayers its override paths name. Handing the plans the fonts is what makes
 * each override's compile the full stage-4 gate, font coverage included (instance.ts
 * compileOverride); the tree's own texts need no such proof, since their fonts are authored, not
 * live. The plans the build walk consumes are these, never prepare's.
 */
export function gateTreeResources(tree: WriteNode, loaded: LoadedTreeResources, subject: string, exposure: ExposureContext = {}): RenderResources {
  assertExposureTree(tree, exposure);
  assertBuiltInteriorLegal(tree);
  const needs: InstanceNeeds = planInstanceTree(tree, { targets: loaded.targets, gate: loaded });
  return gatedRenderResources(loaded, needs.plans, [loaded.live], subject, exposure.destination);
}

// The apply span's resources: what prepare loaded, the instance plans, the live nodes of `trees`
// gated with their schedule made, and how the walk records what each node it builds owes.
function gatedRenderResources(loaded: LoadedResources, instances: InstancePlans, trees: readonly LoadedLiveTree[], subject: string, destination?: BaseNode): RenderResources {
  const gate = { fonts: loaded.fonts, tokens: loaded.tokens };
  const resources: RenderResources = {
    ...gate, images: loaded.images, instances, live: new Map(),
    recordBuiltWords: (wn, node, parent, stretched) => {
      recordObligations(obligationsOnTarget(deriveBuiltNodeObligations(wn, node, gate, parent, instances.get(wn)), { node }, wn.sourcePath ?? subject));
      if (stretched) recordObligations(obligationsOnTarget(deriveBuiltStretchObligations(stretched.axis), { node }, stretched.by));
    },
  };
  const { nodes, landing } = gateLiveTrees(trees, resources, subject, destination);
  return nodes.size ? { ...resources, live: nodes, liveLanding: landing } : resources;
}

/**
 * Stage 3 — the verb's resource awaits, and the only suspension between the compiles and the seal.
 * ONE font load and ONE image request however many entries there are: a batch is one verb, so it
 * owes one round trip, and every extra suspension is another instant the user can edit across.
 *
 * `plans` and `needs` are prepare's HINT plans — what the deltas need loaded if the document stays
 * as it is. `needs` is every INSTANCE entry's slot content: the one way a delta BUILDS nodes, so
 * the one way an edit's resources carry tree fonts at all. The instance PLANS are not here: those
 * are the gate's to make, against the document at the seal (instance.ts planInstanceEdit).
 *
 * `beforeLoads` runs once the tokens resolve and before the fonts and images: where a verb reads
 * what its words depend on (call-obligations.ts captureReadDependencies). The token lookups before
 * it are a window the drift check doesn't cover.
 */
export async function loadEditResources(
  plans: readonly EditPlan[], needs: readonly InstanceNeeds[] = [], beforeLoads?: (tokens: ResolvedTokens) => void,
): Promise<LoadedResources> {
  const trees: WriteNode[] = [];
  const fontNeeds: EditFontNeed[] = [];
  for (const need of needs) {
    trees.push(...need.slotContentTrees);
    fontNeeds.push(...need.fontNeeds);
  }
  const liveTrees: LoadedLiveTree[] = [];
  const intoNewNode = liveChildrenOfNewNodes(trees);
  for (const tree of trees) liveTrees.push(await loadLiveTree(tree, intoNewNode));
  for (const tree of trees) requestTreeAnnotationCategories(tree);
  for (const { patch } of [...plans, ...fontNeeds]) requestAnnotationCategories(patch.annotations);
  // Tokens first: a font variable's mode values and a text style's font are font needs of their own.
  const tokens = mergeResolvedTokens(
    await resolveTokenRefs(collectTokenRefs([...[...plans, ...fontNeeds].map((p) => p.patch), ...trees])),
    ...liveTrees.map((live) => live.loaded.tokens),
  );
  beforeLoads?.(tokens);
  // Slot content is BUILT, so its fonts are a tree's, not a delta's — folded into the same load.
  const fonts = await loadFontsForTextEdits([...plans, ...fontNeeds], trees, tokens);
  const images = await fetchImagesForTrees([...plans.map((plan) => plan.patch), ...trees]);
  // Categories last of the three: resolving one can CREATE a file-scoped category, so a batch whose
  // font or image load was going to fail anyway never creates one to be cleaned up again.
  await resolveAnnotationCategories();
  for (const live of liveTrees) { Object.assign(fonts, live.loaded.fonts); Object.assign(images, live.loaded.images); }
  return { fonts, images, tokens, liveTrees };
}

/** What stage 3 loaded — everything the apply span needs except the instance plans the gate makes. */
export interface LoadedResources {
  liveTrees?: LoadedLiveTree[];
  fonts: FontMap;
  images: Record<string, string>;
  tokens: ResolvedTokens;
}

/**
 * The apply span's resources: what stage 3 loaded, plus the instance plans the gate made for the
 * slot content this verb builds — every entry's, merged, since a batch walks its content once.
 */
export function gateEditResources(loaded: LoadedResources, needs: readonly InstanceNeeds[], subject: string): RenderResources {
  const instances = new Map<WriteNode, InstancePlan>();
  for (const need of needs) need.plans.forEach((plan, wn) => instances.set(wn, plan));
  return gatedRenderResources(loaded, instances, loaded.liveTrees ?? [], subject);
}

function assertSceneNode(node: BaseNode): asserts node is SceneNode {
  if (node.type === "PAGE" || node.type === "DOCUMENT") throw new FlcmError("authoring", "a page or document cannot be placed as a scene node.");
}

// Live nodes whose spec parent this verb builds: a new node's children, or a new instance's slot
// content. Taken across every tree a verb loads, because an edit's slot content lists a nested new
// instance's slot content again as a root of its own.
export function liveChildrenOfNewNodes(trees: readonly WriteNode[]): Set<WriteNode> {
  return new Set(trees.flatMap(treeNodes).flatMap(wn => wn.liveId !== undefined ? [] : childTreeNodes(wn)));
}

export async function loadLiveTree(tree: WriteNode, intoNewNode = liveChildrenOfNewNodes([tree])): Promise<LoadedLiveTree> {
  const entries = new Map<LiveRef, LoadedLiveEntry>();
  const live: { ref: LiveRef; node: SceneNode }[] = [];
  for (const ref of treeNodes(tree)) {
    if (ref.liveId === undefined) continue;
    try {
      const node = await resolveTarget({ id: ref.liveId });
      assertSceneNode(node);
      if (ref.authoring.svg !== undefined) throw new FlcmError("authoring", "svg has no live geometry edit: importing markup can change node types and child identities. Move with { id }, or omit the id to import new artwork.");
      if (ref.source.type !== undefined && ref.source.type !== "IMAGE-SVG" && ref.source.type !== node.type) throw new FlcmError("authoring", "type " + ref.source.type + " does not match live " + node.type + ".");
      live.push({ ref, node });
    } catch (cause) { throw locateFailure(cause, { path: ref.sourcePath }); }
  }
  for (const { ref, node } of live) {
    const at = ref.sourcePath;
    try {
      const { key, d, vectorPaths, componentPropertyReferences, ...delta } = ref.authoring;
      const refs = componentPropertyReferences === undefined ? undefined : compileBindingBag(componentPropertyReferences, bindableFieldsOf(node.type), at);
      let pathData: VectorPaths | undefined;
      if (d !== undefined) {
        if (node.type !== "VECTOR") throw new FlcmError("authoring", "d is a VECTOR geometry word.");
        if (typeof d !== "string" || !d.trim()) throw new FlcmError("authoring", "d must be a non-empty SVG path string.");
        pathData = [{ data: normalizePathData(d), windingRule: "NONZERO" }];
      }
      if (vectorPaths !== undefined) {
        if (node.type !== "VECTOR" || d !== undefined) throw new FlcmError("authoring", "vectorPaths requires a VECTOR and cannot be combined with d.");
        pathData = normalizeVectorPaths(vectorPaths);
      }
      if (key !== undefined && typeof key !== "string") throw new FlcmError("authoring", "key must be a string.");
      const changes = delta as EditDelta;
      const hint = Object.keys(delta).some(k => delta[k] !== undefined) ? compileEditPlan(node, changes, at) : undefined;
      const targets = createResolvedTargets();
      const current = node.type === "INSTANCE" ? await resolveInstanceEditTargets(node, hint?.instanceWords ?? {}, targets) : null;
      const instance = hint?.instanceWords ? planInstanceEdit(node, hint.instanceWords, current, { targets }, at) : undefined;
      entries.set(ref, { ref, node, changes, key, refs, pathData, hint, targets, current, instance, intoNewNode: intoNewNode.has(ref) });
    } catch (cause) { throw locateFailure(cause, { path: at }); }
  }
  const prepared = [...entries.values()];
  let dependencies = NO_READ_DEPENDENCIES;
  const capture = (tokens: ResolvedTokens) => {
    dependencies = captureReadDependencies(prepared.flatMap((e) => [
      ...(e.hint ? deriveConcurrentEditObligations(e.hint, e.instance, tokens, liveObligationSite(e.node), e.ref.sourcePath) : []),
      ...obligationsOnTarget(deriveLiveEntryObligations(e.key as string | undefined, e.pathData, e.refs), { node: e.node }, e.ref.sourcePath),
    ]));
  };
  const loaded = prepared.length
    ? await loadEditResources(prepared.flatMap(e => [...(e.hint ? [e.hint] : []), ...(e.instance?.overrides.map(o => o.plan) ?? [])]), prepared.flatMap(e => e.instance ? [e.instance.needs] : []), capture)
    : { fonts: {}, images: {}, tokens: NO_TOKENS };
  // What each live node and override path inherits from, so the tree orders a main component's
  // edit before the layers that show it, through nested instances too (operation-schedule.ts).
  const mains = await resolveInstanceMains(prepared.flatMap((e) => [
    e.node,
    ...(e.instance?.overrides ?? []).map((o) => ({ id: liveSublayerId(e.node.id, o.path), type: o.plan.node.type })),
  ]));
  return { tree, entries, loaded, dependencies, mains };
}

/** One live node a tree names, resolved in prepare: the node, its words split by who resolves them, and the hint plans. */
export interface LoadedLiveEntry {
  ref: LiveRef; node: SceneNode;
  /** Every edit word it states. */
  changes: EditDelta;
  key: unknown; pathData?: VectorPaths;
  /** The binding bag the author stated, compiled against the live node's type. */
  refs?: ComponentPropertyBinding;
  hint: EditPlan | undefined;
  targets: ReturnType<typeof createResolvedTargets>;
  current: Awaited<ReturnType<typeof resolveInstanceEditTargets>> | null;
  instance: ReturnType<typeof planInstanceEdit> | undefined;
  intoNewNode: boolean;
}

export interface LoadedLiveTree {
  tree: WriteNode;
  loaded: LoadedResources;
  entries: ReadonlyMap<LiveRef, LoadedLiveEntry>;
  /** What prepare read of every entry's words before the loads, for the gate's drift check. */
  dependencies: ReadDependencies;
  /** Each instance's main component its live nodes and override paths sit in, as prepare resolved it. */
  mains: InstanceMains;
}

