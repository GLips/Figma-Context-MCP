// A render root lands on the PAGE, and a page has no layout — nothing moves aside to make room. With
// no `left`/`top` a root goes to the page origin, so a second render lands exactly on top of the
// first, and the agent (which gets back a handle, not a canvas) has no way to notice. This note is
// the only channel that tells it.
//
// Deliberately not a warning and never an error: a placement that overlaps is a fact, not a mistake,
// and the agent is the one who knows whether it meant it. State the geometry, name the prop that
// moves it, stop.
//
// PAGE LEVEL ONLY, and only for a freshly-rendered root. Overlap between children inside a frame is
// left alone — layering there is ordinary design (scrims, badges, stacked icons) and a note would
// fire on nearly every render and be tuned out within two calls. The READ path says nothing about
// any of this either: this is feedback about a placement you just made, not a property of the
// document, and re-deriving it on every get() would be pure context tax.

import { rectIntersectionArea } from "@framelink/core";
import type { SnapshotRect } from "@framelink/core/snapshot";

/** How much of the new root must be buried before it's worth a line. A hairline kiss between
 *  neighbouring artboards is normal layout; 5% is past "adjacent" and into "one is hiding the other". */
const OVERLAP_NOTE_FLOOR = 0.05;

/** At most this many neighbours are named. A root dropped onto a busy page can touch a dozen; the
 *  agent needs enough to move it, not an inventory. The rest are counted, never silently dropped. */
const OVERLAP_NOTE_MAX_NAMED = 3;

// absoluteBoundingBox rather than x/y/width/height: it is the ROTATED bounds, and a rotated node's
// raw width/height describe a box that isn't where the pixels are. Null for a node with no geometry
// (and on some degenerate vectors), which is why every caller here treats absence as "skip", not 0.
function boundsOf(node: any): SnapshotRect | null {
  const box = node.absoluteBoundingBox;
  if (!box || !(box.width > 0) || !(box.height > 0)) return null;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

const px = (n: number): string => String(Math.round(n));

const describeBox = (name: string, b: SnapshotRect): string =>
  '"' + name + '" at ' + px(b.x) + "," + px(b.y) + " (" + px(b.width) + "×" + px(b.height) + ")";

/**
 * One line of placement feedback for a just-rendered root, or null when it landed clear.
 *
 * The percentage is always "how much of THE NEW ROOT this neighbour covers" — one denominator, so
 * no legend is needed to read the line. Negative space: that means a root large enough to engulf a
 * small neighbour stays silent (the engulfed node is ~0% of the root). Deliberate — a page-sized
 * section frame swallowing an icon is usually intentional, and a second denominator would cost more
 * confusion than it buys.
 */
export function describeRootOverlap(root: any): string | null {
  const rootBox = boundsOf(root);
  if (!rootBox) return null;
  const rootArea = rootBox.width * rootBox.height;

  const hits: { text: string; share: number }[] = [];
  for (const sibling of figma.currentPage.children) {
    if (sibling === root || sibling.visible === false) continue;
    const box = boundsOf(sibling);
    if (!box) continue;
    const share = rectIntersectionArea(rootBox, box) / rootArea;
    if (share < OVERLAP_NOTE_FLOOR) continue;
    hits.push({ text: describeBox(sibling.name, box), share });
  }
  if (hits.length === 0) return null;

  // Most-buried first: if the list is truncated, the ones that survive are the ones worth moving for.
  hits.sort((a, b) => b.share - a.share);
  const named = hits
    .slice(0, OVERLAP_NOTE_MAX_NAMED)
    .map((h) => h.text + " covers " + Math.round(h.share * 100) + "% of it")
    .join("; ");
  const rest = hits.length - OVERLAP_NOTE_MAX_NAMED;

  return (
    "flcm.render: " +
    describeBox(root.name, rootBox) +
    " landed on top of " +
    hits.length +
    (hits.length === 1 ? " node" : " nodes") +
    " already on this page: " +
    named +
    (rest > 0 ? "; and " + rest + " more" : "") +
    ". Set `left`/`top` on the root to place it somewhere else."
  );
}
