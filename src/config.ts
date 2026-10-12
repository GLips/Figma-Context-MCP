import { config as loadEnv } from "dotenv";
import { resolve as resolvePath } from "path";
import type { FigmaAuthOptions } from "./services/figma.js";
import { VALID_OUTPUT_FORMATS, isOutputFormat, type OutputFormat } from "./utils/serialize.js";

export type Source = "cli" | "env" | "default";

export const DEFAULT_FRAMELINK_API_URL = "https://app.framelink.ai";
export const DEFAULT_HTTP_PORT = 3333;
export const DEFAULT_HTTP_HOST = "127.0.0.1";

export interface Resolved<T> {
  value: T;
  source: Source;
}

export interface ServerFlags {
  figmaApiKey?: string;
  figmaOauthToken?: string;
  env?: string;
  port?: number;
  host?: string;
  json?: boolean;
  format?: string;
  skipImageDownloads?: boolean;
  imageDir?: string;
  proxy?: string;
  stdio?: boolean;
  noTelemetry?: boolean;
  codeMode?: boolean;
  assetRoot?: string;
}

export interface ServerConfig {
  auth: FigmaAuthOptions;
  port: number;
  host: string;
  proxy: string | undefined;
  outputFormat: OutputFormat;
  skipImageDownloads: boolean;
  imageDir: string;
  isStdioMode: boolean;
  telemetryEnabled: boolean;
  codeMode: boolean;
  assetRoot: string;
  framelinkApiUrl: string;
  configSources: Record<string, Source>;
}

/** Resolve a config value through the priority chain: CLI flag → env var → default. */
export function resolve<T>(flag: T | undefined, env: T | undefined, fallback: T): Resolved<T> {
  if (flag !== undefined) return { value: flag, source: "cli" };
  if (env !== undefined) return { value: env, source: "env" };
  return { value: fallback, source: "default" };
}

