/**
 * `NodeSnapshot` — the plan-neutral, core-owned INPUT to `canonicalize`.
 *
 * This is the raw structural form the transform consumes: the wire encodings are
 * decoded (text as runs, uniform image ref, normalized gradient, resolved
 * style/component metadata, no top-level tables), but the values are still raw
 * (RGBA floats, numeric sizes, raw layout traits) — CSS conversion + dedup is
 * `canonicalize`'s sole job, never an adapter's (Invariant 5). One core, two
 * producers: `restNodeToSnapshot` (server) and `sceneNodeToSnapshot` (plugin,
 * out of scope here) both feed this identical shape (Invariant 2).
 *
 * IMPORTANT: this type is deliberately a *structural subset* of a Figma
 * `Node` for the ~1:1 fields (same names, compatible value types), so raw Figma
 * nodes remain assignable during the incremental carve. It carries NO
 * `@figma/rest-api-spec` import — the core module graph must stay Figma-free
 * (Invariant 2 / Phase 1 Done-when). The type grows one concern at a time as
 * each transformer migrates off Figma types onto the snapshot.
 */
/** Axis-aligned box in absolute coordinates (Figma `Rectangle`, decoupled). */
export interface SnapshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Per-side stroke weights (Figma `StrokeWeights`, decoupled). */
export interface SnapshotStrokeWeights {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface NodeSnapshot {
  id: string;
  name: string;
  /** Raw Figma node type (e.g. FRAME, TEXT, VECTOR). The walker maps VECTOR→IMAGE-SVG. */
  type: string;
  visible?: boolean;
  /**
   * Component-property references (e.g. `{ visible: "Show Badge#341:0" }`). The
   * walker reads `visible` to rescue hidden nodes inside component definitions;
   * the component extractor simplifies the rest.
   */
  componentPropertyReferences?: Record<string, string>;
  children?: NodeSnapshot[];

  // ------------------------------------------------------------------------
  // Layout traits — a node's own box and how it sits in its parent's layout.
  // Field names/unions mirror Figma's HasLayoutTrait so raw REST nodes stay
  // structurally assignable during the carve; the values are raw (px numbers,
  // enum tags), and the CSS mapping is canonicalize's job (Invariant 5).
  // ------------------------------------------------------------------------
  absoluteBoundingBox?: SnapshotRect | null;
  layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
  layoutAlign?: "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX";
  layoutGrow?: 0 | 1;
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  preserveRatio?: boolean;
  gridColumnAnchorIndex?: number;
  gridRowAnchorIndex?: number;
  gridColumnSpan?: number;
  gridRowSpan?: number;
  gridChildHorizontalAlign?: "AUTO" | "MIN" | "CENTER" | "MAX";
  gridChildVerticalAlign?: "AUTO" | "MIN" | "CENTER" | "MAX";

  // ------------------------------------------------------------------------
  // Frame / auto-layout container traits (Figma HasFramePropertiesTrait).
  // ------------------------------------------------------------------------
  clipsContent?: boolean;
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  overflowDirection?:
    | "HORIZONTAL_SCROLLING"
    | "VERTICAL_SCROLLING"
    | "HORIZONTAL_AND_VERTICAL_SCROLLING"
    | "NONE";
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "BASELINE";
  counterAxisAlignContent?: "AUTO" | "SPACE_BETWEEN";
  layoutWrap?: "NO_WRAP" | "WRAP";
  itemSpacing?: number;
  counterAxisSpacing?: number;
  gridColumnsSizing?: string;
  gridRowsSizing?: string;
  gridRowGap?: number;
  gridColumnGap?: number;
}
