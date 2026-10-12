import type {
  NodeSnapshot,
  SnapshotImageFilters,
  SnapshotImagePaint,
  SnapshotPaint,
} from "../snapshot.js";
import type { SimplifiedNode } from "../types.js";
import { generateCSSShorthand, isVisible, pixelRound } from "../utils.js";
import { styleReference, variableReference, type VariableReference } from "../tokens.js";
import { bindParts, type BoundSides } from "./bound-values.js";

import {
  convertColor,
  flattenSolidFills,
  formatRGBAColor,
  formatSolidColor,
} from "./style/color.js";
import {
  translateScaleMode,
  handleImageTransform,
  isIdentityTransform,
  parsePatternPaint,
} from "./style/image.js";
import type { SimplifiedImageFill } from "./style/image.js";
import { convertGradientToCss } from "./style/gradient.js";

// The style transformer is split across a style/ subdirectory (color, image,
// gradient) because gradient geometry alone is ~290 lines. This module stays the
// single entry point the rest of the package imports, so the re-exports below
// preserve the import surface every caller already uses.
export type { CSSRGBAColor, CSSHexColor, ColorValue } from "./style/color.js";
export {
  convertColor,
  formatRGBAColor,
  formatSolidColor,
  flattenSolidFills,
} from "./style/color.js";
export type { SimplifiedImageFill, SimplifiedPatternFill } from "./style/image.js";
export type { SimplifiedGradientFill } from "./style/gradient.js";

import type { CSSRGBAColor, CSSHexColor } from "./style/color.js";
import type { SimplifiedPatternFill } from "./style/image.js";
import type { SimplifiedGradientFill } from "./style/gradient.js";

/**
 * A solid that blends with its backdrop, so it can't be a bare color string. A
 * normal-blend solid is always the bare string.
 */
export type SimplifiedSolidFill = {
  type: "SOLID";
  color: CSSRGBAColor | CSSHexColor;
  blendMode: string;
};

/**
 * A variable-bound solid that can't be a bare reference: it carries a paint opacity or a blend the
 * variable doesn't. Bound solids never fold with other layers (see flattenSolidFills).
 */
export type SimplifiedBoundSolidFill = {
  type: "SOLID";
  color: VariableReference<string>;
  opacity?: number;
  blendMode?: string;
};

/**
 * One paint layer. A variable-bound solid at full opacity and normal blend is its bare
 * `{ variable }` reference. A paint STYLE is never a layer — it replaces the whole slot (see
 * SimplifiedNode.fill).
 */
export type SimplifiedFill =
  | VariableReference<string>
  | SimplifiedBoundSolidFill
  | SimplifiedSolidFill
  | SimplifiedImageFill
  | SimplifiedGradientFill
  | SimplifiedPatternFill
  | CSSRGBAColor
  | CSSHexColor;

/**
 * Figma BlendMode → CSS mix-blend-mode keyword, the one spelling node and paint
 * blends share. Figma's UI calls LINEAR_BURN/LINEAR_DODGE "Plus darker"/"Plus
 * lighter", CSS's own words. PASS_THROUGH (a group compositing as if absent) has
 * no keyword and stays unmapped.
 */
const CSS_BLEND_KEYWORDS: Record<string, string> = {
  NORMAL: "normal",
  DARKEN: "darken",
  MULTIPLY: "multiply",
  LINEAR_BURN: "plus-darker",
  COLOR_BURN: "color-burn",
  LIGHTEN: "lighten",
  SCREEN: "screen",
  LINEAR_DODGE: "plus-lighter",
  COLOR_DODGE: "color-dodge",
  OVERLAY: "overlay",
  SOFT_LIGHT: "soft-light",
  HARD_LIGHT: "hard-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity",
};

export function cssBlendKeyword(mode: string | undefined): string | undefined {
  return mode !== undefined && Object.prototype.hasOwnProperty.call(CSS_BLEND_KEYWORDS, mode)
    ? CSS_BLEND_KEYWORDS[mode]
    : undefined;
}

/** A paint's blend as a deviation-only spread: present only when it isn't normal. */
function paintBlend(mode: string | undefined): { blendMode?: string } {
  const keyword = cssBlendKeyword(mode);
  return keyword && keyword !== "normal" ? { blendMode: keyword } : {};
}

const IMAGE_FILTER_KEYS = [
  "exposure",
  "contrast",
  "saturation",
  "temperature",
  "tint",
  "highlights",
  "shadows",
] as const;

type ImageAdjustments = Pick<SimplifiedImageFill, "opacity" | "rotation" | "filters">;

/**
 * An image paint's opacity/rotation/filters, each only when it deviates from Figma's
 * default. Rounded like every emitted number: the plugin reports float32 (0.4 reads
 * 0.4000000059604645), and the rounded value is what an agent pastes back.
 */
