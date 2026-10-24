/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { WriteLayout } from "./ir.js";

export type Axis = "horizontal" | "vertical";
export const AXES = {
  horizontal: { dimension: "width", sizing: "layoutSizingHorizontal", tracks: "gridColumnSizes", template: "gridTemplateColumns", count: "gridColumnCount" },
  vertical: { dimension: "height", sizing: "layoutSizingVertical", tracks: "gridRowSizes", template: "gridTemplateRows", count: "gridRowCount" },
} as const;
export type LayoutMode =
  | { kind: "free"; word: "none"; native: "NONE" }
  | { kind: "flow"; word: "row" | "column"; native: "HORIZONTAL" | "VERTICAL"; main: Axis; cross: Axis }
  | { kind: "grid"; word: "grid"; native: "GRID" };
export const LAYOUT_MODES = {
  none: { kind: "free", word: "none", native: "NONE" },
  row: { kind: "flow", word: "row", native: "HORIZONTAL", main: "horizontal", cross: "vertical" },
  column: { kind: "flow", word: "column", native: "VERTICAL", main: "vertical", cross: "horizontal" },
  grid: { kind: "grid", word: "grid", native: "GRID" },
} as const satisfies Record<NonNullable<WriteLayout["mode"]>, LayoutMode>;
const NATIVE_MODES: Record<string, LayoutMode> = Object.fromEntries(Object.values(LAYOUT_MODES).map(mode => [mode.native, mode]));
export function layoutModeOf(node: { layoutMode?: string } | null | undefined): LayoutMode {
  return node?.layoutMode && Object.prototype.hasOwnProperty.call(NATIVE_MODES, node.layoutMode) ? NATIVE_MODES[node.layoutMode] : LAYOUT_MODES.none;
}
export function effectiveLayoutMode(layout: WriteLayout, live?: { layoutMode?: string }): LayoutMode {
  return layout.mode === undefined ? layoutModeOf(live) : LAYOUT_MODES[layout.mode];
}

// A child has one placement context. Absolute children use the parent's box, including under a grid.
// placementKind is the one place that decides which: childLayout, and a moved node's carried sizing.
export function placementKind(mode: LayoutMode, absolute: boolean): ChildLayout["kind"] {
  return absolute ? "free" : mode.kind;
}

// What "fill" asks for in a placement: a share of what the layout hands out (a flow's spare room,
// a grid cell), or the whole of the parent's box. A carried fill keeps its meaning only between
// placements that read it the same way.
export function fillReading(kind: ChildLayout["kind"]): "layout-share" | "parent-box" {
  return kind === "free" ? "parent-box" : "layout-share";
}
// Figma's per-axis constraint enum keyed by the author's directional `constraints` (ir.ts ConstraintX/ConstraintY).
// Two maps because the axis-neutral words (center/stretch/scale) sit alongside axis-specific edges.
// "none" → MIN: clearing a constraint restores Figma's default (near-edge). Here, not in the bridge,
// because the instance write policy compares a live constraint against a word without importing the bridge.
export const CONSTRAINT_H: Record<string, string> = { left: "MIN", center: "CENTER", right: "MAX", stretch: "STRETCH", scale: "SCALE", none: "MIN" };
export const CONSTRAINT_V: Record<string, string> = { top: "MIN", center: "CENTER", bottom: "MAX", stretch: "STRETCH", scale: "SCALE", none: "MIN" };

export type ChildLayout =
  | { kind: "free"; layout: WriteLayout }
  | { kind: "flow"; mode: Extract<LayoutMode, { kind: "flow" }>; layout: WriteLayout }
  | { kind: "grid"; layout: WriteLayout; align?: "MIN" | "MAX" | "CENTER" | "AUTO" };
export const FLOW_ALIGNMENT_GUIDANCE = 'Figma renders per-child layoutAlign MIN/CENTER/MAX nowhere (deprecated); only STRETCH is real, accepted here as alignSelf: "stretch" for counter-axis fill. Set layout.alignItems on the parent to align every child, or wrap this child in a fill-sized frame with its own alignItems.';
const CELL_ALIGN = { start: "MIN", end: "MAX", center: "CENTER", auto: "AUTO" } as const;
export function childLayout(mode: LayoutMode, words: WriteLayout, absolute: boolean, subject: string): ChildLayout {
  const layout = normalizeChildLayoutAliases(words, mode, absolute, subject);
  const hasCellWords = layout.gridColumn || layout.gridRow || layout.justifySelf || layout.zIndex !== undefined;
  const kind = placementKind(mode, absolute);
  if (hasCellWords && kind !== "grid") throw new Error(subject + ": grid placement requires an in-flow GRID parent.");
  if (kind === "free") {
    if (layout.alignSelf) throw new Error(subject + ": alignSelf requires an in-flow auto-layout parent.");
    return { kind, layout };
  }
  if (mode.kind === "flow") {
    if (layout.alignSelf !== undefined) throw new Error(subject + ": " + FLOW_ALIGNMENT_GUIDANCE);
    return { kind: "flow", mode, layout };
  }
  const alignment = layout.alignSelf;
  if (alignment && !Object.prototype.hasOwnProperty.call(CELL_ALIGN, alignment)) throw new Error(subject + ": alignSelf under grid must be " + Object.keys(CELL_ALIGN).join(", ") + ".");
  return { kind: "grid", layout, align: alignment ? CELL_ALIGN[alignment as keyof typeof CELL_ALIGN] : undefined };
}

/**
 * Stretch is a size request on the axis its CSS word governs, not a second alignment implementation:
 * Figma has no STRETCH alignment anywhere, and "fill that axis" is the same picture. `alignSelf`
 * governs the block axis — a flow parent's cross axis, a grid cell's height — and `justifySelf` the
 * inline axis, which only grid has a word for. Both rewrite the same way, so the spelling a CSS
 * author reaches for never becomes a refusal for a picture flcm can draw.
 */
function normalizeChildLayoutAliases(layout: WriteLayout, parent: LayoutMode, absolute: boolean, subject: string): WriteLayout {
  let out = layout;
  if (layout.alignSelf === "stretch") {
    if (absolute || parent.kind === "free") throw new Error(subject + ': alignSelf "stretch" requires an in-flow row/column or grid parent.');
    out = stretchIntoFill(out, "alignSelf", parent.kind === "flow" ? parent.cross : "vertical", subject);
  }
  // Out of flow (or under a row/column, which has no cell) the word is left alone for childLayout's
  // own "grid placement requires an in-flow GRID parent" refusal — one home for that sentence.
  if (out.justifySelf === "stretch" && parent.kind === "grid" && !absolute) out = stretchIntoFill(out, "justifySelf", "horizontal", subject);
  return out;
}

function stretchIntoFill(layout: WriteLayout, word: "alignSelf" | "justifySelf", axis: "horizontal" | "vertical", subject: string): WriteLayout {
  if (layout.sizing?.[axis] !== undefined && layout.sizing[axis] !== "fill") {
    throw new Error(subject + ": " + word + ' "stretch" conflicts with the authored ' + (axis === "horizontal" ? "width" : "height") + '; use "fill".');
  }
  const words = { ...layout };
  delete words[word];
  return { ...words, sizing: { ...layout.sizing, [axis]: "fill" } };
}
