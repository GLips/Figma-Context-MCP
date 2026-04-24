import path from "path";
import { z } from "zod";
import { FigmaService } from "../../services/figma.js";
import { Logger } from "../../utils/logger.js";
import {
  captureDownloadImagesCall,
  captureValidationReject,
  type AuthMode,
  type ClientInfo,
  type Transport,
} from "~/telemetry/index.js";
import { downloadFigmaImages as runDownloadFigmaImages } from "../../services/download-figma-images.js";
import { sendProgress, startProgressHeartbeat, type ToolExtra } from "../progress.js";

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
  figma_api_key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional Figma Personal Access Token for this tool call. Overrides server-level API key or OAuth authentication for this request only.",
    ),
};

const parametersSchema = z.object(parameters);
export type DownloadImagesParams = z.infer<typeof parametersSchema>;

async function downloadFigmaImages(
  params: DownloadImagesParams,
  figmaService: FigmaService,
  imageDir: string | undefined,
  transport: Transport,
  authMode: AuthMode,
  clientInfo: ClientInfo | undefined,
  extra: ToolExtra,
) {
  try {
    const { fileKey, nodes, localPath, pngScale, figma_api_key } = parametersSchema.parse(params);
    const callFigmaService = figma_api_key ? figmaService.withApiKey(figma_api_key) : figmaService;
    const callAuthMode: AuthMode = figma_api_key ? "api_key" : authMode;

    // Resolve localPath relative to the configured image directory.
    // path.join (not path.resolve) so a leading "/" is treated as relative, not absolute —
    // LLMs frequently produce paths like "/public/images" when they mean "public/images".
    // This is a security boundary tied to server config, so it lives at the edge rather
    // than in the shared core.
    const baseDir = imageDir ?? process.cwd();
    const resolvedPath = path.resolve(path.join(baseDir, localPath));
    // Drive roots (e.g. E:\) already end with a separator — avoid doubling it
    const baseDirPrefix = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
    if (resolvedPath !== baseDir && !resolvedPath.startsWith(baseDirPrefix)) {
      // Path-traversal rejection happens after schema validation, so the SDK
      // wrapper in mcp/index.ts never sees it. Capture it here as a validation
      // reject so we can track how often LLMs trip over the localPath contract.
      captureValidationReject(
        {
          tool: "download_figma_images",
          field: "localPath",
          rule: "path_traversal",
          message: `Path resolves outside allowed image directory: ${localPath}`,
        },
        { transport, authMode, clientInfo },
      );
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

    await sendProgress(extra, 0, 3, "Resolving image downloads");

    let stopHeartbeat: (() => void) | undefined;
    const { downloads, successCount } = await runDownloadFigmaImages(
      callFigmaService,
      { fileKey, nodes, localPath: resolvedPath, pngScale },
      {
        onDownloadStart: async (downloadCount) => {
          await sendProgress(extra, 1, 3, `Resolved ${downloadCount} images, downloading`);
          stopHeartbeat = startProgressHeartbeat(extra, "Downloading images");
        },
        onDownloadComplete: () => {
          stopHeartbeat?.();
        },
        onComplete: (outcome) =>
          captureDownloadImagesCall(outcome, { transport, authMode: callAuthMode, clientInfo }),
      },
    );

    await sendProgress(extra, 2, 3, `Downloaded ${successCount} images, formatting response`);

    const imagesList = downloads
      .map(({ result, requestedFileNames }) => {
        const fileName = result.filePath.split("/").pop() || result.filePath;
        const dimensions = `${result.finalDimensions.width}x${result.finalDimensions.height}`;
        const cropStatus = result.wasCropped ? " (cropped)" : "";

        const dimensionInfo = result.cssVariables
          ? `${dimensions} | ${result.cssVariables}`
          : dimensions;

        const aliasText =
          requestedFileNames.length > 1
            ? ` (also requested as: ${requestedFileNames.filter((name) => name !== fileName).join(", ")})`
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
    const message = error instanceof Error ? error.message : String(error);
    Logger.error(`Error downloading images from ${params.fileKey}:`, error);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to download images: ${message}`,
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
