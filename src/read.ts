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
  /** Resolved on the first Figma call of a tool, never on `initialize` or `tools/list`. */
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
  const figmaService = new FigmaService(
    {
      async resolve(opts) {
        const credential = await credentials.resolve(opts);
        addRequestSecret(credential.token);
        return credential;
      },
      invalidate: () => credentials.invalidate(),
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
  if (outcome.kind === "rejected") {
    return {
      tool: outcome.tool,
      outcome: "rejected",
      durationMs: 0,
      errorCategory: "invalid_input",
    };
  }
  const { error, durationMs } = outcome.outcome;
  const base = {
    tool: outcome.tool,
    durationMs,
    outcome: error === undefined ? ("ok" as const) : ("error" as const),
    ...errorFields(error),
  };
  switch (outcome.tool) {
    case "get_figma_data":
      return {
        ...base,
        rawSizeKb: outcome.outcome.metrics?.rawSizeKb,
        simplifiedSizeKb: outcome.outcome.metrics?.simplifiedSizeKb,
      };
    case "download_figma_images":
      return {
        ...base,
        imageCount: outcome.outcome.imageCount,
        successCount: outcome.outcome.successCount,
      };
    case "get_figma_comments":
      return base;
  }
}
