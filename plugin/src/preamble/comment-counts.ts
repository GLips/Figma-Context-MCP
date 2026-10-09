/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
/**
 * How many unresolved comment threads point at each node — the `comments: n` on read results.
 *
 * The server sends pins (anchor frame + offset); the guess at the node under each pin runs here, on live
 * geometry, through the same core hit-test the REST comments tool uses. Each thread lands on exactly one
 * node, so counts add up across a tree. Page-anchored threads point at no node and aren't counted.
 *
 * One fetch per execution: the preamble is evaluated afresh for every run, so this module's memo dies
 * with the run — which is also what keeps one user's comments out of another's run.
 */
import { hitTestCommentPin, type CommentPinGeometry } from "@framelink/core";
import { sceneFigma as figma } from "./scene-access.js";
import { requestHostCommentPins, type HostCommentPin } from "./host.js";
import { isReadableSceneNode, readableChildren } from "./scene-readability.js";

export type CommentCounts = ReadonlyMap<string, number>;

let counts: Promise<CommentCounts> | undefined;

/** Counts for this run, fetched on first use. Empty, never an error, when comments can't be read. */
export function readCommentCounts(): Promise<CommentCounts> {
  counts ??= loadCommentCounts();
  return counts;
}

// A node a hit-test can't read (orphaned slot content) is treated as invisible: skipped, never fatal.
const livePinGeometry: CommentPinGeometry<BaseNode> = {
  bounds: (node) => ("absoluteBoundingBox" in node ? node.absoluteBoundingBox : null),
  visible: (node) => isReadableSceneNode(node) && (!("visible" in node) || node.visible),
  clipsContent: (node) => "clipsContent" in node && node.clipsContent,
  children: (node) => ("children" in node ? (readableChildren<BaseNode>(node) ?? []) : []),
};

async function loadCommentCounts(): Promise<CommentCounts> {
  const tally = new Map<string, number>();
  // Only private org plugins get the file key (manifest `enablePrivatePluginApi`); without it, no counts.
  const fileKey = figma.fileKey;
  if (!fileKey) return tally;
  const pins = await requestHostCommentPins(fileKey);
  for (const pin of pins ?? []) {
    const assigned = await assignPin(pin).catch(() => null);
    if (assigned) tally.set(assigned, (tally.get(assigned) ?? 0) + 1);
  }
  return tally;
}

// The id the thread counts against, or null for a page pin or a deleted anchor. Throws when Figma
// can't walk the anchor (another page not loaded under dynamic-page); the caller drops that one pin.
async function assignPin(pin: HostCommentPin): Promise<string | null> {
  const anchor = await figma.getNodeByIdAsync(pin.nodeId);
  if (!anchor || anchor.removed || anchor.type === "PAGE" || anchor.type === "DOCUMENT") return null;
  const box = livePinGeometry.bounds(anchor);
  const below = box
    ? hitTestCommentPin(anchor, { x: box.x + pin.x, y: box.y + pin.y }, livePinGeometry)
    : [];
  return (below[below.length - 1] ?? anchor).id;
}
