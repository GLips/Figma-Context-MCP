import { assertGridSizing } from "./layout-legality.js";
import type { WriteLayout } from "./ir.js";
import { AXES, LAYOUT_MODES, layoutModeOf, type LayoutMode, type Axis, type ChildLayout } from "./layout-mode.js";

// Native layout policy owns mode-dependent writes. Bridge orchestration only chooses a policy.
interface LayoutBehavior {
  rawHugs(node: any, axis: Axis): boolean;
  container(node: any, layout: WriteLayout): void;
  ownSize(node: any, sizing: NonNullable<WriteLayout["sizing"]>): void;
  fill(parent: any, child: any, context: ChildLayout, crossStretch: boolean): void;
  clearFill(parent: any, child: any, layout: WriteLayout): void;
  clearChildren(parent: any): void;
  place(parent: any, child: any, context: ChildLayout): void;
  defaultSizing(layout: WriteLayout): NonNullable<WriteLayout["sizing"]>;
}
const noWrite = () => {};
const JUSTIFY = { start: "MIN", center: "CENTER", end: "MAX", between: "SPACE_BETWEEN" } as const;
const ALIGN = { start: "MIN", center: "CENTER", end: "MAX", baseline: "BASELINE" } as const;
const hugDefault = (layout: WriteLayout) => ({ horizontal: "hug", vertical: "hug", ...layout.sizing } as const);

function flowBehavior(mode: Extract<LayoutMode, { kind: "flow" }>): LayoutBehavior {
  function restoreCrossHug(child: any): void {
    const own = layoutModeOf(child);
    if (own.kind === "flow" && own.main === mode.cross) child.primaryAxisSizingMode = "AUTO";
  }
  function stretch(child: any, axis: Axis): void {
    child[axis === mode.main ? "layoutGrow" : "layoutAlign"] = axis === mode.main ? 1 : "STRETCH";
    const own = layoutModeOf(child);
    // Only a flow child’s primary HUG overrides stretch; its counter HUG must survive un-fill.
    if (own.kind === "flow" && own.main === axis) child.primaryAxisSizingMode = "FIXED";
    if (own.kind === "grid") gridOwnSize(child, { [axis]: "fixed" });
  }
  return {
    rawHugs(node, axis) { return node[axis === mode.main ? "primaryAxisSizingMode" : "counterAxisSizingMode"] === "AUTO"; },
    container(f, layout) {
      if (mode.word === "row" && layout.wrap !== undefined) f.layoutWrap = layout.wrap ? "WRAP" : "NO_WRAP";
      if (layout.gap !== undefined) {
        const gap = typeof layout.gap === "number" ? { row: layout.gap, column: layout.gap } : layout.gap;
        f.itemSpacing = mode.word === "row" ? gap.column : gap.row;
        if (f.layoutWrap === "WRAP") { f.counterAxisAlignContent = "AUTO"; f.counterAxisSpacing = mode.word === "row" ? gap.row : gap.column; }
      }
      if (layout.justifyContent) f.primaryAxisAlignItems = JUSTIFY[layout.justifyContent];
      if (layout.alignItems) {
        for (const child of f.children || []) {
          if (layout.alignItems === "stretch") {
            if (child.layoutPositioning !== "ABSOLUTE") stretch(child, mode.cross);
          } else if (child.layoutAlign === "STRETCH") { child.layoutAlign = "INHERIT"; restoreCrossHug(child); }
        }
        if (layout.alignItems !== "stretch") f.counterAxisAlignItems = ALIGN[layout.alignItems];
      }
    },
    ownSize(node, sizing) {
      for (const axis of [mode.main, mode.cross]) {
        const value = sizing[axis];
        if (value && value !== "fill") node[axis === mode.main ? "primaryAxisSizingMode" : "counterAxisSizingMode"] = value === "hug" ? "AUTO" : "FIXED";
      }
    },
    fill(_parent, child, context, crossStretch) {
      const s = context.layout.sizing || {};
      for (const axis of [mode.main, mode.cross]) if (s[axis] === "fill") stretch(child, axis);
      if (crossStretch && s[mode.cross] !== "fixed" && s[mode.cross] !== "fill") stretch(child, mode.cross);
    },
    clearFill(_parent, child, layout) {
      const s = layout.sizing || {};
      if (s[mode.main] === "fixed" || s[mode.main] === "hug") child.layoutGrow = 0;
      if ((s[mode.cross] === "fixed" || s[mode.cross] === "hug") && child.layoutAlign === "STRETCH") child.layoutAlign = "INHERIT";
    },
    clearChildren(parent) {
      for (const child of parent.children || []) {
        child.layoutGrow = 0;
        if (child.layoutAlign === "STRETCH") { child.layoutAlign = "INHERIT"; restoreCrossHug(child); }
      }
    },
    place(_parent, child, context) { if (context.kind === "flow" && context.align) child.layoutAlign = context.align; },
    defaultSizing: hugDefault,
  };
}

