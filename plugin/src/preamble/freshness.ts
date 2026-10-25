/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// freshness — the gate-phase refusals every mutating verb shares (mutation-lock.ts on the phase
// rule). A verb's prepare resolves nodes and loads pages across awaits the user has the document
// open across; its synchronous gate asks these, against the document as it stands at the seal,
// before anything is written. Each is the one concurrent-edit error (flcm-error.ts): whatever moved,
// the file was edited in Figma while the call ran.

import { ConcurrentEditError } from "./flcm-error.js";

/**
 * A node prepare resolved is still on the canvas. Figma keeps accepting writes on a removed node
 * and reporting them as success, so this is the one existence check that cannot be left to the
 * apply span's own refusals.
 */
export function assertNodeStillOnCanvas(node: SceneNode, path: string): void {
  if (!node.removed) return;
  throw new ConcurrentEditError({ path, node: { type: node.type, name: node.name, id: node.id }, changed: "it was deleted" });
}

/**
 * The pages a verb's prepare loaded. Under the manifest's `documentAccess: dynamic-page` a
 * PageNode's `children`/`appendChild`/`insertChild` all throw until the page is loaded — [verified,
 * plugin-typings 1.133: the note on each of those members] — and loading is async, so it is
 * prepare's. WHICH page is a hint read then (a destination's, as it stood); the gate proves the
 * page the destination is on at the seal is one of these, so a node the user dragged to another
 * page during the loads refuses here rather than as Figma's own throw from inside the span.
 */
export type LoadedPages = Set<string>;

export function createLoadedPages(): LoadedPages {
  return new Set();
}

/** Prepare's half: load `node` if it is a page, and record it. Anything else is a scene node the resolution already materialized. */
export async function loadPageForWrite(node: any, pages: LoadedPages): Promise<void> {
  if (!node || node.type !== "PAGE") return;
  await node.loadAsync();
  pages.add(node.id);
}

/** The gate's half: `parent` is a scene node, or a page prepare loaded. */
export function assertPageLoaded(parent: any, pages: LoadedPages, path: string): void {
  if (!parent || parent.type !== "PAGE" || pages.has(parent.id)) return;
  throw new ConcurrentEditError({
    path,
    changed: "the destination moved to page " + JSON.stringify(parent.name) + " (id " + JSON.stringify(parent.id) + "), which this call didn't load",
  });
}
