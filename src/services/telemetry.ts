import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type { GetFigmaDataOutcome } from "~/services/get-figma-data.js";
import type { DownloadImagesOutcome } from "~/services/download-figma-images.js";

// Write-only project key for the Framelink MCP analytics project.
// This is intentionally embedded in the published package — it's a public
// ingest key that cannot read data, only send events.
const POSTHOG_API_KEY = "phc_REPLACE_ME_WITH_REAL_KEY";
const POSTHOG_HOST = "https://us.i.posthog.com";

export type Transport = "stdio" | "http" | "cli";
export type AuthMode = "oauth" | "api_key";

export interface InitTelemetryOptions {
  optOut?: boolean;
  /**
   * Flush events immediately instead of batching. For short-lived processes
   * (e.g. the `fetch` CLI command) that would otherwise exit before the
   * default flush interval fires and drop the event.
   */
  immediateFlush?: boolean;
  /**
   * Strings to scrub from `error_message` before sending events to PostHog.
   * The shell passes whatever it considers sensitive (API keys, OAuth tokens,
   * etc). Empty strings are filtered automatically so callers don't have to.
   */
  redactFromErrors?: string[];
}

/**
 * Telemetry is enabled by default. Any single opt-out signal disables it —
 * the `optOut` flag (CLI), FRAMELINK_TELEMETRY=off, or a truthy DO_NOT_TRACK.
 * Signals are OR'd, not prioritized, so users can't accidentally re-enable
 * telemetry by setting one variable when another is already opting out.
 *
 * DO_NOT_TRACK follows the https://consoledonottrack.com/ convention: any
 * non-empty value other than "0" means opt-out.
 */
export function resolveTelemetryEnabled(optOut?: boolean): boolean {
  if (optOut === true) return false;
  if (process.env.FRAMELINK_TELEMETRY === "off") return false;
  const doNotTrack = process.env.DO_NOT_TRACK;
  if (doNotTrack && doNotTrack !== "0") return false;
  return true;
}

type CommonCallProps = {
  duration_ms: number;
  transport: Transport;
  auth_mode: AuthMode;
  is_error: boolean;
  error_type?: string;
  error_message?: string;
};

type GetFigmaDataCall = CommonCallProps & {
  tool: "get_figma_data";
  output_format: "yaml" | "json";
  raw_size_kb?: number;
  simplified_size_kb?: number;
  node_count?: number;
  depth: number | null;
  has_node_id: boolean;
};

type DownloadFigmaImagesCall = CommonCallProps & {
  tool: "download_figma_images";
  image_count: number;
  success_count?: number;
};

type ToolCallProperties = GetFigmaDataCall | DownloadFigmaImagesCall;

type ToolCallContext = { transport: Transport; authMode: AuthMode };

type CommonProperties = {
  server_version: string;
  os_platform: NodeJS.Platform;
  node_major: number;
  is_ci: boolean;
};

let client: PostHog | undefined;
let sessionId: string | undefined;
let commonProps: CommonProperties | undefined;
let disabled = true;
let initialized = false;
let redactionSecrets: string[] = [];

function parseNodeMajor(version: string): number {
  const major = version.split(".")[0];
  return Number.parseInt(major, 10);
}

function redactErrorMessage(message: string): string {
  let result = message;
  for (const secret of redactionSecrets) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

export function initTelemetry(opts?: InitTelemetryOptions): boolean {
  if (initialized) return !disabled;
  initialized = true;

  if (!resolveTelemetryEnabled(opts?.optOut)) {
    disabled = true;
    return false;
  }

  disabled = false;
  sessionId = randomUUID();
  redactionSecrets = (opts?.redactFromErrors ?? []).filter(Boolean);

  commonProps = {
    server_version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
    os_platform: process.platform,
    node_major: parseNodeMajor(process.versions.node),
    is_ci: Boolean(process.env.CI),
  };

  // disableGeoip: false is load-bearing — the Node SDK defaults GeoIP to off,
  // and our geography analytics depend on it being enabled.
  client = new PostHog(POSTHOG_API_KEY, {
    host: POSTHOG_HOST,
    disableGeoip: false,
    ...(opts?.immediateFlush ? { flushAt: 1, flushInterval: 0 } : {}),
  });

  return true;
}

function captureToolCall(props: ToolCallProperties): void {
  if (disabled || !client || !sessionId || !commonProps) return;

  const { error_message } = props;
  const redactedProps =
    error_message !== undefined
      ? { ...props, error_message: redactErrorMessage(error_message) }
      : props;

  // Telemetry must never surface errors to callers — this runs inside a
  // lifecycle observer where throwing would mask the tool's real return
  // value (or its original error). Swallow silently; no logging because
  // telemetry is supposed to be invisible.
  try {
    client.capture({
      distinctId: sessionId,
      event: "tool_called",
      properties: { ...commonProps, ...redactedProps },
    });
  } catch {
    // intentionally empty
  }
}

function errorFields(
  error: unknown,
): Pick<CommonCallProps, "is_error" | "error_type" | "error_message"> {
  if (error === undefined) return { is_error: false };
  return {
    is_error: true,
    error_type: error instanceof Error ? error.constructor.name : "Unknown",
    error_message: error instanceof Error ? error.message : String(error),
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
    output_format: outcome.outputFormat,
    depth: outcome.input.depth ?? null,
    has_node_id: Boolean(outcome.input.nodeId),
    raw_size_kb: outcome.metrics?.rawSizeKb,
    simplified_size_kb: outcome.metrics?.simplifiedSizeKb,
    node_count: outcome.metrics?.nodeCount,
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

export async function shutdown(): Promise<void> {
  if (disabled || !client) return;

  const current = client;
  client = undefined;
  disabled = true;
  try {
    await current.shutdown();
  } catch {
    // Telemetry shutdown must never break callers — the server.ts shutdown
    // handler and the fetch.ts cleye chain both depend on this resolving.
  }
  // Reset so the module can be re-initialized in the same process (relevant
  // for tests; harmless in production where shutdown runs only at exit).
  initialized = false;
}