export function envStr(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function envInt(...names: string[]): number | undefined {
  for (const name of names) {
    const val = process.env[name];
    if (val) return parseInt(val, 10);
  }
  return undefined;
}

export function envBool(name: string): boolean | undefined {
  const val = process.env[name];
  if (val === "true") return true;
  if (val === "false") return false;
  return undefined;
}

// Throws on invalid input so callers control how the failure surfaces — the
// server entry point exits the process, but the `fetch` CLI command needs to
// run its `finally` (telemetry shutdown) before exiting, which `process.exit`
// would bypass.
export function parseOutputFormat(
  value: string | undefined,
  source: string,
): OutputFormat | undefined {
  if (value === undefined) return undefined;
  if (isOutputFormat(value)) return value;
  throw new Error(
    `Invalid ${source} value '${value}'. Expected one of: ${VALID_OUTPUT_FORMATS.join(", ")}`,
  );
}

function maskApiKey(key: string): string {
  if (!key || key.length <= 4) return "****";
  return `****${key.slice(-4)}`;
}

export function loadEnvFile(envPath?: string): string {
  const envFilePath = envPath ? resolvePath(envPath) : resolvePath(process.cwd(), ".env");
  loadEnv({ path: envFilePath, override: true });
  return envFilePath;
}

type CredentialFlags = { figmaApiKey?: string; figmaOauthToken?: string };

// The single resolution of the Figma credentials; `getServerConfig` keeps the
// `Resolved` pair for its source display, everyone else takes `resolveAuth`.
function resolveFigmaCredentials(flags: CredentialFlags) {
  const figmaApiKey = resolve(flags.figmaApiKey, envStr("FIGMA_API_KEY"), "");
  const figmaOauthToken = resolve(flags.figmaOauthToken, envStr("FIGMA_OAUTH_TOKEN"), "");
  const auth: FigmaAuthOptions = {
    figmaApiKey: figmaApiKey.value,
    figmaOAuthToken: figmaOauthToken.value,
    useOAuth: Boolean(figmaOauthToken.value),
  };
  return { auth, figmaApiKey, figmaOauthToken };
}

export function resolveAuth(flags: CredentialFlags): FigmaAuthOptions {
  return resolveFigmaCredentials(flags).auth;
}

// Only explicit proxy config: standard env vars (HTTPS_PROXY, HTTP_PROXY, NO_PROXY) are handled by
// undici's EnvHttpProxyAgent at the dispatcher level, which correctly respects NO_PROXY exclusions.
export function resolveProxy(flags: { proxy?: string }) {
  return resolve(flags.proxy, envStr("FIGMA_PROXY"), undefined);
}

/**
 * Telemetry is enabled by default. Any single opt-out signal disables it —
 * the `--no-telemetry` flag, FRAMELINK_TELEMETRY=off, or a truthy DO_NOT_TRACK.
 * Signals are OR'd, not prioritized, so users can't accidentally re-enable
 * telemetry by setting one variable when another is already opting out.
 *
 * DO_NOT_TRACK follows the https://consoledonottrack.com/ convention: any
 * non-empty value other than "0" means opt-out.
 */
export function resolveTelemetryEnabled(optOut?: boolean): boolean {
  if (optOut === true) return false;
  if (envStr("FRAMELINK_TELEMETRY") === "off") return false;
  const doNotTrack = envStr("DO_NOT_TRACK");
  if (doNotTrack && doNotTrack !== "0") return false;
  return true;
}

/**
 * Thrown for user-fixable input errors (missing credentials, missing file key,
 * etc.). CLI entry points catch this and print the bare message with exit 1,
 * distinct from unexpected crashes that get a "Failed to start server:" prefix
 * and stack trace. Throwing (vs. process.exit) keeps validators pure and safe
 * for library consumers of `~/mcp-server`.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Fail fast when global credentials are required but missing. HTTP mode skips
 * this check so it can accept per-request `X-Figma-Token` headers; stdio and
 * the `fetch` CLI have no way to receive request-time auth and must have
 * something resolvable at startup or they'd just defer the failure to the
 * first tool call with a misleading "send X-Figma-Token" message.
 */
export function requireGlobalCredentials(auth: FigmaAuthOptions): void {
  if (auth.figmaApiKey || auth.figmaOAuthToken) return;
  throw new UsageError(
    "Either FIGMA_API_KEY or FIGMA_OAUTH_TOKEN is required (via CLI argument or .env file)",
  );
}

export function getServerConfig(flags: ServerFlags): ServerConfig {
  // Load .env before resolving env-backed values
  const envFilePath = loadEnvFile(flags.env);
  const envFileSource: Source = flags.env !== undefined ? "cli" : "default";

  // Resolve config values: CLI flag → env var → default
  const { auth, figmaApiKey, figmaOauthToken } = resolveFigmaCredentials(flags);
  const port = resolve(flags.port, envInt("FRAMELINK_PORT", "PORT"), DEFAULT_HTTP_PORT);
  const host = resolve(flags.host, envStr("FRAMELINK_HOST"), DEFAULT_HTTP_HOST);
  const skipImageDownloads = resolve(
    flags.skipImageDownloads,
    envBool("SKIP_IMAGE_DOWNLOADS"),
    false,
  );
  const envImageDir = envStr("IMAGE_DIR");
  const imageDir = resolve(
    flags.imageDir ? resolvePath(flags.imageDir) : undefined,
    envImageDir ? resolvePath(envImageDir) : undefined,
    process.cwd(),
  );

  const proxy = resolveProxy(flags);

  // --format wins; --json is a back-compat alias for --format=json. Invalid
  // user-supplied values fail loudly at startup rather than silently coercing.
  const formatFromFlag =
    parseOutputFormat(flags.format, "--format") ?? (flags.json ? "json" : undefined);
  const formatFromEnv = parseOutputFormat(envStr("OUTPUT_FORMAT"), "OUTPUT_FORMAT");
  const outputFormat = resolve<OutputFormat>(formatFromFlag, formatFromEnv, "tree");

  const isStdioMode = flags.stdio === true;

  // Escape hatch for MCP clients that cache tools/list and ignore list_changed: force the
  // code-mode tools to be advertised from startup instead of waiting for a plugin connection.
  const codeMode = resolve(flags.codeMode, envBool("FIGMA_CODE_MODE"), false);

  // The directory local flcm.image() file paths and scriptPath scripts are confined to — a security
  // boundary, not a convenience (see plugin-bridge/contained-file.ts). Defaults to cwd, which is the agent's
  // repo in the common launch shape.
  const { assetRoot, framelinkApiUrl } = resolvePluginConfig(flags.assetRoot);

  const telemetryEnabled = resolveTelemetryEnabled(flags.noTelemetry);
  const telemetrySource: Source =
    flags.noTelemetry === true
      ? "cli"
      : envStr("FRAMELINK_TELEMETRY") !== undefined || envStr("DO_NOT_TRACK") !== undefined
        ? "env"
        : "default";

  const configSources: Record<string, Source> = {
    envFile: envFileSource,
    figmaApiKey: figmaApiKey.source,
    figmaOauthToken: figmaOauthToken.source,
    port: port.source,
    host: host.source,
    proxy: proxy.source,
    outputFormat: outputFormat.source,
    skipImageDownloads: skipImageDownloads.source,
    imageDir: imageDir.source,
    codeMode: codeMode.source,
    assetRoot: assetRoot.source,
    framelinkApiUrl: framelinkApiUrl.source,
    telemetry: telemetrySource,
  };

  if (!isStdioMode) {
    console.log("\nConfiguration:");
    console.log(`- ENV_FILE: ${envFilePath} (source: ${configSources.envFile})`);
    if (auth.useOAuth) {
      console.log(
        `- FIGMA_OAUTH_TOKEN: ${maskApiKey(auth.figmaOAuthToken)} (source: ${configSources.figmaOauthToken})`,
      );
      console.log("- Authentication Method: OAuth Bearer Token");
    } else if (auth.figmaApiKey) {
      console.log(
        `- FIGMA_API_KEY: ${maskApiKey(auth.figmaApiKey)} (source: ${configSources.figmaApiKey})`,
      );
      console.log("- Authentication Method: Personal Access Token (X-Figma-Token)");
    } else {
      console.log("- Authentication Method: Per-request X-Figma-Token header");
    }
    console.log(`- FRAMELINK_PORT: ${port.value} (source: ${configSources.port})`);
    console.log(`- FRAMELINK_HOST: ${host.value} (source: ${configSources.host})`);
    console.log(`- PROXY: ${proxy.value ? "configured" : "none"} (source: ${configSources.proxy})`);
    console.log(`- OUTPUT_FORMAT: ${outputFormat.value} (source: ${configSources.outputFormat})`);
    console.log(
      `- SKIP_IMAGE_DOWNLOADS: ${skipImageDownloads.value} (source: ${configSources.skipImageDownloads})`,
    );
    console.log(`- IMAGE_DIR: ${imageDir.value} (source: ${configSources.imageDir})`);
    console.log(`- CODE_MODE: ${codeMode.value} (source: ${configSources.codeMode})`);
    console.log(`- ASSET_ROOT: ${assetRoot.value} (source: ${configSources.assetRoot})`);
    console.log(
      `- FRAMELINK_API_URL: ${framelinkApiUrl.value} (source: ${configSources.framelinkApiUrl})`,
    );
    console.log(
      `- TELEMETRY: ${telemetryEnabled ? "enabled" : "disabled"} (source: ${configSources.telemetry})`,
    );
    console.log();
  }

  return {
    auth,
    port: port.value,
    host: host.value,
    proxy: proxy.value,
    outputFormat: outputFormat.value,
    skipImageDownloads: skipImageDownloads.value,
    imageDir: imageDir.value,
    isStdioMode,
    telemetryEnabled,
    codeMode: codeMode.value,
    assetRoot: assetRoot.value,
    framelinkApiUrl: framelinkApiUrl.value,
    configSources,
  };
}

/** Plugin-only configuration, shared with the saved-script CLI; no REST credentials required. */
export function resolvePluginConfig(assetRootFlag?: string) {
  const envAssetRoot = envStr("FRAMELINK_ASSET_ROOT");
  return {
    assetRoot: resolve(
      assetRootFlag ? resolvePath(assetRootFlag) : undefined,
      envAssetRoot ? resolvePath(envAssetRoot) : undefined,
      process.cwd(),
    ),
    framelinkApiUrl: resolve(undefined, envStr("FRAMELINK_API_URL"), DEFAULT_FRAMELINK_API_URL),
  };
}
