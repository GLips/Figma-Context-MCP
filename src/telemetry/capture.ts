import { getErrorMeta } from "~/utils/error-meta.js";
import type { GetFigmaDataOutcome } from "~/services/get-figma-data.js";
import type { DownloadImagesOutcome } from "~/services/download-figma-images.js";
import { captureEvent } from "./client.js";
import type {
  CommonCallProps,
  GetFigmaDataCall,
  DownloadFigmaImagesCall,
  ToolCallProperties,
  ToolCallContext,
  ValidationRejectInput,
} from "./types.js";

function captureToolCall(props: ToolCallProperties): void {
  captureEvent("tool_called", props as unknown as Record<string, unknown>);
}

function errorFields(
  error: unknown,
): Pick<
  CommonCallProps,
  | "is_error"
  | "error_type"
  | "error_message"
  | "error_phase"
  | "http_status"
  | "network_code"
  | "fs_code"
  | "is_retryable"
> {
  if (error === undefined) return { is_error: false };
  const meta = getErrorMeta(error);
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    is_error: true,
    error_type: error instanceof Error ? error.constructor.name : "Unknown",
    error_message: rawMessage,
    error_phase: meta.phase,
    http_status: meta.http_status,
    network_code: meta.network_code,
    fs_code: meta.fs_code,
    is_retryable: meta.is_retryable,
  };
}

function toGetFigmaDataEvent(
  outcome: GetFigmaDataOutcome,
  context: ToolCallContext,
): GetFigmaDataCall {
  return {
    tool: "get_figma_data",
    duration_ms: outcome.durationMs,
    transport: context.transport,
    auth_mode: context.authMode,
    client_name: context.clientInfo?.name,
    client_version: context.clientInfo?.version,
    output_format: outcome.outputFormat,
    depth: outcome.input.depth ?? null,
    has_node_id: Boolean(outcome.input.nodeId),
    raw_size_kb: outcome.metrics?.rawSizeKb,
    simplified_size_kb: outcome.metrics?.simplifiedSizeKb,
    raw_node_count: outcome.metrics?.rawNodeCount,
    simplified_node_count: outcome.metrics?.simplifiedNodeCount,
    max_depth: outcome.metrics?.maxDepth,
    named_style_count: outcome.metrics?.namedStyleCount,
    component_count: outcome.metrics?.componentCount,
    instance_count: outcome.metrics?.instanceCount,
    text_node_count: outcome.metrics?.textNodeCount,
    image_node_count: outcome.metrics?.imageNodeCount,
    component_property_count: outcome.metrics?.componentPropertyCount,
    has_variables: outcome.metrics?.hasVariables,
    fetch_ms: outcome.metrics?.fetchMs,
    simplify_ms: outcome.metrics?.simplifyMs,
    serialize_ms: outcome.metrics?.serializeMs,
    ...errorFields(outcome.error),
  };
}

function toDownloadImagesEvent(
  outcome: DownloadImagesOutcome,
  context: ToolCallContext,
): DownloadFigmaImagesCall {
  return {
    tool: "download_figma_images",
    duration_ms: outcome.durationMs,
    transport: context.transport,
    auth_mode: context.authMode,
    client_name: context.clientInfo?.name,
    client_version: context.clientInfo?.version,
    image_count: outcome.imageCount,
    success_count: outcome.successCount,
    ...errorFields(outcome.error),
  };
}

export function captureGetFigmaDataCall(
  outcome: GetFigmaDataOutcome,
  context: ToolCallContext,
): void {
  captureToolCall(toGetFigmaDataEvent(outcome, context));
}

export function captureDownloadImagesCall(
  outcome: DownloadImagesOutcome,
  context: ToolCallContext,
): void {
  captureToolCall(toDownloadImagesEvent(outcome, context));
}

/**
 * Capture a tool call that was rejected by input validation. Fires a regular
 * `tool_called` event so PostHog dashboards can aggregate it alongside successful
 * calls (filter by `error_phase == "validate"`). Most tool-specific metric
 * fields are absent because the pipeline never ran — only validation context.
 */
export function captureValidationReject(
  input: ValidationRejectInput,
  context: ToolCallContext,
): void {
  const common: CommonCallProps = {
    duration_ms: input.durationMs ?? 0,
    transport: context.transport,
    auth_mode: context.authMode,
    client_name: context.clientInfo?.name,
    client_version: context.clientInfo?.version,
    is_error: true,
    error_type: "ValidationError",
    error_message: input.message,
    error_phase: "validate",
    validation_field: input.field,
    validation_rule: input.rule,
  };

  if (input.tool === "get_figma_data") {
    captureToolCall({
      ...common,
      tool: "get_figma_data",
      output_format: input.outputFormat ?? "yaml",
      depth: null,
      has_node_id: false,
    });
  } else {
    captureToolCall({
      ...common,
      tool: "download_figma_images",
      image_count: 0,
    });
  }
}
