import fs from "fs";
import path from "path";
import sharp from "sharp";
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
    // Extract transform values
    const scaleX = cropTransform[0]?.[0] ?? 1;
    const skewX = cropTransform[0]?.[1] ?? 0;
    const translateX = cropTransform[0]?.[2] ?? 0;
    const skewY = cropTransform[1]?.[0] ?? 0;
    const scaleY = cropTransform[1]?.[1] ?? 1;
    const translateY = cropTransform[1]?.[2] ?? 0;

    // Load the image and get metadata
    const image = sharp(imagePath);
    const metadata = await image.metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error(`Could not get image dimensions for ${imagePath}`);
    }

    const { width, height } = metadata;

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

    // Validate crop dimensions
    if (cropWidth <= 0 || cropHeight <= 0) {
      Logger.log(`Invalid crop dimensions for ${imagePath}, using original image`);
      return imagePath;
    }

    // Overwrite the original file with the cropped version
    const tempPath = imagePath + ".tmp";

    // Apply crop transformation to temporary file first
    await image
      .extract({
        left: cropLeft,
        top: cropTop,
        width: cropWidth,
        height: cropHeight,
      })
      .toFile(tempPath);

    // Replace original file with cropped version
    fs.renameSync(tempPath, imagePath);

    Logger.log(`Cropped image saved (overwritten): ${imagePath}`);
    Logger.log(
      `Crop region: ${cropLeft}, ${cropTop}, ${cropWidth}x${cropHeight} from ${width}x${height}`,
    );

    return imagePath;
  } catch (error) {
    Logger.error(`Error cropping image ${imagePath}:`, error);
    // Return original path if cropping fails
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
  const { Logger } = await import("./logger.js");

  try {
    const metadata = await sharp(imagePath).metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error(`Could not get image dimensions for ${imagePath}`);
    }

    return {
      width: metadata.width,
      height: metadata.height,
    };
  } catch (error) {
    Logger.error(`Error getting image dimensions for ${imagePath}:`, error);
    // Return default dimensions if reading fails
    return { width: 1000, height: 1000 };
  }
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

  // Get original dimensions before any processing
  const originalDimensions = await getImageDimensions(originalPath);
  Logger.log(`Original dimensions: ${originalDimensions.width}x${originalDimensions.height}`);

  let finalPath = originalPath;
  let wasCropped = false;
  let cropRegion: { left: number; top: number; width: number; height: number } | undefined;

  // Apply crop transform if needed
  if (needsCropping && cropTransform) {
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
