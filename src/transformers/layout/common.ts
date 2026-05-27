import type {
  Node as FigmaDocumentNode,
  HasFramePropertiesTrait,
  HasLayoutTrait,
} from "@figma/rest-api-spec";
import { exhaustiveCheck } from "~/utils/common.js";
import { isFrame } from "~/utils/identity.js";

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
