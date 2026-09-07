// render — the one place a spec tree becomes live nodes. Split from flcm.ts (the constructors)
// because its PREPARE reaches the edit compile through instance.ts (an instance spec's overrides
// are edit deltas resolved against the live component), and edit.ts imports the constructors'
// leaf compilers — so a render living beside the constructors would close a module cycle.

import { WriteNode, Handle } from "./ir.js";
import { assertConstructorBuiltTree } from "./provenance.js";
import { assertSizingResolvesAgainstParentFrame } from "./layout-legality.js";
import { loadFontsForTree, loadFontsForTextEdits } from "./fonts.js";
import { buildNode, placeRootOnPage, settleHandles, resolvePercents, RenderCtx, RenderResources } from "./bridge.js";
import { describeRootOverlap } from "./root-overlap.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { fetchImagesForTrees } from "./flcm.js";
import { prepareInstancePlans } from "./instance.js";

// The read-only resource loads a tree needs before ANY node is created — the instance plans
// (component + property + override resolution, which reads the document but writes nothing), then
// fonts and image bytes in parallel (neither depends on the other, and they're a run's two slowest
// awaits). Shared by render and the structural insert verbs, which owe the same guarantee: a
// blocked url, an oversize image, an unknown component or an unreachable host aborts with zero
// mutations.
//
// Instance plans resolve FIRST, alone: an override's text delta decides which live fonts to load,
// so the font load depends on it — and the resolution is a chain of in-document lookups, never a
// host round trip, so nothing is lost by not overlapping it with the image request.
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
export async function loadTreeResources(tree: WriteNode): Promise<RenderResources> {
  const { plans: instances, fontNeeds } = await prepareInstancePlans(tree);
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
  const settledImages = settled(fetchImagesForTrees([tree]));
  const settledFonts = settled(loadAllFonts());
  const images = await settledImages;
  const fonts = await settledFonts;
  if (failed) throw firstFailure;
  return { images, fonts, instances };

  // The tree's own text fonts plus every override delta's (an override retypes a live sublayer
  // — the same live-then-authored load an edit makes). Keyed by (family, weight, italic) on both
  // sides, so the merge can't collide on a different meaning.
  async function loadAllFonts() {
    const own = await loadFontsForTree(tree);
    if (!fontNeeds.length) return own;
    return { ...own, ...(await loadFontsForTextEdits(fontNeeds)) };
  }
}

// render(tree) — the one place nodes are created. Loads fonts, walks the WriteNode tree, stamps each
// `key` into pluginData('flcm/key'), and returns the built tree's top node plus a map of every keyed node. Only
// keyed nodes appear in `keyed`; a duplicate key within one render is a loud error (in bridge).
// A single expression on purpose: the queue slot is reserved before render() can possibly yield,
// which is the lock's invocation-order guarantee (see enterMutatingVerb) — don't add work above it.
function render(tree: WriteNode): Promise<{ node: Handle; keyed: Record<string, Handle> }> {
  return enterMutatingVerb(
    "render",
    // Prepare — spec checks, then the read-only resource loads (parallel: neither depends on the
    // other, and they're the run's two slowest awaits). A reject here — bad spec, blocked url,
    // oversize, unreachable — exits with zero mutations and zero undo residue, and a run the
    // server cancelled during the awaits is refused before the entry seal. Deliberate cost:
    // concurrent renders' prepares now SUM (each waits its turn in the queue slot) against the
    // server's never-suspended 45s run ceiling — and font-only prepares, which emit no bridge
    // traffic, against the 15s inactivity deadline too — where they used to overlap. The price
    // of one entry shape for every verb; a run that genuinely needs many cold fetches should
    // split its work. Upside: the per-run in-flight image cap can no longer refuse a
    // Promise.all of image renders.
    async () => {
      if (!tree || typeof tree !== "object" || typeof tree.type !== "string") {
        throw new Error("flcm.render: expected a node from flcm.frame()/text()/rect()/ellipse()/line()/svg()/path()/instance(), got " + JSON.stringify(tree) + ".");
      }
      // Authenticate provenance for the WHOLE tree before the resource loads below — a hand-built
      // node must reject with its own message, not surface as a confusing image/font error after
      // a wasted host round-trip.
      assertConstructorBuiltTree(tree);
      // The root lands on the page, which has no bounded size to resolve "fill" or a percent
      // against — reject before the image round-trip (this check needs no bytes) and before
      // buildNode, which only guards a percent on a *child*. The rule is edit's page-parent gate,
      // shared (assertSizingResolvesAgainstParentFrame), so the two verbs answer identically.
      if (tree.layout) {
        assertSizingResolvesAgainstParentFrame(tree.layout, true, "flcm");
      }
      return loadTreeResources(tree);
    },
    // Apply — node creation, sealed as one undo step.
    (resources) => {
      const ctx: RenderCtx = { ...resources, keyed: {}, pending: [] };
      // Build the tree (percent children land at a provisional size), then fold every percent/anchor into
      // pixels against each parent's now-realized size in one post-walk pass (bridge.resolvePercents).
      const root = buildNode(tree, ctx);
      // The root's own position words (absolute x/y, pin, anchor) apply against the page — the
      // walk above only positions CHILDREN, and edit applies the same words to a page child.
      if (tree.layout) placeRootOnPage(root, tree.layout, ctx);
      resolvePercents(ctx);
      // After resolvePercents, so the root's bounds are final — and through the CONSOLE channel,
      // which every already-installed plugin already returns. A new field on EXECUTE_CODE_RESULT
      // would be a protocol bump, i.e. a manual manifest re-import for every user, to say something
      // this advisory. ADR-0010 buys exactly this: placement feedback ships with the server.
      const overlap = describeRootOverlap(root);
      if (overlap) console.log(overlap);
      // Handles are minted only now: geometry settles once the whole tree is laid out (bridge.settleHandles).
      return settleHandles(root, ctx.keyed);
    },
  );
}

export { render };
