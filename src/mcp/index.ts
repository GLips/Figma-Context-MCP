import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FigmaService, staticCredentialSource } from "../services/figma.js";
import {
  authMode,
  captureFeedbackWatchCall,
  captureObservedCall,
  captureReadToolCall,
  type ToolCallContext,
  type ToolEventProperties,
  type Transport,
} from "~/telemetry/index.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { registerReadTools } from "./read-tools.js";
import { registerFeedbackWatchTool } from "./feedback-watch-tool.js";
import { registerReportIssueTool } from "./report-issue-tool.js";
import type { AnnotationChangeSource } from "~/services/watch-figma-feedback.js";
import { askAgentsForUserGoal, type ObserveToolCall } from "./framelink-tool.js";
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
  /**
   * Telemetry records this server's calls. Only then does every tool take an optional `userGoal`
   * (worth its tokens only when recorded) and report_framelink_issue exist (a report is telemetry).
   */
  telemetry?: boolean;
  extensions?: readonly ServerExtension<Caller>[];
};

function createServer<Caller extends CallerContext>(
  caller: Caller,
  {
    transport,
    outputFormat = "tree",
    skipImageDownloads = false,
    telemetry = false,
    extensions = [],
  }: CreateServerOptions<Caller>,
) {
  const server = new McpServer(serverInfo);
  // Before any tool registers: it decides each tool's schema.
  if (telemetry) askAgentsForUserGoal(server);
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
    observe: (outcome) => captureReadToolCall(outcome, context),
    describeReadRecovery: recoveries.length
      ? (error, request) =>
          recoveries.map((describe) => describe(error, request)).find((text) => text !== null) ??
          null
      : undefined,
  });

  const annotationSources = extensions.flatMap(
    (extension) => extension.annotationChanges?.(caller) ?? [],
  );
  registerFeedbackWatchTool(server, figmaService, annotationSources[0] ?? null, (observation) =>
    captureFeedbackWatchCall(observation, context),
  );

  if (telemetry)
    registerReportIssueTool(server, context, (observation) =>
      captureObservedCall(observation, context),
    );

  for (const extension of extensions)
    extension.register(server, {
      transport,
      caller,
      figmaService,
      getFigmaData,
      observe: (observation) => captureObservedCall(observation, context),
    });

  return server;
}

export { createServer };
