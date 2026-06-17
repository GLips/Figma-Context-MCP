import type { Paint, Transform } from "@figma/rest-api-spec";

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
  /**
   * Reference to the embedded image asset. Omitted when Figma returns a null
   * imageRef — typically images pasted in from a file you don't own, where the
   * asset still renders in the editor (it's reachable from the source file)
   * but isn't registered against your file. In that case download_figma_images
   * falls back to rendering the containing node as a PNG via its nodeId.
   */
  imageRef?: string;
  /**
   * Present when the fill is an animated GIF. Use this ref (instead of imageRef) when calling
   * download_figma_images to retrieve the animated GIF file; imageRef only points to a static
   * snapshot frame.
   */
  gifRef?: string;
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

/**
 * Translate Figma scale modes to CSS properties based on usage context
 *
 * @param scaleMode - The Figma scale mode (FILL, FIT, TILE, STRETCH)
 * @param isBackground - Whether this image will be used as background-image (true) or <img> tag (false)
 * @param scalingFactor - For TILE mode, the scaling factor relative to original image size
 * @returns Object containing CSS properties and processing metadata
 */
export function translateScaleMode(
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
export function handleImageTransform(
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
 * Convert a Figma PatternPaint to a CSS-like pattern fill.
 *
 * Ignores `tileType` and `spacing` from the Figma API currently as there's
 * no great way to translate them to CSS.
 *
 * @param raw - The Figma PatternPaint to convert
 * @returns The converted pattern SimplifiedFill
 */
export function parsePatternPaint(raw: Extract<Paint, { type: "PATTERN" }>): SimplifiedPatternFill {
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
