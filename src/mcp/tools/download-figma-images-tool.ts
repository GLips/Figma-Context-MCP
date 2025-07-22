import { z } from "zod";
import { FigmaService } from "../../services/figma.js";
import { Logger } from "../../utils/logger.js";

const parameters = {
  fileKey: z.string().describe("The key of the Figma file containing the images"),
  nodes: z
    .object({
      nodeId: z
        .string()
        .describe("The ID of the Figma image node to fetch, formatted as 1234:5678"),
      imageRef: z
        .string()
        .optional()
        .describe(
          "If a node has an imageRef fill, you must include this variable. Leave blank when downloading Vector SVG images.",
        ),
      fileName: z
        .string()
        .describe(
          "The local name for saving the fetched file, including extension. Either png or svg.",
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
      "The absolute path to the directory where images are stored in the project. If the directory does not exist, it will be created. The format of this path should respect the directory format of the operating system you are running on. Don't use any special character escaping in the path name either.",
    ),
};

const parametersSchema = z.object(parameters);
export type DownloadImagesParams = z.infer<typeof parametersSchema>;

// Enhanced handler function with image processing support
async function downloadFigmaImages(params: DownloadImagesParams, figmaService: FigmaService) {
  try {
    const { fileKey, nodes, localPath, pngScale = 2 } = params;

    // Process nodes: collect unique downloads and track which requests they satisfy
    const downloadItems = [];
    const downloadToRequests = new Map<number, string[]>(); // download index -> requested filenames
    const seenDownloads = new Map<string, number>(); // uniqueKey -> download index

    for (const node of nodes) {
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

      if (node.imageRef) {
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
        downloadItems.push({ ...downloadItem, nodeId: node.nodeId });
        downloadToRequests.set(downloadIndex, [finalFileName]);
      }
    }

    const allDownloads = await figmaService.downloadImages(fileKey, localPath, downloadItems, {
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

// Export tool configuration
export const downloadFigmaImagesTool = {
  name: "download_figma_images",
  description:
    "Download SVG and PNG images used in a Figma file based on the IDs of image or icon nodes",
  parameters,
  handler: downloadFigmaImages,
} as const;
