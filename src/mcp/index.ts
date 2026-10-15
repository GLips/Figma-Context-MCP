import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService, staticCredentialSource } from "../services/figma.js";
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
import type { CallerContext } from "./caller-context.js";

export type { CallerContext };

export type ServerTransport = Extract<Transport, "stdio" | "http">;

/** What an extension's tools are built from, fixed for the server's lifetime. */
export interface ServerExtensionContext<Caller extends CallerContext = CallerContext> {
  transport: ServerTransport;
  /** Everything the tools may spend; an extension reads its own grants from here, never a global. */
  caller: Caller;
  /** This server's Figma client, spending the caller's credential. */
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
export interface ServerExtension<Caller extends CallerContext = CallerContext> {
  /** Guidance appended to a failed get_figma_data for this caller: another way to get the same data. */
  describeReadRecovery?(caller: Caller): DescribeReadRecovery | null;
  register(server: McpServer, context: ServerExtensionContext<Caller>): void;
}

/** How the server is configured, the same for every caller. */
export type CreateServerOptions<Caller extends CallerContext = CallerContext> = {
  transport: ServerTransport;
  outputFormat?: OutputFormat;
  /** Don't offer download_figma_images at all, to any caller. */
  skipImageDownloads?: boolean;
  extensions?: readonly ServerExtension<Caller>[];
};

function createServer<Caller extends CallerContext>(
  caller: Caller,
  {
    transport,
    outputFormat = "tree",
    skipImageDownloads = false,
    extensions = [],
  }: CreateServerOptions<Caller>,
) {
  const server = new McpServer(serverInfo);
  const figmaService = new FigmaService(staticCredentialSource(caller.credential));
  const context: ToolCallContext = {
    transport,
    authMode: authMode(caller.credential),
    get clientInfo() {
      const info = server.server.getClientVersion();
      return info && { name: info.name, version: info.version };
    },
  };

  const recoveries = extensions.flatMap(
    (extension) => extension.describeReadRecovery?.(caller) ?? [],
  );
  const { getFigmaData } = registerReadTools(server, figmaService, {
    outputFormat,
    images: skipImageDownloads
      ? { kind: "none" }
      : caller.imageDir === null
        ? { kind: "refused" }
        : { kind: "disk", imageDir: caller.imageDir },
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
      caller,
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
