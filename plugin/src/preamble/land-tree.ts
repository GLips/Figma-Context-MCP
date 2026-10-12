/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// land-tree — the one path a compiled tree's root takes into its parent, for every verb that lands
// one (render and the insert verbs in structure.ts, flcm.component).

import { attachBuiltChild, liveParentAttachFacts, settleApplySpan, type RenderCtx } from "./bridge.js";
import { describeRootOverlap } from "./root-overlap.js";
import type { WriteNode } from "./ir.js";

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
