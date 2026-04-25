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
import { resolveLocalPath, type ResolveLocalPathFailureReason } from "../../utils/local-path.js";

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
      "The directory to save images in. Provide a path relative to the server's image directory (e.g., 'public/images' or 'assets/icons') using forward slashes. Absolute paths are accepted only if they point inside the image directory. The directory is created if missing.",
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
    const { fileKey, nodes, localPath, pngScale } = parametersSchema.parse(params);

    // Resolve localPath against the configured image directory. The resolver
    // accepts relative paths and absolute paths that fall under imageDir; it
    // rejects absolute paths pointing elsewhere (which would silently miswrite
    // under the previous join-based logic). See utils/local-path.ts.
    const baseDir = imageDir ?? process.cwd();
    const resolution = resolveLocalPath(localPath, baseDir);
    if (!resolution.ok) {
      // Path-traversal rejection happens after schema validation, so the SDK
      // wrapper in mcp/index.ts never sees it. Capture it here as a validation
      // reject so we can track how often LLMs trip over the localPath contract.
      const details = rejectionDetails(resolution.reason, localPath, baseDir);
      captureValidationReject(
        {
          tool: "download_figma_images",
          field: "localPath",
          rule: details.rule,
          message: details.telemetryMessage,
        },
        { transport, authMode, clientInfo },
      );
      return {
        isError: true,
        content: [{ type: "text" as const, text: details.userMessage }],
      };
    }
    const resolvedPath = resolution.resolvedPath;

    await sendProgress(extra, 0, 3, "Resolving image downloads");

    let stopHeartbeat: (() => void) | undefined;
    const { downloads, successCount } = await runDownloadFigmaImages(
      figmaService,
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
          captureDownloadImagesCall(outcome, { transport, authMode, clientInfo }),
      },
    );

    await sendProgress(extra, 2, 3, `Downloaded ${successCount} images, formatting response`);

    const imagesList = downloads
      .map(({ result, requestedFileNames }) => {
        // path.basename, not split("/"), so this works with backslash paths on Windows.
        const fileName = path.basename(result.filePath);
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
          // Echo the absolute resolved path so callers can immediately verify
          // where files landed. If imageDir defaulted to a server cwd that
          // doesn't match the user's project, this surfaces the mismatch
          // instead of letting it look like a successful no-op. Code-fenced
          // so markdown-rendering clients don't fight separator characters.
          text: `Downloaded ${successCount} images to \`${resolvedPath}\`:\n${imagesList}`,
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

function rejectionDetails(
  reason: ResolveLocalPathFailureReason,
  localPath: string,
  baseDir: string,
): { rule: ResolveLocalPathFailureReason; userMessage: string; telemetryMessage: string } {
  switch (reason) {
    case "windows_path_on_posix":
      return {
        rule: reason,
        telemetryMessage: `Windows-style path on POSIX server: ${localPath}`,
        userMessage:
          `Invalid path: "${localPath}" looks like a Windows path (backslash separator or drive letter), but this server is running on POSIX where those aren't path separators. ` +
          `Use forward slashes only. The server's image directory is "${baseDir}"; pass a path relative to it (e.g., "public/images").`,
      };
    case "outside_image_dir": {
      // Leading-slash inputs used to be silently re-interpreted as relative
      // under the old path.join hack. They now reject; spell out the retry so
      // an LLM doesn't have to guess that "/public/images" should have been
      // "public/images".
      const leadingSlashHint = /^[/\\]/.test(localPath)
        ? ` If you meant a directory inside the image directory, drop the leading slash (e.g., use "${localPath.replace(/^[/\\]+/, "")}").`
        : "";
      return {
        rule: reason,
        telemetryMessage: `Path resolves outside allowed image directory: ${localPath}`,
        userMessage:
          `Invalid path: "${localPath}" resolves outside the allowed image directory. ` +
          `The server's image directory is "${baseDir}". Provide a path relative to this directory (e.g., "public/images" or "assets/icons").` +
          leadingSlashHint,
      };
    }
  }
}

// Export tool configuration
export const downloadFigmaImagesTool = {
  name: "download_figma_images",
  getDescription,
  parametersSchema,
  handler: downloadFigmaImages,
} as const;
