/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { WriteLayout } from "./ir.js";
import { layoutModeOf } from "./layout-mode.js";

// flcm rotates about the node's centre, the way CSS `rotate()` and the Figma UI do. Figma's own
// `rotation` setter turns about the transform's translation instead — the box's top-left corner — so
// the write path keeps one invariant across a write span: an out-of-flow node's translation holds
// its UNROTATED top-left (the authored `left`/`top`), every applier writes and resizes against that,
// and the span ends by moving the translation so the turned box sits centred on the unrotated one.
// Reads report the same unrotated corner, so a `get` pastes back to where it was.
//
// An in-flow auto-layout child is the flow's to place, so none of this touches it.

interface Point { x: number; y: number }

/** Whether the parent's auto-layout owns this node's translation. */
export function isPlacedByFlow(node: any): boolean {
  const parent = node.parent;
  return !!parent && layoutModeOf(parent).kind !== "free" && node.layoutPositioning !== "ABSOLUTE";
}

// Where the unrotated corner sits relative to the translation: the centre is translation + M·half,
// and the unrotated corner is centre - half, so the offset is (M - I)·half, M being Figma's
// [[cos, sin], [-sin, cos]] for `rotation`. Built from `rotation`, not the live matrix: the read side
// (core's unrotatedCorner) only has `rotation`, and a flip hides in the matrix as a rotation of 0 or
// 180 — pivoting on the matrix would put read and write on different corners, and a pasted-back
// read would walk the node by its height.
function cornerOffsetOf(node: any): Point {
  const radians = (node.rotation * Math.PI) / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const hw = node.width / 2, hh = node.height / 2;
  return { x: (cos - 1) * hw + sin * hh, y: -sin * hw + (cos - 1) * hh };
}

function isTurned(node: any): boolean {
  return typeof node.rotation === "number" && node.rotation !== 0;
}

/** The node's unrotated top-left in its parent's frame — what `left`/`top` mean on both read and write. */
export function unrotatedCornerOf(node: any): Point {
  if (!isTurned(node)) return { x: node.x, y: node.y };
  const offset = cornerOffsetOf(node);
  return { x: node.x + offset.x, y: node.y + offset.y };
}

/** A write span's opening state for one node, threaded to its `settleCentrePivot`. */
export interface PivotHold { corner: Point; inFlow: boolean }

/**
 * Open a write span on a live node: move a turned out-of-flow node's translation onto its unrotated
 * corner, so the appliers that follow write `left`/`top` and resize as if it were unrotated. Captured
 * but not written for an in-flow node, whose translation the flow would overwrite; settle uses it if
 * the span lifts the node out of the flow.
 */
export function holdUnrotatedCorner(node: any): PivotHold | undefined {
  if (!isTurned(node)) return undefined;
  const hold = { corner: unrotatedCornerOf(node), inFlow: isPlacedByFlow(node) };
  if (!hold.inFlow) { node.x = hold.corner.x; node.y = hold.corner.y; }
  return hold;
}

/**
 * Close a write span: turn the node about the centre of its unrotated box. Runs after every
 * position and size write has landed — a size or percent settled later would grow the box from the
 * wrong corner. `layout` is the delta the span applied, when there was one.
 */
export function settleCentrePivot(node: any, hold?: PivotHold, layout?: WriteLayout): void {
  if (isPlacedByFlow(node)) return;
  // Lifted out of the flow this span: on an axis the delta didn't place, the node keeps the centre
  // the flow gave it, rather than turning about the flow's corner.
  if (hold?.inFlow) {
    if (layout?.left == null && layout?.percentPos?.x == null) node.x = hold.corner.x;
    if (layout?.top == null && layout?.percentPos?.y == null) node.y = hold.corner.y;
  }
  if (!isTurned(node)) return;
  const offset = cornerOffsetOf(node);
  node.x -= offset.x;
  node.y -= offset.y;
}
