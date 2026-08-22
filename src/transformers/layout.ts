import { isInAutoLayoutFlow, isFrame, isLayout, isRectangle } from "~/utils/identity.js";
import type { Node as FigmaDocumentNode, HasLayoutTrait, Transform } from "@figma/rest-api-spec";
import { generateCSSShorthand, pixelRound } from "~/utils/common.js";
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
import type { SimplifiedLayout } from "./layout/common.js";

export type { SimplifiedLayout } from "./layout/common.js";
export { computeGridChildOrder } from "./layout/grid.js";

// Convert Figma's layout config into a more typical flex-like schema
export function buildSimplifiedLayout(
  n: FigmaDocumentNode,
  parent?: FigmaDocumentNode,
): SimplifiedLayout {
  const frameValues = buildSimplifiedFrameValues(n);
  const parentGridPacked =
    isFrame(parent) && parent.layoutMode === "GRID" && "children" in parent
      ? isPackedGrid(parent.children as FigmaDocumentNode[])
      : undefined;
  const layoutValues =
    buildSimplifiedLayoutValues(n, parent, frameValues.mode, parentGridPacked) || {};

  return { ...frameValues, ...layoutValues };
}

function buildSimplifiedFrameValues(n: FigmaDocumentNode): SimplifiedLayout | { mode: "none" } {
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
    // Grid template/gap properties live on HasLayoutTrait; GRID frames always
    // carry both traits, so the cast is safe.
    const ln = n as unknown as HasLayoutTrait;
    const cols = ln.gridColumnsSizing?.trim();
    if (cols) frameValues.gridTemplateColumns = cols;

    const rows = ln.gridRowsSizing?.trim();
    if (rows) frameValues.gridTemplateRows = rows;

    frameValues.gap = gapShorthand(ln.gridRowGap, ln.gridColumnGap);
    return frameValues;
  }

  // Flex-specific — mode is narrowed to "row" | "column" after grid early-return
  frameValues.justifyContent = convertJustifyContent(n.primaryAxisAlignItems ?? "MIN");
  frameValues.alignItems = convertAlignItems(n.counterAxisAlignItems ?? "MIN", n.children, mode);
  frameValues.wrap = n.layoutWrap === "WRAP" ? true : undefined;
  frameValues.gap = buildFlexGap(n, mode);

  return frameValues;
}

