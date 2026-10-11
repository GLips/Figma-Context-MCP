import type { NodeSnapshot } from "../snapshot.js";
import {
  generateCSSShorthand,
  isFrame,
  isInAutoLayoutFlow,
  isLayout,
  pixelRound,
  type LayoutSnapshot,
} from "../utils.js";
import {
  convertSizing,
  gapShorthand,
  getChildStretch,
  layoutModeToSchema,
  resolveChildAxis,
  shouldEmitFixedDimension,
} from "./layout/common.js";
import { buildFlexGap, convertAlignItems, convertJustifyContent } from "./layout/flex.js";
import { buildGridChildPositioning, isPackedGrid } from "./layout/grid.js";
import { bindNumber, bindParts } from "./bound-values.js";
import { variableReference } from "../tokens.js";
import type { NodeGeometry, SimplifiedDimension, SimplifiedLayout } from "./layout/common.js";

export type { NodeGeometry, SimplifiedDimension, SimplifiedLayout } from "./layout/common.js";
export { computeGridChildOrder } from "./layout/grid.js";

/**
 * Convert Figma's layout config into the canonical hybrid structure: container
 * config (`layout` group) plus per-node geometry (emitted at the node top
 * level). One function because both halves share the axis resolution — a
 * child's stretch/dimension semantics depend on the parent's layout mode.
 */
export function buildSimplifiedLayout(
  n: NodeSnapshot,
  parent?: NodeSnapshot,
): { layout: SimplifiedLayout; geometry: NodeGeometry } {
  const layout = buildSimplifiedFrameValues(n);
  const parentGridPacked =
    isFrame(parent) && parent.layoutMode === "GRID" && parent.children
      ? isPackedGrid(parent.children)
      : undefined;
  const parentIsGrid = parentGridPacked !== undefined;

  // Grid child properties: positioning, spans, alignment, and z-order
  if (
    isLayout(n) &&
    parentGridPacked !== undefined &&
    parent &&
    n.layoutPositioning !== "ABSOLUTE"
  ) {
    Object.assign(layout, buildGridChildPositioning(n, parent, parentGridPacked));
  }

  // Flow layoutAlign's legacy alignment values do not render; STRETCH is captured by sizing.
  return { layout, geometry: buildNodeGeometry(n, parent, layout.mode, parentIsGrid) };
}

function buildSimplifiedFrameValues(n: NodeSnapshot): SimplifiedLayout {
  if (!isFrame(n)) {
    return {};
  }

  const mode = layoutModeToSchema(n.layoutMode);
  const frameValues: SimplifiedLayout = { mode };

  const overflowScroll: SimplifiedLayout["overflowScroll"] = [];
  if (n.overflowDirection?.includes("HORIZONTAL")) overflowScroll.push("x");
  if (n.overflowDirection?.includes("VERTICAL")) overflowScroll.push("y");
  if (overflowScroll.length > 0) frameValues.overflowScroll = overflowScroll;

  if (mode === "none") {
    return frameValues;
  }

  // Shared across grid and flex containers. Every optional word is set only when it has a value:
  // the plugin hands this object to the sandbox AS-IS (no JSON round trip to drop an undefined
  // key), and a read shape spreads into the constructors, whose closed-set gate judges every
  // present key — so a present-but-undefined `alignSelf` would read as an unknown prop.
  const sides = {
    top: n.paddingTop ?? 0,
    right: n.paddingRight ?? 0,
    bottom: n.paddingBottom ?? 0,
    left: n.paddingLeft ?? 0,
  };
  const bound = n.boundVariables;
  const boundPadding = bindParts([
    ["top", sides.top, bound?.paddingTop],
    ["right", sides.right, bound?.paddingRight],
    ["bottom", sides.bottom, bound?.paddingBottom],
    ["left", sides.left, bound?.paddingLeft],
  ]);
  if (boundPadding) frameValues.padding = boundPadding;
  else if (sides.top || sides.bottom || sides.left || sides.right) {
    frameValues.padding = generateCSSShorthand(sides);
  }

  if (mode === "grid") {
    const cols = n.gridColumnsSizing?.trim();
    if (cols) frameValues.gridTemplateColumns = cols;

    const rows = n.gridRowsSizing?.trim();
    if (rows) frameValues.gridTemplateRows = rows;

    setIfDefined(frameValues, "gap", gapShorthand(n.gridRowGap, n.gridColumnGap));
    return frameValues;
  }

  // Flex-specific — mode is narrowed to "row" | "column" after grid early-return
  setIfDefined(
    frameValues,
    "justifyContent",
    convertJustifyContent(n.primaryAxisAlignItems ?? "MIN"),
  );
  setIfDefined(
    frameValues,
    "alignItems",
    convertAlignItems(n.counterAxisAlignItems ?? "MIN", n.children ?? [], mode),
  );
  if (n.layoutWrap === "WRAP") frameValues.wrap = true;
  setIfDefined(frameValues, "gap", buildFlexGap(n, mode));

  return frameValues;
}

