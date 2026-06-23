import type {
  Rectangle,
  HasLayoutTrait,
  StrokeWeights,
  HasFramePropertiesTrait,
} from "@figma/rest-api-spec";
import { isTruthy } from "remeda";
import type { CSSHexColor, CSSRGBAColor } from "~/transformers/style.js";

export { isTruthy };

export function hasValue<K extends PropertyKey, T>(
  key: K,
  obj: unknown,
  typeGuard?: (val: unknown) => val is T,
): obj is Record<K, T> {
  const isObject = typeof obj === "object" && obj !== null;
  if (!isObject || !(key in obj)) return false;
  const val = (obj as Record<K, unknown>)[key];
  return typeGuard ? typeGuard(val) : val !== undefined;
}

// Checks for `HasFramePropertiesTrait`, not node type. This is the FRAME family
// — FRAME, GROUP, COMPONENT, COMPONENT_SET, INSTANCE — i.e. the nodes that can
// carry auto-layout properties like `layoutMode`, `paddingTop`, etc. NOT a
// general "is container" check: SECTION, BOOLEAN_OPERATION, and TABLE all hold
// children but do not have frame properties. Structural checking via
// `clipsContent` covers the FRAME family without maintaining a type-string list.
export function isFrame(val: unknown): val is HasFramePropertiesTrait {
  return (
    typeof val === "object" &&
    !!val &&
    "clipsContent" in val &&
    typeof val.clipsContent === "boolean"
  );
}

export function isLayout(val: unknown): val is HasLayoutTrait {
  return (
    typeof val === "object" &&
    !!val &&
    "absoluteBoundingBox" in val &&
    typeof val.absoluteBoundingBox === "object" &&
    !!val.absoluteBoundingBox &&
    "x" in val.absoluteBoundingBox &&
    "y" in val.absoluteBoundingBox &&
    "width" in val.absoluteBoundingBox &&
    "height" in val.absoluteBoundingBox
  );
}

/**
 * Whether a node uses flex-style auto-layout (HORIZONTAL or VERTICAL layoutMode).
 *
 * Narrower than the general "auto-layout" concept — does NOT match `layoutMode: "GRID"`.
 * GRID has a different positioning model (gridRowAnchorIndex etc.) and a different schema
 * mapping (CSS Grid rather than flex), so callers that care about row/column flex
 * semantics specifically should use this; callers that want "any non-NONE auto-layout"
 * should use {@link hasAutoLayout}.
 */
export function hasFlexLayout(val: unknown): val is HasFramePropertiesTrait {
  return isFrame(val) && (val.layoutMode === "HORIZONTAL" || val.layoutMode === "VERTICAL");
}

/**
 * Whether a node uses CSS-grid-style auto-layout (`layoutMode: "GRID"`).
 *
 * Children of grid frames are positioned via gridRow/ColumnAnchorIndex + gridRow/ColumnSpan
 * rather than flex flow or absolute coordinates.
 */
export function hasGridLayout(val: unknown): val is HasFramePropertiesTrait {
  return isFrame(val) && val.layoutMode === "GRID";
}

/**
 * Whether a node uses any form of Figma auto-layout — flex (HORIZONTAL/VERTICAL) or GRID.
 *
 * Use this when the question is "did the designer hand-position children, or did they let
 * Figma's layout engine do it?" — e.g., deciding whether to skip absolute-positioning
 * emission, or whether to preserve authored structure when collapsing SVG containers.
 *
 * When the answer matters per-mode (e.g., emitting flex vs grid CSS), branch on
 * `layoutMode` directly or use the narrower {@link hasFlexLayout} / {@link hasGridLayout}.
 */
export function hasAutoLayout(val: unknown): val is HasFramePropertiesTrait {
  return hasFlexLayout(val) || hasGridLayout(val);
}

/**
 * Checks if:
 * 1. A node is a child to an auto-layout frame (flex or grid)
 * 2. The child adheres to the auto-layout rules—i.e. it's not absolutely positioned
 *
 * @param node - The node to check.
 * @param parent - The parent node.
 * @returns True if the node is a child of an auto-layout frame, false otherwise.
 */
export function isInAutoLayoutFlow(node: unknown, parent: unknown): boolean {
  return hasAutoLayout(parent) && isLayout(node) && node.layoutPositioning !== "ABSOLUTE";
}

export function isStrokeWeights(val: unknown): val is StrokeWeights {
  return (
    typeof val === "object" &&
    val !== null &&
    "top" in val &&
    "right" in val &&
    "bottom" in val &&
    "left" in val
  );
}

export function isRectangle<T, K extends string>(
  key: K,
  obj: T,
): obj is T & { [P in K]: Rectangle } {
  const recordObj = obj as Record<K, unknown>;
  return (
    typeof obj === "object" &&
    !!obj &&
    key in recordObj &&
    typeof recordObj[key] === "object" &&
    !!recordObj[key] &&
    "x" in recordObj[key] &&
    "y" in recordObj[key] &&
    "width" in recordObj[key] &&
    "height" in recordObj[key]
  );
}

export function isRectangleCornerRadii(val: unknown): val is number[] {
  return Array.isArray(val) && val.length === 4 && val.every((v) => typeof v === "number");
}

export function isCSSColorValue(val: unknown): val is CSSRGBAColor | CSSHexColor {
  return typeof val === "string" && (val.startsWith("#") || val.startsWith("rgba"));
}
