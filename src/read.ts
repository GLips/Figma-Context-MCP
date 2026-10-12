/**
 * `figma-developer-mcp/read` — the read tools (get_figma_data, get_figma_comments,
 * download_figma_images) as an MCP server any process can host, with credentials, image storage,
 * cancellation and limits injected by the host.
 *
 * It knows nothing of who the host's users are or how it authenticates them. Importing it has no
 * side effects: no listeners, signal handlers, global dispatcher, telemetry or logging. Its import
 * graph never reaches the local server, config parsing, telemetry or commercial code — enforced by
 * scripts/check-read-entry.mjs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { serverInfo } from "~/mcp/server-info.js";
import {
  registerReadTools,
  type ImageOutput,
  type ReadToolOutcome,
  type ToolCallGuard,
} from "~/mcp/read-tools.js";
import {
  FigmaService,
  type FigmaCredential,
  type FigmaCredentialSource,
} from "~/services/figma.js";
import { getErrorMeta, type ErrorCategory } from "~/utils/error-meta.js";
import type { ImageDestination, ImageLimits, ImageLocation } from "~/utils/image-processing.js";
import {
  addRequestSecret,
  redactRequestSecrets,
  withRequestSecrets,
} from "~/utils/request-secrets.js";
import type { OutputFormat } from "~/utils/serialize.js";

export type {
  ErrorCategory,
  FigmaCredential,
  FigmaCredentialSource,
  ImageDestination,
  ImageLimits,
  ImageLocation,
  ImageOutput,
  OutputFormat,
  ToolCallGuard,
};

export type ReadServerOptions = {
  /**
   * Resolved on the first Figma call of a tool, never on `initialize` or `tools/list`, and then
   * reused by every Figma call this server makes until it is invalidated or a resolve rejects.
   */
  credentials: FigmaCredentialSource;
  /**
   * `destination` drops `localPath` from download_figma_images and reports each image's location
   * (a link, typically) as the destination returns it; `retentionDays` is how long it promises
   * the agent the links last.
   */
  images: ImageOutput;
  /** A deadline or a client gone: aborts every Figma call, image download and image store. */
  signal?: AbortSignal;
  limits?: {
    /** Largest Figma API response accepted, counted while streaming. */
    maxResponseBytes?: number;
    image?: ImageLimits;
  };
  /** Wraps every tool call: the host's admission and rate limits. */
  guardToolCall?: ToolCallGuard;
  /** get_figma_data's output format. Default `tree`, the most compact. */
  outputFormat?: OutputFormat;
  /** Called once per finished tool call. Throwing here never affects the call. */
  observe?: (event: ReadToolObservation) => void;
};

/** One finished read-tool call, sanitized: no error messages, arguments or identifiers. */
export type ReadToolObservation = {
  tool: "get_figma_data" | "get_figma_comments" | "download_figma_images";
  /** `rejected`: the call's arguments failed a check its schema can't express. */
  outcome: "ok" | "error" | "rejected";
  durationMs: number;
  errorCategory?: ErrorCategory;
  httpStatus?: number;
  /** get_figma_data: the Figma response and the simplified output, in KB. */
  rawSizeKb?: number;
  simplifiedSizeKb?: number;
  /** download_figma_images */
  imageCount?: number;
  successCount?: number;
};

/** One server per MCP request: it holds that request's credential source, signal and limits. */
export function createReadServer(options: ReadServerOptions): McpServer {
  const { credentials, limits, observe } = options;
  const server = new McpServer(serverInfo);
  // One get_figma_data call fans out into several Figma requests, some concurrent; they share one
  // host resolve. A rejected resolve is dropped so the next call asks again.
  let pending: Promise<FigmaCredential> | undefined;
  const resolveOnce = (signal: AbortSignal): Promise<FigmaCredential> => {
    const attempt = (pending ??= credentials.resolve({ signal }));
    attempt.catch(() => {
      if (pending === attempt) pending = undefined;
    });
    return attempt;
  };
  const figmaService = new FigmaService(
    {
      async resolve() {
        const credential = await resolveOnce(options.signal ?? new AbortController().signal);
        // Each tool call opens its own secret scope, so every call that uses the credential adds it.
        addRequestSecret(credential.token);
        return credential;
      },
      invalidate() {
        pending = undefined;
        credentials.invalidate();
      },
    },
    {
      signal: options.signal,
      maxResponseBytes: limits?.maxResponseBytes,
      images: limits?.image,
    },
  );
  const hostGuard: ToolCallGuard = options.guardToolCall ?? ((run) => run());

  registerReadTools(server, figmaService, {
    outputFormat: options.outputFormat ?? "tree",
    images: options.images,
    observe: (outcome) => {
      try {
        observe?.(toReadToolObservation(outcome));
      } catch {
        // A host's observer must never turn a finished call into a failed one.
      }
    },
    // The secret scope is outermost so the credential, learned mid-call, is redacted from
    // whatever the call returns — the host guard's own refusals included.
    guardToolCall: (run) =>
      withRequestSecrets([], async () => redactToolResult(await hostGuard(run))),
  });

  return server;
}

function redactToolResult(result: CallToolResult): CallToolResult {
  return {
    ...result,
    content: result.content.map((item) =>
      item.type === "text" ? { ...item, text: redactRequestSecrets(item.text) } : item,
    ),
  };
}

function errorFields(error: unknown): Pick<ReadToolObservation, "errorCategory" | "httpStatus"> {
  if (error === undefined) return {};
  const { category, http_status } = getErrorMeta(error);
  return { errorCategory: category, httpStatus: http_status };
}

function toReadToolObservation(outcome: ReadToolOutcome): ReadToolObservation {
  const { tool, durationMs } = outcome;
  if (outcome.kind === "rejected")
    return { tool, outcome: "rejected", durationMs, errorCategory: "invalid_input" };
  if (outcome.kind === "threw")
    return { tool, outcome: "error", durationMs, ...errorFields(outcome.error) };
  // A call that failed before its pipeline ran (a malformed key the schema let through) has no facts.
  if (!outcome.facts) return { tool, outcome: outcome.isError ? "error" : "ok", durationMs };
  const { error } = outcome.facts;
  const base = {
    tool,
    durationMs: outcome.facts.durationMs,
    outcome: error === undefined ? ("ok" as const) : ("error" as const),
    ...errorFields(error),
  };
  switch (outcome.tool) {
    case "get_figma_data":
      return {
        ...base,
        rawSizeKb: outcome.facts.metrics?.rawSizeKb,
        simplifiedSizeKb: outcome.facts.metrics?.simplifiedSizeKb,
      };
    case "download_figma_images":
      return {
        ...base,
        imageCount: outcome.facts.imageCount,
        successCount: outcome.facts.successCount,
      };
    case "get_figma_comments":
      return base;
  }
}
