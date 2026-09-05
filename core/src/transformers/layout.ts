import type { NodeSnapshot } from "../snapshot.js";
import {
  generateCSSShorthand,
  isFrame,
  isInAutoLayoutFlow,
  isLayout,
  pixelRound,
} from "../utils.js";
import {
  convertSelfAlign,
  convertSizing,
  gapShorthand,
  getChildStretch,
  layoutModeToSchema,
  resolveChildAxis,
  shouldEmitFixedDimension,
} from "./layout/common.js";
import { buildFlexGap, convertAlignItems, convertJustifyContent } from "./layout/flex.js";
import { buildGridChildPositioning, isPackedGrid } from "./layout/grid.js";
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

  return { layout, geometry: buildNodeGeometry(n, parent, layout.mode, parentIsGrid) };
}

function buildSimplifiedFrameValues(n: NodeSnapshot): SimplifiedLayout {
  if (!isFrame(n)) {
    return { mode: "none" };
  }

  const frameValues: SimplifiedLayout = {
    mode: layoutModeToSchema(n.layoutMode),
  };

  const overflowScroll: SimplifiedLayout["overflowScroll"] = [];
  if (n.overflowDirection?.includes("HORIZONTAL")) overflowScroll.push("x");
  if (n.overflowDirection?.includes("VERTICAL")) overflowScroll.push("y");
  if (overflowScroll.length > 0) frameValues.overflowScroll = overflowScroll;

  const { mode } = frameValues;
  if (mode === "none") {
    return frameValues;
  }

  // Shared across grid and flex containers
  frameValues.alignSelf = convertSelfAlign(n.layoutAlign);
  if (n.paddingTop || n.paddingBottom || n.paddingLeft || n.paddingRight) {
    frameValues.padding = generateCSSShorthand({
      top: n.paddingTop ?? 0,
      right: n.paddingRight ?? 0,
      bottom: n.paddingBottom ?? 0,
      left: n.paddingLeft ?? 0,
    });
  }

  if (mode === "grid") {
    const cols = n.gridColumnsSizing?.trim();
    if (cols) frameValues.gridTemplateColumns = cols;

    const rows = n.gridRowsSizing?.trim();
    if (rows) frameValues.gridTemplateRows = rows;

    frameValues.gap = gapShorthand(n.gridRowGap, n.gridColumnGap);
    return frameValues;
  }

  // Flex-specific — mode is narrowed to "row" | "column" after grid early-return
  frameValues.justifyContent = convertJustifyContent(n.primaryAxisAlignItems ?? "MIN");
  frameValues.alignItems = convertAlignItems(
    n.counterAxisAlignItems ?? "MIN",
    n.children ?? [],
    mode,
  );
  frameValues.wrap = n.layoutWrap === "WRAP" ? true : undefined;
  frameValues.gap = buildFlexGap(n, mode);

  return frameValues;
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
  const horizontal = resolveAxisDimension(
    convertSizing(n.layoutSizingHorizontal),
    size.width,
    isRoot,
    !stretch.horizontal && shouldEmitFixedDimension(n.layoutSizingHorizontal, axis),
  );
  const vertical = resolveAxisDimension(
    convertSizing(n.layoutSizingVertical),
    size.height,
    isRoot,
    !stretch.vertical && shouldEmitFixedDimension(n.layoutSizingVertical, axis),
  );
  if (horizontal.dimension !== undefined) geometry.width = horizontal.dimension;
  if (vertical.dimension !== undefined) geometry.height = vertical.dimension;
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
    // `ownOrigin` is already parent-relative; the AABB fallback subtracts the
    // parent's box, which is the same point whenever neither node is rotated.
    const origin = n.ownOrigin ?? {
      x: n.absoluteBoundingBox.x - parent.absoluteBoundingBox.x,
      y: n.absoluteBoundingBox.y - parent.absoluteBoundingBox.y,
    };
    geometry.left = pixelRound(origin.x);
    geometry.top = pixelRound(origin.y);
  }

  // Figma reports rotation in degrees, counterclockwise-positive; CSS rotate()
  // is clockwise-positive. Negate so the value pastes straight into CSS.
  if (n.rotation) {
    const degrees = pixelRound(-n.rotation);
    if (degrees !== 0) geometry.rotation = degrees;
  }

  return geometry;
}

type AxisDimension = { dimension?: SimplifiedDimension; designed?: string };

/**
 * Resolve one axis of a node's sizing to the flattened vocabulary: a concrete
 * number IS fixed px, `"fill"`/`"hug"` carry sizing intent, and the root's
 * artifact-FIXED becomes `"contextual"` with the designed size preserved as a
 * non-binding reference. An axis with no signal (no sizing flag and no
 * emittable dimension) is omitted entirely — there is no bare "fixed" tag.
 */
function resolveAxisDimension(
  sizing: "fixed" | "fill" | "hug" | undefined,
  boxSize: number,
  isRoot: boolean,
  emitFixedNumber: boolean,
): AxisDimension {
  if (sizing === "fill" || sizing === "hug") return { dimension: sizing };
  // For the root, rewrite the spurious FIXED axis as "contextual" (it fills
  // whatever it's placed in) and surface the designed size as a non-binding
  // reference — absolutely-positioned children and the fill-chain still need a
  // concrete size to anchor against. Real FILL/HUG axes are intent (above).
  if (isRoot) {
    return sizing === "fixed"
      ? { dimension: "contextual", designed: `${pixelRound(boxSize)}px` }
      : {};
  }
  return emitFixedNumber ? { dimension: pixelRound(boxSize) } : {};
}