function imageAdjustments(raw: SnapshotImagePaint): ImageAdjustments {
  const out: ImageAdjustments = {};
  if (raw.opacity !== undefined && pixelRound(raw.opacity) !== 1)
    out.opacity = pixelRound(raw.opacity);
  if (raw.rotation) out.rotation = raw.rotation;
  const filters: SnapshotImageFilters = {};
  for (const key of IMAGE_FILTER_KEYS) {
    const value = raw.filters?.[key];
    if (value !== undefined && pixelRound(value) !== 0) filters[key] = pixelRound(value);
  }
  if (Object.keys(filters).length) out.filters = filters;
  return out;
}

/** Stroke geometry: what sits beside the stroke paint, even under a paint style (which covers only the paint). */
export type StrokeGeometry = {
  /**
   * CSS metric string: "1px", or per-side shorthand "1px 2px 3px 4px". Once a side is bound: one
   * variable on all four sides is its reference, otherwise per side.
   */
  strokeWidth?: string | VariableReference<number> | BoundSides;
  strokeDashes?: number[];
  /** "inside" is the omitted default — it matches the CSS border an LLM writes. */
  strokeAlign?: "outside" | "center";
};

export function buildStrokeGeometry(n: NodeSnapshot): StrokeGeometry {
  const strokes: StrokeGeometry = {};
  if (typeof n.strokeWeight === "number" && n.strokeWeight > 0) {
    strokes.strokeWidth = `${pixelRound(n.strokeWeight)}px`;
  }

  if (n.strokeDashes && n.strokeDashes.length) {
    strokes.strokeDashes = n.strokeDashes;
  }

  if (n.strokeAlign === "OUTSIDE") strokes.strokeAlign = "outside";
  // CENTER is every LINE's default (createLine seeds it), and LINE's write vocabulary has no
  // strokeAlign word, so emitting it there made every read line refuse to round-trip.
  if (n.strokeAlign === "CENTER" && n.type !== "LINE") strokes.strokeAlign = "center";

  if (n.individualStrokeWeights) {
    strokes.strokeWidth = generateCSSShorthand(n.individualStrokeWeights);
  }

  const weight = n.strokeWeight ?? 0;
  const weights = n.individualStrokeWeights ?? {
    top: weight,
    right: weight,
    bottom: weight,
    left: weight,
  };
  const bound = n.boundVariables;
  const boundWidth = bindParts([
    ["top", weights.top, bound?.strokeTopWeight],
    ["right", weights.right, bound?.strokeRightWeight],
    ["bottom", weights.bottom, bound?.strokeBottomWeight],
    ["left", weights.left, bound?.strokeLeftWeight],
  ]);
  if (boundWidth) strokes.strokeWidth = boundWidth;

  return strokes;
}

/**
 * Fold a paint stack into the ONE value a slot carries. Invisible paints drop;
 * an all-solid stack flattens to the single resolved color a viewer sees,
 * removing the layer-order ambiguity that misleads LLM consumers; a mixed stack
 * (gradient/image/pattern, or a non-normal blend) can't be folded and stays an
 * array, reversed into CSS top-first order. A lone paint unwraps to a scalar, so
 * only a genuinely stacked paint costs the array. The same fold serves a node's
 * `fill`/`stroke` and a text run's `color`.
 */
export function foldPaintStack(
  raw: SnapshotPaint[] | undefined,
  hasChildren: boolean = false,
): SimplifiedFill | SimplifiedFill[] | undefined {
  if (!raw || !raw.length) return undefined;
  const paints = raw.filter(isVisible);
  const flattened = flattenSolidFills(paints);
  if (flattened !== null) return flattened;
  const parsed = paints.map((p) => parsePaint(p, hasChildren)).reverse();
  if (parsed.length === 0) return undefined;
  return parsed.length === 1 ? parsed[0] : parsed;
}

/**
 * The literal a paint style resolves to, as the slot would spell it unstyled. A variable live
 * Figma reports under the style's own paint is dropped: the value is the color, not another reference.
 */
export function paintStyleValue(
  raw: SnapshotPaint[] | undefined,
  hasChildren: boolean,
  fold: boolean,
): SimplifiedFill | SimplifiedFill[] | undefined {
  const literal = raw?.map((paint) =>
    paint.type === "SOLID" && paint.colorVariable ? { ...paint, colorVariable: undefined } : paint,
  );
  return fold ? foldPaintStack(literal, hasChildren) : paintLayers(literal, hasChildren);
}

/** Every visible layer, unfolded, in CSS top-first order; a lone layer unwraps to a scalar. */
function paintLayers(
  raw: SnapshotPaint[] | undefined,
  hasChildren: boolean,
): SimplifiedFill | SimplifiedFill[] | undefined {
  const parsed = (raw ?? [])
    .filter(isVisible)
    .map((paint) => parsePaint(paint, hasChildren))
    .reverse();
  if (parsed.length === 0) return undefined;
  return parsed.length === 1 ? parsed[0] : parsed;
}

