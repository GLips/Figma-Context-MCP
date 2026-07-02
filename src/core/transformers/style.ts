import type { NodeSnapshot, SnapshotPaint } from "~/core/snapshot.js";
import { generateCSSShorthand, isVisible } from "~/core/utils.js";

import { convertColor, formatRGBAColor } from "./style/color.js";
import { translateScaleMode, handleImageTransform, parsePatternPaint } from "./style/image.js";
import type { SimplifiedImageFill } from "./style/image.js";
import { convertGradientToCss } from "./style/gradient.js";

// The style transformer is split across a style/ subdirectory (color, image,
// gradient) because gradient geometry alone is ~290 lines. This module stays the
// single public entry point — `~/core/transformers/style.js` — so the re-exports below
// preserve the import surface every caller already uses.
export type { CSSRGBAColor, CSSHexColor, ColorValue } from "./style/color.js";
export { convertColor, formatRGBAColor, flattenSolidFills } from "./style/color.js";
export type { SimplifiedImageFill, SimplifiedPatternFill } from "./style/image.js";
export type { SimplifiedGradientFill } from "./style/gradient.js";

import type { CSSRGBAColor, CSSHexColor } from "./style/color.js";
import type { SimplifiedPatternFill } from "./style/image.js";
import type { SimplifiedGradientFill } from "./style/gradient.js";

export type SimplifiedFill =
  | SimplifiedImageFill
  | SimplifiedGradientFill
  | SimplifiedPatternFill
  | CSSRGBAColor
  | CSSHexColor;

export type SimplifiedStroke = {
  colors: SimplifiedFill[];
  strokeWeight?: string;
  strokeDashes?: number[];
  strokeWeights?: string;
  strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";
};

/**
 * Build simplified stroke information from a Figma node
 *
 * @param n - The Figma node to extract stroke information from
 * @param hasChildren - Whether the node has children (affects paint processing)
 * @returns Simplified stroke object with colors and properties
 */
export function buildSimplifiedStrokes(
  n: NodeSnapshot,
  hasChildren: boolean = false,
): SimplifiedStroke {
  let strokes: SimplifiedStroke = { colors: [] };
  if (n.strokes && n.strokes.length) {
    // Reverse to match CSS stacking order (Figma layers bottom-to-top, CSS top-to-bottom)
    strokes.colors = n.strokes
      .filter(isVisible)
      .map((stroke) => parsePaint(stroke, hasChildren))
      .reverse();
  }

  if (typeof n.strokeWeight === "number" && n.strokeWeight > 0) {
    strokes.strokeWeight = `${n.strokeWeight}px`;
  }

  if (n.strokeDashes && n.strokeDashes.length) {
    strokes.strokeDashes = n.strokeDashes;
  }

  if (n.strokeAlign === "OUTSIDE" || n.strokeAlign === "CENTER") {
    strokes.strokeAlign = n.strokeAlign;
  }

  if (n.individualStrokeWeights) {
    strokes.strokeWeight = generateCSSShorthand(n.individualStrokeWeights);
  }

  return strokes;
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
    if (raw.crop) {
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
    const { hex, opacity } = convertColor(raw.color, raw.opacity);
    if (opacity === 1) {
      return hex;
    } else {
      return formatRGBAColor(raw.color, opacity);
    }
  } else if (raw.type === "PATTERN") {
    return parsePatternPaint(raw);
  } else {
    return {
      type: raw.type,
      gradient: convertGradientToCss(raw),
    };
  }
}
