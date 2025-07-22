import type {
  Node as FigmaDocumentNode,
  Paint,
  Vector,
  RGBA,
  Transform,
} from "@figma/rest-api-spec";
import { generateCSSShorthand, isVisible } from "~/utils/common.js";
import { hasValue, isStrokeWeights } from "~/utils/identity.js";

export type CSSRGBAColor = `rgba(${number}, ${number}, ${number}, ${number})`;
export type CSSHexColor = `#${string}`;
export interface ColorValue {
  hex: CSSHexColor;
  opacity: number;
}

/**
 * Simplified image fill with CSS properties and processing metadata
 *
 * This type represents an image fill that can be used as either:
 * - background-image (when parent node has children)
 * - <img> tag (when parent node has no children)
 *
 * The CSS properties are mutually exclusive based on usage context.
 */
export type SimplifiedImageFill = {
  type: "IMAGE";
  imageRef: string;
  scaleMode: "FILL" | "FIT" | "TILE" | "STRETCH";
  /**
   * For TILE mode, the scaling factor relative to original image size
   */
  scalingFactor?: number;

  // CSS properties for background-image usage (when node has children)
  backgroundSize?: string;
  backgroundRepeat?: string;

  // CSS properties for <img> tag usage (when node has no children)
  isBackground?: boolean;
  objectFit?: string;

  // Image processing metadata (NOT for CSS translation)
  // Used by download tools to determine post-processing needs
  imageDownloadArguments?: {
    /**
     * Whether image needs cropping based on transform
     */
    needsCropping: boolean;
    /**
     * Whether CSS variables for dimensions are needed to calculate the background size for TILE mode
     *
     * Figma bases scalingFactor on the image's original size. In CSS, background size (as a percentage)
     * is calculated based on the size of the container. We need to pass back the original dimensions
     * after processing to calculate the intended background size when translated to code.
     */
    requiresImageDimensions: boolean;
    /**
     * Figma's transform matrix for Sharp processing
     */
    cropTransform?: Transform;
    /**
     * Suggested filename suffix to make cropped images unique
     * When the same imageRef is used multiple times with different crops,
     * this helps avoid overwriting conflicts
     */
    filenameSuffix?: string;
  };
};

export type SimplifiedGradientFill = {
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  gradientHandlePositions?: Vector[];
  gradientStops?: {
    position: number;
    color: ColorValue | string;
  }[];
};

export type SimplifiedPatternFill = {
  type: "PATTERN";
  patternSource: {
    /**
     * Hardcode to expect PNG for now, consider SVG detection in the future.
     *
     * SVG detection is a bit challenging because the nodeId in question isn't
     * guaranteed to be included in the response we're working with. No guaranteed
     * way to look into it and see if it's only composed of vector shapes.
     */
    type: "IMAGE-PNG";
    nodeId: string;
  };
  backgroundRepeat: string;
  backgroundSize: string;
  backgroundPosition: string;
};

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
};

/**
 * Translate Figma scale modes to CSS properties based on usage context
 *
 * @param scaleMode - The Figma scale mode (FILL, FIT, TILE, STRETCH)
 * @param isBackground - Whether this image will be used as background-image (true) or <img> tag (false)
 * @param scalingFactor - For TILE mode, the scaling factor relative to original image size
 * @returns Object containing CSS properties and processing metadata
 */
function translateScaleMode(
  scaleMode: "FILL" | "FIT" | "TILE" | "STRETCH",
  hasChildren: boolean,
  scalingFactor?: number,
): {
  css: Partial<SimplifiedImageFill>;
  processing: NonNullable<SimplifiedImageFill["imageDownloadArguments"]>;
} {
  const isBackground = hasChildren;

  switch (scaleMode) {
    case "FILL":
      // Image covers entire container, may be cropped
      return {
        css: isBackground
          ? { backgroundSize: "cover", backgroundRepeat: "no-repeat", isBackground: true }
          : { objectFit: "cover", isBackground: false },
        processing: { needsCropping: false, requiresImageDimensions: false },
      };

    case "FIT":
      // Image fits entirely within container, may have empty space
      return {
        css: isBackground
          ? { backgroundSize: "contain", backgroundRepeat: "no-repeat", isBackground: true }
          : { objectFit: "contain", isBackground: false },
        processing: { needsCropping: false, requiresImageDimensions: false },
      };

    case "TILE":
      // Image repeats to fill container at specified scale
      // Always treat as background image (can't tile an <img> tag)
      return {
        css: {
          backgroundRepeat: "repeat",
          backgroundSize: scalingFactor
            ? `calc(var(--original-width) * ${scalingFactor}) calc(var(--original-height) * ${scalingFactor})`
            : "auto",
          isBackground: true,
        },
        processing: { needsCropping: false, requiresImageDimensions: true },
      };

    case "STRETCH":
      // Figma calls crop "STRETCH" in its API.
      return {
        css: isBackground
          ? { backgroundSize: "100% 100%", backgroundRepeat: "no-repeat", isBackground: true }
          : { objectFit: "fill", isBackground: false },
        processing: { needsCropping: false, requiresImageDimensions: false },
      };

    default:
      return {
        css: {},
        processing: { needsCropping: false, requiresImageDimensions: false },
      };
  }
}

/**
 * Generate a short hash from a transform matrix to create unique filenames
 * @param transform - The transform matrix to hash
 * @returns Short hash string for filename suffix
 */
