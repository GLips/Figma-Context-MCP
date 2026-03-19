import { Jimp } from "jimp";
import type { Transform } from "@figma/rest-api-spec";

/**
 * Apply crop transform to an image based on Figma's transformation matrix
 * @param imagePath - Path to the original image file
 * @param cropTransform - Figma transform matrix [[scaleX, skewX, translateX], [skewY, scaleY, translateY]]
 * @returns Promise<string> - Path to the cropped image
 */
export async function applyCropTransform(
  imagePath: string,
  cropTransform: Transform,
): Promise<string> {
  const { Logger } = await import("./logger.js");

  try {
    // Extract transform values (skew values intentionally unused for now)
    const scaleX = cropTransform[0]?.[0] ?? 1;
    const translateX = cropTransform[0]?.[2] ?? 0;
    const scaleY = cropTransform[1]?.[1] ?? 1;
    const translateY = cropTransform[1]?.[2] ?? 0;

    const image = await Jimp.read(imagePath);
    const { width, height } = image;

    // Calculate crop region based on transform matrix
    // Figma's transform matrix represents how the image is positioned within its container
    // We need to extract the visible portion based on the scaling and translation

    // The transform matrix defines the visible area as:
    // - scaleX/scaleY: how much of the original image is visible (0-1)
    // - translateX/translateY: offset of the visible area (0-1, relative to image size)

    const cropLeft = Math.max(0, Math.round(translateX * width));
    const cropTop = Math.max(0, Math.round(translateY * height));
    const cropWidth = Math.min(width - cropLeft, Math.round(scaleX * width));
    const cropHeight = Math.min(height - cropTop, Math.round(scaleY * height));

    if (cropWidth <= 0 || cropHeight <= 0) {
      Logger.log(`Invalid crop dimensions for ${imagePath}, using original image`);
      return imagePath;
    }

    image.crop({ x: cropLeft, y: cropTop, w: cropWidth, h: cropHeight });
    await image.write(imagePath as `${string}.${string}`);

    Logger.log(`Cropped image saved (overwritten): ${imagePath}`);
    Logger.log(
      `Crop region: ${cropLeft}, ${cropTop}, ${cropWidth}x${cropHeight} from ${width}x${height}`,
    );

    return imagePath;
  } catch (error) {
    Logger.error(`Error cropping image ${imagePath}:`, error);
    return imagePath;
  }
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

export type ImageProcessingResult = {
  filePath: string;
  originalDimensions: { width: number; height: number };
  finalDimensions: { width: number; height: number };
  wasCropped: boolean;
  cropRegion?: { left: number; top: number; width: number; height: number };
  cssVariables?: string;
  processingLog: string[];
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
  const { Logger } = await import("./logger.js");
  const processingLog: string[] = [];

  // First download the original image
  const { downloadFigmaImage } = await import("./common.js");
  const originalPath = await downloadFigmaImage(fileName, localPath, imageUrl);
  Logger.log(`Downloaded original image: ${originalPath}`);

  // SVGs are vector — jimp can't read them and cropping/dimensions don't apply
  const isSvg = fileName.toLowerCase().endsWith(".svg");
  if (isSvg) {
    return {
      filePath: originalPath,
      originalDimensions: { width: 0, height: 0 },
      finalDimensions: { width: 0, height: 0 },
      wasCropped: false,
      processingLog,
    };
  }

  // Get original dimensions before any processing
  const originalDimensions = await getImageDimensions(originalPath);
  Logger.log(`Original dimensions: ${originalDimensions.width}x${originalDimensions.height}`);

  let finalPath = originalPath;
  let wasCropped = false;
  let cropRegion: { left: number; top: number; width: number; height: number } | undefined;

  // Apply crop transform if needed (skip for GIFs — cropping destroys animation frames)
  if (needsCropping && cropTransform && !fileName.toLowerCase().endsWith(".gif")) {
    Logger.log("Applying crop transform...");

    // Extract crop region info before applying transform
    const scaleX = cropTransform[0]?.[0] ?? 1;
    const scaleY = cropTransform[1]?.[1] ?? 1;
    const translateX = cropTransform[0]?.[2] ?? 0;
    const translateY = cropTransform[1]?.[2] ?? 0;

    const cropLeft = Math.max(0, Math.round(translateX * originalDimensions.width));
    const cropTop = Math.max(0, Math.round(translateY * originalDimensions.height));
    const cropWidth = Math.min(
      originalDimensions.width - cropLeft,
      Math.round(scaleX * originalDimensions.width),
    );
    const cropHeight = Math.min(
      originalDimensions.height - cropTop,
      Math.round(scaleY * originalDimensions.height),
    );

    if (cropWidth > 0 && cropHeight > 0) {
      cropRegion = { left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight };
      finalPath = await applyCropTransform(originalPath, cropTransform);
      wasCropped = true;
      Logger.log(`Cropped to region: ${cropLeft}, ${cropTop}, ${cropWidth}x${cropHeight}`);
    } else {
      Logger.log("Invalid crop dimensions, keeping original image");
    }
  }

  // Get final dimensions after processing
  const finalDimensions = await getImageDimensions(finalPath);
  Logger.log(`Final dimensions: ${finalDimensions.width}x${finalDimensions.height}`);

  // Generate CSS variables if required (for TILE mode)
  let cssVariables: string | undefined;
  if (requiresImageDimensions) {
    cssVariables = generateImageCSSVariables(finalDimensions);
  }

  return {
    filePath: finalPath,
    originalDimensions,
    finalDimensions,
    wasCropped,
    cropRegion,
    cssVariables,
    processingLog,
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
