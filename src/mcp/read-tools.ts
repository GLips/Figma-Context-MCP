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
import type { OutputFormat } from "~/utils/serialize.js";
import {
  registerFramelinkTool,
  type FramelinkToolCall,
  type ToolCallObservation,
} from "./framelink-tool.js";
import type { ToolExtra } from "./progress.js";
import {
  downloadFigmaImageDestinationTool,
  downloadFigmaImagesTool,
  getFigmaCommentsTool,
  getFigmaDataTool,
  type DescribeReadRecovery,
  type DownloadImageDestinationParams,
  type DownloadImagesParams,
  type GetFigmaCommentsOutcome,
  type GetFigmaCommentsParams,
  type GetFigmaDataParams,
} from "./tools/index.js";

/**
 * Where download_figma_images puts images. `none` doesn't offer it; `refused` offers it only to
 * explain, when called, that this caller may not write to the server's disk.
 */
export type ImageOutput =
  | { kind: "none" }
  | { kind: "refused" }
  | { kind: "disk"; imageDir: string }
  | { kind: "destination"; destination: ImageDestination; retentionDays: number };

/**
 * Runs around every read-tool call: the host admits or refuses the call here (rate limit,
 * concurrency). A refusal is an ordinary tool result the agent can read and act on.
 */
export type ToolCallGuard = (run: () => Promise<CallToolResult>) => Promise<CallToolResult>;

/** How a read-tool call ended, raw: errors and inputs included. Facts are the tool's own outcome. */
export type ReadToolOutcome =
  | ToolCallObservation<"get_figma_data", GetFigmaDataOutcome>
  | ToolCallObservation<"get_figma_comments", GetFigmaCommentsOutcome>
  | ToolCallObservation<"download_figma_images", DownloadImagesOutcome>;

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

/**
 * Registers the read tools; returns get_figma_data's handle so a composition can re-describe it.
 * Each call runs on the service scoped to its own signal, so a client's cancellation stops that
 * call's Figma reads, enrichment fetches and image downloads.
 */
export function registerReadTools(
  server: McpServer,
  figmaService: FigmaService,
  options: RegisterReadToolsOptions,
): { getFigmaData: RegisteredTool } {
  const { images, observe } = options;
  const guard: ToolCallGuard = options.guardToolCall ?? ((run) => run());

  const getFigmaData = registerFramelinkTool(
    server,
    {
      name: getFigmaDataTool.name,
      title: "Get Figma Data",
      description: getFigmaDataTool.description,
      inputSchema: getFigmaDataTool.parametersSchema,
      unknownParams: "strip",
      annotations: READ_ANNOTATIONS,
      handler: (
        params: GetFigmaDataParams,
        call: FramelinkToolCall<GetFigmaDataOutcome>,
        extra: ToolExtra,
      ) =>
        guard(() =>
          getFigmaDataTool.handler(params, figmaService.withSignal(extra.signal), {
            outputFormat: options.outputFormat,
            describeRecovery: options.describeReadRecovery,
            onComplete: call.record,
            extra,
          }),
        ),
    },
    observe,
  );

  registerFramelinkTool(
    server,
    {
      name: getFigmaCommentsTool.name,
      title: "Get Figma Comments",
      description: getFigmaCommentsTool.description,
      inputSchema: getFigmaCommentsTool.parameters,
      unknownParams: "strip",
      annotations: READ_ANNOTATIONS,
      handler: (
        params: GetFigmaCommentsParams,
        call: FramelinkToolCall<GetFigmaCommentsOutcome>,
        extra: ToolExtra,
      ) =>
        guard(() =>
          getFigmaCommentsTool.handler(params, figmaService.withSignal(extra.signal), {
            onComplete: call.record,
          }),
        ),
    },
    observe,
  );

  if (images.kind === "disk") {
    registerFramelinkTool(
      server,
      {
        name: downloadFigmaImagesTool.name,
        title: "Download Figma Images",
        description: downloadFigmaImagesTool.getDescription(images.imageDir),
        inputSchema: downloadFigmaImagesTool.parametersSchema,
        unknownParams: "strip",
        annotations: DISK_DOWNLOAD_ANNOTATIONS,
        handler: (
          params: DownloadImagesParams,
          call: FramelinkToolCall<DownloadImagesOutcome>,
          extra: ToolExtra,
        ) =>
          guard(() =>
            downloadFigmaImagesTool.handler(params, figmaService.withSignal(extra.signal), {
              imageDir: images.imageDir,
              extra,
              onComplete: call.record,
              onReject: call.reject,
            }),
          ),
      },
      observe,
    );
  } else if (images.kind === "refused") {
    registerFramelinkTool(
      server,
      {
        name: downloadFigmaImagesTool.name,
        title: "Download Figma Images",
        description: downloadFigmaImagesTool.refusedDescription,
        inputSchema: {},
        unknownParams: "strip",
        annotations: READ_ANNOTATIONS,
        handler: async (_params: object, _call: FramelinkToolCall<DownloadImagesOutcome>) =>
          downloadFigmaImagesTool.refusedReply(),
      },
      observe,
    );
  } else if (images.kind === "destination") {
    registerFramelinkTool(
      server,
      {
        name: downloadFigmaImageDestinationTool.name,
        title: "Download Figma Images",
        description: downloadFigmaImageDestinationTool.getDescription(images.retentionDays),
        inputSchema: downloadFigmaImageDestinationTool.parametersSchema,
        unknownParams: "strip",
        // Exports into the host's own storage: nothing of the user's changes.
        annotations: READ_ANNOTATIONS,
        handler: (
          params: DownloadImageDestinationParams,
          call: FramelinkToolCall<DownloadImagesOutcome>,
          extra: ToolExtra,
        ) =>
          guard(() =>
            downloadFigmaImageDestinationTool.handler(
              params,
              figmaService.withSignal(extra.signal),
              { destination: images.destination, extra, onComplete: call.record },
            ),
          ),
      },
      observe,
    );
  }

  return { getFigmaData };
}
