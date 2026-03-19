import { cli } from "cleye";
import { config as loadEnv } from "dotenv";
import { resolve as resolvePath } from "path";
import type { FigmaAuthOptions } from "./services/figma.js";

type Source = "cli" | "env" | "default";

interface Resolved<T> {
  value: T;
  source: Source;
}

interface ServerConfig {
  auth: FigmaAuthOptions;
  port: number;
  host: string;
  outputFormat: "yaml" | "json";
  skipImageDownloads: boolean;
  imageDir: string;
  isStdioMode: boolean;
  configSources: Record<string, Source>;
}

/** Resolve a config value through the priority chain: CLI flag → env var → default. */
function resolve<T>(flag: T | undefined, env: T | undefined, fallback: T): Resolved<T> {
  if (flag !== undefined) return { value: flag, source: "cli" };
  if (env !== undefined) return { value: env, source: "env" };
  return { value: fallback, source: "default" };
}

function envStr(name: string): string | undefined {
  return process.env[name] || undefined;
}

function envInt(...names: string[]): number | undefined {
  for (const name of names) {
    const val = process.env[name];
    if (val) return parseInt(val, 10);
  }
  return undefined;
}

function envBool(name: string): boolean | undefined {
  const val = process.env[name];
  if (val === "true") return true;
  if (val === "false") return false;
  return undefined;
}

function maskApiKey(key: string): string {
  if (!key || key.length <= 4) return "****";
  return `****${key.slice(-4)}`;
}

export function getServerConfig(): ServerConfig {
  const argv = cli({
    name: "figma-developer-mcp",
    version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
    flags: {
      figmaApiKey: {
        type: String,
        description: "Figma API key (Personal Access Token)",
      },
      figmaOauthToken: {
        type: String,
        description: "Figma OAuth Bearer token",
      },
      env: {
        type: String,
        description: "Path to custom .env file to load environment variables from",
      },
      port: {
        type: Number,
        description: "Port to run the server on",
      },
      host: {
        type: String,
        description: "Host to run the server on",
      },
      json: {
        type: Boolean,
        description: "Output data from tools in JSON format instead of YAML",
      },
      skipImageDownloads: {
        type: Boolean,
        description: "Do not register the download_figma_images tool (skip image downloads)",
      },
      imageDir: {
        type: String,
        description:
          "Base directory for image downloads. The download tool will only write files within this directory. Defaults to the current working directory.",
      },
      stdio: {
        type: Boolean,
        description: "Run in stdio transport mode for MCP clients",
      },
    },
  });

  // Load .env before resolving env-backed values
  const envFilePath = argv.flags.env
    ? resolvePath(argv.flags.env)
    : resolvePath(process.cwd(), ".env");
  const envFileSource: Source = argv.flags.env ? "cli" : "default";
  loadEnv({ path: envFilePath, override: true });

  // Resolve config values: CLI flag → env var → default
  const figmaApiKey = resolve(argv.flags.figmaApiKey, envStr("FIGMA_API_KEY"), "");
  const figmaOauthToken = resolve(argv.flags.figmaOauthToken, envStr("FIGMA_OAUTH_TOKEN"), "");
  const port = resolve(argv.flags.port, envInt("FRAMELINK_PORT", "PORT"), 3333);
  const host = resolve(argv.flags.host, envStr("FRAMELINK_HOST"), "127.0.0.1");
  const skipImageDownloads = resolve(
    argv.flags.skipImageDownloads,
    envBool("SKIP_IMAGE_DOWNLOADS"),
    false,
  );
  const envImageDir = envStr("IMAGE_DIR");
  const imageDir = resolve(
    argv.flags.imageDir ? resolvePath(argv.flags.imageDir) : undefined,
    envImageDir ? resolvePath(envImageDir) : undefined,
    process.cwd(),
  );

  // These two don't fit the simple pattern: --json maps to a string enum,
  // and --stdio has a NODE_ENV backdoor.
  const outputFormat = resolve<"yaml" | "json">(
    argv.flags.json ? "json" : undefined,
    envStr("OUTPUT_FORMAT") as "yaml" | "json" | undefined,
    "yaml",
  );
  const isStdioMode = argv.flags.stdio === true || process.env.NODE_ENV === "cli";

  // Auth
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

  const configSources: Record<string, Source> = {
    envFile: envFileSource,
    figmaApiKey: figmaApiKey.source,
    figmaOauthToken: figmaOauthToken.source,
    port: port.source,
    host: host.source,
    outputFormat: outputFormat.source,
    skipImageDownloads: skipImageDownloads.source,
    imageDir: imageDir.source,
  };

  if (!isStdioMode) {
    console.log("\nConfiguration:");
    console.log(`- ENV_FILE: ${envFilePath} (source: ${configSources.envFile})`);
    if (useOAuth) {
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
    console.log(`- OUTPUT_FORMAT: ${outputFormat.value} (source: ${configSources.outputFormat})`);
    console.log(
      `- SKIP_IMAGE_DOWNLOADS: ${skipImageDownloads.value} (source: ${configSources.skipImageDownloads})`,
    );
    console.log(`- IMAGE_DIR: ${imageDir.value} (source: ${configSources.imageDir})`);
    console.log();
  }

  return {
    auth,
    port: port.value,
    host: host.value,
    outputFormat: outputFormat.value,
    skipImageDownloads: skipImageDownloads.value,
    imageDir: imageDir.value,
    isStdioMode,
    configSources,
  };
}
