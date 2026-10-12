import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService, staticCredentialSource, type FigmaCredential } from "../services/figma.js";
import {
  authMode,
  captureDownloadImagesCall,
  captureGetFigmaDataCall,
  captureToolCall,
  type ToolCallContext,
  type ToolCallEvent,
  type ToolEventProperties,
  type Transport,
} from "~/telemetry/index.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { registerReadTools, type ReadToolOutcome } from "./read-tools.js";
import type { ObserveToolCall, ToolCallObservation } from "./framelink-tool.js";
import type { DescribeReadRecovery } from "./tools/index.js";
import { serverInfo } from "./server-info.js";

export type ServerTransport = Extract<Transport, "stdio" | "http">;

/** What an extension's tools are built from, fixed for the server's lifetime. */
export interface ServerExtensionContext {
  transport: ServerTransport;
  /** This server's Figma client: an HTTP request's own credential, or the process's. */
  figmaService: FigmaService;
  /** get_figma_data's handle, for an extension that re-describes it. */
  getFigmaData: RegisteredTool;
  /** Reports the extension's tools exactly as the built-in ones are reported. */
  observe: ObserveToolCall<string, ToolEventProperties>;
}

/**
 * Tools and read hooks added to the MIT read server from outside it — the open-core seam. The
 * composition root (server.ts) passes the commercial code-mode extension; library consumers of
 * `createServer` pass none and get the read-only surface.
 */
export interface ServerExtension {
  /** Guidance appended to a failed get_figma_data: another way to get the same data. */
  describeReadRecovery?: DescribeReadRecovery;
  register(server: McpServer, context: ServerExtensionContext): void;
}

export type CreateServerOptions = {
  transport: ServerTransport;
  outputFormat?: OutputFormat;
  skipImageDownloads?: boolean;
  imageDir?: string;
  extensions?: readonly ServerExtension[];
};

function createServer(
  /** Absent: an HTTP request with no credential to a server with none; Figma calls fail asking for one. */
  credential: FigmaCredential | undefined,
  {
    transport,
    outputFormat = "tree",
    skipImageDownloads = false,
    imageDir,
    extensions = [],
  }: CreateServerOptions,
) {
  const server = new McpServer(serverInfo);
  const figmaService = new FigmaService(staticCredentialSource(credential));
  const context: ToolCallContext = {
    transport,
    authMode: authMode(credential),
    get clientInfo() {
      const info = server.server.getClientVersion();
      return info && { name: info.name, version: info.version };
    },
  };

  const recoveries = extensions.flatMap((extension) => extension.describeReadRecovery ?? []);
  const { getFigmaData } = registerReadTools(server, figmaService, {
    outputFormat,
    images: skipImageDownloads ? { kind: "none" } : { kind: "disk", imageDir },
    observe: (outcome) => captureReadToolOutcome(outcome, context),
    describeReadRecovery: recoveries.length
      ? (error, request) =>
          recoveries.map((describe) => describe(error, request)).find((text) => text !== null) ??
          null
      : undefined,
  });

  for (const extension of extensions)
    extension.register(server, {
      transport,
      figmaService,
      getFigmaData,
      observe: (observation) =>
        captureToolCall(
          toolCallEvent(
            observation,
            observation.kind === "rejected" ? undefined : observation.facts,
          ),
          context,
        ),
    });

  return server;
}

function captureReadToolOutcome(outcome: ReadToolOutcome, context: ToolCallContext): void {
  if (outcome.kind !== "completed" || !outcome.facts) {
    captureToolCall(toolCallEvent(outcome), context);
    return;
  }
  switch (outcome.tool) {
    case "get_figma_data":
      return captureGetFigmaDataCall(outcome.facts, context);
    case "download_figma_images":
      return captureDownloadImagesCall(outcome.facts, context);
    case "get_figma_comments": {
      const { durationMs, error } = outcome.facts;
      return captureToolCall(
        { tool: outcome.tool, durationMs, isError: error !== undefined, error },
        context,
      );
    }
  }
}

/** A call reported from what the seam saw; an extension's recorded facts are its properties. */
function toolCallEvent(
  observation: ToolCallObservation<string, unknown>,
  properties?: ToolEventProperties,
): ToolCallEvent {
  const { tool, durationMs } = observation;
  switch (observation.kind) {
    case "rejected":
      return { tool, durationMs, isError: true, rejection: observation.rejection };
    case "threw":
      return { tool, durationMs, isError: true, error: observation.error, properties };
    case "completed":
      return { tool, durationMs, isError: observation.isError, properties };
  }
}

export { createServer };
