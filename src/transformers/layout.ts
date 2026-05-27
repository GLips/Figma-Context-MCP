import {
  hasGridLayout,
  hasValue,
  isInAutoLayoutFlow,
  isFrame,
  isLayout,
  isRectangle,
} from "~/utils/identity.js";
import type {
  Node as FigmaDocumentNode,
  HasFramePropertiesTrait,
  HasLayoutTrait,
} from "@figma/rest-api-spec";
import { exhaustiveCheck, generateCSSShorthand, pixelRound } from "~/utils/common.js";

export interface SimplifiedLayout {
  mode: "none" | "row" | "column" | "grid";
  justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | "baseline" | "stretch";
  alignItems?: "flex-start" | "flex-end" | "center" | "space-between" | "baseline" | "stretch";
  alignSelf?: "flex-start" | "flex-end" | "center" | "stretch" | "start" | "end";
  wrap?: boolean;
  gap?: string;
  gridTemplateColumns?: string;
  gridTemplateRows?: string;
  gridColumn?: string;
  gridRow?: string;
  justifySelf?: "start" | "end" | "center";
  // Emitted on a grid child only when the parent's child array order (Figma z-order,
  // back-to-front) doesn't match grid-anchor / reading order. The MCP reorders such
  // children into anchor order so the AI generates idiomatic flowing-grid CSS, then
  // surfaces the original z-order here so stacking can be preserved with `z-index`
  // when children overlap. Value is the child's original index in `parent.children`
  // (higher = drawn on top).
  zIndex?: number;
  locationRelativeToParent?: {
    x: number;
    y: number;
  };
  dimensions?: {
    width?: number;
    height?: number;
    aspectRatio?: number;
  };
  padding?: string;
  sizing?: {
    horizontal?: "fixed" | "fill" | "hug";
    vertical?: "fixed" | "fill" | "hug";
  };
  overflowScroll?: ("x" | "y")[];
  position?: "absolute";
}

// Convert Figma's layout config into a more typical flex-like schema
export function buildSimplifiedLayout(
  n: FigmaDocumentNode,
  parent?: FigmaDocumentNode,
): SimplifiedLayout {
  const frameValues = buildSimplifiedFrameValues(n);
  const parentGridPacked =
    isFrame(parent) && parent.layoutMode === "GRID" && "children" in parent
      ? isPackedGrid(parent.children as FigmaDocumentNode[])
      : undefined;
  const layoutValues =
    buildSimplifiedLayoutValues(n, parent, frameValues.mode, parentGridPacked) || {};

  return { ...frameValues, ...layoutValues };
}

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

function convertJustifyContent(align?: HasFramePropertiesTrait["primaryAxisAlignItems"]) {
  switch (align) {
    case "MIN":
      return undefined;
    case "MAX":
      return "flex-end";
    case "CENTER":
      return "center";
    case "SPACE_BETWEEN":
      return "space-between";
    default:
      return undefined;
  }
}

function convertAlignItems(
  align: HasFramePropertiesTrait["counterAxisAlignItems"] | undefined,
  children: FigmaDocumentNode[],
  mode: "row" | "column",
) {
  // Row cross-axis is vertical; column cross-axis is horizontal
  const crossSizing = mode === "row" ? "layoutSizingVertical" : "layoutSizingHorizontal";
  const allStretch =
    children.length > 0 &&
    children.every(
      (c) =>
        ("layoutPositioning" in c && c.layoutPositioning === "ABSOLUTE") ||
        (crossSizing in c && (c as Record<string, unknown>)[crossSizing] === "FILL"),
    );
  if (allStretch) return "stretch";

  switch (align) {
    case "MIN":
      return undefined;
    case "MAX":
      return "flex-end";
    case "CENTER":
      return "center";
    case "BASELINE":
      return "baseline";
    default:
      return undefined;
  }
}

