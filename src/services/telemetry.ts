import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";

// Write-only project key for the Framelink MCP analytics project.
// This is intentionally embedded in the published package — it's a public
// ingest key that cannot read data, only send events.
const POSTHOG_API_KEY = "phc_REPLACE_ME_WITH_REAL_KEY";
const POSTHOG_HOST = "https://us.i.posthog.com";

export type Transport = "stdio" | "http" | "cli";
export type AuthMode = "oauth" | "api_key";

export interface InitTelemetryOptions {
  enabled: boolean;
  figmaApiKey: string;
  figmaOAuthToken: string;
  /**
   * Flush events immediately instead of batching. For short-lived processes
   * (e.g. the `fetch` CLI command) that would otherwise exit before the
   * default flush interval fires and drop the event.
   */
  immediateFlush?: boolean;
}

type CommonCallProps = {
  duration_ms: number;
  transport: Transport;
  auth_mode: AuthMode;
  is_error: boolean;
  error_type?: string;
  error_message?: string;
};

export type GetFigmaDataCall = CommonCallProps & {
  tool: "get_figma_data";
  output_format: "yaml" | "json";
  raw_size_kb?: number;
  simplified_size_kb?: number;
  node_count?: number;
  depth: number | null;
  has_node_id: boolean;
};

export type DownloadFigmaImagesCall = CommonCallProps & {
  tool: "download_figma_images";
  image_count: number;
  success_count?: number;
};

export type ToolCallProperties = GetFigmaDataCall | DownloadFigmaImagesCall;

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

export function initTelemetry(opts: InitTelemetryOptions): void {
  if (initialized) return;
  initialized = true;

  if (!opts.enabled) {
    disabled = true;
    return;
  }

  disabled = false;
  sessionId = randomUUID();
  // Short strings would garble unrelated text via collisions; real Figma
  // tokens are well over 8 chars.
  redactionSecrets = [opts.figmaApiKey, opts.figmaOAuthToken].filter(
    (secret) => secret.length >= 8,
  );

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
    ...(opts.immediateFlush ? { flushAt: 1, flushInterval: 0 } : {}),
  });
}

export function captureToolCall(props: ToolCallProperties): void {
  if (disabled || !client || !sessionId || !commonProps) return;

  const { error_message } = props;
  const redactedProps =
    error_message !== undefined
      ? { ...props, error_message: redactErrorMessage(error_message) }
      : props;

  // Telemetry must never surface errors to callers — this runs inside tool
  // handler `finally` blocks, where throwing would mask the tool's real
  // return value (or its original error). Swallow silently; no logging
  // because telemetry is supposed to be invisible.
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
