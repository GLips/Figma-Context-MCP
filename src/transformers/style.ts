import type { Node as FigmaDocumentNode, Paint } from "@figma/rest-api-spec";
import { generateCSSShorthand, isVisible } from "~/utils/common.js";
import { tagError } from "~/utils/error-meta.js";
import { hasValue, isStrokeWeights } from "~/utils/identity.js";

import { convertColor, formatRGBAColor } from "./style/color.js";
import { translateScaleMode, handleImageTransform, parsePatternPaint } from "./style/image.js";
import type { SimplifiedImageFill } from "./style/image.js";
import { convertGradientToCss } from "./style/gradient.js";

// The style transformer is split across a style/ subdirectory (color, image,
// gradient) because gradient geometry alone is ~290 lines. This module stays the
// single public entry point — `~/transformers/style.js` — so the re-exports below
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
  n: FigmaDocumentNode,
  hasChildren: boolean = false,
): SimplifiedStroke {
  let strokes: SimplifiedStroke = { colors: [] };
  if (hasValue("strokes", n) && Array.isArray(n.strokes) && n.strokes.length) {
    // Reverse to match CSS stacking order (Figma layers bottom-to-top, CSS top-to-bottom)
    strokes.colors = n.strokes
      .filter(isVisible)
      .map((stroke) => parsePaint(stroke, hasChildren))
      .reverse();
  }

  if (hasValue("strokeWeight", n) && typeof n.strokeWeight === "number" && n.strokeWeight > 0) {
    strokes.strokeWeight = `${n.strokeWeight}px`;
  }

  if (hasValue("strokeDashes", n) && Array.isArray(n.strokeDashes) && n.strokeDashes.length) {
    strokes.strokeDashes = n.strokeDashes;
  }

  if (hasValue("strokeAlign", n) && (n.strokeAlign === "OUTSIDE" || n.strokeAlign === "CENTER")) {
    strokes.strokeAlign = n.strokeAlign;
  }

  if (hasValue("individualStrokeWeights", n, isStrokeWeights)) {
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
export function parsePaint(raw: Paint, hasChildren: boolean = false): SimplifiedFill {
  if (raw.type === "IMAGE") {
    // Figma's spec types imageRef as a required string, but in practice it can
    // come back null for IMAGE paints whose asset lives in another file (e.g.
    // pasted from a file you don't own). Omit the field in that case so the
    // LLM doesn't pass a null/"null" through to download_figma_images — the
    // downloader will fall back to rendering the containing node by nodeId.
    const baseImageFill: SimplifiedImageFill = {
      type: "IMAGE",
      ...(raw.imageRef ? { imageRef: raw.imageRef } : {}),
      ...(raw.gifRef ? { gifRef: raw.gifRef } : {}),
      scaleMode: raw.scaleMode as "FILL" | "FIT" | "TILE" | "STRETCH",
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
    if (raw.imageTransform) {
      const transformProcessing = handleImageTransform(raw.imageTransform);
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
    // treat as SOLID
    const { hex, opacity } = convertColor(raw.color!, raw.opacity);
    if (opacity === 1) {
      return hex;
    } else {
      return formatRGBAColor(raw.color!, opacity);
    }
  } else if (raw.type === "PATTERN") {
    return parsePatternPaint(raw);
  } else if (
    ["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"].includes(
      raw.type,
    )
  ) {
    return {
      type: raw.type as
        | "GRADIENT_LINEAR"
        | "GRADIENT_RADIAL"
        | "GRADIENT_ANGULAR"
        | "GRADIENT_DIAMOND",
      gradient: convertGradientToCss(raw),
    };
  } else {
    tagError(new Error(`Unknown paint type: ${raw.type}`), { category: "internal" });
  }
}
