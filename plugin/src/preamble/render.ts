// render — the one place a compiled tree becomes live nodes. Split from flcm.ts (the compilers)
// because its PREPARE reaches the edit compile through instance.ts (an INSTANCE's overrides
// are edit deltas resolved against the live component), and edit-plan.ts imports the compilers'
// leaf compilers — so a render living beside the compilers would close a module cycle.

import { requestAnnotationCategories, requestTreeAnnotationCategories, resolveAnnotationCategories } from "./annotation-categories.js";
import { WriteNode, Handle } from "./ir.js";
import { loadLiveTree, gateLiveTree, LoadedLiveTree } from "./live-tree.js";
import { assertSizingResolvesAgainstParentFrame } from "./layout-legality.js";
import { loadFontsForTree, loadFontsForTextEdits } from "./fonts.js";
import { assertExposureTree, type ExposureContext } from "./instance-exposure.js";
import { buildNode, placeRootOnPage, resolvePercents, beginRenderWalk, RenderCtx, RenderResources } from "./bridge.js";
import { describeRootOverlap } from "./root-overlap.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { fetchImagesForTrees, assertNoComponentPropertyBindings } from "./flcm.js";
import { resolveInstanceTreeTargets, planInstanceTree } from "./instance.js";
import { LoadedResources, InstanceNeeds } from "./edit-plan.js";
import { createResolvedTargets, ResolvedTargets } from "./read.js";

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
  return { images: { ...live.loaded.images, ...images }, fonts: { ...live.loaded.fonts, ...fonts }, targets, live };

  // The tree's own text fonts (and its slot content's), plus every override delta's (an override
  // retypes a live sublayer — the same live-then-authored load an edit makes). Keyed by (family,
  // weight, italic) on both sides, so the merge can't collide on a different meaning.
  async function loadAllFonts() {
    const own = await loadFontsForTree(trees.length === 1 ? tree : { type: "FRAME", children: trees });
    if (!needs.fontNeeds.length) return own;
    return { ...own, ...(await loadFontsForTextEdits(needs.fontNeeds)) };
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
export function gateTreeResources(tree: WriteNode, loaded: LoadedTreeResources, exposure: ExposureContext = {}): RenderResources {
  assertExposureTree(tree, exposure);
  const needs: InstanceNeeds = planInstanceTree(tree, { targets: loaded.targets, fonts: loaded.fonts });
  const resources: RenderResources = { fonts: loaded.fonts, images: loaded.images, instances: needs.plans };
  resources.live = gateLiveTree(loaded.live, resources);
  return resources;
}

/**
 * The build sequence a compiled ROOT gets when it lands on the page: build the tree (percent children at
 * a provisional size), apply the root's own position words against the page, fold every percent and
 * anchor into pixels now that each parent's realized size is readable, and tell the agent when the
 * root landed on top of something.
 *
 * Shared rather than copied because `flcm.component`'s compiled form promises the agent its tree renders
 * "exactly as flcm.render would" — a second hand-rolled copy of these four steps makes that promise
 * false the first time one of them changes. The caller owns the ctx: whether bindings are collected
 * is the caller's declaration, not this function's (see RenderCtx.bindings).
 */
export function buildTreeOnPage(tree: WriteNode, ctx: RenderCtx): any {
  const live = ctx.live?.get(tree);
  const root = live ? live.place(live.node.parent!, () => {}, ctx) : buildNode(tree, ctx);
  // The root's own position words (absolute x/y, pin, anchor) apply against the page — the walk
  // above only positions CHILDREN, and edit applies the same words to a page child.
  if (!live && tree.layout) placeRootOnPage(root, tree.layout, ctx);
  resolvePercents(ctx);
  // After resolvePercents, so the root's bounds are final — and through the CONSOLE channel, which
  // every already-installed plugin already returns. A new field on EXECUTE_CODE_RESULT would be a
  // protocol bump, i.e. a manual manifest re-import for every user, to say something this advisory.
  // ADR-0010 buys exactly this: placement feedback ships with the server.
  const overlap = describeRootOverlap(root);
  if (overlap) console.log(overlap);
  return root;
}

export { render } from "./structure.js";
