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
      fileName: z.string().describe("The local name for saving the fetched file"),
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
  svgOptions: z
    .object({
      outlineText: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to outline text in SVG exports. Default is true."),
      includeId: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to include IDs in SVG exports. Default is false."),
      simplifyStroke: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to simplify strokes in SVG exports. Default is true."),
    })
    .optional()
    .default({})
    .describe("Options for SVG export"),
};

const parametersSchema = z.object(parameters);
export type DownloadImagesParams = z.infer<typeof parametersSchema>;

// Simplified handler function
async function downloadFigmaImages(params: DownloadImagesParams, figmaService: FigmaService) {
  try {
    const { fileKey, nodes, localPath, svgOptions, pngScale = 2 } = params;

    // Convert the tool's node format to the new unified format
    const items = nodes.map((node) => {
      if (node.imageRef) {
        // Image fill
        return { imageRef: node.imageRef, fileName: node.fileName };
      } else {
        // Rendered node
        return { nodeId: node.nodeId, fileName: node.fileName };
      }
    });

    const allDownloads = await figmaService.downloadImages(fileKey, localPath, items, {
      pngScale,
      svgOptions,
    });

    const successCount = allDownloads.filter(Boolean).length;

    return {
      content: [
        {
          type: "text" as const,
          text:
            successCount === allDownloads.length
              ? `Successfully downloaded ${successCount} images`
              : `Downloaded ${successCount}/${allDownloads.length} images (some failed)`,
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
