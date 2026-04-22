import { config as loadEnv } from "dotenv";
import os from "os";
import { isAbsolute, join, resolve as resolvePath } from "path";
import type { FigmaAuthOptions } from "./services/figma.js";
import type { FigmaCachingOptions } from "./services/figma-file-cache.js";
import { resolveTelemetryEnabled } from "./telemetry/index.js";

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
  outputFormat: "yaml" | "json";
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

  if (!auth.figmaApiKey && !auth.figmaOAuthToken) {
    console.error(
      "Either FIGMA_API_KEY or FIGMA_OAUTH_TOKEN is required (via CLI argument or .env file)",
    );
    process.exit(1);
  }

  return auth;
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
  const outputFormat = resolve<"yaml" | "json">(
    flags.json ? "json" : undefined,
    envStr("OUTPUT_FORMAT") as "yaml" | "json" | undefined,
    "yaml",
  );
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
    } else {
      console.log(
        `- FIGMA_API_KEY: ${maskApiKey(auth.figmaApiKey)} (source: ${configSources.figmaApiKey})`,
      );
      console.log("- Authentication Method: Personal Access Token (X-Figma-Token)");
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
