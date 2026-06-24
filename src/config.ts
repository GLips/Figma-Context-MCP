import { config as loadEnv } from "dotenv";
import os from "os";
import { isAbsolute, join, resolve as resolvePath } from "path";
import type { FigmaAuthOptions } from "./services/figma.js";
import type { FigmaCachingOptions } from "./services/figma-file-cache.js";
import { resolveTelemetryEnabled } from "./telemetry/index.js";
import { VALID_OUTPUT_FORMATS, isOutputFormat, type OutputFormat } from "./utils/serialize.js";

export type Source = "cli" | "env" | "default";

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
  noTelemetry: boolean;
  caching?: FigmaCachingOptions;
  configSources: Record<string, Source>;
}

type DurationUnit = "ms" | "s" | "m" | "h" | "d";

const DURATION_IN_MS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/** Resolve a config value through the priority chain: CLI flag -> env var -> default. */
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

export function resolveAuth(flags: {
  figmaApiKey?: string;
  figmaOauthToken?: string;
}): FigmaAuthOptions {
  const figmaApiKey = resolve(flags.figmaApiKey, envStr("FIGMA_API_KEY"), "");
  const figmaOauthToken = resolve(flags.figmaOauthToken, envStr("FIGMA_OAUTH_TOKEN"), "");

  const useOAuth = Boolean(figmaOauthToken.value);
  const auth: FigmaAuthOptions = {
    figmaApiKey: figmaApiKey.value,
    figmaOAuthToken: figmaOauthToken.value,
    useOAuth,
  };

  return auth;
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
  const envFilePath = loadEnvFile(flags.env);
  const envFileSource: Source = flags.env !== undefined ? "cli" : "default";

  const auth = resolveAuth(flags);

  const figmaApiKey = resolve(flags.figmaApiKey, envStr("FIGMA_API_KEY"), "");
  const figmaOauthToken = resolve(flags.figmaOauthToken, envStr("FIGMA_OAUTH_TOKEN"), "");
  const port = resolve(flags.port, envInt("FRAMELINK_PORT", "PORT"), 3333);
  const host = resolve(flags.host, envStr("FRAMELINK_HOST"), "127.0.0.1");
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
  const proxy = resolve(flags.proxy, envStr("FIGMA_PROXY"), undefined);
  // --format wins; --json is a back-compat alias for --format=json. Invalid
  // user-supplied values fail loudly at startup rather than silently coercing.
  const formatFromFlag =
    parseOutputFormat(flags.format, "--format") ?? (flags.json ? "json" : undefined);
  const formatFromEnv = parseOutputFormat(envStr("OUTPUT_FORMAT"), "OUTPUT_FORMAT");
  const outputFormat = resolve<OutputFormat>(formatFromFlag, formatFromEnv, "tree");
  const caching = resolve<FigmaCachingOptions | undefined>(
    undefined,
    parseCachingConfig(process.env.FIGMA_CACHING),
    undefined,
  );

  const isStdioMode = flags.stdio === true;
  const noTelemetry = flags.noTelemetry ?? false;
  const telemetrySource: Source =
    flags.noTelemetry === true
      ? "cli"
      : process.env.FRAMELINK_TELEMETRY !== undefined || process.env.DO_NOT_TRACK !== undefined
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
    telemetry: telemetrySource,
    caching: caching.source,
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
    const telemetryEnabled = resolveTelemetryEnabled(noTelemetry);
    console.log(
      `- TELEMETRY: ${telemetryEnabled ? "enabled" : "disabled"} (source: ${configSources.telemetry})`,
    );
    console.log(
      `- FIGMA_CACHING: ${caching.value ? JSON.stringify({ cacheDir: caching.value.cacheDir, ttlMs: caching.value.ttlMs }) : "disabled"} (source: ${configSources.caching})`,
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
    noTelemetry,
    caching: caching.value,
    configSources,
  };
}

function parseCachingConfig(rawValue: string | undefined): FigmaCachingOptions | undefined {
  if (!rawValue) return undefined;

  try {
    const parsed = JSON.parse(rawValue) as {
      cacheDir?: string;
      ttl: {
        value: number;
        unit: DurationUnit;
      };
    };

    if (!parsed || typeof parsed !== "object") {
      throw new Error("FIGMA_CACHING must be a JSON object");
    }

    if (!parsed.ttl || typeof parsed.ttl.value !== "number" || parsed.ttl.value <= 0) {
      throw new Error("FIGMA_CACHING.ttl.value must be a positive number");
    }

    if (!parsed.ttl.unit || !(parsed.ttl.unit in DURATION_IN_MS)) {
      throw new Error("FIGMA_CACHING.ttl.unit must be one of ms, s, m, h, d");
    }

    const ttlMs = parsed.ttl.value * DURATION_IN_MS[parsed.ttl.unit];
    const cacheDir = resolveCacheDir(parsed.cacheDir);

    return { cacheDir, ttlMs };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to parse FIGMA_CACHING: ${message}`);
    process.exit(1);
  }
}

function resolveCacheDir(inputPath?: string): string {
  const defaultDir = getDefaultCacheDir();
  if (!inputPath) {
    return defaultDir;
  }

  const expanded = expandHomeDir(inputPath.trim());
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolvePath(process.cwd(), expanded);
}

function expandHomeDir(targetPath: string): string {
  if (targetPath === "~") {
    return os.homedir();
  }

  if (targetPath.startsWith("~/")) {
    return resolvePath(os.homedir(), targetPath.slice(2));
  }

  return targetPath;
}

function getDefaultCacheDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const base = process.env.LOCALAPPDATA || resolvePath(os.homedir(), "AppData", "Local");
    return join(base, "FigmaMcpCache");
  }

  if (platform === "darwin") {
    return join(os.homedir(), "Library", "Caches", "FigmaMcp");
  }

  const xdgCache = process.env.XDG_CACHE_HOME || join(os.homedir(), ".cache");
  return join(xdgCache, "figma-mcp");
}
