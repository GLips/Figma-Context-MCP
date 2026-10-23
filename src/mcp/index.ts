import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService, staticCredentialSource } from "../services/figma.js";
import {
  authMode,
  captureToolCall,
  downloadImagesCallEvent,
  getFigmaDataCallEvent,
  type ToolCallContext,
  type ToolCallEvent,
  type ToolEventProperties,
  type Transport,
} from "~/telemetry/index.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { registerReadTools, type ReadToolOutcome } from "./read-tools.js";
import { registerFeedbackWatchTool } from "./feedback-watch-tool.js";
import type { AnnotationChangeSource } from "~/services/watch-figma-feedback.js";
import {
  askAgentsForUserGoal,
  type ObserveToolCall,
  type ToolCallObservation,
} from "./framelink-tool.js";
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
  /** Where watch_figma_feedback reads annotation changes for this caller; none watches comments only. */
  annotationChanges?(caller: Caller): AnnotationChangeSource | null;
  register(server: McpServer, context: ServerExtensionContext<Caller>): void;
}

/** How the server is configured, the same for every caller. */
export type CreateServerOptions<Caller extends CallerContext = CallerContext> = {
  transport: ServerTransport;
  outputFormat?: OutputFormat;
  /** Don't offer download_figma_images at all, to any caller. */
  skipImageDownloads?: boolean;
  /** Offer every tool an optional `userGoal` param; only worth its tokens while telemetry records it. */
  askUserGoal?: boolean;
  extensions?: readonly ServerExtension<Caller>[];
};

function createServer<Caller extends CallerContext>(
  caller: Caller,
  {
    transport,
    outputFormat = "tree",
    skipImageDownloads = false,
    askUserGoal = false,
    extensions = [],
  }: CreateServerOptions<Caller>,
) {
  const server = new McpServer(serverInfo);
  // Before any tool registers: it decides each tool's schema.
  if (askUserGoal) askAgentsForUserGoal(server);
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

  const annotationSources = extensions.flatMap(
    (extension) => extension.annotationChanges?.(caller) ?? [],
  );
  registerFeedbackWatchTool(server, figmaService, annotationSources[0] ?? null, (outcome) =>
    captureToolCall(
      outcome.kind === "completed" && outcome.facts
        ? {
            tool: outcome.tool,
            durationMs: outcome.facts.durationMs,
            intent: outcome.intent,
            isError: outcome.facts.error !== undefined,
            error: outcome.facts.error,
            properties: outcome.facts.status ? { watch_status: outcome.facts.status } : undefined,
          }
        : toolCallEvent(outcome),
      context,
    ),
  );

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
  captureToolCall({ ...readToolCallEvent(outcome), intent: outcome.intent }, context);
}

function readToolCallEvent(outcome: ReadToolOutcome): ToolCallEvent {
  if (outcome.kind !== "completed" || !outcome.facts) return toolCallEvent(outcome);
  switch (outcome.tool) {
    case "get_figma_data":
      return getFigmaDataCallEvent(outcome.facts);
    case "download_figma_images":
      return downloadImagesCallEvent(outcome.facts);
    case "get_figma_comments": {
      const { durationMs, error } = outcome.facts;
      return { tool: outcome.tool, durationMs, isError: error !== undefined, error };
    }
  }
}

/** A call reported from what the seam saw; an extension's recorded facts are its properties. */
function toolCallEvent(
  observation: ToolCallObservation<string, unknown>,
  properties?: ToolEventProperties,
): ToolCallEvent {
  const { tool, durationMs, intent } = observation;
  switch (observation.kind) {
    case "rejected":
      return { tool, durationMs, intent, isError: true, rejection: observation.rejection };
    case "threw":
      return { tool, durationMs, intent, isError: true, error: observation.error, properties };
    case "completed":
      return { tool, durationMs, intent, isError: observation.isError, properties };
  }
}

export { createServer };