/**
 * The one paint-slot policy, for `fill` and `stroke` alike. A paint style names the whole slot, so
 * it wins over the layers — and over any paint variable under it, which live Figma reports for the
 * style's own paint. `fold` is the only difference between the two reads: the runtime keeps every
 * layer, so a re-authored stack is lossless; the wire folds a solid stack into the one color a
 * viewer sees.
 *
 * An empty slot is absent, except on the one node each slot defines: a TEXT is nothing without its
 * fill and a LINE nothing without its stroke, and the write side keeps Figma's default black when
 * the word is absent, so the no-paint state is spelled with the removal word "none".
 */
export function paintSlot(
  node: NodeSnapshot,
  slot: "fill" | "stroke",
  { fold }: { fold: boolean },
): NonNullable<SimplifiedNode["fill"]> | undefined {
  const hasChildren = !!node.children?.length;
  const paints = slot === "fill" ? node.fills : node.strokes;
  const style = node.styles?.[slot];
  const value = style
    ? styleReference(style, paintStyleValue(paints, hasChildren, fold))
    : fold
      ? foldPaintStack(paints, hasChildren)
      : paintLayers(paints, hasChildren);
  if (value !== undefined) return value;
  return node.type === (slot === "fill" ? "TEXT" : "LINE") ? "none" : undefined;
}

/**
 * Convert a Figma paint (solid, image, gradient) to a SimplifiedFill
 * @param raw - The Figma paint to convert
 * @param hasChildren - Whether the node has children (determines CSS properties)
 * @returns The converted SimplifiedFill
 */
export function parsePaint(raw: SnapshotPaint, hasChildren: boolean = false): SimplifiedFill {
  if (raw.type === "IMAGE") {
    // The adapter omits `ref` for IMAGE paints whose asset lives in another file
    // (e.g. pasted from a file you don't own) — Figma returns a null imageRef there.
    // Omit the output field in that case so the LLM doesn't pass a null/"null"
    // through to download_figma_images — the downloader falls back to rendering
    // the containing node by nodeId.
    const baseImageFill: SimplifiedImageFill = {
      type: "IMAGE",
      ...(raw.ref ? { imageRef: raw.ref } : {}),
      ...(raw.gifRef ? { gifRef: raw.gifRef } : {}),
      scaleMode: raw.scaleMode,
      scalingFactor: raw.scalingFactor,
      ...paintBlend(raw.blendMode),
      ...imageAdjustments(raw),
    };

    // Get CSS properties and processing metadata from scale mode
    // TILE mode always needs to be treated as background image (can't tile an <img> tag)
    const isBackground = hasChildren || baseImageFill.scaleMode === "TILE";
    const { css, processing } = translateScaleMode(
      baseImageFill.scaleMode,
      isBackground,
      raw.scalingFactor,
    );

    // Combine scale mode processing with transform processing if needed
    // Transform processing (cropping) takes precedence over scale mode processing
    let finalProcessing = processing;
    // An identity crop is a STRETCH whose frame already matches the image — nothing to cut.
    if (raw.crop && !isIdentityTransform(raw.crop)) {
      const transformProcessing = handleImageTransform(raw.crop);
      finalProcessing = {
        ...processing,
        ...transformProcessing,
        // Keep requiresImageDimensions from scale mode (needed for TILE)
        requiresImageDimensions:
          processing.requiresImageDimensions || transformProcessing.requiresImageDimensions,
      };
    }

    return {
      ...baseImageFill,
      ...css,
      imageDownloadArguments: finalProcessing,
    };
  } else if (raw.type === "SOLID") {
    if (raw.colorVariable) {
      // The variable carries the color's own alpha; only the paint's opacity and blend ride beside it.
      const color = variableReference(raw.colorVariable, formatSolidColor(raw.color));
      const opacity = pixelRound(raw.opacity ?? 1);
      const { blendMode } = paintBlend(raw.blendMode);
      if (opacity === 1 && !blendMode) return color;
      return {
        type: "SOLID",
        color,
        ...(opacity !== 1 ? { opacity } : {}),
        ...(blendMode ? { blendMode } : {}),
      };
    }
    const { hex, opacity } = convertColor(raw.color, raw.opacity);
    const color = opacity === 1 ? hex : formatRGBAColor(raw.color, opacity);
    const { blendMode } = paintBlend(raw.blendMode);
    return blendMode ? { type: "SOLID", color, blendMode } : color;
  } else if (raw.type === "PATTERN") {
    return parsePatternPaint(raw);
  } else {
    return {
      type: raw.type,
      gradient: convertGradientToCss(raw),
      ...paintBlend(raw.blendMode),
    };
  }
}
