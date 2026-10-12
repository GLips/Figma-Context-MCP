/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { paintSitesOf, type LiveRef, type WriteProps } from "./ir.js";
import { requestHostImages } from "./host.js";

// Every url-backed image paint in a tree, over the same sites the bridge paints (paintSitesOf).
// A hash-backed image already names bytes in the document, so it is no source to fetch.
function imageUrlsOf(tree: WriteProps | LiveRef, out: string[]): void {
  // A live node's paints are its edit delta's, fetched with the live tree (live-tree.ts); its
  // children are this tree's.
  if (!("liveId" in tree)) {
    for (const { stack } of paintSitesOf(tree)) for (const paint of stack) if (paint.kind === "image" && "url" in paint) out.push(paint.url);
  }
  for (const child of tree.children ?? []) imageUrlsOf(child, out);
}

// Fetch bytes for every image paint in `trees` through the host channel in ONE deduped request,
// BEFORE any canvas write — a fetch failure (blocked url, oversize, unreachable) aborts with zero
// mutations. The await is the run's suspension point; a cancelled or disconnected run dies here
// when the host rejects its pending fetch. Plural because one verb owes one round trip: ten
// entries sharing a url fetch it once.
export async function fetchImagesForTrees(trees: readonly (WriteProps | LiveRef)[]): Promise<Record<string, string>> {
  const all: string[] = [];
  for (const tree of trees) imageUrlsOf(tree, all);
  const urls = Array.from(new Set(all));
  if (!urls.length) return {};
  return requestHostImages(urls);
}
