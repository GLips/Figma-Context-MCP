import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import jpeg from "@jimp/js-jpeg";
import gif from "@jimp/js-gif";
import * as crop from "@jimp/plugin-crop";
import type { Transform } from "@figma/rest-api-spec";
import { readFile } from "node:fs/promises";
import { downloadFigmaImage } from "~/utils/download-figma-image.js";
import { Logger } from "~/utils/logger.js";

const Jimp = createJimp({ formats: [png, jpeg, gif], plugins: [crop.methods] });

export type CropRegion = { left: number; top: number; width: number; height: number };

/**
 * The visible rectangle of an image under Figma's crop transform, or null when the transform
 * leaves nothing visible. The matrix is [[scaleX, skewX, translateX], [skewY, scaleY, translateY]]:
 * scale is the visible fraction of the image (0-1), translate the offset of that window, also as
 * a fraction of the image size. Skew is not applied.
 */
export function computeCropRegion(
  cropTransform: Transform,
  { width, height }: { width: number; height: number },
): CropRegion | null {
  const scaleX = cropTransform[0]?.[0] ?? 1;
  const translateX = cropTransform[0]?.[2] ?? 0;
  const scaleY = cropTransform[1]?.[1] ?? 1;
  const translateY = cropTransform[1]?.[2] ?? 0;

  const left = Math.max(0, Math.round(translateX * width));
  const top = Math.max(0, Math.round(translateY * height));
  const cropWidth = Math.min(width - left, Math.round(scaleX * width));
  const cropHeight = Math.min(height - top, Math.round(scaleY * height));

  return cropWidth > 0 && cropHeight > 0
    ? { left, top, width: cropWidth, height: cropHeight }
    : null;
}

/**
 * Crop the image file in place to its Figma crop transform. Returns the region it cropped to, or
 * null when the transform leaves nothing visible and the file is left as is. Read and write
 * failures propagate: a caller must never report a crop that didn't happen.
 */
export async function applyCropTransform(
  imagePath: string,
  cropTransform: Transform,
): Promise<CropRegion | null> {
  const image = await Jimp.read(imagePath);
  const region = computeCropRegion(cropTransform, image);
  if (!region) return null;

  image.crop({ x: region.left, y: region.top, w: region.width, h: region.height });
  await image.write(imagePath as `${string}.${string}`);
  return region;
}

/**
 * Get image dimensions from a file
 * @param imagePath - Path to the image file
 * @returns Promise<{width: number, height: number}>
 */
export async function getImageDimensions(imagePath: string): Promise<{
  width: number;
  height: number;
}> {
  const image = await Jimp.read(imagePath);
  return { width: image.width, height: image.height };
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
  filePath: string;
  originalDimensions: { width: number; height: number };
  finalDimensions: { width: number; height: number };
  wasCropped: boolean;
  cropRegion?: CropRegion;
  cssVariables?: string;
};

/**
 * Enhanced image download with post-processing
 * @param fileName - The filename to save as
 * @param localPath - The local path to save to
 * @param imageUrl - Image URL
 * @param needsCropping - Whether to apply crop transform
 * @param cropTransform - Transform matrix for cropping
 * @param requiresImageDimensions - Whether to generate dimension metadata
 * @returns Promise<ImageProcessingResult> - Detailed processing information
 */
export async function downloadAndProcessImage(
  fileName: string,
  localPath: string,
  imageUrl: string,
  needsCropping: boolean = false,
  cropTransform?: Transform,
  requiresImageDimensions: boolean = false,
): Promise<ImageProcessingResult> {
  const filePath = await downloadFigmaImage(fileName, localPath, imageUrl);
  Logger.log(`Downloaded original image: ${filePath}`);

  // SVGs are vector — jimp can't read them and cropping doesn't apply. Their
  // intrinsic size is declared in the markup, so read it from there rather than
  // reporting a misleading 0x0 (which reads like a download failure).
  if (fileName.toLowerCase().endsWith(".svg")) {
    const dimensions = parseSvgDimensions(await readFile(filePath, "utf-8"));
    return {
      filePath,
      originalDimensions: dimensions,
      finalDimensions: dimensions,
      wasCropped: false,
      cssVariables: requiresImageDimensions ? generateImageCSSVariables(dimensions) : undefined,
    };
  }

  const originalDimensions = await getImageDimensions(filePath);

  // Skip GIFs: cropping destroys animation frames.
  const cropRegion =
    needsCropping && cropTransform && !fileName.toLowerCase().endsWith(".gif")
      ? await applyCropTransform(filePath, cropTransform)
      : null;
  if (cropRegion) {
    Logger.log(
      `Cropped ${filePath} to ${cropRegion.left}, ${cropRegion.top}, ${cropRegion.width}x${cropRegion.height}`,
    );
  }
  const finalDimensions = cropRegion
    ? { width: cropRegion.width, height: cropRegion.height }
    : originalDimensions;

  return {
    filePath,
    originalDimensions,
    finalDimensions,
    wasCropped: cropRegion !== null,
    cropRegion: cropRegion ?? undefined,
    // Generated for TILE-mode fills, which size the tile from the image.
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
