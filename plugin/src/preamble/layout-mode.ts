import type { WriteLayout } from "./ir.js";
import { normalizeChildLayoutAliases } from "./input-aliases.js";

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
export type ChildLayout =
  | { kind: "free"; layout: WriteLayout }
  | { kind: "flow"; mode: Extract<LayoutMode, { kind: "flow" }>; layout: WriteLayout; align?: "MIN" | "MAX" | "CENTER" | "INHERIT" }
  | { kind: "grid"; layout: WriteLayout; align?: "MIN" | "MAX" | "CENTER" | "AUTO" };
const FLOW_ALIGN = { "flex-start": "MIN", "flex-end": "MAX", center: "CENTER", auto: "INHERIT" } as const;
const CELL_ALIGN = { start: "MIN", end: "MAX", center: "CENTER", auto: "AUTO" } as const;
export function childLayout(mode: LayoutMode, words: WriteLayout, absolute: boolean, subject: string): ChildLayout {
  const layout = normalizeChildLayoutAliases(words, mode, absolute, subject);
  const hasCellWords = layout.gridColumn || layout.gridRow || layout.justifySelf || layout.zIndex !== undefined;
  const kind = absolute ? "free" : mode.kind;
  if (hasCellWords && kind !== "grid") throw new Error(subject + ": grid placement requires an in-flow GRID parent.");
  if (kind === "free") {
    if (layout.alignSelf) throw new Error(subject + ": alignSelf requires an in-flow auto-layout parent.");
    return { kind, layout };
  }
  const alignment = layout.alignSelf;
  const table = kind === "grid" ? CELL_ALIGN : FLOW_ALIGN;
  if (alignment && !Object.prototype.hasOwnProperty.call(table, alignment)) throw new Error(subject + ": alignSelf under " + mode.word + " must be " + Object.keys(table).join(", ") + ".");
  if (mode.kind === "flow") return { kind: "flow", mode, layout, align: alignment ? FLOW_ALIGN[alignment as keyof typeof FLOW_ALIGN] : undefined };
  return { kind: "grid", layout, align: alignment ? CELL_ALIGN[alignment as keyof typeof CELL_ALIGN] : undefined };
}
