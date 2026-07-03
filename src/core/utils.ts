/**
 * Builtin-free helpers for the simplify core: CSS formatting utilities plus the
 * snapshot trait guards (isFrame, hasAutoLayout, …). This module must stay
 * pure — no Node builtins, no external packages — because the whole core graph
 * bundles into the plugin's QuickJS sandbox (Invariant 4, gated by the esbuild
 * `platform:'neutral'` purity probe).
 */
import type { NodeSnapshot, SnapshotRect } from "~/core/snapshot.js";

/**
 * Generate a CSS shorthand for values that come with top, right, bottom, and left
 *
 * input: { top: 10, right: 10, bottom: 10, left: 10 }
 * output: "10px"
 *
 * input: { top: 10, right: 20, bottom: 10, left: 20 }
 * output: "10px 20px"
 *
 * input: { top: 10, right: 20, bottom: 30, left: 40 }
 * output: "10px 20px 30px 40px"
 *
 * @param values - The values to generate the shorthand for
 * @returns The generated shorthand
 */
export function generateCSSShorthand(
  values: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  },
  {
    ignoreZero = true,
    suffix = "px",
  }: {
    /**
     * If true and all values are 0, return undefined. Defaults to true.
     */
    ignoreZero?: boolean;
    /**
     * The suffix to add to the shorthand. Defaults to "px".
     */
    suffix?: string;
  } = {},
) {
  const { top, right, bottom, left } = values;
  if (ignoreZero && top === 0 && right === 0 && bottom === 0 && left === 0) {
    return undefined;
  }
  if (top === right && right === bottom && bottom === left) {
    return `${top}${suffix}`;
  }
  if (right === left) {
    if (top === bottom) {
      return `${top}${suffix} ${right}${suffix}`;
    }
    return `${top}${suffix} ${right}${suffix} ${bottom}${suffix}`;
  }
  return `${top}${suffix} ${right}${suffix} ${bottom}${suffix} ${left}${suffix}`;
}

/**
 * Check if an element is visible
 * @param element - The item to check
 * @returns True if the item is visible, false otherwise
 */
export function isVisible(element: { visible?: boolean }): boolean {
  return element.visible ?? true;
}

/**
 * Rounds a number to two decimal places, suitable for pixel value processing.
 * @param num The number to be rounded.
 * @returns The rounded number with two decimal places.
 * @throws TypeError If the input is not a valid number
 */
export function pixelRound(num: number): number {
  if (isNaN(num)) {
    throw new TypeError(`Input must be a valid number`);
  }
  return Number(Number(num).toFixed(2));
}

/**
 * Compile-time exhaustiveness guard for discriminated unions.
 *
 * Place in the default branch of a switch over a union: the `value: never` parameter
 * forces TS to error here if any union member was missed, and the `never` return type
 * tells control-flow analysis that execution doesn't continue (so callers don't need a
 * trailing return). Throws at runtime as a defense against type-system bypasses
 * (`as`, JSON inputs, etc.) — should never actually fire in well-typed code.
 */
export function exhaustiveCheck(value: never): never {
  throw new Error(`Unhandled discriminant: ${String(value)}`);
}

/**
 * Serialize a value to JSON with sorted object keys so two equal-but-
 * differently-ordered objects produce the same string. Used for cache keys
 * and deep-equality checks where property order isn't a stable guarantee
 * (e.g. partial TypeStyle entries from Figma's styleOverrideTable).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// Snapshot trait guards
// ---------------------------------------------------------------------------

/** A snapshot known to carry frame/auto-layout traits (has `clipsContent`). */
export type FrameSnapshot = NodeSnapshot & { clipsContent: boolean };
/** A snapshot known to have a concrete bounding box (participates in layout). */
export type LayoutSnapshot = NodeSnapshot & { absoluteBoundingBox: SnapshotRect };

// Checks for `HasFramePropertiesTrait`, not node type. This is the FRAME family
// — FRAME, GROUP, COMPONENT, COMPONENT_SET, INSTANCE — i.e. the nodes that can
// carry auto-layout properties like `layoutMode`, `paddingTop`, etc. NOT a
// general "is container" check: SECTION, BOOLEAN_OPERATION, and TABLE all hold
// children but do not have frame properties. Structural checking via
// `clipsContent` covers the FRAME family without maintaining a type-string list.
export function isFrame(val: unknown): val is FrameSnapshot {
  return (
    typeof val === "object" &&
    !!val &&
    "clipsContent" in val &&
    typeof val.clipsContent === "boolean"
  );
}

export function isLayout(val: unknown): val is LayoutSnapshot {
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
export function hasFlexLayout(val: unknown): val is FrameSnapshot {
  return isFrame(val) && (val.layoutMode === "HORIZONTAL" || val.layoutMode === "VERTICAL");
}

/**
 * Whether a node uses CSS-grid-style auto-layout (`layoutMode: "GRID"`).
 *
 * Children of grid frames are positioned via gridRow/ColumnAnchorIndex + gridRow/ColumnSpan
 * rather than flex flow or absolute coordinates.
 */
export function hasGridLayout(val: unknown): val is FrameSnapshot {
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
export function hasAutoLayout(val: unknown): val is FrameSnapshot {
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

export function isRectangleCornerRadii(val: unknown): val is number[] {
  return Array.isArray(val) && val.length === 4 && val.every((v) => typeof v === "number");
}
