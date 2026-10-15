// zod/v3 — see get-figma-data-tool.ts: classic-API schemas kept as-is across the zod-4 bump.
import { z } from "zod/v3";
import {
  downloadFigmaImages as runDownloadFigmaImages,
  type DownloadImagesOutcome,
} from "../../services/download-figma-images.js";
import type { FigmaService } from "../../services/figma.js";
import {
  FIGMA_FILE_KEY_FORMAT_MESSAGE,
  FIGMA_FILE_KEY_PATTERN,
  FIGMA_NODE_ID_FORMAT_MESSAGE,
  FIGMA_NODE_ID_PATTERN,
  figmaFileKey,
  figmaNodeId,
} from "../../utils/figma-url.js";
import { createDiskImageDestination, type ImageDestination } from "../../utils/image-processing.js";
import { type ResolveLocalPathFailureReason, resolveLocalPath } from "../../utils/local-path.js";
import { Logger } from "../../utils/logger.js";
import { sendProgress, startProgressHeartbeat, type ToolExtra } from "../progress.js";

const sharedParameters = {
  fileKey: z
    .string()
    .regex(FIGMA_FILE_KEY_PATTERN, FIGMA_FILE_KEY_FORMAT_MESSAGE)
    .describe("The key of the Figma file containing the images"),
  nodes: z
    .object({
      nodeId: z
        .string()
        .regex(FIGMA_NODE_ID_PATTERN, FIGMA_NODE_ID_FORMAT_MESSAGE)
        .describe("The ID of the Figma image node to fetch, formatted as 1234:5678"),
      imageRef: z
        .string()
        .optional()
        .describe(
          "If a node has an imageRef fill, you must include this variable. Leave blank when downloading Vector SVG images or animated GIFs (use gifRef instead), or when an IMAGE fill is present without an imageRef — in that case the node is rendered as PNG via nodeId.",
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
        .describe("The file name for the fetched image, including extension. png, svg, or gif."),
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
};

const parameters = {
  ...sharedParameters,
  localPath: z
    .string()
    .describe(
      "The directory to save images in. Provide a path relative to the server's image directory (e.g., 'public/images' or 'assets/icons'). Either separator works. Absolute paths are accepted only if they point inside the image directory. The directory is created if missing.",
    ),
};

const parametersSchema = z.object(parameters);
export type DownloadImagesParams = z.infer<typeof parametersSchema>;

// The destination variant has no localPath: its images land wherever the destination puts them.
const destinationParametersSchema = z.object(sharedParameters);
export type DownloadImageDestinationParams = z.infer<typeof destinationParametersSchema>;

type TextToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };

/** A localPath the schema accepted but the image directory refuses — codes only, never the path. */
export type LocalPathRejection = {
  field: "localPath";
  rule: ResolveLocalPathFailureReason;
  detail?: string;
};

type DownloadHandlerOptions = {
  extra: ToolExtra;
  onComplete: (outcome: DownloadImagesOutcome) => void;
};

/** Run the pipeline into `destination` and render one line per image. */
async function downloadAndList(
  figmaService: FigmaService,
  input: Omit<DownloadImageDestinationParams, "pngScale"> & {
    pngScale: number;
    destination: ImageDestination;
  },
  { extra, onComplete }: DownloadHandlerOptions,
): Promise<{ summary: string; imagesList: string; isError: true | undefined }> {
  await sendProgress(extra, 0, 3, "Resolving image downloads");

  let stopHeartbeat: (() => void) | undefined;
  const request = {
    ...input,
    fileKey: figmaFileKey(input.fileKey),
    nodes: input.nodes.map((node) => ({ ...node, nodeId: figmaNodeId(node.nodeId) })),
  };
  const { downloads, successCount } = await runDownloadFigmaImages(figmaService, request, {
    onDownloadStart: async (downloadCount) => {
      await sendProgress(extra, 1, 3, `Resolved ${downloadCount} images, downloading`);
      stopHeartbeat = startProgressHeartbeat(extra, "Downloading images");
    },
    onDownloadComplete: () => {
      stopHeartbeat?.();
    },
    onComplete,
  });

  await sendProgress(extra, 2, 3, `Downloaded ${successCount} images, formatting response`);

  const imagesList = downloads
    .map(({ fileName, aliases, outcome }) => {
      const aliasText = aliases.length > 0 ? ` (also requested as: ${aliases.join(", ")})` : "";
      switch (outcome.status) {
        case "written": {
          const { result } = outcome;
          const dimensions = `${result.finalDimensions.width}x${result.finalDimensions.height}`;
          const dimensionInfo = result.cssVariables
            ? `${dimensions} | ${result.cssVariables}`
            : dimensions;
          // A file's directory is already in the reply's header line; a link is per image.
          const locationInfo = result.location.kind === "url" ? `${result.location.url} | ` : "";
          const cropStatus = result.wasCropped ? " (cropped)" : "";
          return `- ${fileName}: ${locationInfo}${dimensionInfo}${cropStatus}${aliasText}`;
        }
        case "not_rendered":
          return `- ${fileName}: not downloaded, Figma returned no image for it${aliasText}`;
        case "failed": {
          const reason =
            outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          return `- ${fileName}: failed, ${reason}${aliasText}`;
        }
      }
    })
    .join("\n");

  return {
    summary: `Downloaded ${successCount} of ${downloads.length} images`,
    imagesList,
    // Partial failures are listed per file; only a call that wrote nothing because downloads
    // failed is an error.
    isError:
      successCount === 0 && downloads.some(({ outcome }) => outcome.status === "failed")
        ? true
        : undefined,
  };
}

function downloadFailure(fileKey: string, error: unknown): TextToolResult {
  const message = error instanceof Error ? error.message : String(error);
  Logger.error(`Error downloading images from ${fileKey}:`, error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Failed to download images: ${message}` }],
  };
}

async function downloadFigmaImages(
  params: DownloadImagesParams,
  figmaService: FigmaService,
  {
    imageDir,
    onReject,
    ...options
  }: DownloadHandlerOptions & {
    imageDir: string;
    onReject: (rejection: LocalPathRejection) => void;
  },
): Promise<TextToolResult> {
  try {
    const { fileKey, nodes, localPath, pngScale } = parametersSchema.parse(params);

    // Resolve localPath against the configured image directory. The resolver
    // accepts relative paths and absolute paths that fall under imageDir; it
    // rejects absolute paths pointing elsewhere (which would silently miswrite
    // under the previous join-based logic). See utils/local-path.ts.
    const resolution = resolveLocalPath(localPath, imageDir);
    if (!resolution.ok) {
      // Path-traversal rejection happens after schema validation, so the SDK's
      // validation hook never sees it. Report it here as a validation reject so we
      // can track how often LLMs trip over the localPath contract.
      const details = rejectionDetails(resolution.reason, localPath, imageDir);
      onReject({ field: "localPath", rule: details.rule, detail: details.detail });
      return {
        isError: true,
        content: [{ type: "text" as const, text: details.userMessage }],
      };
    }
    const resolvedPath = resolution.resolvedPath;

    const { summary, imagesList, isError } = await downloadAndList(
      figmaService,
      { fileKey, nodes, pngScale, destination: createDiskImageDestination(resolvedPath) },
      options,
    );

    return {
      isError,
      content: [
        {
          type: "text" as const,
          // Echo the absolute resolved path so callers can immediately verify
          // where files landed. If imageDir defaulted to a server cwd that
          // doesn't match the user's project, this surfaces the mismatch
          // instead of letting it look like a successful no-op. Code-fenced
          // so markdown-rendering clients don't fight separator characters.
          text: `${summary} to \`${resolvedPath}\`:\n${imagesList}`,
        },
      ],
    };
  } catch (error) {
    return downloadFailure(params.fileKey, error);
  }
}

