/**
 * Comment pin → node hit-test.
 *
 * Figma records a comment against the top-level frame (or page) under the pin, plus an offset — never the
 * nested node the commenter was pointing at. Both the REST comments tool and the plugin's read counts
 * guess that node with this one function, so the tool and the counts agree on where a thread belongs.
 *
 * Geometry is read through accessors rather than a built tree: the plugin walks live nodes lazily and
 * the REST side walks wire nodes, and neither should materialize a copy of a frame to ask one question.
 */
import type { SnapshotPoint, SnapshotRect } from "./snapshot.js";

/** The narrow geometry a hit-test needs. `bounds` is absolute; null for a node with no box. */
export interface CommentPinGeometry<N> {
  bounds(node: N): SnapshotRect | null;
  visible(node: N): boolean;
  clipsContent(node: N): boolean;
  /** Paint order, bottom first — Figma's own child order. */
  children(node: N): readonly N[];
}

/**
 * The path from just below `anchor` down to the deepest visible node under `point`, or `[]` when no
 * descendant contains it (the anchor itself is the best answer).
 *
 * Overlapping siblings are tried topmost first, and the first subtree with any hit wins — the commenter
 * clicked what they saw. A clipping node's subtree is skipped when the point is outside it; a
 * non-clipping node is still searched, because its children can overflow onto the pin.
 *
 * Instances are not a stopping point and there is no size threshold: the caller returns the whole path,
 * so an agent can tell a label from the button around it.
 */
export function hitTestCommentPin<N>(
  anchor: N,
  point: SnapshotPoint,
  geometry: CommentPinGeometry<N>,
): N[] {
  return deepestHit(anchor, point, geometry)?.slice(1) ?? [];
}

function deepestHit<N>(node: N, point: SnapshotPoint, geometry: CommentPinGeometry<N>): N[] | null {
  const box = geometry.bounds(node);
  const inside = box !== null && boxContainsPoint(box, point);
  if (!inside && geometry.clipsContent(node)) return null;
  const children = geometry.children(node);
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (!geometry.visible(child)) continue;
    const below = deepestHit(child, point, geometry);
    if (below) return [node, ...below];
  }
  return inside ? [node] : null;
}

// Half-open, so a pin on the seam between two adjacent cells belongs to exactly one of them.
function boxContainsPoint(box: SnapshotRect, point: SnapshotPoint): boolean {
  return (
    point.x >= box.x &&
    point.x < box.x + box.width &&
    point.y >= box.y &&
    point.y < box.y + box.height
  );
}
