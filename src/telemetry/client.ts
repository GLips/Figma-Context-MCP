import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import { proxyMode, type ProxyMode } from "~/utils/proxy-env.js";
import type { InitTelemetryOptions } from "./types.js";

// Write-only project key for the Framelink MCP analytics project.
// This is intentionally embedded in the published package — it's a public
// ingest key that cannot read data, only send events.
const POSTHOG_API_KEY = "phc_w69pYvKwGNLsUHU4TGGpgAiscm8nhjudHgAJzAdzXkJV";
const POSTHOG_HOST = "https://us.i.posthog.com";

type CommonProperties = {
  server_version: string;
  os_platform: NodeJS.Platform;
  nodejs_major: number;
  is_ci: boolean;
  /**
   * Which dispatcher the server installed for outbound fetches:
   * `none` (Node default), `explicit` (--proxy/FIGMA_PROXY), or `env`
   * (EnvHttpProxyAgent driven by HTTP_PROXY/HTTPS_PROXY/NO_PROXY).
   *
   * Lets us correlate failure rates (especially auth-category 403s — see
   * issue #358) with the proxy configuration a user was actually running
   * under, without logging the proxy URL itself.
   */
  proxy_mode: ProxyMode;
};

let client: PostHog | undefined;
let sessionId: string | undefined;
let commonProps: CommonProperties | undefined;
let disabled = true;
let initialized = false;
let redactionSecrets: string[] = [];

// Per-request redaction context. The init-time `redactionSecrets` list only
// covers credentials known at startup; with HTTP `X-Figma-Token` auth the
// real credential arrives per request and must not leak into telemetry. Each
// HTTP handler runs its body inside `withRequestSecrets(...)`, and capture
// merges the request-scoped list with the global one. AsyncLocalStorage
// propagates the value through the request's promise chain without us having
// to thread it down through every call site.
const requestSecrets = new AsyncLocalStorage<readonly string[]>();

export function withRequestSecrets<T>(
  secrets: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  // Filter empties to avoid `replaceAll("", ...)`, which loops over every
  // character of the message and produces nonsense output.
  const filtered = secrets.filter(Boolean);
  if (filtered.length === 0) return fn();
  return requestSecrets.run(filtered, fn);
}

function parseNodeMajor(version: string): number {
  return Number.parseInt(version.split(".")[0], 10);
}

function redactErrorMessage(message: string): string {
  let result = message;
  for (const secret of redactionSecrets) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
  for (const secret of requestSecrets.getStore() ?? []) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
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

export function initTelemetry(opts?: InitTelemetryOptions): boolean {
  if (initialized) return !disabled;

  if (!resolveTelemetryEnabled(opts?.optOut)) {
    disabled = true;
    // Intentionally do NOT mark `initialized` here. An opted-out init must
    // not poison subsequent re-init attempts (e.g. tests that opt out then
    // opt in to verify capture). Re-running resolveTelemetryEnabled is cheap.
    return false;
  }

  initialized = true;
  disabled = false;
  sessionId = randomUUID();
  redactionSecrets = (opts?.redactFromErrors ?? []).filter(Boolean);

  commonProps = {
    server_version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
    os_platform: process.platform,
    nodejs_major: parseNodeMajor(process.versions.node),
    is_ci: Boolean(process.env.CI),
    proxy_mode: proxyMode(),
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

/**
 * Low-level event capture. Handles disabled state, redaction, and common
 * property merging. Capture functions in capture.ts shape the event and
 * delegate here.
 *
 * Telemetry must never surface errors to callers — this runs inside lifecycle
 * observers where throwing would mask the tool's real return value (or its
 * original error). Swallow silently; no logging because telemetry is supposed
 * to be invisible.
 */
const MAX_ERROR_MESSAGE_LENGTH = 2000;

function truncateForTelemetry(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH) + "…[truncated]"
    : message;
}

export function captureEvent(event: string, properties: Record<string, unknown>): void {
  if (disabled || !client || !sessionId || !commonProps) return;

  // Redact secrets BEFORE truncating so a token straddling the cut point
  // can't survive as a partial match.
  const errorMessage = properties.error_message;
  const processed =
    typeof errorMessage === "string"
      ? {
          ...properties,
          error_message: truncateForTelemetry(redactErrorMessage(errorMessage)),
        }
      : properties;

  try {
    client.capture({
      distinctId: sessionId,
      event,
      properties: { ...commonProps, ...processed },
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