function gridOwnSize(node: any, sizing: NonNullable<WriteLayout["sizing"]>): void {
  for (const axis of ["horizontal", "vertical"] as const) {
    const value = sizing[axis];
    if (value && value !== "fill") node[AXES[axis].sizing] = value === "hug" ? "HUG" : "FIXED";
  }
}
const GRID: LayoutBehavior = {
  rawHugs(node, axis) { return node[AXES[axis].sizing] === "HUG"; },
  container(node, layout) {
    assertGridSizing(layout, node, "flcm");
    for (const axis of ["horizontal", "vertical"] as const) {
      const { template, count, tracks, sizing } = AXES[axis];
      const requested = layout[template];
      if (!requested) continue;
      node.gridAutoTracks = "NONE";
      const previous = node[sizing];
      // New native tracks start FLEX; temporarily bound HUG before assigning their actual types.
      if (previous === "HUG") node[sizing] = "FIXED";
      node[count] = requested.length;
      requested.forEach((track, i) => {
        node[tracks][i].type = track.type;
        if (track.type !== "HUG") node[tracks][i].value = track.value;
      });
      if (previous === "HUG" && !requested.some(t => t.type === "FLEX")) node[sizing] = "HUG";
    }
    if (layout.gap !== undefined) {
      node.gridRowGap = typeof layout.gap === "number" ? layout.gap : layout.gap.row;
      node.gridColumnGap = typeof layout.gap === "number" ? layout.gap : layout.gap.column;
    }
  },
  ownSize: gridOwnSize,
  fill(_parent, child, context) {
    for (const axis of ["horizontal", "vertical"] as const) if (context.layout.sizing?.[axis] === "fill") child[AXES[axis].sizing] = "FILL";
  },
  clearFill(_parent, child, layout) { gridOwnSize(child, layout.sizing || {}); },
  clearChildren(parent) {
    for (const child of parent.children || []) for (const axis of ["horizontal", "vertical"] as const) {
      if (child[AXES[axis].sizing] === "FILL") child[AXES[axis].sizing] = "FIXED";
    }
  },
  place(parent, child, context) {
    if (context.kind !== "grid") return;
    const layout = context.layout;
    if (layout.gridColumn || layout.gridRow || layout.zIndex !== undefined) parent.gridItemsPositioning = "MANUAL";
    if (layout.gridColumn) child.gridColumnSpan = 1;
    if (layout.gridRow) child.gridRowSpan = 1;
    if (layout.gridColumn?.anchor !== undefined || layout.gridRow?.anchor !== undefined) child.setGridChildPosition(layout.gridRow?.anchor ?? child.gridRowAnchorIndex, layout.gridColumn?.anchor ?? child.gridColumnAnchorIndex);
    if (layout.gridColumn) child.gridColumnSpan = layout.gridColumn.span;
    if (layout.gridRow) child.gridRowSpan = layout.gridRow.span;
    if (layout.justifySelf) child.gridChildHorizontalAlign = layout.justifySelf;
    if (context.align) child.gridChildVerticalAlign = context.align;
  },
  defaultSizing: hugDefault,
};
const FREE: LayoutBehavior = {
  rawHugs: () => false,
  container: noWrite, ownSize: noWrite, fill: noWrite, clearFill: noWrite, place: noWrite,
  clearChildren(parent) {
    // Parked flow marks cannot become active merely because a free-form parent gains a direction.
    for (const child of parent.children || []) { child.layoutGrow = 0; if (child.layoutAlign === "STRETCH") child.layoutAlign = "INHERIT"; }
  },
  defaultSizing: hugDefault,
};
const BEHAVIORS: Record<LayoutMode["word"], LayoutBehavior> = { none: FREE, row: flowBehavior(LAYOUT_MODES.row), column: flowBehavior(LAYOUT_MODES.column), grid: GRID };
export function behaviorForMode(mode: LayoutMode): LayoutBehavior { return BEHAVIORS[mode.word]; }
export function layoutBehavior(node: { layoutMode?: string }): LayoutBehavior { return BEHAVIORS[layoutModeOf(node).word]; }

/** Explicit indexes occupy slots; unmentioned siblings fill the remaining slots in their existing order. */
export function applySiblingOrder(parent: any, edits: readonly { child: any; index: number }[]): void {
  if (!edits.length) return;
  const slots: any[] = new Array(parent.children.length);
  const named = new Set(edits.map(edit => edit.child));
  for (const { child, index } of edits) {
    if (index >= slots.length) throw new Error("zIndex must be within the parent's sibling count.");
    if (slots[index]) throw new Error("zIndex must name a distinct sibling index in one operation.");
    slots[index] = child;
  }
  const rest = parent.children.filter((child: any) => !named.has(child));
  for (let i = 0; i < slots.length; i++) slots[i] ??= rest.shift();
  parent.gridItemsPositioning = "MANUAL";
  // Move backward into earlier slots only. No pre/post-removal index convention can change that index.
  for (let i = 0; i < slots.length; i++) if (parent.children[i] !== slots[i]) parent.insertChild(i, slots[i]);
}
