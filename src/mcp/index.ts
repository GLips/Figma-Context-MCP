import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { FigmaService, type FigmaAuthOptions } from "../services/figma.js";
import { Logger } from "../utils/logger.js";
import {
  downloadFigmaImagesTool,
  getFigmaDataTool,
  type DownloadImagesParams,
  type GetFigmaDataParams,
} from "./tools/index.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Send a progress notification if the client requested one via progressToken.
 * No-ops silently when the client didn't ask for progress.
 */
export async function sendProgress(
  extra: ToolExtra,
  progress: number,
  total?: number,
  message?: string,
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;

  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken, progress, total, message },
  });
}

const serverInfo = {
  name: "Figma MCP Server",
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
  description:
    "Gives AI coding agents access to Figma design data, providing layout, styling, and content information for implementing designs.",
};

type CreateServerOptions = {
  isHTTP?: boolean;
  outputFormat?: "yaml" | "json";
  skipImageDownloads?: boolean;
  imageDir?: string;
};

function createServer(
  authOptions: FigmaAuthOptions,
  {
    isHTTP = false,
    outputFormat = "yaml",
    skipImageDownloads = false,
    imageDir,
  }: CreateServerOptions = {},
) {
  const server = new McpServer(serverInfo);
  const figmaService = new FigmaService(authOptions);
  registerTools(server, figmaService, { outputFormat, skipImageDownloads, imageDir });

  Logger.isHTTP = isHTTP;

  return server;
}

function registerTools(
  server: McpServer,
  figmaService: FigmaService,
  options: {
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
      getFigmaDataTool.handler(params, figmaService, options.outputFormat, extra),
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
        downloadFigmaImagesTool.handler(params, figmaService, options.imageDir, extra),
    );
  }
}

export { createServer };
