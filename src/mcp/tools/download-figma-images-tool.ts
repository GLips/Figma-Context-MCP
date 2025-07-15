import { z } from "zod";
import type { ToolDefinition } from "../index.js";
import { FigmaService } from "../../services/figma.js";
import { Logger } from "../../utils/logger.js";

const name = "download_figma_images";
const description =
  "Download SVG and PNG images used in a Figma file based on the IDs of image or icon nodes";
const parameters = {
  fileKey: z.string().describe("The key of the Figma file containing the node"),
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

type DownloadFigmaImagesOptions = {
  figmaService: FigmaService;
};

// Overloaded factory function
export function createDownloadFigmaImagesTool(
  options: DownloadFigmaImagesOptions,
): ToolDefinition<typeof parameters> {
  return {
    name,
    description,
    parameters,
    handler:
      () =>
      async ({ fileKey, nodes, localPath, svgOptions, pngScale }) => {
        try {
          const imageFills = nodes.filter(({ imageRef }) => !!imageRef) as {
            nodeId: string;
            imageRef: string;
            fileName: string;
          }[];

          const { figmaService } = options;

          const fillDownloads = figmaService.getImageFills(fileKey, imageFills, localPath);
          const renderRequests = nodes
            .filter(({ imageRef }) => !imageRef)
            .map(({ nodeId, fileName }) => ({
              nodeId,
              fileName,
              fileType: fileName.endsWith(".svg") ? ("svg" as const) : ("png" as const),
            }));

          const renderDownloads = figmaService.getImages(
            fileKey,
            renderRequests,
            localPath,
            pngScale,
            svgOptions,
          );

          const downloads = await Promise.all([fillDownloads, renderDownloads]).then(([f, r]) => [
            ...f,
            ...r,
          ]);

          // If any download fails, return false
          const saveSuccess = !downloads.find((success) => !success);
          return {
            content: [
              {
                type: "text",
                text: saveSuccess
                  ? `Success, ${downloads.length} images downloaded: ${downloads.join(", ")}`
                  : "Failed",
              },
            ],
          };
        } catch (error) {
          Logger.error(`Error downloading images from file ${fileKey}:`, error);
          return {
            isError: true,
            content: [{ type: "text", text: `Error downloading images: ${error}` }],
          };
        }
      },
    register: (server) => {
      if (!options) {
        throw new Error(
          "Cannot register downloadFigmaImagesTool without required options (figmaService)",
        );
      }
      return server.tool(
        name,
        description,
        parameters,
        createDownloadFigmaImagesTool(options).handler(),
      );
    },
  };
}