function setIfDefined<K extends keyof SimplifiedLayout>(
  layout: SimplifiedLayout,
  key: K,
  value: SimplifiedLayout[K] | undefined,
): void {
  if (value !== undefined) layout[key] = value;
}

function buildNodeGeometry(
  n: NodeSnapshot,
  parent: NodeSnapshot | undefined,
  mode: SimplifiedLayout["mode"],
  parentIsGrid: boolean,
): NodeGeometry {
  // No bounding box (e.g. DOCUMENT/CANVAS, synthetic fixtures) → no geometry
  // signal at all; every axis is omitted rather than guessed.
  if (!isLayout(n)) return {};

  // The requested root has no parent in the payload, so Figma reports its sizing
  // FIXED relative to an absent container — an artifact of being top-level, not
  // design intent. Honoring it as a hard width/height pins the whole design to
  // its artboard and kills responsiveness. Descendants (which have a real parent)
  // keep their fill/hug/fixed semantics. See fig-ovmi.
  const isRoot = parent === undefined;
  const geometry: NodeGeometry = {};
  const bound = n.boundVariables;
  if (n.minWidth != null) geometry.minWidth = bindNumber(pixelRound(n.minWidth), bound?.minWidth);
  if (n.maxWidth != null) geometry.maxWidth = bindNumber(pixelRound(n.maxWidth), bound?.maxWidth);
  if (n.minHeight != null)
    geometry.minHeight = bindNumber(pixelRound(n.minHeight), bound?.minHeight);
  if (n.maxHeight != null)
    geometry.maxHeight = bindNumber(pixelRound(n.maxHeight), bound?.maxHeight);

  // Per-axis width/height. Emit a concrete number only when the child isn't
  // stretching that axis and the sizing flag permits it. Stretch detection and
  // the "is FIXED?" rule both depend on whether the parent is flex, grid, or
  // non-auto-layout — see ./layout/common.ts for the per-axis vocabulary mapping.
  const axis = resolveChildAxis(n, parent, mode, parentIsGrid);
  const stretch = getChildStretch(n, axis);
  // The node's OWN size is what width/height mean (see NodeGeometry); the AABB is
  // the fallback for a producer that couldn't determine it (see NodeSnapshot.ownSize),
  // and the two are the same box on every unrotated node.
  const size = n.ownSize ?? n.absoluteBoundingBox;
  // Outside auto-layout (a free-form parent, or the root) Figma reports FIXED on every axis, even a
  // TEXT axis that grows with its content. That axis is the text's default — what an unnamed
  // dimension authors — so it is omitted rather than pinned to today's measurement. A real
  // HUG/FILL flag (in-flow under auto-layout) is intent and resolves below as usual.
  const textFollowsContent = textAxesFollowingContent(n);
  const horizontal =
    textFollowsContent.horizontal && isUnflaggedOrFixed(n.layoutSizingHorizontal)
      ? {}
      : resolveAxisDimension(
          convertSizing(n.layoutSizingHorizontal),
          size.width,
          isRoot,
          !stretch.horizontal && shouldEmitFixedDimension(n.layoutSizingHorizontal, axis),
        );
  // A LINE has no height — Figma reports 0 on every one — so its vertical axis says nothing and is
  // omitted, matching the write side, where flcm.line sizes on `width` alone.
  const vertical =
    n.type === "LINE" || (textFollowsContent.vertical && isUnflaggedOrFixed(n.layoutSizingVertical))
      ? {}
      : resolveAxisDimension(
          convertSizing(n.layoutSizingVertical),
          size.height,
          isRoot,
          !stretch.vertical && shouldEmitFixedDimension(n.layoutSizingVertical, axis),
        );
  // Only a fixed size gives way to its variable; fill and hug are sizing words, not values. A root's
  // "contextual" is a fixed axis too: a bound one is deliberate, so it reads as its variable rather
  // than as the size it happened to be designed at.
  const bindsFixed = (dimension: SimplifiedDimension | undefined) =>
    typeof dimension === "number" || dimension === "contextual";
  if (horizontal.dimension !== undefined)
    geometry.width =
      bindsFixed(horizontal.dimension) && bound?.width
        ? variableReference(bound.width)
        : horizontal.dimension;
  // A TEXT's height follows its content unless it fills or is fixed — "hug" is every text's default,
  // so it is omitted, the way the write side treats an unnamed height. A number (a fixed-height
  // text box, textAutoResize NONE) and "fill" are the deviations and survive.
  const textDefaultHeight = n.type === "TEXT" && vertical.dimension === "hug";
  if (vertical.dimension !== undefined && !textDefaultHeight)
    geometry.height =
      bindsFixed(vertical.dimension) && bound?.height
        ? variableReference(bound.height)
        : vertical.dimension;
  if (horizontal.designed !== undefined) geometry.designedWidth = horizontal.designed;
  if (vertical.designed !== undefined) geometry.designedHeight = vertical.designed;

  // Preserves historical behavior: aspectRatio is emitted only for
  // column-parent children. Likely should apply more broadly — pre-existing.
  // Measured on the OWN size, the same box width/height come from: the ratio sits
  // beside them and describes the same node, so reading it off the page-space AABB
  // would put a rotated node's shadow ratio next to its authored dimensions.
  if (!isRoot && axis === "column" && n.preserveRatio && size.height !== 0) {
    geometry.aspectRatio = size.width / size.height;
  }

  // Emit positioning relative to parent unless the parent's auto-layout already
  // places this child. `isLayout(parent)` also screens out top-level nodes
  // (no parent) and parents without bounding boxes (e.g. CANVAS), where
  // coordinates would be meaningless.
  if (isLayout(parent) && !isInAutoLayoutFlow(n, parent)) {
    if (n.layoutPositioning === "ABSOLUTE") {
      geometry.position = "absolute";
    }
    const corner = unrotatedCorner(n, parent, size);
    geometry.left = pixelRound(corner.x);
    geometry.top = pixelRound(corner.y);
  }

  // Figma reports rotation in degrees, counterclockwise-positive; CSS rotate()
  // is clockwise-positive. Negate so the value pastes straight into CSS.
  if (n.rotation) {
    const degrees = pixelRound(-n.rotation);
    if (degrees !== 0) geometry.rotation = degrees;
  }

  return geometry;
}

