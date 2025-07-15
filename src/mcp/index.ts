import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { FigmaService, type FigmaAuthOptions } from "../services/figma.js";
import { Logger } from "../utils/logger.js";
import { createGetFigmaDataTool, createDownloadFigmaImagesTool } from "./tools/index.js";

const serverInfo = {
  name: "Figma MCP Server",
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
};

type CreateServerOptions = {
  isHTTP?: boolean;
  outputFormat?: "yaml" | "json";
};

export type ToolDefinition<
  Args extends ZodRawShape,
  RegisterOptions extends Record<string, any> = {},
> = {
  name: string;
  description: string;
  parameters: Args;
  handler: (options?: RegisterOptions) => ToolCallback<Args>;
  register: (server: McpServer) => RegisteredTool;
};

function createServer(
  authOptions: FigmaAuthOptions,
  { isHTTP = false, outputFormat = "yaml" }: CreateServerOptions = {},
) {
  const server = new McpServer(serverInfo);
  // const figmaService = new FigmaService(figmaApiKey);
  const figmaService = new FigmaService(authOptions);
  registerTools(server, figmaService, outputFormat);

  Logger.isHTTP = isHTTP;

  return server;
}

function registerTools(
  server: McpServer,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
): void {
  // Create and register get_figma_data tool
  const getFigmaDataTool = createGetFigmaDataTool({ figmaService, outputFormat });
  getFigmaDataTool.register(server);

  // TODO: Clean up all image download related code, particularly getImages in Figma service
  // Create and register download_figma_images tool
  const downloadFigmaImagesTool = createDownloadFigmaImagesTool({ figmaService });
  downloadFigmaImagesTool.register(server);
}

export { createServer };
