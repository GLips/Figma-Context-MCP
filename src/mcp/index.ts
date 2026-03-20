import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService, type FigmaAuthOptions } from "../services/figma.js";
import { Logger } from "../utils/logger.js";
import {
  downloadFigmaImagesTool,
  getFigmaDataTool,
  whoamiTool,
  getDesignContextTool,
  getScreenshotTool,
  getVariableDefsTool,
  createDesignSystemRulesTool,
  getMetadataTool,
  getFigJamTool,
  type DownloadImagesParams,
  type GetFigmaDataParams,
  type WhoamiParams,
  type GetDesignContextParams,
  type GetScreenshotParams,
  type GetVariableDefsParams,
  type CreateDesignSystemRulesParams,
  type GetMetadataParams,
  type GetFigJamParams,
} from "./tools/index.js";

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
};

function createServer(
  authOptions: FigmaAuthOptions,
  { isHTTP = false, outputFormat = "yaml", skipImageDownloads = false }: CreateServerOptions = {},
) {
  const server = new McpServer(serverInfo);
  const figmaService = new FigmaService(authOptions);
  registerTools(server, figmaService, { outputFormat, skipImageDownloads });

  Logger.isHTTP = isHTTP;

  return server;
}

function registerTools(
  server: McpServer,
  figmaService: FigmaService,
  options: {
    outputFormat: "yaml" | "json";
    skipImageDownloads: boolean;
  },
): void {
  // Existing tools
  server.registerTool(
    getFigmaDataTool.name,
    {
      title: "Get Figma Data",
      description: getFigmaDataTool.description,
      inputSchema: getFigmaDataTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetFigmaDataParams) =>
      getFigmaDataTool.handler(params, figmaService, options.outputFormat),
  );

  if (!options.skipImageDownloads) {
    server.registerTool(
      downloadFigmaImagesTool.name,
      {
        title: "Download Figma Images",
        description: downloadFigmaImagesTool.description,
        inputSchema: downloadFigmaImagesTool.parametersSchema,
        annotations: { openWorldHint: true },
      },
      (params: DownloadImagesParams) => downloadFigmaImagesTool.handler(params, figmaService),
    );
  }

  // Phase 1 tools
  server.registerTool(
    whoamiTool.name,
    {
      title: "Who Am I",
      description: whoamiTool.description,
      inputSchema: whoamiTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: WhoamiParams) => whoamiTool.handler(params, figmaService, options.outputFormat),
  );

  server.registerTool(
    getDesignContextTool.name,
    {
      title: "Get Design Context",
      description: getDesignContextTool.description,
      inputSchema: getDesignContextTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetDesignContextParams) =>
      getDesignContextTool.handler(params, figmaService, options.outputFormat),
  );

  server.registerTool(
    getScreenshotTool.name,
    {
      title: "Get Screenshot",
      description: getScreenshotTool.description,
      inputSchema: getScreenshotTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetScreenshotParams) => getScreenshotTool.handler(params, figmaService),
  );

  server.registerTool(
    getVariableDefsTool.name,
    {
      title: "Get Variable Definitions",
      description: getVariableDefsTool.description,
      inputSchema: getVariableDefsTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetVariableDefsParams) =>
      getVariableDefsTool.handler(params, figmaService, options.outputFormat),
  );

  server.registerTool(
    createDesignSystemRulesTool.name,
    {
      title: "Create Design System Rules",
      description: createDesignSystemRulesTool.description,
      inputSchema: createDesignSystemRulesTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: CreateDesignSystemRulesParams) => createDesignSystemRulesTool.handler(params),
  );

  server.registerTool(
    getMetadataTool.name,
    {
      title: "Get Metadata",
      description: getMetadataTool.description,
      inputSchema: getMetadataTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetMetadataParams) => getMetadataTool.handler(params, figmaService),
  );

  // Phase 2 tools
  server.registerTool(
    getFigJamTool.name,
    {
      title: "Get FigJam",
      description: getFigJamTool.description,
      inputSchema: getFigJamTool.parametersSchema,
      annotations: { readOnlyHint: true },
    },
    (params: GetFigJamParams) => getFigJamTool.handler(params, figmaService),
  );
}

export { createServer };