function buildSimplifiedLayoutValues(
  n: FigmaDocumentNode,
  parent: FigmaDocumentNode | undefined,
  mode: SimplifiedLayout["mode"],
  parentGridPacked?: boolean,
): SimplifiedLayout | undefined {
  if (!isLayout(n)) return undefined;

  // The requested root has no parent in the payload, so Figma reports its sizing
  // FIXED relative to an absent container — an artifact of being top-level, not
  // design intent. Honoring it as a hard width/height pins the whole design to
  // its artboard and kills responsiveness. Descendants (which have a real parent)
  // keep their fill/hug/fixed semantics. See fig-ovmi.
  const isRoot = parent === undefined;

  const layoutValues: SimplifiedLayout = { mode };

  layoutValues.sizing = {
    horizontal: convertSizing(n.layoutSizingHorizontal),
    vertical: convertSizing(n.layoutSizingVertical),
  };

  // For the root, rewrite each spurious FIXED axis as "contextual" (it fills
  // whatever it's placed in) and surface the designed size as a non-binding
  // reference — absolutely-positioned children and the fill-chain still need a
  // concrete size to anchor against. Real FILL/HUG axes are intent; leave them.
  if (isRoot && n.absoluteBoundingBox) {
    if (layoutValues.sizing.horizontal === "fixed") {
      layoutValues.sizing.horizontal = "contextual";
      layoutValues.designedWidth = `${pixelRound(n.absoluteBoundingBox.width)}px`;
    }
    if (layoutValues.sizing.vertical === "fixed") {
      layoutValues.sizing.vertical = "contextual";
      layoutValues.designedHeight = `${pixelRound(n.absoluteBoundingBox.height)}px`;
    }
  }

  // Emit positioning relative to parent unless the parent's auto-layout already
  // places this child. `isLayout(parent)` also screens out top-level nodes
  // (no parent) and parents without bounding boxes (e.g. CANVAS), where
  // coordinates would be meaningless.
  if (isLayout(parent) && !isInAutoLayoutFlow(n, parent)) {
    if (n.layoutPositioning === "ABSOLUTE") {
      layoutValues.position = "absolute";
    }
    if (n.absoluteBoundingBox && parent.absoluteBoundingBox) {
      layoutValues.locationRelativeToParent = {
        x: pixelRound(n.absoluteBoundingBox.x - parent.absoluteBoundingBox.x),
        y: pixelRound(n.absoluteBoundingBox.y - parent.absoluteBoundingBox.y),
      };
    }
  }

  // Grid child properties: positioning, spans, alignment, and z-order
  const parentIsGrid = parentGridPacked !== undefined;
  if (parentIsGrid && parent && n.layoutPositioning !== "ABSOLUTE") {
    Object.assign(layoutValues, buildGridChildPositioning(n, parent, parentGridPacked));
  }

  // Emit a dimension only when the child isn't stretching that axis and the
  // sizing flag permits it. Stretch detection and the "is FIXED?" rule both
  // depend on whether the parent is flex, grid, or non-auto-layout — see the
  // helpers in ./layout/common.ts for the per-axis vocabulary mapping.
  if (!isRoot && isRectangle("absoluteBoundingBox", n)) {
    const dimensions: { width?: number; height?: number; aspectRatio?: number } = {};
    const axis = resolveChildAxis(n, parent, mode, parentIsGrid);
    const stretch = getChildStretch(n, axis);

    if (!stretch.horizontal && shouldEmitFixedDimension(n.layoutSizingHorizontal, axis)) {
      dimensions.width = n.absoluteBoundingBox.width;
    }
    if (!stretch.vertical && shouldEmitFixedDimension(n.layoutSizingVertical, axis)) {
      dimensions.height = n.absoluteBoundingBox.height;
    }

    // Preserves historical behavior: aspectRatio is emitted only for
    // column-parent children. Likely should apply more broadly — pre-existing.
    if (axis === "column" && n.preserveRatio && n.absoluteBoundingBox.height !== 0) {
      dimensions.aspectRatio = n.absoluteBoundingBox.width / n.absoluteBoundingBox.height;
    }

    if (Object.keys(dimensions).length > 0) {
      if (dimensions.width) {
        dimensions.width = pixelRound(dimensions.width);
      }
      if (dimensions.height) {
        dimensions.height = pixelRound(dimensions.height);
      }
      layoutValues.dimensions = dimensions;
    }
  }

  // When geometry=paths supplies true transforms, undo the axis-aligned
  // flattening for rotated nodes: absoluteBoundingBox is the box AROUND a
  // rotated node — inflated and corner-anchored — which mis-sizes and
  // mis-places anything tilted (a 100x148.75 cover at -18.3° reads as an
  // unrotated 141.6x172.6). Emit the unrotated size, the pre-rotation
  // top-left (the relativeTransform translation, already parent-relative),
  // and the angle itself. Children of rotated groups take this path even
  // when unrotated locally, so nested transforms compose.
  const ln = n as unknown as HasLayoutTrait;
  const pln = parent as unknown as HasLayoutTrait | undefined;
  if (ln.relativeTransform && ln.size) {
    const rotation = matrixRotationDeg(ln.relativeTransform);
    const parentRotation = pln?.relativeTransform ? matrixRotationDeg(pln.relativeTransform) : 0;
    if (
      Math.abs(rotation) > ROTATION_EPSILON_DEG ||
      Math.abs(parentRotation) > ROTATION_EPSILON_DEG
    ) {
      if (Math.abs(rotation) > ROTATION_EPSILON_DEG) {
        layoutValues.rotation = pixelRound(rotation);
      }
      layoutValues.dimensions = {
        width: pixelRound(ln.size.x),
        height: pixelRound(ln.size.y),
      };
      layoutValues.locationRelativeToParent = {
        x: pixelRound(ln.relativeTransform[0][2]),
        y: pixelRound(ln.relativeTransform[1][2]),
      };
    }
  }

  // Vector-class nodes can render ink well inside their layout box — a
  // text-on-path node's box says nothing about where the glyphs sit, so an
  // exported asset placed at the box lands in the wrong place. Surface the
  // ink bounds parent-relative when they differ materially from the box.
  const rb = (
    n as { absoluteRenderBounds?: { x: number; y: number; width: number; height: number } | null }
  ).absoluteRenderBounds;
  if (
    rb &&
    ln.absoluteBoundingBox &&
    pln?.absoluteBoundingBox &&
    VECTOR_RENDER_BOUND_TYPES.has(n.type)
  ) {
    const bb = ln.absoluteBoundingBox;
    const differs =
      Math.abs(rb.x - bb.x) > 1 ||
      Math.abs(rb.y - bb.y) > 1 ||
      Math.abs(rb.width - bb.width) > 1 ||
      Math.abs(rb.height - bb.height) > 1;
    if (differs) {
      layoutValues.renderBounds = {
        x: pixelRound(rb.x - pln.absoluteBoundingBox.x),
        y: pixelRound(rb.y - pln.absoluteBoundingBox.y),
        width: pixelRound(rb.width),
        height: pixelRound(rb.height),
      };
    }
  }

  return layoutValues;
}

// Below this, rounding noise in exported files produces spurious sub-pixel
// "rotations"; at or under it a node is treated as upright.
const ROTATION_EPSILON_DEG = 0.05;

// Node types whose ink routinely diverges from their layout box. TEXT_PATH is
// compared as a string because @figma/rest-api-spec predates it.
const VECTOR_RENDER_BOUND_TYPES = new Set<string>([
  "TEXT_PATH",
  "VECTOR",
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "POLYGON",
]);

// Rotation angle encoded in a Figma transform, in degrees with Figma's sign
// convention (counter-clockwise positive). For a rotation by θ the matrix rows
// are [[cos θ, sin θ, tx], [-sin θ, cos θ, ty]].
function matrixRotationDeg(t: Transform): number {
  return (Math.atan2(t[0][1], t[0][0]) * 180) / Math.PI;
}
