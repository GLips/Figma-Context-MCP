/**
 * Axis-aligned box arithmetic on `SnapshotRect`.
 *
 * Lives in core because both halves need it and core is the only module either can import: the READ
 * path asks whether a grid's children overlap (to decide if `zIndex` is worth emitting), and the
 * WRITE path asks how much of a fresh render root landed on top of its page neighbours. Same
 * geometry, opposite directions.
 */
import type { SnapshotRect } from "./snapshot.js";

/**
 * Area of the intersection of two boxes, or 0 when they don't overlap.
 *
 * Boxes that merely TOUCH are not overlapping — a zero-width or zero-height intersection yields 0,
 * which is what keeps adjacent grid cells at `gap: 0` from reading as stacked.
 */
export function rectIntersectionArea(a: SnapshotRect, b: SnapshotRect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** Whether two boxes overlap at all. Defined on the area so the two can't drift apart. */
export function rectsOverlap(a: SnapshotRect, b: SnapshotRect): boolean {
  return rectIntersectionArea(a, b) > 0;
}

/** Whether any pair in a set of boxes overlaps. O(n²) — meant for a node's children, not a page. */
export function anyRectsOverlap(boxes: SnapshotRect[]): boolean {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (rectsOverlap(boxes[i], boxes[j])) return true;
    }
  }
  return false;
}
