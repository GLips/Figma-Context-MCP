import { isInAutoLayoutFlow, isFrame, isLayout, isRectangle } from "~/utils/identity.js";
import type { Node as FigmaDocumentNode, HasLayoutTrait } from "@figma/rest-api-spec";
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

  return layoutValues;
}
