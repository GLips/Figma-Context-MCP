import path from "path";
import { type Command, command } from "cleye";
import {
  envStr,
  loadEnvFile,
  resolveAuth,
  requireGlobalCredentials,
  UsageError,
} from "~/config.js";
import { FigmaService } from "~/services/figma.js";
import { downloadFigmaImages } from "~/services/download-figma-images.js";
import { parseFigmaUrl } from "~/utils/figma-url.js";
import { authMode, initTelemetry, captureDownloadImagesCall, shutdown } from "~/telemetry/index.js";

// Same node ID shape the MCP tools accept, including nested instance paths.
const NODE_ID_PATTERN = /^I?\d+[:|-]\d+(?:;\d+[:|-]\d+)*$/;
const IMAGE_FORMATS = ["png", "svg"] as const;
type ImageFormat = (typeof IMAGE_FORMATS)[number];

export type DownloadImagesFlags = {
  fileKey?: string;
  nodeId?: string[];
  format?: string;
  scale?: number;
  imageDir?: string;
  figmaApiKey?: string;
  figmaOauthToken?: string;
  env?: string;
  noTelemetry?: boolean;
};

export type DownloadImagesCommandResult = {
  imageDir: string;
  filePaths: string[];
  /** Requested nodes Figma returned no image for (e.g. invisible or empty nodes). */
  missingNodeIds: string[];
};

export const downloadImagesCommand: Command = command(
  {
    name: "download-images",
    description: "Export Figma nodes as PNG or SVG files and print the saved paths to stdout",
    parameters: ["[url]"],
    flags: {
      fileKey: {
        type: String,
        description: "Figma file key (overrides URL)",
      },
      nodeId: {
        type: [String],
        description: "Node ID to export, format 1234:5678. Repeat to export several nodes",
      },
      format: {
        type: String,
        description: "Image format: png (default) or svg",
      },
      scale: {
        type: Number,
        description: "Export scale for PNG images (default: 2)",
      },
      imageDir: {
        type: String,
        description: "Directory to save images in (default: IMAGE_DIR or the current directory)",
      },
      figmaApiKey: {
        type: String,
        description: "Figma API key",
      },
      figmaOauthToken: {
        type: String,
        description: "Figma OAuth token",
      },
      env: {
        type: String,
        description: "Path to .env file",
      },
      noTelemetry: {
        type: Boolean,
        description: "Disable usage telemetry",
      },
    },
  },
  (argv) => {
    runDownloadImages(argv.flags, argv._)
      .then(({ filePaths, missingNodeIds }) => {
        for (const filePath of filePaths) console.log(filePath);
        if (missingNodeIds.length > 0) {
          console.error(
            `Figma returned no image for node(s) ${missingNodeIds.join(", ")}. ` +
              "Check that the node IDs exist and that the nodes are visible.",
          );
          process.exitCode = 1;
        }
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      })
      .finally(() => shutdown());
  },
);

export async function runDownloadImages(
  flags: DownloadImagesFlags,
  positionals: string[],
): Promise<DownloadImagesCommandResult> {
  const url = positionals[0];
  let fileKey = flags.fileKey;
  const requestedNodeIds = [...(flags.nodeId ?? [])];

  if (url) {
    try {
      const parsed = parseFigmaUrl(url);
      fileKey ??= parsed.fileKey;
      // An explicit --node-id selects what to export; the URL's node only
      // fills in when none was given, mirroring how --file-key overrides it.
      if (requestedNodeIds.length === 0 && parsed.nodeId) requestedNodeIds.push(parsed.nodeId);
    } catch (error) {
      if (!fileKey) throw error;
      // fileKey provided via flag — malformed URL is non-fatal
    }
  }

  if (!fileKey) {
    throw new UsageError("Either a Figma URL or --file-key is required");
  }
  if (requestedNodeIds.length === 0) {
    throw new UsageError("At least one node is required: pass a URL with node-id or --node-id");
  }

  const invalidNodeId = requestedNodeIds.find((id) => !NODE_ID_PATTERN.test(id));
  if (invalidNodeId) {
    throw new UsageError(
      `Invalid node ID '${invalidNodeId}'. Expected a format like 1234:5678 or I5666:180910;1:10515`,
    );
  }

  const format = parseImageFormat(flags.format);
  if (flags.scale !== undefined && !(flags.scale > 0)) {
    throw new UsageError("--scale must be a positive number");
  }

  // URLs encode node IDs with dashes (1-2) while the API uses colons (1:2);
  // canonicalize so the same node passed both ways is only exported once.
  const nodeIds = [...new Set(requestedNodeIds.map((id) => id.replace(/-/g, ":")))];

  loadEnvFile(flags.env);
  const imageDir = path.resolve(flags.imageDir ?? envStr("IMAGE_DIR") ?? process.cwd());
  const auth = resolveAuth(flags);
  requireGlobalCredentials(auth);

  initTelemetry({
    optOut: flags.noTelemetry,
    immediateFlush: true,
    redactFromErrors: [auth.figmaApiKey, auth.figmaOAuthToken],
  });

  const nodes = nodeIds.map((nodeId) => ({ nodeId, fileName: toFileName(nodeId, format) }));
  const mode = authMode(auth);
  const { downloads } = await downloadFigmaImages(
    new FigmaService(auth),
    { fileKey, nodes, localPath: imageDir, pngScale: flags.scale },
    {
      onComplete: (outcome) =>
        captureDownloadImagesCall(outcome, { transport: "cli", authMode: mode }),
    },
  );

  // The service skips nodes Figma has no render for rather than failing the
  // whole batch, so work out which requested nodes didn't produce a file.
  const filePaths = downloads.map(({ result }) => result.filePath);
  const savedFileNames = new Set(filePaths.map((filePath) => path.basename(filePath)));
  const missingNodeIds = nodes
    .filter(({ fileName }) => !savedFileNames.has(fileName))
    .map(({ nodeId }) => nodeId);

  return { imageDir, filePaths, missingNodeIds };
}

function parseImageFormat(value: string | undefined): ImageFormat {
  if (value === undefined) return "png";
  const format = value.toLowerCase();
  if ((IMAGE_FORMATS as readonly string[]).includes(format)) return format as ImageFormat;
  throw new UsageError(
    `Invalid --format value '${value}'. Expected one of: ${IMAGE_FORMATS.join(", ")}`,
  );
}

// "I5666:180910;1:10515" -> "I5666-180910-1-10515.png". Node IDs are always
// colon-separated number pairs, so collapsing every separator to "-" stays unambiguous.
function toFileName(nodeId: string, format: ImageFormat): string {
  return `${nodeId.replace(/[^a-zA-Z0-9]+/g, "-")}.${format}`;
}
