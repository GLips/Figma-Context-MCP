import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { FigmaService, type FigmaAuthOptions } from "../services/figma.js";
import { Logger } from "../utils/logger.js";
import { authMode, type AuthMode, type ClientInfo, type Transport } from "~/telemetry/index.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { installValidationRejectCapture } from "./validation-capture.js";
import type { ToolExtra } from "./progress.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import { registerCodeModeTools } from "~/commercial/tools/code-mode-tools.js";
import {
  advertisePluginReadRoute,
  describePluginReadRecovery,
} from "~/commercial/tools/plugin-read-route.js";
import type { ImageDestination } from "~/utils/image-processing.js";
import {
  downloadFigmaImageLinksTool,
  downloadFigmaImagesTool,
  getFigmaCommentsTool,
  getFigmaDataTool,
  type DownloadImageLinksParams,
  type DownloadImagesParams,
  type GetFigmaCommentsParams,
  type GetFigmaDataParams,
} from "./tools/index.js";

export const serverInfo = {
  name: "Figma MCP Server",
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
  description:
    "Gives AI coding agents access to Figma design data, providing layout, styling, and content information for implementing designs.",
};

export type ServerTransport = Extract<Transport, "stdio" | "http" | "hosted">;

export type CreateServerOptions = {
  transport: ServerTransport;
  outputFormat?: OutputFormat;
  skipImageDownloads?: boolean;
  imageDir?: string;
  /**
   * The process-wide WS relay to the Figma plugin (started once by `startServer`). When present,
   * the code-mode write tools are registered — advertised dynamically once a plugin connects — and
   * get_figma_data's description and failures point at the plugin read route.
   * Absent for library consumers of `createServer`, which get the read-only surface unchanged.
   */
  pluginBridge?: PluginBridgeRuntime;
  /** Force the code-mode tools to be advertised from startup (`--code-mode`). */
  codeMode?: boolean;
};

function createServer(
  authOptions: FigmaAuthOptions,
  {
    transport,
    outputFormat = "tree",
    skipImageDownloads = false,
    imageDir,
    pluginBridge,
    codeMode = false,
  }: CreateServerOptions,
) {
  const server = new McpServer(serverInfo);
  const figmaService = new FigmaService(authOptions);
  const mode = authMode(authOptions);

  const getClientInfo = clientInfoReader(server);

  registerReadTools(server, figmaService, {
    transport,
    authMode: mode,
    outputFormat,
    images: skipImageDownloads ? { kind: "none" } : { kind: "disk", imageDir },
    getClientInfo,
    pluginBridge,
  });

  if (pluginBridge) {
    registerCodeModeTools(server, pluginBridge, { codeMode, transport, figmaService });
  }

  installValidationRejectCapture(server, {
    transport,
    authMode: mode,
    outputFormat,
    getClientInfo,
  });

  Logger.isHTTP = transport !== "stdio";

  return server;
}

export function clientInfoReader(server: McpServer): () => ClientInfo | undefined {
  return () => {
    const info = server.server.getClientVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  };
}

/** Where download_figma_images puts images, or that it isn't offered at all. */
export type ImageOutput =
  | { kind: "none" }
  | { kind: "disk"; imageDir?: string }
  | { kind: "links"; destination: ImageDestination; retentionDays: number };

/**
 * Runs around every read-tool call. Hosted mode admits or refuses the call here (rate limit,
 * concurrency); a refusal is an ordinary tool error the agent can read and act on.
 */
export type ToolCallGuard = (run: () => Promise<CallToolResult>) => Promise<CallToolResult>;

export type RegisterReadToolsOptions = {
  transport: ServerTransport;
  authMode: AuthMode;
  outputFormat: OutputFormat;
  images: ImageOutput;
  getClientInfo: () => ClientInfo | undefined;
  pluginBridge?: PluginBridgeRuntime;
  guardToolCall?: ToolCallGuard;
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

export function registerReadTools(
  server: McpServer,
  figmaService: FigmaService,
  options: RegisterReadToolsOptions,
): void {
  const { pluginBridge, images } = options;
  const guard: ToolCallGuard = options.guardToolCall ?? ((run) => run());
  const toolContext = () => ({
    transport: options.transport,
    authMode: options.authMode,
    clientInfo: options.getClientInfo(),
  });

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
        getFigmaDataTool.handler(
          params,
          figmaService,
          options.outputFormat,
          options.transport,
          options.authMode,
          options.getClientInfo(),
          pluginBridge &&
            ((error, request) => describePluginReadRecovery(pluginBridge, error, request)),
          extra,
        ),
      ),
  );
  if (pluginBridge) {
    advertisePluginReadRoute(getFigmaData, pluginBridge, {
      baseDescription: getFigmaDataTool.description,
      transport: options.transport,
    });
  }

  server.registerTool(
    getFigmaCommentsTool.name,
    {
      title: "Get Figma Comments",
      description: getFigmaCommentsTool.description,
      inputSchema: getFigmaCommentsTool.parameters,
      annotations: READ_ANNOTATIONS,
    },
    (params: GetFigmaCommentsParams) =>
      guard(() => getFigmaCommentsTool.handler(params, figmaService)),
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
          downloadFigmaImagesTool.handler(
            params,
            figmaService,
            images.imageDir,
            options.transport,
            options.authMode,
            options.getClientInfo(),
            extra,
          ),
        ),
    );
  } else if (images.kind === "links") {
    server.registerTool(
      downloadFigmaImageLinksTool.name,
      {
        title: "Download Figma Images",
        description: downloadFigmaImageLinksTool.getDescription(images.retentionDays),
        inputSchema: downloadFigmaImageLinksTool.parametersSchema,
        // Exports into the server's own storage: nothing of the user's changes.
        annotations: READ_ANNOTATIONS,
      },
      (params: DownloadImageLinksParams, extra: ToolExtra) =>
        guard(() =>
          downloadFigmaImageLinksTool.handler(
            params,
            figmaService,
            images.destination,
            toolContext(),
            extra,
          ),
        ),
    );
  }
}

export { createServer };
