import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { proxyMode, type ProxyMode } from "~/utils/proxy-env.js";
import { redactFigmaIdentifiers } from "./redact-identifiers.js";
import { redactRequestSecrets } from "~/utils/request-secrets.js";
import type { InitTelemetryOptions } from "./types.js";
import { exceptionProperties } from "./exception-event.js";
import {
  createPostHogExporter,
  type ConfirmedSend,
  type TelemetryExporter,
} from "./posthog-exporter.js";

export type { ConfirmedSend };

// Write-only project key for the Framelink MCP analytics project.
// This is intentionally embedded in the published package — it's a public
// ingest key that cannot read data, only send events.
const POSTHOG_API_KEY = "phc_w69pYvKwGNLsUHU4TGGpgAiscm8nhjudHgAJzAdzXkJV";
const POSTHOG_HOST = "https://us.i.posthog.com";
// The long-lived server's batching cadence; a CLI command's events go out when it closes telemetry.
const FLUSH_INTERVAL_MS = 10_000;
// Identifies the sender in PostHog's `$lib` breakdowns.
const TELEMETRY_LIB = "framelink-mcp";

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

// "off" covers both never-initialized and opted-out: an opted-out init leaves
// the state untouched, so a later init (tests opting back in) still works.
type TelemetryState =
  | { kind: "off" }
  | {
      kind: "on";
      exporter: TelemetryExporter;
      sessionId: string;
      commonProps: CommonProperties;
      /** Grows as callers resolve credentials; read at capture time, so a later secret still counts. */
      redactionSecrets: Set<string>;
    };

let state: TelemetryState = { kind: "off" };

function parseNodeMajor(version: string): number {
  return Number.parseInt(version.split(".")[0], 10);
}

// A home directory of "/" (some containers) would turn every slash into "~".
const HOME_DIR = homedir();
const scrubbableHomeDir = HOME_DIR.length > 1 ? HOME_DIR : undefined;

function redactTelemetryString(value: string, redactionSecrets: ReadonlySet<string>): string {
  let result = value;
  for (const secret of redactionSecrets) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
  result = redactRequestSecrets(result);
  // Credentials first, identifiers second: secret scrubbing is exact-substring
  // and must see the message unmodified, in case a token sits inside a URL
  // fragment that identifier scrubbing would otherwise rewrite around it.
  //
  // The home-dir scrub is a backstop, not a path policy: absolute paths carry
  // the OS username, and a producer that interpolates one shouldn't leak it.
  if (scrubbableHomeDir) result = result.replaceAll(scrubbableHomeDir, "~");
  return redactFigmaIdentifiers(result);
}

/**
 * Turn telemetry on for this process, or add `redactFromTelemetry` to the secrets an already-on
 * client scrubs. Returns whether telemetry is on. Every caller must register the credentials it
 * resolved here before anything it does can be captured.
 */
export function initTelemetry(opts: InitTelemetryOptions): boolean {
  const secrets = (opts.redactFromTelemetry ?? []).filter(Boolean);
  if (state.kind === "on") {
    for (const secret of secrets) state.redactionSecrets.add(secret);
    return true;
  }
  if (!opts.enabled) return false;

  const serverVersion = process.env.NPM_PACKAGE_VERSION ?? "unknown";
  state = {
    kind: "on",
    exporter: createPostHogExporter({
      host: POSTHOG_HOST,
      apiKey: POSTHOG_API_KEY,
      flushIntervalMs: FLUSH_INTERVAL_MS,
    }),
    sessionId: randomUUID(),
    redactionSecrets: new Set(secrets),
    commonProps: {
      server_version: serverVersion,
      os_platform: process.platform,
      nodejs_major: parseNodeMajor(process.versions.node),
      is_ci: Boolean(process.env.CI),
      proxy_mode: proxyMode(),
    },
  };
  return true;
}

// A reported error's message is free text of unbounded length; redact BEFORE truncating, so a token
// straddling the cut can't survive as a partial match.
const MAX_ERROR_MESSAGE_LENGTH = 2000;

function truncateForTelemetry(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH) + "…[truncated]"
    : message;
}

/**
 * Low-level event capture: disabled state, redaction, common properties. Capture functions in
 * capture.ts shape the event and delegate here.
 *
 * Telemetry must never surface errors to callers — this runs inside lifecycle observers where
 * throwing would mask the tool's real return value (or its original error). Swallow silently; no
 * logging because telemetry is supposed to be invisible.
 */
