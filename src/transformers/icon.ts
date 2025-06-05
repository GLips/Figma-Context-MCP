import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";
import { type FetchImageParams, FigmaService } from "~/services/figma.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import fs from "fs";
import path from "path";
import * as os from "node:os";

/**
 * Represents a simplified icon object with type, filename, and content.
 */
export type SimpledIcon = {
  type: "svg" | "png";
  fileName: string;
  content: string;
};

/**
 * Builds a simplified icon object from a Figma document node.
 * Generates an SVG icon if all children of the node are of type VECTOR.
 * Removes componentId for INSTANCE nodes, fetches the image, and constructs the icon object.
 * Uses MD5 file naming to generate unique file names based on file content, ensuring frontend projects
 * avoid redundant imports of the same image by reusing identical assets.
 *
 * @param fileKey - The key identifying the Figma file
 * @param n - The Figma document node to process
 * @returns A Promise resolving to a SimpledIcon object if successful, or null if the node is invalid or processing fails
 */
export async function buildSimplifiedIcon(
  fileKey: string,
  n: FigmaDocumentNode,
): Promise<SimpledIcon | null> {
  if ("children" in n) {
    const isAllVectorChildren = n.children.every((child) => child.type === "VECTOR");
    if (isAllVectorChildren) {
      const figmaService = FigmaService.getInstance();
      const params: FetchImageParams[] = [
        {
          nodeId: n.id,
          fileName: generateRandomName("svg"),
          fileType: "svg",
        },
      ];
      const tempDir = getImageTempDirPath("svg");
      const urls = await figmaService.getImages(fileKey, params, tempDir, 1);
      const url = urls[0];
      if (url) {
        // Generate an MD5-based file name using the file content and node name to ensure uniqueness
        const md5Name = generateFileMd5Name("svg", url, n.name);
        const result: SimpledIcon = {
          type: "svg",
          fileName: md5Name,
          content: fs.readFileSync(url, "utf8"),
        };
        fs.unlinkSync(url);
        return result;
      }
    }
  }

  return null;
}

/**
 * Retrieves the temporary directory path for images.
 * Returns the appropriate temporary directory path based on the environment and file type.
 *
 * @param fileType - The image file type, either "svg" or "png".
 * @returns The full path to the temporary image directory.
 */
function getImageTempDirPath(fileType: "svg" | "png"): string {
  const baseDir = os.tmpdir();
  const result = path.join(baseDir, "figma-mcp", "tmp", fileType === "svg" ? "svg" : "png");
  if (process.env.NODE_ENV === "development") {
    console.log(`Base temporary directory: ${result}`);
  }
  return result;
}

/**
 * Generates a random filename with the specified file type extension.
 *
 * @param fileType - The file type for the extension, either "svg" or "png".
 * @param length - The length of the random filename (excluding extension), defaults to 8.
 * @returns A random filename with the specified file type extension.
 */
function generateRandomName(fileType: "svg" | "png", length: number = 8): string {
  const characters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    result += characters[randomIndex];
  }
  return `${result}.${fileType}`;
}

/**
 * Sanitizes a filename by replacing non-alphanumeric characters with underscores.
 *
 * @param str - The string to sanitize.
 * @returns The sanitized filename string.
 */
function sanitizeFilename(str: string): string {
  return str.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Generates a filename with an MD5 hash based on the file type, content, and input string.
 * Constructs a filename by extracting the last segment of the input string, sanitizing it,
 * and appending a 6-character MD5 hash of the file content.
 *
 * @param fileType - The file type for the extension, either "svg" or "png".
 * @param fileUrl - The path to the file to read for MD5 hashing.
 * @param inputString - The input string to derive the base filename from.
 * @returns The generated filename in the format `<baseName>_<md5Hash>.<fileType>`.
 */
function generateFileMd5Name(
  fileType: "svg" | "png",
  fileUrl: string,
  inputString: string,
): string {
  const parts = inputString.toLowerCase().split(/[/_]/);
  let baseName = parts[parts.length - 1];

  baseName = baseName || "file";

  baseName = sanitizeFilename(baseName);

  const fileContent = readFileSync(fileUrl);
  const md5Hash = createHash("md5").update(fileContent).digest("hex").slice(-6);

  return `${baseName}_${md5Hash}.${fileType}`;
}
