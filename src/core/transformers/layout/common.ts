import { exhaustiveCheck, isFrame, isInAutoLayoutFlow } from "~/core/utils.js";
import type { NodeSnapshot } from "~/core/snapshot.js";

/**
 * Container config only (the canonical `layout` group). Per-node geometry —
 * width/height, position, rotation — lives at the node top level as
 * `NodeGeometry`, per the canonical vocabulary's hybrid structure.
 *
 * The string-union members below ARE the Figma-realizable subset of each
 * CSS-named field, shared by both producers: values outside a union are valid
 * CSS the canvas can't realize (`space-around`, `position: sticky`, …) and the
 * write edge (flcm's schema) fails loud naming the supported set rather than
 * emitting a silent no-op. These unions are the canonical definition of those
 * subsets now that the vocabulary spec is superseded by code.
 */
export interface SimplifiedLayout {
  mode: "none" | "row" | "column" | "grid";
  justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | "baseline" | "stretch";
  alignItems?: "flex-start" | "flex-end" | "center" | "space-between" | "baseline" | "stretch";
  alignSelf?: "flex-start" | "flex-end" | "center" | "stretch" | "start" | "end";
  wrap?: boolean;
  gap?: string;
  padding?: string;
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
  overflowScroll?: ("x" | "y")[];
}

/**
 * A node's sizing along one axis. A concrete number IS fixed px — there is no
 * separate `sizing: fixed` flag. "contextual" is read-only and root-only: the
 * requested root's REST-reported FIXED size is an artifact of being top-level,
 * not design intent (see resolveAxisDimension in ../layout.ts).
 */
export type SimplifiedDimension = number | "fill" | "hug" | "contextual";

/**
 * Per-node geometry, emitted at the node top level (hybrid structure).
 *
 * CANONICAL MEANING OF `width`/`height`: the node's OWN size — the number it was
 * authored at, in its own pre-rotation frame — never the page-space axis-aligned
 * box that contains it. The two differ only for a rotated node, and only the own
 * size composes with `rotation` the way CSS composes `width` with `rotate()`: a
 * 40x24 rect authored at 15° emits `width: 40, height: 24, rotation: -15`, which
 * pastes as `width: 40px; transform: rotate(-15deg)`, and the AABB's 44.85 is a
 * fact about its shadow on the page. `left`/`top` follow the same rule — they name
 * the node's own top-left corner in the parent's frame, not the AABB's corner
 * (which a rotated node doesn't even have). Figma rotates about that same corner,
 * so the CSS composes only under `transform-origin: 0 0`; at the default centre
 * origin the rotation walks the box off its `left`/`top`. This matches how the
 * write path spells the same numbers (`geometryOf`, plugin bridge), so a shape
 * read back can be written straight out again — with one spelling the two would
 * differ on if they could ever meet: under a GROUP, read measures `left`/`top` in
 * the group's own frame, where `geometryOf` reports the raw container-parent offset
 * Figma states. They don't meet, because render parents only into frames it built
 * itself, so no handle it mints has a group above it.
 *
 * The source is `NodeSnapshot.ownSize`/`ownOrigin`; both fall back to
 * `absoluteBoundingBox` when the producer couldn't determine the node's own box.
 * `aspectRatio` is measured on the same own size — it describes the node beside
 * it, not the node's shadow. Page-space questions that genuinely want the AABB
 * (grid child-overlap) read it off the snapshot directly.
 */
export interface NodeGeometry {
  width?: SimplifiedDimension;
  height?: SimplifiedDimension;
  // The size the requested root was designed at, surfaced as a non-binding
  // reference (not a hard width/height). The root's own dimensions are
  // "contextual" — it fills whatever it's placed in — but absolutely-positioned
  // children and the fill-chain still need a concrete size to anchor against, so
  // we keep the designed value here, string-typed with a px suffix so it can't
  // be mistaken for a binding numeric width.
  designedWidth?: string;
  designedHeight?: string;
  aspectRatio?: number;
  position?: "absolute";
  // Offset from the parent's top-left corner, matching the numeric emission
  // convention of the sibling geometry fields (width/height). Emitted only when
  // the parent's auto-layout doesn't already place this node.
  left?: number;
  top?: number;
  /**
   * Rotation in degrees. The canonical vocabulary is **clockwise-positive**, like
   * CSS `rotate()`. Figma's raw `node.rotation` is **counterclockwise**-positive
   * (on the Y-down canvas, `atan2(-m10, m00)` of a visually clockwise rotation is
   * negative), so both producers negate to cross the convention boundary:
   *   - **read** negates on emit here (`geometry.rotation = -n.rotation`);
   *   - **write** negates on set (`node.rotation = -wn.rotation`, plugin bridge).
   * This is the single source for the sign convention — it used to live in the
   * (now code-superseded) canonical-vocabulary spec.
   */
  rotation?: number;
}

export function convertSizing(s?: NodeSnapshot["layoutSizingHorizontal"]) {
  if (s === "FIXED") return "fixed";
  if (s === "FILL") return "fill";
  if (s === "HUG") return "hug";
  return undefined;
}

export function convertSelfAlign(align?: NodeSnapshot["layoutAlign"]) {
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

// Centralized mapping of the snapshot's layoutMode to our schema's mode tag.
// Exhaustive switch — if NodeSnapshot["layoutMode"] ever gains a new value,
// exhaustiveCheck fails the build until we decide how to map it.
export function layoutModeToSchema(
  layoutMode: NodeSnapshot["layoutMode"],
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

export function getParentAutoLayoutMode(parent?: NodeSnapshot): "row" | "column" | undefined {
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
  n: NodeSnapshot,
  parent: NodeSnapshot | undefined,
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
export function getChildStretch(n: NodeSnapshot, axis: ChildAxis): StretchFlags {
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
  sizing: NodeSnapshot["layoutSizingHorizontal"] | undefined,
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
