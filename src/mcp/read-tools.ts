// The three read tools, registered the same way for every composition: the local server adds the
// plugin read route and telemetry on top, the embeddable read entry adds a credential secret scope
// and sanitized observations. Nothing here may import `~/commercial/` or telemetry — the read
// entry's import graph runs through this module (checked by scripts/check-read-entry.mjs).
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { FigmaService } from "~/services/figma.js";
import type { GetFigmaDataOutcome } from "~/services/get-figma-data.js";
import type { DownloadImagesOutcome } from "~/services/download-figma-images.js";
import type { ImageDestination } from "~/utils/image-processing.js";
import type { ResolveLocalPathFailureReason } from "~/utils/local-path.js";
import type { OutputFormat } from "~/utils/serialize.js";
import type { ToolExtra } from "./progress.js";
import {
  downloadFigmaImageDestinationTool,
  downloadFigmaImagesTool,
  getFigmaCommentsTool,
  getFigmaDataTool,
  type DescribeReadRecovery,
  type DownloadImageDestinationParams,
  type DownloadImagesParams,
  type GetFigmaCommentsParams,
  type GetFigmaDataParams,
} from "./tools/index.js";

/** Where download_figma_images puts images, or that it isn't offered at all. */
export type ImageOutput =
  | { kind: "none" }
  | { kind: "disk"; imageDir?: string }
  | { kind: "destination"; destination: ImageDestination; retentionDays: number };

/**
 * Runs around every read-tool call: the host admits or refuses the call here (rate limit,
 * concurrency). A refusal is an ordinary tool result the agent can read and act on.
 */
export type ToolCallGuard = (run: () => Promise<CallToolResult>) => Promise<CallToolResult>;

/** What a read tool reports when it finishes, raw: errors and inputs included. */
export type ReadToolOutcome =
  | { tool: "get_figma_data"; kind: "completed"; outcome: GetFigmaDataOutcome }
  | {
      tool: "get_figma_comments";
      kind: "completed";
      outcome: { durationMs: number; error?: unknown };
    }
  | { tool: "download_figma_images"; kind: "completed"; outcome: DownloadImagesOutcome }
  | {
      tool: "download_figma_images";
      kind: "rejected";
      field: "localPath";
      rule: ResolveLocalPathFailureReason;
      message: string;
    };

export type RegisterReadToolsOptions = {
  outputFormat: OutputFormat;
  images: ImageOutput;
  observe: (outcome: ReadToolOutcome) => void;
  guardToolCall?: ToolCallGuard;
  /** Extra guidance appended to a failed get_figma_data — another way to get the same data. */
  describeReadRecovery?: DescribeReadRecovery;
};

// Explicit on every read tool, in every mode: directory review requires all three, and the
// MCP defaults (destructive, open-world) are the opposite of what these tools do. Reads touch only
// the user's own Figma files — a closed domain.
const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
// A local download writes files into the user's project and overwrites same-named ones.
const DISK_DOWNLOAD_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

/** Registers the read tools; returns get_figma_data's handle so a composition can re-describe it. */
export function registerReadTools(
  server: McpServer,
  figmaService: FigmaService,
  options: RegisterReadToolsOptions,
): { getFigmaData: RegisteredTool } {
  const { images, observe } = options;
  const guard: ToolCallGuard = options.guardToolCall ?? ((run) => run());

  const getFigmaData = server.registerTool(
    getFigmaDataTool.name,
    {
      title: "Get Figma Data",
      description: getFigmaDataTool.description,
      inputSchema: getFigmaDataTool.parametersSchema,
      annotations: READ_ANNOTATIONS,
    },
    (params: GetFigmaDataParams, extra: ToolExtra) =>
      guard(() =>
        getFigmaDataTool.handler(params, figmaService, {
          outputFormat: options.outputFormat,
          describeRecovery: options.describeReadRecovery,
          onComplete: (outcome) => observe({ tool: "get_figma_data", kind: "completed", outcome }),
          extra,
        }),
      ),
  );

  server.registerTool(
    getFigmaCommentsTool.name,
    {
      title: "Get Figma Comments",
      description: getFigmaCommentsTool.description,
      inputSchema: getFigmaCommentsTool.parameters,
      annotations: READ_ANNOTATIONS,
    },
    (params: GetFigmaCommentsParams) =>
      guard(() =>
        getFigmaCommentsTool.handler(params, figmaService, (outcome) =>
          observe({ tool: "get_figma_comments", kind: "completed", outcome }),
        ),
      ),
  );

  if (images.kind === "disk") {
    server.registerTool(
      downloadFigmaImagesTool.name,
      {
        title: "Download Figma Images",
        description: downloadFigmaImagesTool.getDescription(images.imageDir),
        inputSchema: downloadFigmaImagesTool.parametersSchema,
        annotations: DISK_DOWNLOAD_ANNOTATIONS,
      },
      (params: DownloadImagesParams, extra: ToolExtra) =>
        guard(() =>
          downloadFigmaImagesTool.handler(params, figmaService, images.imageDir, observe, extra),
        ),
    );
  } else if (images.kind === "destination") {
    server.registerTool(
      downloadFigmaImageDestinationTool.name,
      {
        title: "Download Figma Images",
        description: downloadFigmaImageDestinationTool.getDescription(images.retentionDays),
        inputSchema: downloadFigmaImageDestinationTool.parametersSchema,
        // Exports into the host's own storage: nothing of the user's changes.
        annotations: READ_ANNOTATIONS,
      },
      (params: DownloadImageDestinationParams, extra: ToolExtra) =>
        guard(() =>
          downloadFigmaImageDestinationTool.handler(
            params,
            figmaService,
            images.destination,
            observe,
            extra,
          ),
        ),
    );
  }

  return { getFigmaData };
}
