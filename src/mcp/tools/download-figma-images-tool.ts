import path from "path";
import { z } from "zod";
import { FigmaService } from "../../services/figma.js";
import { Logger } from "../../utils/logger.js";

const parameters = {
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe("The key of the Figma file containing the images"),
  nodes: z
    .object({
      nodeId: z
        .string()
        .regex(
          /^I?\d+[:|-]\d+(?:;\d+[:|-]\d+)*$/,
          "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'",
        )
        .describe("The ID of the Figma image node to fetch, formatted as 1234:5678"),
      imageRef: z
        .string()
        .optional()
        .describe(
          "If a node has an imageRef fill, you must include this variable. Leave blank when downloading Vector SVG images or animated GIFs (use gifRef instead).",
        ),
      gifRef: z
        .string()
        .optional()
        .describe(
          "If a node has a gifRef fill (animated GIF), you must include this variable to download the animated GIF. When gifRef is present in the Figma data, use it instead of imageRef to get the animated file rather than a static snapshot.",
        ),
      fileName: z
        .string()
        .regex(
          /^[a-zA-Z0-9_.-]+\.(png|svg|gif)$/,
          "File names must contain only letters, numbers, underscores, dots, or hyphens, and end with .png, .svg, or .gif.",
        )
        .describe(
          "The local name for saving the fetched file, including extension. png, svg, or gif.",
        ),
      needsCropping: z
        .boolean()
        .optional()
        .describe("Whether this image needs cropping based on its transform matrix"),
      cropTransform: z
        .array(z.array(z.number()))
        .optional()
        .describe("Figma transform matrix for image cropping"),
      requiresImageDimensions: z
        .boolean()
        .optional()
        .describe("Whether this image requires dimension information for CSS variables"),
      filenameSuffix: z
        .string()
        .regex(
          /^[a-zA-Z0-9_-]+$/,
          "Suffix must contain only letters, numbers, underscores, or hyphens",
        )
        .optional()
        .describe(
          "Suffix to add to filename for unique cropped images, provided in the Figma data (e.g., 'abc123')",
        ),
    })
    .array()
    .describe("The nodes to fetch as images"),
  pngScale: z
    .number()
    .positive()
    .optional()
    .default(2)
    .describe(
      "Export scale for PNG images. Optional, defaults to 2 if not specified. Affects PNG images only.",
    ),
  localPath: z
    .string()
    .describe(
      "The path to the directory where images should be saved, relative to the project root. If the directory does not exist, it will be created. Use forward slashes for path separators (e.g., 'public/images' or 'assets/icons').",
    ),
};

const parametersSchema = z.object(parameters);
export type DownloadImagesParams = z.infer<typeof parametersSchema>;

