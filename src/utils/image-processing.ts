import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import jpeg from "@jimp/js-jpeg";
import gif from "@jimp/js-gif";
import * as crop from "@jimp/plugin-crop";
import type { Transform } from "@figma/rest-api-spec";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readBodyWithLimit } from "./fetch-json.js";
import { tagError } from "./error-meta.js";
import { isWithin } from "./local-path.js";
import { Logger } from "./logger.js";

const Jimp = createJimp({ formats: [png, jpeg, gif], plugins: [crop.methods] });

/**
 * The visible region of an image under a Figma image-fill transform, or null when the transform
 * leaves nothing visible. Skew is intentionally ignored.
 *
 * The matrix is [[scaleX, skewX, translateX], [skewY, scaleY, translateY]]: scale is how much of
 * the image is visible (0-1), translate is the visible area's offset (0-1, relative to image size).
 */
export function cropRegionFor(
  { width, height }: { width: number; height: number },
  cropTransform: Transform,
): { left: number; top: number; width: number; height: number } | null {
  const scaleX = cropTransform[0]?.[0] ?? 1;
  const translateX = cropTransform[0]?.[2] ?? 0;
  const scaleY = cropTransform[1]?.[1] ?? 1;
  const translateY = cropTransform[1]?.[2] ?? 0;

  const left = Math.max(0, Math.round(translateX * width));
  const top = Math.max(0, Math.round(translateY * height));
  const cropWidth = Math.min(width - left, Math.round(scaleX * width));
  const cropHeight = Math.min(height - top, Math.round(scaleY * height));
  if (cropWidth <= 0 || cropHeight <= 0) return null;
  return { left, top, width: cropWidth, height: cropHeight };
}

/**
 * Read an SVG's intrinsic dimensions from its markup.
 *
 * jimp only decodes rasters, so the SVG branch can't measure files the way the
 * raster path does — but an SVG already declares its own size as text. Prefer the
 * `width`/`height` attributes (Figma exports them as plain user units, e.g.
 * `width="52"`); fall back to the viewBox's width/height when they're missing or
 * non-absolute (percentages aren't an intrinsic pixel size). Returns {0,0} only
 * when the markup carries no usable size at all.
 */
export function parseSvgDimensions(svg: string): { width: number; height: number } {
  const openTag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? "";

  const attr = (name: string): string | undefined =>
    openTag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];

  const parseLength = (raw: string | undefined): number | undefined => {
    // Percentages (and other relative units) aren't an intrinsic pixel size.
    if (!raw || raw.includes("%")) return undefined;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const width = parseLength(attr("width"));
  const height = parseLength(attr("height"));
  if (width !== undefined && height !== undefined) {
    return { width, height };
  }

  // viewBox is "min-x min-y width height" — the last two are the intrinsic size.
  const viewBox = attr("viewBox");
  if (viewBox) {
    const [, , vbWidth, vbHeight] = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (vbWidth > 0 && vbHeight > 0) {
      return { width: vbWidth, height: vbHeight };
    }
  }

  return { width: 0, height: 0 };
}

export type ImageProcessingResult = {
  fileName: string;
  /** Where the processed image landed: a local file path, or a link in hosted mode. */
  location: string;
  originalDimensions: { width: number; height: number };
  finalDimensions: { width: number; height: number };
  wasCropped: boolean;
  cropRegion?: { left: number; top: number; width: number; height: number };
  cssVariables?: string;
};

/** Where processed images are stored. Returns the location reported back to the agent. */
export type ImageDestination = {
  write(fileName: string, bytes: Buffer, contentType: string): Promise<string>;
};

/**
 * Resource bounds for image downloads. Local mode sets none; hosted mode sets all three, since one
 * process serves every user and a large render multiplies through download, decode and upload.
 */
export type ImagePolicy = {
  /** Refuse an image whose download is larger than this. */
  maxBytes?: number;
  /** Wraps each image's whole download → process → store job; bounds how many run at once. */
  runJob?: <T>(job: () => Promise<T>) => Promise<T>;
  /** Sees the raw bytes before jimp decodes them; throws to refuse a decompression bomb. */
  beforeDecode?: (bytes: Buffer) => void;
};

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  gif: "image/gif",
  svg: "image/svg+xml",
};

function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[fileName.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
}

