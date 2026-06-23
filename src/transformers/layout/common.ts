import type {
  Node as FigmaDocumentNode,
  HasFramePropertiesTrait,
  HasLayoutTrait,
} from "@figma/rest-api-spec";
import { exhaustiveCheck } from "~/utils/common.js";
import { isFrame, isInAutoLayoutFlow } from "~/utils/identity.js";

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
  // The size the requested root was designed at, surfaced as a non-binding
  // reference (not a hard width/height). The root's own dimensions are
  // "contextual" — it fills whatever it's placed in — but absolutely-positioned
  // children and the fill-chain still need a concrete size to anchor against, so
  // we keep the designed value here, named so it can't be mistaken for a pin.
  designedWidth?: string;
  designedHeight?: string;
  padding?: string;
  sizing?: {
    // "contextual": size is determined by wherever the element is placed (used
    // for the requested root, whose FIXED size is an artifact of being top-level).
    horizontal?: "fixed" | "fill" | "hug" | "contextual";
    vertical?: "fixed" | "fill" | "hug" | "contextual";
  };
  overflowScroll?: ("x" | "y")[];
  position?: "absolute";
}

export function convertSizing(
  s?: HasLayoutTrait["layoutSizingHorizontal"] | HasLayoutTrait["layoutSizingVertical"],
) {
  if (s === "FIXED") return "fixed";
  if (s === "FILL") return "fill";
  if (s === "HUG") return "hug";
  return undefined;
}

export function convertSelfAlign(align?: HasLayoutTrait["layoutAlign"]) {
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

// Centralized mapping of Figma's layoutMode to our schema's mode tag.
// Exhaustive switch — if @figma/rest-api-spec ever adds a new layoutMode value,
// exhaustiveCheck fails the build until we decide how to map it.
export function layoutModeToSchema(
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

export function getParentAutoLayoutMode(parent?: FigmaDocumentNode): "row" | "column" | undefined {
  if (!isFrame(parent)) return undefined;
  if (parent.layoutMode === "HORIZONTAL") return "row";
  if (parent.layoutMode === "VERTICAL") return "column";
  return undefined;
}

/**
 * The axis a child's layout flags should be interpreted against.
 *
 * Figma encodes "is this child stretching?" with different properties depending
 * on the parent's layout mode, and `layoutGrow` / `layoutAlign` are keyed to the
 * parent's main/cross axes rather than literal horizontal/vertical. Resolving
 * this once up front means the dimension logic doesn't have to re-derive it.
 */
export type ChildAxis = "row" | "column" | "grid" | "none";

export type StretchFlags = { horizontal: boolean; vertical: boolean };

/**
 * Determines the axis context for interpreting `n`'s sizing/stretch flags.
 *
 * For flex children, `layoutGrow` is "stretch along main axis" and
 * `layoutAlign === "STRETCH"` is "stretch along cross axis" — both keyed to the
 * *parent's* axis, not the child's own layout. A row child inside a column
 * parent has its main axis aligned with the column. Picking the wrong axis here
 * silently mis-emits dimensions (see fix #379).
 */
export function resolveChildAxis(
  n: FigmaDocumentNode,
  parent: FigmaDocumentNode | undefined,
  ownMode: SimplifiedLayout["mode"],
  parentIsGrid: boolean,
): ChildAxis {
  if (parentIsGrid) return "grid";
  // When in an auto-layout parent, prefer the parent's axis (fix #379).
  // Outside it, fall back to the node's own mode so a top-level row/column
  // frame still threads through the row/column dimension logic. Per the
  // Figma spec, layoutGrow/layoutAlign only apply to direct auto-layout
  // children, so consulting them outside that context is arguably wrong —
  // but this preserves the pre-refactor behavior.
  const parentAxis = isInAutoLayoutFlow(n, parent) ? getParentAutoLayoutMode(parent) : undefined;
  if (parentAxis) return parentAxis;
  return ownMode === "row" || ownMode === "column" ? ownMode : "none";
}

/**
 * Per-axis "is this child stretching to fill the parent?" flags, normalizing
 * Figma's flex vs grid vocabularies into the same shape.
 *
 * - Flex children use `layoutGrow` (main axis, numeric 0/1) and
 *   `layoutAlign === "STRETCH"` (cross axis, enum).
 * - Grid children use `layoutSizing{Horizontal,Vertical} === "FILL"` (no
 *   main/cross — properties are axis-named directly).
 */
export function getChildStretch(n: HasLayoutTrait, axis: ChildAxis): StretchFlags {
  switch (axis) {
    case "grid":
      return {
        horizontal: n.layoutSizingHorizontal === "FILL",
        vertical: n.layoutSizingVertical === "FILL",
      };
    case "row":
      return { horizontal: !!n.layoutGrow, vertical: n.layoutAlign === "STRETCH" };
    case "column":
      return { horizontal: n.layoutAlign === "STRETCH", vertical: !!n.layoutGrow };
    case "none":
      return { horizontal: false, vertical: false };
    default:
      return exhaustiveCheck(axis);
  }
}

/**
 * Whether an axis should emit its bounding-box dimension.
 *
 * Flex children are strict: `layoutSizing*` is reliably populated by Figma and
 * only `FIXED` should emit. Grid children and non-auto-layout nodes also allow
 * absent sizing — for non-auto-layout nodes the property may not exist at all,
 * and the historical grid path treated absent as fixed for symmetry.
 */
export function shouldEmitFixedDimension(
  sizing: HasLayoutTrait["layoutSizingHorizontal"] | undefined,
  axis: ChildAxis,
): boolean {
  if (axis === "row" || axis === "column") return sizing === "FIXED";
  return !sizing || sizing === "FIXED";
}

// Zero is only meaningful as one half of a two-value shorthand (e.g. "0px 16px").
// As a single value it's the CSS default — omit to match the project's convention.
export function gapShorthand(row?: number, col?: number): string | undefined {
  if (row === undefined && col === undefined) return undefined;
  if (row !== undefined && col !== undefined) {
    if (row === 0 && col === 0) return undefined;
    return row === col ? `${row}px` : `${row}px ${col}px`;
  }
  const single = (row ?? col)!;
  return single ? `${single}px` : undefined;
}