async function downloadFigmaImagesToDestination(
  params: DownloadImageDestinationParams,
  figmaService: FigmaService,
  { destination, ...options }: DownloadHandlerOptions & { destination: ImageDestination },
): Promise<TextToolResult> {
  try {
    const { fileKey, nodes, pngScale } = destinationParametersSchema.parse(params);
    const { summary, imagesList, isError } = await downloadAndList(
      figmaService,
      { fileKey, nodes, pngScale, destination },
      options,
    );
    return { isError, content: [{ type: "text" as const, text: `${summary}:\n${imagesList}` }] };
  } catch (error) {
    return downloadFailure(params.fileKey, error);
  }
}

function getDescription(imageDir: string) {
  return `Save a Figma file's images to disk: image fills (PNG or GIF), icons and vectors (SVG), or any node rendered as PNG. Copy nodeId, imageRef, gifRef and the crop fields from get_figma_data output. Files are saved under the server's image directory: ${imageDir}`;
}

// Writing images means writing to the server's own disk, which belongs to the operator alone.
const REFUSED_TEXT =
  "download_figma_images is unavailable to remote callers: it writes to the server's own disk, " +
  "which only a server listening on a loopback address grants, to the person running it. To " +
  "save images into your project, run Framelink on your own machine.";

function refusedReply(): TextToolResult {
  return { isError: true, content: [{ type: "text", text: REFUSED_TEXT }] };
}

/**
 * What kind of path an agent passed, without the path itself: a rejected path is absolute or
 * escaping by definition, so it names a user's home and client directories and must not reach
 * telemetry. The shape alone tells us which contract mistake agents make.
 */
function localPathShape(localPath: string): string {
  if (/^[a-zA-Z]:/.test(localPath)) return "drive_letter";
  if (/^[/\\]{2}/.test(localPath)) return "unc";
  if (/^[/\\]/.test(localPath)) return "absolute";
  if (localPath.startsWith("~")) return "home_tilde";
  if (/(^|[/\\])\.\.([/\\]|$)/.test(localPath)) return "dotdot";
  return "relative";
}

function rejectionDetails(
  reason: ResolveLocalPathFailureReason,
  localPath: string,
  baseDir: string,
): {
  rule: ResolveLocalPathFailureReason;
  detail?: string;
  userMessage: string;
} {
  switch (reason) {
    case "drive_letter_on_posix":
      return {
        rule: reason,
        userMessage:
          `Invalid path: "${localPath}" starts with a Windows drive letter, but this server is running on POSIX where drive letters don't exist. ` +
          `The server's image directory is "${baseDir}"; pass a path relative to it (e.g., "public/images").`,
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
        detail: localPathShape(localPath),
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
  refusedDescription: REFUSED_TEXT,
  refusedReply,
  parametersSchema,
  handler: downloadFigmaImages,
} as const;

/** The same export, stored by a host-supplied destination, which usually hands back links. */
export const downloadFigmaImageDestinationTool = {
  name: "download_figma_images",
  getDescription: (retentionDays: number) =>
    `Export a Figma file's images: image fills (PNG or GIF), icons and vectors (SVG), or any node rendered as PNG. Copy nodeId, imageRef, gifRef and the crop fields from get_figma_data output. Returns a link to each processed image; links expire after ${retentionDays} days.`,
  parametersSchema: destinationParametersSchema,
  handler: downloadFigmaImagesToDestination,
} as const;