function generateTransformHash(transform: Transform): string {
  const values = transform.flat();
  const hash = values.reduce((acc, val) => {
    // Simple hash function - convert to string and create checksum
    const str = val.toString();
    for (let i = 0; i < str.length; i++) {
      acc = ((acc << 5) - acc + str.charCodeAt(i)) & 0xffffffff;
    }
    return acc;
  }, 0);

  // Convert to positive hex string, take first 6 chars
  return Math.abs(hash).toString(16).substring(0, 6);
}

/**
 * Handle imageTransform for post-processing (not CSS translation)
 *
 * When Figma includes an imageTransform matrix, it means the image is cropped/transformed.
 * This function converts the transform into processing instructions for Sharp.
 *
 * @param imageTransform - Figma's 2x3 transform matrix [[scaleX, skewX, translateX], [skewY, scaleY, translateY]]
 * @returns Processing metadata for image cropping
 */
function handleImageTransform(
  imageTransform: Transform,
): NonNullable<SimplifiedImageFill["imageDownloadArguments"]> {
  const transformHash = generateTransformHash(imageTransform);
  return {
    needsCropping: true,
    requiresImageDimensions: false,
    cropTransform: imageTransform,
    filenameSuffix: `${transformHash}`,
  };
}

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
    strokes.colors = n.strokes.filter(isVisible).map((stroke) => parsePaint(stroke, hasChildren));
  }

  if (hasValue("strokeWeight", n) && typeof n.strokeWeight === "number" && n.strokeWeight > 0) {
    strokes.strokeWeight = `${n.strokeWeight}px`;
  }

  if (hasValue("strokeDashes", n) && Array.isArray(n.strokeDashes) && n.strokeDashes.length) {
    strokes.strokeDashes = n.strokeDashes;
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
    const baseImageFill: SimplifiedImageFill = {
      type: "IMAGE",
      imageRef: raw.imageRef,
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
      gradientHandlePositions: raw.gradientHandlePositions,
      gradientStops: raw.gradientStops.map(({ position, color }) => ({
        position,
        color: convertColor(color),
      })),
    };
  } else {
    throw new Error(`Unknown paint type: ${raw.type}`);
  }
}

/**
 * Convert a Figma PatternPaint to a CSS-like pattern fill.
 *
 * Ignores `tileType` and `spacing` from the Figma API currently as there's
 * no great way to translate them to CSS.
 *
 * @param raw - The Figma PatternPaint to convert
 * @returns The converted pattern SimplifiedFill
 */
function parsePatternPaint(
  raw: Extract<Paint, { type: "PATTERN" }>,
): Extract<SimplifiedFill, { type: "PATTERN" }> {
  /**
   * The only CSS-like repeat value supported by Figma is repeat.
   *
   * They also have hexagonal horizontal and vertical repeats, but
   * those aren't easy to pull off in CSS, so we just use repeat.
   */
  let backgroundRepeat = "repeat";

  let horizontal = "left";
  switch (raw.horizontalAlignment) {
    case "START":
      horizontal = "left";
      break;
    case "CENTER":
      horizontal = "center";
      break;
    case "END":
      horizontal = "right";
      break;
  }

  let vertical = "top";
  switch (raw.verticalAlignment) {
    case "START":
      vertical = "top";
      break;
    case "CENTER":
      vertical = "center";
      break;
    case "END":
      vertical = "bottom";
      break;
  }

  return {
    type: raw.type,
    patternSource: {
      type: "IMAGE-PNG",
      nodeId: raw.sourceNodeId,
    },
    backgroundRepeat,
    backgroundSize: `${Math.round(raw.scalingFactor * 100)}%`,
    backgroundPosition: `${horizontal} ${vertical}`,
  };
}

/**
 * Convert hex color value and opacity to rgba format
 * @param hex - Hexadecimal color value (e.g., "#FF0000" or "#F00")
 * @param opacity - Opacity value (0-1)
 * @returns Color string in rgba format
 */
export function hexToRgba(hex: string, opacity: number = 1): string {
  // Remove possible # prefix
  hex = hex.replace("#", "");

  // Handle shorthand hex values (e.g., #FFF)
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }

  // Convert hex to RGB values
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  // Ensure opacity is in the 0-1 range
  const validOpacity = Math.min(Math.max(opacity, 0), 1);

  return `rgba(${r}, ${g}, ${b}, ${validOpacity})`;
}

/**
 * Convert color from RGBA to { hex, opacity }
 *
 * @param color - The color to convert, including alpha channel
 * @param opacity - The opacity of the color, if not included in alpha channel
 * @returns The converted color
 **/
export function convertColor(color: RGBA, opacity = 1): ColorValue {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);

  // Alpha channel defaults to 1. If opacity and alpha are both and < 1, their effects are multiplicative
  const a = Math.round(opacity * color.a * 100) / 100;

  const hex = ("#" +
    ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase()) as CSSHexColor;

  return { hex, opacity: a };
}

/**
 * Convert color from Figma RGBA to rgba(#, #, #, #) CSS format
 *
 * @param color - The color to convert, including alpha channel
 * @param opacity - The opacity of the color, if not included in alpha channel
 * @returns The converted color
 **/
export function formatRGBAColor(color: RGBA, opacity = 1): CSSRGBAColor {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  // Alpha channel defaults to 1. If opacity and alpha are both and < 1, their effects are multiplicative
  const a = Math.round(opacity * color.a * 100) / 100;

  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