/** Writes images into one local directory — the only place local mode stores them. */
export function createDiskImageDestination(directory: string): ImageDestination {
  return {
    async write(fileName, bytes) {
      const fullPath = path.resolve(path.join(directory, fileName));
      if (!isWithin(directory, fullPath)) {
        tagError(new Error(`File path escapes target directory: ${fileName}`), {
          category: "invalid_input",
        });
      }
      await mkdir(directory, { recursive: true });
      await writeFile(fullPath, bytes);
      return fullPath;
    },
  };
}

async function fetchImageBytes(
  imageUrl: string,
  { maxBytes, signal }: { maxBytes?: number; signal?: AbortSignal },
): Promise<Buffer> {
  try {
    const response = await fetch(imageUrl, { method: "GET", signal });
    if (!response.ok) {
      tagError(new Error(`Failed to download image: ${response.statusText}`), {
        category: "image_download",
      });
    }
    return maxBytes === undefined
      ? Buffer.from(await response.arrayBuffer())
      : await readBodyWithLimit(response, maxBytes);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Error downloading image: ${errorMessage}`, { cause: error });
  }
}

/**
 * Download one image, crop it to its fill transform and measure it, then store the result.
 * @param needsCropping - Whether to apply crop transform
 * @param cropTransform - Transform matrix for cropping
 * @param requiresImageDimensions - Whether to generate dimension metadata
 */
export async function downloadAndProcessImage(
  fileName: string,
  destination: ImageDestination,
  imageUrl: string,
  needsCropping: boolean = false,
  cropTransform: Transform | undefined,
  requiresImageDimensions: boolean = false,
  { policy = {}, signal }: { policy?: ImagePolicy; signal?: AbortSignal } = {},
): Promise<ImageProcessingResult> {
  const bytes = await fetchImageBytes(imageUrl, { maxBytes: policy.maxBytes, signal });
  const contentType = contentTypeFor(fileName);

  // SVGs are vector — jimp can't read them and cropping doesn't apply. Their
  // intrinsic size is declared in the markup, so read it from there rather than
  // reporting a misleading 0x0 (which reads like a download failure).
  if (contentType === "image/svg+xml") {
    const dimensions = parseSvgDimensions(bytes.toString("utf-8"));
    Logger.log(`SVG dimensions: ${dimensions.width}x${dimensions.height}`);
    return {
      fileName,
      location: await destination.write(fileName, bytes, contentType),
      originalDimensions: dimensions,
      finalDimensions: dimensions,
      wasCropped: false,
      cssVariables: requiresImageDimensions ? generateImageCSSVariables(dimensions) : undefined,
    };
  }

  policy.beforeDecode?.(bytes);
  const image = await Jimp.fromBuffer(bytes);
  const originalDimensions = { width: image.width, height: image.height };
  Logger.log(`Original dimensions: ${originalDimensions.width}x${originalDimensions.height}`);

  // Skip GIFs — cropping destroys animation frames.
  const cropRegion =
    needsCropping && cropTransform && contentType !== "image/gif"
      ? (cropRegionFor(originalDimensions, cropTransform) ?? undefined)
      : undefined;

  let output = bytes;
  if (cropRegion) {
    image.crop({
      x: cropRegion.left,
      y: cropRegion.top,
      w: cropRegion.width,
      h: cropRegion.height,
    });
    output = await image.getBuffer(contentType as "image/png");
    Logger.log(
      `Cropped to region: ${cropRegion.left}, ${cropRegion.top}, ${cropRegion.width}x${cropRegion.height}`,
    );
  }

  const finalDimensions = { width: image.width, height: image.height };
  return {
    fileName,
    location: await destination.write(fileName, output, contentType),
    originalDimensions,
    finalDimensions,
    wasCropped: cropRegion !== undefined,
    cropRegion,
    cssVariables: requiresImageDimensions ? generateImageCSSVariables(finalDimensions) : undefined,
  };
}

/**
 * Create CSS custom properties for image dimensions
 * @param imagePath - Path to the image file
 * @returns Promise<string> - CSS custom properties
 */
export function generateImageCSSVariables({
  width,
  height,
}: {
  width: number;
  height: number;
}): string {
  return `--original-width: ${width}px; --original-height: ${height}px;`;
}
