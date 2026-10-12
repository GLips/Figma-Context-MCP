import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { PostHog } from "posthog-node";
import { proxyMode, type ProxyMode } from "~/utils/proxy-env.js";
import { redactFigmaIdentifiers } from "./redact-identifiers.js";
import { redactRequestSecrets } from "~/utils/request-secrets.js";
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

// "off" covers both never-initialized and opted-out: an opted-out init leaves
// the state untouched, so a later init (tests opting back in) still works.
type TelemetryState =
  | { kind: "off" }
  | {
      kind: "on";
      client: PostHog;
      sessionId: string;
      commonProps: CommonProperties;
      redactionSecrets: readonly string[];
    };

let state: TelemetryState = { kind: "off" };

function parseNodeMajor(version: string): number {
  return Number.parseInt(version.split(".")[0], 10);
}

// A home directory of "/" (some containers) would turn every slash into "~".
const HOME_DIR = homedir();
const scrubbableHomeDir = HOME_DIR.length > 1 ? HOME_DIR : undefined;

function redactTelemetryString(value: string, redactionSecrets: readonly string[]): string {
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

export function initTelemetry(opts: InitTelemetryOptions): boolean {
  if (state.kind === "on") return true;
  if (!opts.enabled) return false;

  // disableGeoip: false is load-bearing — the Node SDK defaults GeoIP to off,
  // and our geography analytics depend on it being enabled.
  const client = new PostHog(POSTHOG_API_KEY, {
    host: POSTHOG_HOST,
    disableGeoip: false,
    ...(opts.immediateFlush ? { flushAt: 1, flushInterval: 0 } : {}),
  });

  state = {
    kind: "on",
    client,
    sessionId: randomUUID(),
    redactionSecrets: (opts.redactFromTelemetry ?? []).filter(Boolean),
    commonProps: {
      server_version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
      os_platform: process.platform,
      nodejs_major: parseNodeMajor(process.versions.node),
      is_ci: Boolean(process.env.CI),
      proxy_mode: proxyMode(),
    },
  };
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
  if (state.kind === "off") return;
  const { client, sessionId, commonProps, redactionSecrets } = state;

  // Scrub every string-valued property, not just `error_message`. The
  // signature here is `Record<string, unknown>`, so the next event field that
  // carries free text would otherwise ship raw — the exact failure this
  // redaction exists to prevent, reintroduced by someone naming a field
  // something other than `error_message`. Non-string values can't carry an
  // identifier we care about, and `commonProps` is machine-generated, so it's
  // merged in below without passing through here.
  //
  // Redact BEFORE truncating so a token straddling the cut point can't
  // survive as a partial match. Only `error_message` is truncated; the other
  // fields are bounded by construction.
  const processed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value !== "string") {
      processed[key] = value;
      continue;
    }
    const redacted = redactTelemetryString(value, redactionSecrets);
    processed[key] = key === "error_message" ? truncateForTelemetry(redacted) : redacted;
  }

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
  if (state.kind === "off") return;

  const { client } = state;
  // Back to "off" so the module can be re-initialized in the same process
  // (relevant for tests; harmless in production where shutdown runs at exit).
  state = { kind: "off" };
  try {
    await client.shutdown();
  } catch {
    // Telemetry shutdown must never break callers — the server.ts shutdown
    // handler and the fetch.ts cleye chain both depend on this resolving.
  }
}
