import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService, type FigmaAuthOptions } from "../services/figma.js";
import { Logger } from "../utils/logger.js";
import type { AuthMode, Transport } from "../services/telemetry.js";
import type { ToolExtra } from "./progress.js";
import {
  downloadFigmaImagesTool,
  getFigmaDataTool,
  type DownloadImagesParams,
  type GetFigmaDataParams,
} from "./tools/index.js";

const serverInfo = {
  name: "Figma MCP Server",
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
  description:
    "Gives AI coding agents access to Figma design data, providing layout, styling, and content information for implementing designs.",
};

type ServerTransport = Extract<Transport, "stdio" | "http">;

type CreateServerOptions = {
  transport: ServerTransport;
  outputFormat?: "yaml" | "json";
  skipImageDownloads?: boolean;
  imageDir?: string;
};

function createServer(
  authOptions: FigmaAuthOptions,
  { transport, outputFormat = "yaml", skipImageDownloads = false, imageDir }: CreateServerOptions,
) {
  const server = new McpServer(serverInfo);
  const figmaService = new FigmaService(authOptions);
  const authMode: AuthMode = authOptions.useOAuth ? "oauth" : "api_key";
  registerTools(server, figmaService, {
    transport,
    authMode,
    outputFormat,
    skipImageDownloads,
    imageDir,
  });

  Logger.isHTTP = transport !== "stdio";

  return server;
}

function registerTools(
  server: McpServer,
  figmaService: FigmaService,
  options: {
    transport: ServerTransport;
    authMode: AuthMode;
    outputFormat: "yaml" | "json";
    skipImageDownloads: boolean;
    imageDir?: string;
  },
): void {
  server.registerTool(
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
        extra,
      ),
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
          options.outputFormat,
          options.transport,
          options.authMode,
          extra,
        ),
    );
  }
}

export { createServer };