// Enhanced handler function with image processing support
async function downloadFigmaImages(
  params: DownloadImagesParams,
  figmaService: FigmaService,
  imageDir?: string,
) {
  try {
    const { fileKey, nodes, localPath, pngScale = 2 } = parametersSchema.parse(params);

    // Resolve localPath relative to the configured image directory.
    // path.join (not path.resolve) so a leading "/" is treated as relative, not absolute —
    // LLMs frequently produce paths like "/public/images" when they mean "public/images".
    const baseDir = imageDir ?? process.cwd();
    const resolvedPath = path.resolve(path.join(baseDir, localPath));
    if (resolvedPath !== baseDir && !resolvedPath.startsWith(baseDir + path.sep)) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Invalid path: "${localPath}" resolves outside the allowed image directory. The server's image directory is "${baseDir}". Provide a path relative to this directory (e.g., "public/images" or "assets/icons").`,
          },
        ],
      };
    }

    // Process nodes: collect unique downloads and track which requests they satisfy
    const downloadItems = [];
    const downloadToRequests = new Map<number, string[]>(); // download index -> requested filenames
    const seenDownloads = new Map<string, number>(); // uniqueKey -> download index

    for (const rawNode of nodes) {
      const { nodeId: rawNodeId, ...node } = rawNode;

      // Replace - with : in nodeId for our query—Figma API expects :
      const nodeId = rawNodeId?.replace(/-/g, ":");

      // Apply filename suffix if provided
      let finalFileName = node.fileName;
      if (node.filenameSuffix && !finalFileName.includes(node.filenameSuffix)) {
        const ext = finalFileName.split(".").pop();
        const nameWithoutExt = finalFileName.substring(0, finalFileName.lastIndexOf("."));
        finalFileName = `${nameWithoutExt}-${node.filenameSuffix}.${ext}`;
      }

      const downloadItem = {
        fileName: finalFileName,
        needsCropping: node.needsCropping || false,
        cropTransform: node.cropTransform,
        requiresImageDimensions: node.requiresImageDimensions || false,
      };

      if (node.gifRef) {
        // GIF fills are always unique downloads (animated, no dedup needed)
        const downloadIndex = downloadItems.length;
        downloadItems.push({ ...downloadItem, gifRef: node.gifRef });
        downloadToRequests.set(downloadIndex, [finalFileName]);
      } else if (node.imageRef) {
        // For imageRefs, check if we've already planned to download this
        const uniqueKey = `${node.imageRef}-${node.filenameSuffix || "none"}`;

        if (!node.filenameSuffix && seenDownloads.has(uniqueKey)) {
          // Already planning to download this, just add to the requests list
          const downloadIndex = seenDownloads.get(uniqueKey)!;
          const requests = downloadToRequests.get(downloadIndex)!;
          if (!requests.includes(finalFileName)) {
            requests.push(finalFileName);
          }

          // Update requiresImageDimensions if needed
          if (downloadItem.requiresImageDimensions) {
            downloadItems[downloadIndex].requiresImageDimensions = true;
          }
        } else {
          // New unique download
          const downloadIndex = downloadItems.length;
          downloadItems.push({ ...downloadItem, imageRef: node.imageRef });
          downloadToRequests.set(downloadIndex, [finalFileName]);
          seenDownloads.set(uniqueKey, downloadIndex);
        }
      } else {
        // Rendered nodes are always unique
        const downloadIndex = downloadItems.length;
        downloadItems.push({ ...downloadItem, nodeId });
        downloadToRequests.set(downloadIndex, [finalFileName]);
      }
    }

    const allDownloads = await figmaService.downloadImages(fileKey, resolvedPath, downloadItems, {
      pngScale,
    });

    const successCount = allDownloads.filter(Boolean).length;

    // Format results with aliases
    const imagesList = allDownloads
      .map((result, index) => {
        const fileName = result.filePath.split("/").pop() || result.filePath;
        const dimensions = `${result.finalDimensions.width}x${result.finalDimensions.height}`;
        const cropStatus = result.wasCropped ? " (cropped)" : "";

        const dimensionInfo = result.cssVariables
          ? `${dimensions} | ${result.cssVariables}`
          : dimensions;

        // Show all the filenames that were requested for this download
        const requestedNames = downloadToRequests.get(index) || [fileName];
        const aliasText =
          requestedNames.length > 1
            ? ` (also requested as: ${requestedNames.filter((name: string) => name !== fileName).join(", ")})`
            : "";

        return `- ${fileName}: ${dimensionInfo}${cropStatus}${aliasText}`;
      })
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Downloaded ${successCount} images:\n${imagesList}`,
        },
      ],
    };
  } catch (error) {
    Logger.error(`Error downloading images from ${params.fileKey}:`, error);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to download images: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

function getDescription(imageDir?: string) {
  const baseDir = imageDir ?? process.cwd();
  return `Download SVG and PNG images used in a Figma file based on the IDs of image or icon nodes. Images will be saved relative to the server's image directory: ${baseDir}`;
}

// Export tool configuration
export const downloadFigmaImagesTool = {
  name: "download_figma_images",
  getDescription,
  parametersSchema,
  handler: downloadFigmaImages,
} as const;
