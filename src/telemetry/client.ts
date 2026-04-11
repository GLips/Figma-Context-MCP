import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type { EventMessage } from "posthog-node";
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
};

let client: PostHog | undefined;
let sessionId: string | undefined;
let commonProps: CommonProperties | undefined;
let disabled = true;
let initialized = false;
let redactionSecrets: string[] = [];

function parseNodeMajor(version: string): number {
  return Number.parseInt(version.split(".")[0], 10);
}

const MAX_ERROR_MESSAGE_LENGTH = 2000;

function redactErrorMessage(message: string): string {
  let result = message;
  for (const secret of redactionSecrets) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

function truncateForTelemetry(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH) + "…[truncated]"
    : message;
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
  };

  // disableGeoip: false is load-bearing — the Node SDK defaults GeoIP to off,
  // and our geography analytics depend on it being enabled.
  client = new PostHog(POSTHOG_API_KEY, {
    host: POSTHOG_HOST,
    disableGeoip: false,
    before_send: redactEvent,
    ...(opts?.immediateFlush ? { flushAt: 1, flushInterval: 0 } : {}),
  });

  return true;
}

/**
 * Centralised redaction for all outbound PostHog events. Runs as a
 * `before_send` hook so every event type is covered — no call site needs to
 * remember to redact manually.
 *
 * - `error_message` (flat property on `tool_called` events)
 * - `$exception_list[*].value` (built internally by the SDK for `$exception`
 *   events — we can't redact before handing the Error over without losing the
 *   original stack trace, so we intercept here)
 */
function redactEvent(event: EventMessage | null): EventMessage | null {
  if (!event || redactionSecrets.length === 0) return event;

  const props = event.properties;
  if (!props) return event;

  if (typeof props.error_message === "string") {
    props.error_message = truncateForTelemetry(redactErrorMessage(props.error_message));
  }

  const list = props.$exception_list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (typeof entry.value === "string") {
        entry.value = truncateForTelemetry(redactErrorMessage(entry.value));
      }
    }
  }

  return event;
}

/**
 * Low-level event capture. Handles disabled state and common property merging.
 * Capture functions in capture.ts shape the event and delegate here; secret
 * redaction runs centrally in the `before_send` hook.
 *
 * Telemetry must never surface errors to callers — this runs inside lifecycle
 * observers where throwing would mask the tool's real return value (or its
 * original error). Swallow silently; no logging because telemetry is supposed
 * to be invisible.
 */
export function captureEvent(event: string, properties: Record<string, unknown>): void {
  if (disabled || !client || !sessionId || !commonProps) return;

  try {
    client.capture({
      distinctId: sessionId,
      event,
      properties: { ...commonProps, ...properties },
    });
  } catch {
    // intentionally empty
  }
}

export function captureException(
  error: unknown,
  additionalProperties?: Record<string, unknown>,
): void {
  if (disabled || !client || !sessionId || !commonProps) return;

  try {
    client.captureException(error, sessionId, {
      ...commonProps,
      ...additionalProperties,
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
