import { config } from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import type { FigmaAuthOptions } from "./services/figma.js";

// Load environment variables from .env file
config();

interface ServerConfig {
  auth: FigmaAuthOptions;
  port: number;
  configSources: {
    figmaApiKey: "cli" | "env";
    figmaOAuthToken: "cli" | "env" | "none";
    port: "cli" | "env" | "default";
  };
}

function maskApiKey(key: string): string {
  if (!key || key.length <= 4) return "****";
  return `****${key.slice(-4)}`;
}

interface CliArgs {
  "figma-api-key"?: string;
  "figma-oauth-token"?: string;
  port?: number;
}

export function getServerConfig(isStdioMode: boolean): ServerConfig {
  // Parse command line arguments
  const argv = yargs(hideBin(process.argv))
    .options({
      "figma-api-key": {
        type: "string",
        description: "Figma API key (Personal Access Token)",
      },
      "figma-oauth-token": {
        type: "string",
        description: "Figma OAuth Bearer token",
      },
      port: {
        type: "number",
        description: "Port to run the server on",
      },
    })
    .help()
    .version(process.env.NPM_PACKAGE_VERSION ?? "unknown")
    .parseSync() as CliArgs;

  const auth: FigmaAuthOptions = {
    figmaApiKey: "",
    figmaOAuthToken: "",
    useOAuth: false,
  };

  const config: Omit<ServerConfig, "auth"> = {
    port: 3333,
    configSources: {
      figmaApiKey: "env",
      figmaOAuthToken: "none",
      port: "default",
    },
  };

  // Handle FIGMA_API_KEY
  if (argv["figma-api-key"]) {
    auth.figmaApiKey = argv["figma-api-key"];
    config.configSources.figmaApiKey = "cli";
  } else if (process.env.FIGMA_API_KEY) {
    auth.figmaApiKey = process.env.FIGMA_API_KEY;
    config.configSources.figmaApiKey = "env";
  }

  // Handle FIGMA_OAUTH_TOKEN
  if (argv["figma-oauth-token"]) {
    auth.figmaOAuthToken = argv["figma-oauth-token"];
    config.configSources.figmaOAuthToken = "cli";
    auth.useOAuth = true;
  } else if (process.env.FIGMA_OAUTH_TOKEN) {
    auth.figmaOAuthToken = process.env.FIGMA_OAUTH_TOKEN;
    config.configSources.figmaOAuthToken = "env";
    auth.useOAuth = true;
  }

  // Handle PORT
  if (argv.port) {
    config.port = argv.port;
    config.configSources.port = "cli";
  } else if (process.env.PORT) {
    config.port = parseInt(process.env.PORT, 10);
    config.configSources.port = "env";
  }

  // Validate configuration
  if (!auth.figmaApiKey && !auth.figmaOAuthToken) {
    console.error(
      "Either FIGMA_API_KEY or FIGMA_OAUTH_TOKEN is required (via CLI argument or .env file)",
    );
    process.exit(1);
  }

  // Log configuration sources
  if (!isStdioMode) {
    console.log("\nConfiguration:");
    if (auth.useOAuth) {
      console.log(
        `- FIGMA_OAUTH_TOKEN: ${maskApiKey(auth.figmaOAuthToken)} (source: ${config.configSources.figmaOAuthToken})`,
      );
      console.log("- Authentication Method: OAuth Bearer Token");
    } else {
      console.log(
        `- FIGMA_API_KEY: ${maskApiKey(auth.figmaApiKey)} (source: ${config.configSources.figmaApiKey})`,
      );
      console.log("- Authentication Method: Personal Access Token (X-Figma-Token)");
    }
    console.log(`- PORT: ${config.port} (source: ${config.configSources.port})`);
    console.log(); // Empty line for better readability
  }

  return {
    ...config,
    auth,
  };
}