/**
 * The parent-relative corner `left`/`top` name: the node's UNROTATED top-left, because the write
 * side turns a node about its centre, as CSS `rotate()` does. Figma's `ownOrigin` is the transform's
 * translation — the corner it turns about — so a rotated node shifts by (M - I)·half, M being the
 * rotation matrix Figma's `relativeTransform` carries. The AABB fallback lands on the same point
 * from the other side: a turned box keeps its centre, so the corner is that centre less half the
 * own size. (The fallback subtracts the parent's AABB corner, exact only under an unrotated parent.)
 */
function unrotatedCorner(
  n: LayoutSnapshot,
  parent: LayoutSnapshot,
  size: { width: number; height: number },
): { x: number; y: number } {
  const hw = size.width / 2;
  const hh = size.height / 2;
  if (!n.ownOrigin) {
    const box = n.absoluteBoundingBox;
    return {
      x: box.x + box.width / 2 - hw - parent.absoluteBoundingBox.x,
      y: box.y + box.height / 2 - hh - parent.absoluteBoundingBox.y,
    };
  }
  if (!n.rotation) return n.ownOrigin;
  const radians = (n.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: n.ownOrigin.x + (cos - 1) * hw + sin * hh,
    y: n.ownOrigin.y - sin * hw + (cos - 1) * hh,
  };
}

function textAxesFollowingContent(n: NodeSnapshot): { horizontal: boolean; vertical: boolean } {
  if (n.type !== "TEXT") return { horizontal: false, vertical: false };
  return {
    horizontal: n.textAutoResize === "WIDTH_AND_HEIGHT",
    vertical: n.textAutoResize === "WIDTH_AND_HEIGHT" || n.textAutoResize === "HEIGHT",
  };
}

function isUnflaggedOrFixed(sizing: NodeSnapshot["layoutSizingHorizontal"]): boolean {
  return sizing === undefined || sizing === "FIXED";
}

type AxisDimension = { dimension?: SimplifiedDimension; designed?: string };

/**
 * Resolve one axis of a node's sizing to the flattened vocabulary: a concrete
 * number IS fixed px, `"fill"`/`"hug"` carry sizing intent, and the root's
 * artifact-FIXED becomes `"contextual"` with the designed size preserved as a
 * non-binding reference (as does a root `"fill"`, whose parent is gone). An
 * axis with no signal (no sizing flag and no emittable dimension) is omitted
 * entirely — there is no bare "fixed" tag.
 */
function resolveAxisDimension(
  sizing: "fixed" | "fill" | "hug" | undefined,
  boxSize: number,
  isRoot: boolean,
  emitFixedNumber: boolean,
): AxisDimension {
  if (sizing === "hug") return { dimension: sizing };
  // A root's fill resolved against a parent the read no longer carries, so its
  // pixel size rides along — the one number that survives being placed where
  // fill can't resolve (a page). Hug is the node's own content size and needs none.
  if (sizing === "fill")
    return isRoot
      ? { dimension: sizing, designed: `${pixelRound(boxSize)}px` }
      : { dimension: sizing };
  // For the root, rewrite the spurious FIXED axis as "contextual" (it fills
  // whatever it's placed in) and surface the designed size as a non-binding
  // reference — absolutely-positioned children and the fill-chain still need a
  // concrete size to anchor against.
  if (isRoot) {
    return sizing === "fixed"
      ? { dimension: "contextual", designed: `${pixelRound(boxSize)}px` }
      : {};
  }
  return emitFixedNumber ? { dimension: pixelRound(boxSize) } : {};
}
