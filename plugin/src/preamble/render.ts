/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Tree landing — the prepare/gate pair every verb that lands a compiled tree runs before its seal
// (render and the insert verbs in structure.ts, flcm.component), and landTree, the one path its root
// takes into a parent. Split from flcm.ts (the compilers) because the PREPARE reaches the edit compile
// through instance.ts (an INSTANCE's overrides are edit deltas resolved against the live component),
// and edit-plan.ts imports the compilers' leaf compilers — so living beside the compilers would close
// a module cycle.

import { requestAnnotationCategories, requestTreeAnnotationCategories, resolveAnnotationCategories } from "./annotation-categories.js";
import { WriteNode } from "./ir.js";
import { loadLiveTree, gateLiveTree, LoadedLiveTree } from "./live-tree.js";
import { loadFontsForTree, loadFontsForTextEdits } from "./fonts.js";
import { collectTokenRefs, resolveTokenRefs, mergeResolvedTokens } from "./tokens.js";
import { assertExposureTree, type ExposureContext } from "./instance-exposure.js";
import { attachBuiltChild, liveParentAttachFacts, settleApplySpan, assertBuiltInteriorLegal, RenderCtx, RenderResources } from "./bridge.js";
import { describeRootOverlap } from "./root-overlap.js";
import { fetchImagesForTrees } from "./image-prefetch.js";
import { resolveInstanceTreeTargets, planInstanceTree } from "./instance.js";
import { LoadedResources, InstanceNeeds } from "./edit-plan.js";
import { createResolvedTargets, ResolvedTargets } from "./target.js";

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
export function gateTreeResources(tree: WriteNode, loaded: LoadedTreeResources, exposure: ExposureContext = {}): RenderResources {
  assertExposureTree(tree, exposure);
  assertBuiltInteriorLegal(tree);
  const needs: InstanceNeeds = planInstanceTree(tree, { targets: loaded.targets, fonts: loaded.fonts });
  const resources: RenderResources = { fonts: loaded.fonts, images: loaded.images, tokens: loaded.tokens, instances: needs.plans, live: new Map() };
  return { ...resources, live: gateLiveTree(loaded.live, resources) };
}

/**
 * Land a compiled tree's root in `parent` and settle it: attach it through the same attach-then-size
 * entry the build walk gives every child, then fold every percent into pixels now that each parent's
 * realized size is readable. Every tree-placing verb lands through here — render and the insert
 * verbs into their destination, flcm.component onto the page (or a live root where it stands, with a
 * `place` that leaves it there) — so a root lands the same way whichever verb placed it.
 *
 * `noteOverlap` is for a root the agent placed on the page without seeing it: the note goes through
 * the CONSOLE channel, which every installed plugin already returns. A new field on
 * EXECUTE_CODE_RESULT would be a protocol bump (a manual manifest re-import) for an advisory;
 * ADR-0010 buys exactly this — placement feedback ships with the server.
 */
export function landTree(parent: any, place: (node: any) => void, tree: WriteNode, ctx: RenderCtx, subject: string, noteOverlap: boolean): any {
  const root = attachBuiltChild(parent, tree, ctx, liveParentAttachFacts(parent, subject), place);
  settleApplySpan(ctx.span);
  if (noteOverlap) {
    const overlap = describeRootOverlap(root);
    if (overlap) console.log(overlap);
  }
  return root;
}
