import type { Node as FigmaDocumentNode, HasLayoutTrait } from "@figma/rest-api-spec";
import { hasGridLayout, hasValue, isLayout } from "~/utils/identity.js";
import type { SimplifiedLayout } from "./common.js";

/**
 * Compute the order in which a grid container's children should appear so that
 * array position matches grid-flow (reading) order.
 *
 * Why: Figma returns children in z-order (back-to-front), which can differ
 * from the order their grid anchors place them in. CSS auto-placement uses
 * DOM order, so emitting children in Figma's z-order lands them in the wrong
 * cells. Sorting into anchor order lets us emit idiomatic flowing-grid CSS
 * (no explicit `grid-column` / `grid-row` per child) while keeping rendering
 * correct. The original z-order is surfaced via {@link SimplifiedLayout.zIndex}
 * on children whose position changed.
 *
 * ABSOLUTE-positioned children don't participate in grid flow, so they keep
 * their original slot in the array — only in-flow children are reordered
 * relative to each other.
 *
 * Returns null when the parent isn't a grid, has no children, or when the
 * existing order already matches anchor order (no work to do).
 */
export function computeGridChildOrder(parent: FigmaDocumentNode): number[] | null {
  if (!hasGridLayout(parent) || !hasValue("children", parent)) return null;
  const children = parent.children as FigmaDocumentNode[];
  if (children.length < 2) return null;

  const isAbsolute = (c: FigmaDocumentNode) => isLayout(c) && c.layoutPositioning === "ABSOLUTE";

  const inFlow = children
    .map((_, i) => i)
    .filter((i) => !isAbsolute(children[i]))
    .sort((a, b) => {
      const ca = children[a] as HasLayoutTrait;
      const cb = children[b] as HasLayoutTrait;
      const ar = ca.gridRowAnchorIndex ?? 0;
      const br = cb.gridRowAnchorIndex ?? 0;
      if (ar !== br) return ar - br;
      const ac = ca.gridColumnAnchorIndex ?? 0;
      const bc = cb.gridColumnAnchorIndex ?? 0;
      if (ac !== bc) return ac - bc;
      return a - b; // stable on equal anchors
    });

  // Slot absolute children back into their original positions, and fill the
  // remaining slots with the sorted in-flow indices.
  const result: number[] = [];
  let cursor = 0;
  for (let i = 0; i < children.length; i++) {
    if (isAbsolute(children[i])) {
      result.push(i);
    } else {
      result.push(inFlow[cursor++]);
    }
  }

  return result.every((idx, i) => idx === i) ? null : result;
}

/** Check whether a grid's children fill a packed sequence with no empty cells. */
export function isPackedGrid(children: FigmaDocumentNode[]): boolean {
  const occupied = new Set<string>();

  for (const child of children) {
    if (!isLayout(child) || child.layoutPositioning === "ABSOLUTE") continue;

    const colAnchor = child.gridColumnAnchorIndex ?? 0;
    const rowAnchor = child.gridRowAnchorIndex ?? 0;
    const colSpan = child.gridColumnSpan ?? 1;
    const rowSpan = child.gridRowSpan ?? 1;

    for (let r = rowAnchor; r < rowAnchor + rowSpan; r++) {
      for (let c = colAnchor; c < colAnchor + colSpan; c++) {
        occupied.add(`${r},${c}`);
      }
    }
  }

  if (occupied.size === 0) return true;

  let maxRow = 0;
  let maxCol = 0;
  for (const key of occupied) {
    const [r, c] = key.split(",").map(Number);
    maxRow = Math.max(maxRow, r);
    maxCol = Math.max(maxCol, c);
  }

  // Packed means every cell in the bounding rectangle is occupied
  return occupied.size === (maxRow + 1) * (maxCol + 1);
}

/**
 * Whether any pair of a grid's in-flow children overlap (AABB intersection on
 * `absoluteBoundingBox`).
 *
 * Used to gate `zIndex` emission: when children don't overlap, their CSS
 * stacking can't affect what the user sees, so the z-order annotation is
 * noise. ABSOLUTE-positioned children are excluded — they manage their own
 * stacking and don't participate in grid flow.
 *
 * Edges that merely touch (e.g., adjacent cells with gap = 0) are NOT
 * overlap; strict inequalities below handle that.
 */
function gridChildrenOverlap(parent: FigmaDocumentNode): boolean {
  if (!hasValue("children", parent)) return false;
  const boxes = (parent.children as FigmaDocumentNode[])
    .filter((c) => isLayout(c) && c.layoutPositioning !== "ABSOLUTE")
    .map((c) => (c as HasLayoutTrait).absoluteBoundingBox)
    .filter((b): b is NonNullable<typeof b> => b != null);

  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
      ) {
        return true;
      }
    }
  }
  return false;
}

function convertGridAlign(align: "MIN" | "CENTER" | "MAX"): "start" | "end" | "center" {
  switch (align) {
    case "MIN":
      return "start";
    case "MAX":
      return "end";
    case "CENTER":
      return "center";
  }
}

/**
 * Build the grid-child-specific positioning fields for a node whose parent is a
 * GRID frame: `gridColumn` / `gridRow` (only when needed), self-alignment, and
 * the `zIndex` annotation that preserves Figma z-order when overlap matters.
 *
 * The caller is responsible for confirming the parent is a grid and the child
 * is in-flow (not ABSOLUTE).
 */
export function buildGridChildPositioning(
  n: HasLayoutTrait,
  parent: FigmaDocumentNode,
  packed: boolean,
): Partial<SimplifiedLayout> {
  const out: Partial<SimplifiedLayout> = {};

  const colSpan = n.gridColumnSpan ?? 1;
  const rowSpan = n.gridRowSpan ?? 1;

  if (!packed) {
    const col = (n.gridColumnAnchorIndex ?? 0) + 1; // CSS grid is 1-based
    const row = (n.gridRowAnchorIndex ?? 0) + 1;
    out.gridColumn = colSpan > 1 ? `${col} / span ${colSpan}` : `${col}`;
    out.gridRow = rowSpan > 1 ? `${row} / span ${rowSpan}` : `${row}`;
  } else {
    if (colSpan > 1) out.gridColumn = `span ${colSpan}`;
    if (rowSpan > 1) out.gridRow = `span ${rowSpan}`;
  }

  const hAlign = n.gridChildHorizontalAlign;
  if (hAlign && hAlign !== "AUTO") {
    out.justifySelf = convertGridAlign(hAlign);
  }

  const vAlign = n.gridChildVerticalAlign;
  if (vAlign && vAlign !== "AUTO") {
    out.alignSelf = convertGridAlign(vAlign);
  }

  // When sorting moves this child AND siblings actually overlap, surface its
  // original Figma stacking position so CSS can preserve z-order. Skipped when:
  //   - sort is a no-op (no reorder happened)
  //   - this child's slot didn't move
  //   - no in-flow siblings overlap (stacking can't affect rendering)
  const order = computeGridChildOrder(parent);
  if (order && gridChildrenOverlap(parent)) {
    const originalIndex = (parent as { children: FigmaDocumentNode[] }).children.indexOf(
      n as FigmaDocumentNode,
    );
    const newIndex = order.indexOf(originalIndex);
    if (originalIndex !== newIndex) {
      out.zIndex = originalIndex;
    }
  }

  return out;
}
