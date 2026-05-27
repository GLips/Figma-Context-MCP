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

// Checks for frame *traits*, not node type. Many node types (FRAME, COMPONENT,
// INSTANCE, SECTION, etc.) carry frame properties. Structural checking via
// `clipsContent` covers all of them without maintaining a type-string list.
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
 * Deliberately narrower than Figma's general "auto-layout" concept, which also includes
 * `layoutMode: "GRID"`. GRID has a different positioning model (gridRowAnchorIndex etc.)
 * and callers that care about row/column flex semantics specifically should use this;
 * callers that want "any non-NONE auto-layout" need a separate, broader predicate.
 */
export function hasFlexLayout(val: unknown): boolean {
  return isFrame(val) && (val.layoutMode === "HORIZONTAL" || val.layoutMode === "VERTICAL");
}

/**
 * Checks if:
 * 1. A node is a child to a flex auto-layout frame
 * 2. The child adheres to the auto layout rules—i.e. it's not absolutely positioned
 *
 * Does NOT cover GRID auto-layout — see `hasFlexLayout` for why.
 *
 * @param node - The node to check.
 * @param parent - The parent node.
 * @returns True if the node is a child of a flex auto-layout frame, false otherwise.
 */
export function isInAutoLayoutFlow(node: unknown, parent: unknown): boolean {
  return hasFlexLayout(parent) && isLayout(node) && node.layoutPositioning !== "ABSOLUTE";
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