export function captureEvent(
  event: string,
  properties: Record<string, unknown>,
  /** Per-property length caps, applied after redaction so a secret straddling the cut can't survive. */
  maxLengths: Readonly<Record<string, number>> = {},
): void {
  if (state.kind === "off") return;
  const { exporter, sessionId } = state;
  try {
    exporter.send({
      event,
      distinct_id: sessionId,
      properties: withLibrary(eventProperties(state, properties, maxLengths)),
    });
  } catch {
    // intentionally empty
  }
}

const CONFIRMED_SEND_TIMEOUT_MS = 10_000;

/**
 * Send one event now and say whether PostHog took it — for an event the caller reports back on,
 * unlike every other event, which must stay invisible.
 */
export async function sendEventConfirmed(
  event: string,
  properties: Record<string, unknown>,
  maxLengths: Readonly<Record<string, number>> = {},
): Promise<ConfirmedSend> {
  if (state.kind === "off") return { kind: "off" };
  return state.exporter.sendConfirmed(
    {
      event,
      distinct_id: state.sessionId,
      properties: withLibrary(eventProperties(state, properties, maxLengths)),
    },
    CONFIRMED_SEND_TIMEOUT_MS,
  );
}

// GeoIP stays on by omission: PostHog enriches from the request's IP unless an event carries
// `$geoip_disable: true`, which geography analytics depend on never being sent.
function withLibrary(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    ...properties,
    $lib: TELEMETRY_LIB,
    $lib_version: state.kind === "on" ? state.commonProps.server_version : "unknown",
  };
}

function eventProperties(
  { sessionId, commonProps, redactionSecrets }: Extract<TelemetryState, { kind: "on" }>,
  properties: Record<string, unknown>,
  maxLengths: Readonly<Record<string, number>>,
): Record<string, unknown> {
  // Every string-valued property is scrubbed, whatever its name: the signature is
  // `Record<string, unknown>`, so the next field to carry free text would otherwise ship raw.
  // `commonProps` is machine-generated, so it's merged in below without passing through here.
  const processed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties))
    processed[key] =
      typeof value === "string"
        ? redactTelemetryString(value, redactionSecrets).slice(0, maxLengths[key])
        : value;
  // `$session_id` is how PostHog's MCP analytics groups calls into one agent's session.
  return { ...commonProps, $session_id: sessionId, ...processed };
}

/**
 * Report an unexpected failure to PostHog Error Tracking. What leaves is a fresh error, never the
 * original: its message is `message` (the caller has already fingerprinted response bodies) and its
 * stack is the original's frames, both through the same scrub as every event string — credentials,
 * the home directory, Figma identifiers. No cause chain rides along, so nothing unscrubbed can.
 */
export function captureUnexpectedError(
  error: unknown,
  message: string,
  properties: Record<string, string | undefined>,
): void {
  if (state.kind === "off") return;
  const { exporter, sessionId, commonProps, redactionSecrets } = state;
  const scrub = (value: string) => redactTelemetryString(value, redactionSecrets);
  const reported = new Error(truncateForTelemetry(scrub(message)));
  reported.name = error instanceof Error ? error.name : "NonError";
  // Frames only: the stack's first lines repeat the raw message.
  const frames = (error instanceof Error ? (error.stack ?? "") : "")
    .split("\n")
    .filter((line) => /^\s+at /.test(line));
  reported.stack = [`${reported.name}: ${reported.message}`, ...frames.map(scrub)].join("\n");
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties))
    if (value !== undefined) scrubbed[key] = scrub(value);
  try {
    exporter.send({
      event: "$exception",
      distinct_id: sessionId,
      properties: withLibrary({
        ...exceptionProperties(reported),
        ...commonProps,
        ...scrubbed,
      }),
    });
  } catch {
    // intentionally empty
  }
}

/**
 * Deliver what is queued within `deadlineMs`, then abort the rest, so telemetry never holds a
 * process's exit past it. Back to "off" afterwards, so tests can initialize again.
 */
export async function closeTelemetry(deadlineMs: number): Promise<void> {
  if (state.kind === "off") return;
  const { exporter } = state;
  state = { kind: "off" };
  await exporter.close(deadlineMs);
}
