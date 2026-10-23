import { getErrorMeta } from "~/utils/error-meta.js";
import { HttpError } from "~/utils/fetch-json.js";
import type { GetFigmaDataOutcome } from "~/services/get-figma-data.js";
import type { DownloadImagesOutcome } from "~/services/download-figma-images.js";
import { captureEvent, captureUnexpectedError } from "./client.js";
import { fingerprintResponseBody } from "./response-body-fingerprint.js";
import type {
  ErrorCallProps,
  ToolCallContext,
  ToolCallEvent,
  ToolEventProperties,
} from "./types.js";

/**
 * One `tool_called` event, for any tool. Failures are reported as codes — category, status,
 * phase, the responder's fingerprint — never as the error's free text, which quotes what the user
 * sent and what servers answered. An UNEXPECTED failure (no category, or `internal`) also goes to
 * error tracking, message and stack scrubbed (client.ts), since codes can't say what broke.
 *
 * The one free text sent on purpose is the agent's stated intent (Graham, fig-138): it is the
 * agent's own summary, scrubbed like every string, and PostHog's MCP analytics groups it into
 * themes, which is the point of collecting it.
 */
export function captureToolCall(event: ToolCallEvent, context: ToolCallContext): void {
  const { tool, durationMs, isError, error, rejection, properties, intent } = event;
  const failed = isError || rejection !== undefined;
  captureEvent("tool_called", {
    ...properties,
    tool,
    duration_ms: durationMs,
    transport: context.transport,
    auth_mode: context.authMode,
    client_name: context.clientInfo?.name,
    client_version: context.clientInfo?.version,
    has_intent: intent !== undefined,
    is_error: failed,
    ...(rejection
      ? {
          error_phase: "validate",
          error_category: "invalid_input",
          validation_field: rejection.field,
          validation_rule: rejection.rule,
          validation_detail: rejection.detail,
        }
      : error === undefined
        ? {}
        : errorFields(error)),
  });
  if (intent !== undefined) captureMcpIntent(tool, intent, durationMs, failed, context);
  if (error !== undefined && isUnexpectedError(error))
    captureUnexpectedError(error, messageWithoutResponseBodies(error), {
      tool,
      transport: context.transport,
      figma_user_id:
        typeof properties?.figma_user_id === "string" ? properties.figma_user_id : undefined,
    });
}

// PostHog's MCP analytics reads `$mcp_tool_call` events keyed by `$session_id` (client.ts stamps
// it on every event) — its intent digest and clusters both query exactly these properties, so the
// event goes out only for a call that stated an intent: calls without one feed neither view.
const MAX_INTENT_LENGTH = 300;

function captureMcpIntent(
  tool: string,
  intent: string,
  durationMs: number,
  isError: boolean,
  context: ToolCallContext,
): void {
  captureEvent("$mcp_tool_call", {
    $mcp_tool_name: tool,
    // Clipped where PostHog's digest clips, so a rambling agent can't pay for an oversized event.
    $mcp_intent: intent.slice(0, MAX_INTENT_LENGTH),
    $mcp_intent_source: "context_parameter",
    $mcp_is_error: isError,
    $mcp_duration_ms: durationMs,
    $mcp_client_name: context.clientInfo?.name,
    $mcp_client_version: context.clientInfo?.version,
  });
}

/** For a caller with nothing to add to the read's own event: the `fetch` command. */
export function captureGetFigmaDataCall(
  outcome: GetFigmaDataOutcome,
  context: ToolCallContext,
): void {
  captureToolCall(getFigmaDataCallEvent(outcome), context);
}

export function getFigmaDataCallEvent(outcome: GetFigmaDataOutcome): ToolCallEvent {
  return {
    tool: "get_figma_data",
    durationMs: outcome.durationMs,
    isError: outcome.error !== undefined,
    error: outcome.error,
    properties: getFigmaDataProperties(outcome),
  };
}

export function downloadImagesCallEvent(outcome: DownloadImagesOutcome): ToolCallEvent {
  return {
    tool: "download_figma_images",
    durationMs: outcome.durationMs,
    isError: outcome.error !== undefined,
    error: outcome.error,
    properties: { image_count: outcome.imageCount, success_count: outcome.successCount },
  };
}

function getFigmaDataProperties(outcome: GetFigmaDataOutcome): ToolEventProperties {
  const { metrics } = outcome;
  return {
    output_format: outcome.outputFormat,
    depth: outcome.input.depth ?? null,
    has_node_id: Boolean(outcome.input.nodeId),
    raw_size_kb: metrics?.rawSizeKb,
    simplified_size_kb: metrics?.simplifiedSizeKb,
    raw_node_count: metrics?.rawNodeCount,
    simplified_node_count: metrics?.simplifiedNodeCount,
    max_depth: metrics?.maxDepth,
    named_style_count: metrics?.namedStyleCount,
    component_count: metrics?.componentCount,
    instance_count: metrics?.instanceCount,
    text_node_count: metrics?.textNodeCount,
    image_node_count: metrics?.imageNodeCount,
    component_property_count: metrics?.componentPropertyCount,
    has_variables: metrics?.hasVariables,
    fetch_ms: metrics?.fetchMs,
    decode_ms: metrics?.decodeMs,
    enrich_ms: metrics?.enrichMs,
    simplify_ms: metrics?.simplifyMs,
    serialize_ms: metrics?.serializeMs,
  };
}

/** A failure nothing tagged as anticipated: a bug, or an outage no producer names. */
function isUnexpectedError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  const { category } = getErrorMeta(error);
  return category === undefined || category === "internal";
}

function errorFields(error: unknown): ErrorCallProps {
  const meta = getErrorMeta(error);
  const responseBody = responseBodyOf(error);
  return {
    error_type: error instanceof Error ? error.constructor.name : "Unknown",
    error_phase: meta.phase,
    error_category: meta.category,
    http_status: meta.http_status,
    network_code: meta.network_code,
    fs_code: meta.fs_code,
    is_retryable: meta.is_retryable,
    response_fingerprint:
      responseBody === undefined ? undefined : fingerprintResponseBody(responseBody),
  };
}

/** The first HTTP response body in the error's cause chain — who answered a failed request. */
function responseBodyOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); ) {
    seen.add(current);
    if (current instanceof HttpError && current.responseBody) return current.responseBody;
    current = current.cause;
  }
  return undefined;
}

/**
 * The error message with every HTTP response body in its cause chain swapped for a fingerprint.
 * Producers splice the body into the message verbatim (the user needs it), so substitution here is
 * what keeps block-page contents — usernames, client IPs, internal hosts — out of PostHog.
 */
function messageWithoutResponseBodies(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); ) {
    seen.add(current);
    if (current instanceof HttpError && current.responseBody) {
      message = message.replaceAll(
        current.responseBody,
        fingerprintResponseBody(current.responseBody),
      );
    }
    current = current.cause;
  }
  return message;
}