function convertSelfAlign(align?: HasLayoutTrait["layoutAlign"]) {
  switch (align) {
    case "MIN":
      // MIN, AKA flex-start, is the default alignment
      return undefined;
    case "MAX":
      return "flex-end";
    case "CENTER":
      return "center";
    case "STRETCH":
      return "stretch";
    default:
      return undefined;
  }
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

/** Check whether children fill a packed sequence with no empty cells. */
function isPackedGrid(children: FigmaDocumentNode[]): boolean {
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

// SPACE_BETWEEN computes gaps dynamically — the API returns stale spacing
// values, but Figma's UI shows "Auto". Suppress the affected axis.
function buildGap(n: HasFramePropertiesTrait, mode: "row" | "column"): string | undefined {
  const primaryGap = n.primaryAxisAlignItems === "SPACE_BETWEEN" ? undefined : n.itemSpacing;
  const counterGap =
    n.layoutWrap !== "WRAP" || n.counterAxisAlignContent === "SPACE_BETWEEN"
      ? undefined
      : n.counterAxisSpacing;

  // Map Figma's primary/counter axes to CSS's row/column axes
  const rowGap = mode === "row" ? counterGap : primaryGap;
  const colGap = mode === "row" ? primaryGap : counterGap;

  return gapShorthand(rowGap, colGap);
}

// Zero is only meaningful as one half of a two-value shorthand (e.g. "0px 16px").
// As a single value it's the CSS default — omit to match the project's convention.
function gapShorthand(row?: number, col?: number): string | undefined {
  if (row === undefined && col === undefined) return undefined;
  if (row !== undefined && col !== undefined) {
    if (row === 0 && col === 0) return undefined;
    return row === col ? `${row}px` : `${row}px ${col}px`;
  }
  const single = (row ?? col)!;
  return single ? `${single}px` : undefined;
}

// interpret sizing
function convertSizing(
  s?: HasLayoutTrait["layoutSizingHorizontal"] | HasLayoutTrait["layoutSizingVertical"],
) {
  if (s === "FIXED") return "fixed";
  if (s === "FILL") return "fill";
  if (s === "HUG") return "hug";
  return undefined;
}

// Centralized mapping of Figma's layoutMode to our schema's mode tag.
// Exhaustive switch — if @figma/rest-api-spec ever adds a new layoutMode value,
// exhaustiveCheck fails the build until we decide how to map it.
function layoutModeToSchema(
  layoutMode: HasFramePropertiesTrait["layoutMode"],
): SimplifiedLayout["mode"] {
  switch (layoutMode) {
    case "HORIZONTAL":
      return "row";
    case "VERTICAL":
      return "column";
    case "GRID":
      return "grid";
    case "NONE":
    case undefined:
      return "none";
    default:
      return exhaustiveCheck(layoutMode);
  }
}

function buildSimplifiedFrameValues(n: FigmaDocumentNode): SimplifiedLayout | { mode: "none" } {
  if (!isFrame(n)) {
    return { mode: "none" };
  }

  const frameValues: SimplifiedLayout = {
    mode: layoutModeToSchema(n.layoutMode),
  };

  const overflowScroll: SimplifiedLayout["overflowScroll"] = [];
  if (n.overflowDirection?.includes("HORIZONTAL")) overflowScroll.push("x");
  if (n.overflowDirection?.includes("VERTICAL")) overflowScroll.push("y");
  if (overflowScroll.length > 0) frameValues.overflowScroll = overflowScroll;

  const { mode } = frameValues;
  if (mode === "none") {
    return frameValues;
  }

  // Shared across grid and flex containers
  frameValues.alignSelf = convertSelfAlign(n.layoutAlign);
  if (n.paddingTop || n.paddingBottom || n.paddingLeft || n.paddingRight) {
    frameValues.padding = generateCSSShorthand({
      top: n.paddingTop ?? 0,
      right: n.paddingRight ?? 0,
      bottom: n.paddingBottom ?? 0,
      left: n.paddingLeft ?? 0,
    });
  }

  if (mode === "grid") {
    // Grid template/gap properties live on HasLayoutTrait; GRID frames always
    // carry both traits, so the cast is safe.
    const ln = n as unknown as HasLayoutTrait;
    const cols = ln.gridColumnsSizing?.trim();
    if (cols) frameValues.gridTemplateColumns = cols;

    const rows = ln.gridRowsSizing?.trim();
    if (rows) frameValues.gridTemplateRows = rows;

    frameValues.gap = gapShorthand(ln.gridRowGap, ln.gridColumnGap);
    return frameValues;
  }

  // Flex-specific — mode is narrowed to "row" | "column" after grid early-return
  frameValues.justifyContent = convertJustifyContent(n.primaryAxisAlignItems ?? "MIN");
  frameValues.alignItems = convertAlignItems(n.counterAxisAlignItems ?? "MIN", n.children, mode);
  frameValues.wrap = n.layoutWrap === "WRAP" ? true : undefined;
  frameValues.gap = buildGap(n, mode);

  return frameValues;
}

function getParentAutoLayoutMode(parent?: FigmaDocumentNode): "row" | "column" | undefined {
  if (!isFrame(parent)) return undefined;
  if (parent.layoutMode === "HORIZONTAL") return "row";
  if (parent.layoutMode === "VERTICAL") return "column";
  return undefined;
}

function buildSimplifiedLayoutValues(
  n: FigmaDocumentNode,
  parent: FigmaDocumentNode | undefined,
  mode: SimplifiedLayout["mode"],
  parentGridPacked?: boolean,
): SimplifiedLayout | undefined {
  if (!isLayout(n)) return undefined;

  const layoutValues: SimplifiedLayout = { mode };

  layoutValues.sizing = {
    horizontal: convertSizing(n.layoutSizingHorizontal),
    vertical: convertSizing(n.layoutSizingVertical),
  };

  // Emit positioning relative to parent unless the parent's auto-layout already
  // places this child. `isLayout(parent)` also screens out top-level nodes
  // (no parent) and parents without bounding boxes (e.g. CANVAS), where
  // coordinates would be meaningless.
  if (isLayout(parent) && !isInAutoLayoutFlow(n, parent)) {
    if (n.layoutPositioning === "ABSOLUTE") {
      layoutValues.position = "absolute";
    }
    if (n.absoluteBoundingBox && parent.absoluteBoundingBox) {
      layoutValues.locationRelativeToParent = {
        x: pixelRound(n.absoluteBoundingBox.x - parent.absoluteBoundingBox.x),
        y: pixelRound(n.absoluteBoundingBox.y - parent.absoluteBoundingBox.y),
      };
    }
  }

  // Grid child properties: positioning, spans, and alignment
  const parentIsGrid = parentGridPacked !== undefined;
  if (parentIsGrid && n.layoutPositioning !== "ABSOLUTE") {
    const gapped = !parentGridPacked;

    const colSpan = n.gridColumnSpan ?? 1;
    const rowSpan = n.gridRowSpan ?? 1;

    if (gapped) {
      const col = (n.gridColumnAnchorIndex ?? 0) + 1; // CSS grid is 1-based
      const row = (n.gridRowAnchorIndex ?? 0) + 1;
      layoutValues.gridColumn = colSpan > 1 ? `${col} / span ${colSpan}` : `${col}`;
      layoutValues.gridRow = rowSpan > 1 ? `${row} / span ${rowSpan}` : `${row}`;
    } else {
      if (colSpan > 1) layoutValues.gridColumn = `span ${colSpan}`;
      if (rowSpan > 1) layoutValues.gridRow = `span ${rowSpan}`;
    }

    const hAlign = n.gridChildHorizontalAlign;
    if (hAlign && hAlign !== "AUTO") {
      layoutValues.justifySelf = convertGridAlign(hAlign);
    }

    const vAlign = n.gridChildVerticalAlign;
    if (vAlign && vAlign !== "AUTO") {
      layoutValues.alignSelf = convertGridAlign(vAlign);
    }

    // When sorting moves this child, surface its original Figma stacking position
    // so the AI can preserve z-order when children overlap. Skipped when sort is
    // a no-op (parent is null-result), and when this child's slot didn't move.
    if (parent) {
      const order = computeGridChildOrder(parent);
      if (order) {
        const originalIndex = (parent as { children: FigmaDocumentNode[] }).children.indexOf(n);
        const newIndex = order.indexOf(originalIndex);
        if (originalIndex !== newIndex) {
          layoutValues.zIndex = originalIndex;
        }
      }
    }
  }

  // Handle dimensions based on layout growth and alignment
  if (isRectangle("absoluteBoundingBox", n)) {
    const dimensions: { width?: number; height?: number; aspectRatio?: number } = {};
    const sizingMode = isInAutoLayoutFlow(n, parent)
      ? (getParentAutoLayoutMode(parent) ?? mode)
      : mode;

    // Grid children use fixed-only dimension logic regardless of their own layout mode
    const dimensionMode = parentIsGrid ? "none" : sizingMode;

    // Only include dimensions that aren't meant to stretch
    if (dimensionMode === "row") {
      // AutoLayout row, only include dimensions if the node is not growing
      if (!n.layoutGrow && n.layoutSizingHorizontal == "FIXED")
        dimensions.width = n.absoluteBoundingBox.width;
      if (n.layoutAlign !== "STRETCH" && n.layoutSizingVertical == "FIXED")
        dimensions.height = n.absoluteBoundingBox.height;
    } else if (dimensionMode === "column") {
      // AutoLayout column, only include dimensions if the node is not growing
      if (n.layoutAlign !== "STRETCH" && n.layoutSizingHorizontal == "FIXED")
        dimensions.width = n.absoluteBoundingBox.width;
      if (!n.layoutGrow && n.layoutSizingVertical == "FIXED")
        dimensions.height = n.absoluteBoundingBox.height;

      if (n.preserveRatio) {
        dimensions.aspectRatio = n.absoluteBoundingBox?.width / n.absoluteBoundingBox?.height;
      }
    } else {
      // Grid children or non-auto-layout nodes: include FIXED dimensions only
      if (!n.layoutSizingHorizontal || n.layoutSizingHorizontal === "FIXED") {
        dimensions.width = n.absoluteBoundingBox.width;
      }
      if (!n.layoutSizingVertical || n.layoutSizingVertical === "FIXED") {
        dimensions.height = n.absoluteBoundingBox.height;
      }
    }

    if (Object.keys(dimensions).length > 0) {
      if (dimensions.width) {
        dimensions.width = pixelRound(dimensions.width);
      }
      if (dimensions.height) {
        dimensions.height = pixelRound(dimensions.height);
      }
      layoutValues.dimensions = dimensions;
    }
  }

  return layoutValues;
}
