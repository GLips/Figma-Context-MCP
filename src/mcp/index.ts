import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService, type FigmaAuthOptions } from "../services/figma.js";
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
import {
  downloadFigmaImagesTool,
  getFigmaCommentsTool,
  getFigmaDataTool,
  type DownloadImagesParams,
  type GetFigmaCommentsParams,
  type GetFigmaDataParams,
} from "./tools/index.js";

const serverInfo = {
  name: "Figma MCP Server",
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
  description:
    "Gives AI coding agents access to Figma design data, providing layout, styling, and content information for implementing designs.",
};

export type ServerTransport = Extract<Transport, "stdio" | "http">;

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

  const getClientInfo = (): ClientInfo | undefined => {
    const info = server.server.getClientVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  };

  registerTools(server, figmaService, {
    transport,
    authMode: mode,
    outputFormat,
    skipImageDownloads,
    imageDir,
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

  return server;
}

type RegisterToolsOptions = {
  transport: ServerTransport;
  authMode: AuthMode;
  outputFormat: OutputFormat;
  skipImageDownloads: boolean;
  imageDir?: string;
  getClientInfo: () => ClientInfo | undefined;
  pluginBridge?: PluginBridgeRuntime;
};

function registerTools(
  server: McpServer,
  figmaService: FigmaService,
  options: RegisterToolsOptions,
): void {
  const { pluginBridge } = options;
  const getFigmaData = server.registerTool(
    getFigmaDataTool.name,
    {
      title: "Get Figma Data",
      description: getFigmaDataTool.description,
      inputSchema: getFigmaDataTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetFigmaDataParams, extra: ToolExtra) =>
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
      annotations: { readOnlyHint: true },
    },
    (params: GetFigmaCommentsParams) => getFigmaCommentsTool.handler(params, figmaService),
  );

  if (!options.skipImageDownloads) {
    server.registerTool(
      downloadFigmaImagesTool.name,
      {
        title: "Download Figma Images",
        description: downloadFigmaImagesTool.getDescription(options.imageDir),
        inputSchema: downloadFigmaImagesTool.parametersSchema,
        annotations: { openWorldHint: true },
      },
      (params: DownloadImagesParams, extra: ToolExtra) =>
        downloadFigmaImagesTool.handler(
          params,
          figmaService,
          options.imageDir,
          options.transport,
          options.authMode,
          options.getClientInfo(),
          extra,
        ),
    );
  }
}

export { createServer };
