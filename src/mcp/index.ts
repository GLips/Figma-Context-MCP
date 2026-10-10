import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getFigmaDataTool } from "./tools/index.js";
import { FigmaService, staticCredentialSource, type FigmaAuthOptions } from "../services/figma.js";
import { Logger } from "../utils/logger.js";
import {
  authMode,
  captureDownloadImagesCall,
  captureGetFigmaDataCall,
  captureValidationReject,
  type ClientInfo,
  type ToolCallContext,
  type Transport,
} from "~/telemetry/index.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { installValidationRejectCapture } from "./validation-capture.js";
import { registerReadTools, type ReadToolOutcome } from "./read-tools.js";
import { serverInfo } from "./server-info.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import { registerCodeModeTools } from "~/commercial/tools/code-mode-tools.js";
import {
  advertisePluginReadRoute,
  describePluginReadRecovery,
} from "~/commercial/tools/plugin-read-route.js";

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
  const figmaService = new FigmaService(staticCredentialSource(authOptions));
  const mode = authMode(authOptions);

  const getClientInfo = clientInfoReader(server);
  const callContext = (): ToolCallContext => ({
    transport,
    authMode: mode,
    clientInfo: getClientInfo(),
  });

  const { getFigmaData } = registerReadTools(server, figmaService, {
    outputFormat,
    images: skipImageDownloads ? { kind: "none" } : { kind: "disk", imageDir },
    observe: (outcome) => captureReadToolOutcome(outcome, callContext()),
    describeReadRecovery:
      pluginBridge &&
      ((error, request) => describePluginReadRecovery(pluginBridge, error, request)),
  });

  if (pluginBridge) {
    advertisePluginReadRoute(getFigmaData, pluginBridge, {
      baseDescription: getFigmaDataTool.description,
      transport,
    });
    registerCodeModeTools(server, pluginBridge, { codeMode, transport, figmaService });
  }

  installValidationRejectCapture(server, {
    transport,
    authMode: mode,
    outputFormat,
    getClientInfo,
  });

  Logger.enabled = true;
  Logger.isHTTP = transport !== "stdio";

  return server;
}

// get_figma_comments has no telemetry event of its own yet.
function captureReadToolOutcome(outcome: ReadToolOutcome, context: ToolCallContext): void {
  if (outcome.kind === "rejected") {
    const { tool, field, rule, message } = outcome;
    captureValidationReject({ tool, field, rule, message }, context);
  } else if (outcome.tool === "get_figma_data") {
    captureGetFigmaDataCall(outcome.outcome, context);
  } else if (outcome.tool === "download_figma_images") {
    captureDownloadImagesCall(outcome.outcome, context);
  }
}

export function clientInfoReader(server: McpServer): () => ClientInfo | undefined {
  return () => {
    const info = server.server.getClientVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  };
}

export { createServer };
