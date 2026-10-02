import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService, type FigmaAuthOptions } from "../services/figma.js";
import { Logger } from "../utils/logger.js";
import { authMode, type AuthMode, type ClientInfo, type Transport } from "~/telemetry/index.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { installValidationRejectCapture } from "./validation-capture.js";
import type { ToolExtra } from "./progress.js";
import type { CachedFigmaData } from "~/services/get-figma-data.js";
import type { ImageUrlCache, ResponseCache } from "~/services/response-cache.js";
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

export type CreateServerOptions = {
  transport: ServerTransport;
  outputFormat?: OutputFormat;
  skipImageDownloads?: boolean;
  imageDir?: string;
  /**
   * Process-wide cache. HTTP mode constructs a new MCP server per request, so
   * the cache has to be owned by the process and passed in — a cache created
   * inside `createServer` would never be hit twice.
   */
  responseCache?: ResponseCache<CachedFigmaData>;
  /**
   * Same TTL as `responseCache`, for the image fill and render URL lookups.
   * Owned by the process for the same reason: HTTP builds a server per request.
   * Holds URLs only — the image bytes are downloaded on every call.
   */
  imageUrlCache?: ImageUrlCache;
};

function createServer(
  authOptions: FigmaAuthOptions,
  {
    transport,
    outputFormat = "tree",
    skipImageDownloads = false,
    imageDir,
    responseCache,
    imageUrlCache,
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
    responseCache,
    imageUrlCache,
    getClientInfo,
  });

  installValidationRejectCapture(server, {
    transport,
    authMode: mode,
    outputFormat,
    getClientInfo,
  });

  Logger.isHTTP = transport !== "stdio";

  return server;
}

type RegisterToolsOptions = {
  transport: ServerTransport;
  authMode: AuthMode;
  outputFormat: OutputFormat;
  skipImageDownloads: boolean;
  imageDir?: string;
  responseCache?: ResponseCache<CachedFigmaData>;
  imageUrlCache?: ImageUrlCache;
  getClientInfo: () => ClientInfo | undefined;
};

function registerTools(
  server: McpServer,
  figmaService: FigmaService,
  options: RegisterToolsOptions,
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
        options.getClientInfo(),
        extra,
        options.responseCache,
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
          options.transport,
          options.authMode,
          options.getClientInfo(),
          extra,
          options.imageUrlCache,
        ),
    );
  }
}

export { createServer };
