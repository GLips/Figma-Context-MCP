#!/usr/bin/env node

import { cli } from "cleye";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, getServerConfig, UsageError } from "./config.js";
import { CLI_NAME } from "./utils/cli-help.js";
import { startServer } from "./server.js";
import { CLI_COMMANDS } from "./commands/index.js";
import { enableLogging } from "./utils/logger.js";

// stderr until the server starts: the commands and stdio mode keep stdout for their output.
enableLogging({ http: false });

// Defaults live in the descriptions, not cleye's `default`: a parsed default would outrank the env
// var in getServerConfig's flag → env → default resolution.
const ROOT_HELP_DESCRIPTION = `Framelink MCP for Figma. With no command, runs the MCP server: over HTTP at
http://${DEFAULT_HTTP_HOST}:${DEFAULT_HTTP_PORT}/mcp, or over stdin/stdout with --stdio, which is what most MCP client
configs launch.

Reading over the Figma REST API needs a token (--figma-api-key or FIGMA_API_KEY): the read tools,
fetch and comments. The Framelink Figma plugin needs none: its tools appear once it connects, and
execute reads and edits the open file through it.
Flags can also be set by the env var named in their description, or in a .env file.

The commands do the same jobs from a shell. Run \`${CLI_NAME} <command> --help\` for details.`;

const argv = cli({
  name: CLI_NAME,
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
  help: {
    description: ROOT_HELP_DESCRIPTION,
    examples: [`${CLI_NAME} --stdio --figma-api-key <token>`, `${CLI_NAME} --port 8080`],
  },
  flags: {
    stdio: {
      type: Boolean,
      description: "Serve MCP over stdin/stdout instead of HTTP",
    },
    figmaApiKey: {
      type: String,
      placeholder: "<token>",
      description: "Figma personal access token (env FIGMA_API_KEY)",
    },
    figmaOauthToken: {
      type: String,
      placeholder: "<token>",
      description:
        "Figma OAuth bearer token; used instead of the API key when set (env FIGMA_OAUTH_TOKEN)",
    },
    env: {
      type: String,
      placeholder: "<file>",
      description: "Load environment variables from this file (default ./.env)",
    },
    port: {
      type: Number,
      placeholder: "<n>",
      description: `HTTP port (default ${DEFAULT_HTTP_PORT}; env FRAMELINK_PORT or PORT)`,
    },
    host: {
      type: String,
      placeholder: "<address>",
      description: `HTTP bind address (default ${DEFAULT_HTTP_HOST}; env FRAMELINK_HOST)`,
    },
    json: {
      type: Boolean,
      description: "Alias for --format json",
    },
    format: {
      type: String,
      placeholder: "<tree|yaml|json>",
      description:
        "get_figma_data output format (default tree, the most compact; env OUTPUT_FORMAT)",
    },
    skipImageDownloads: {
      type: Boolean,
      description: "Don't offer the download_figma_images tool (env SKIP_IMAGE_DOWNLOADS)",
    },
    imageDir: {
      type: String,
      placeholder: "<dir>",
      description:
        "download_figma_images may only write inside this directory (default cwd; env IMAGE_DIR)",
    },
    proxy: {
      type: String,
      placeholder: "<url|none>",
      description:
        "Proxy for Figma API calls, e.g. http://proxy:8080; 'none' ignores HTTP(S)_PROXY (env FIGMA_PROXY)",
    },
    assetRoot: {
      type: String,
      placeholder: "<dir>",
      description:
        "Local files flcm.image() may read must be inside this directory (default cwd; env FRAMELINK_ASSET_ROOT)",
    },
    codeMode: {
      type: Boolean,
      description:
        "Advertise the plugin's tools from startup rather than on connect, for MCP clients that cache the tool list (env FIGMA_CODE_MODE)",
    },
    noTelemetry: {
      type: Boolean,
      description: "Turn off usage telemetry (env FRAMELINK_TELEMETRY=off or DO_NOT_TRACK=1)",
    },
  },
  commands: CLI_COMMANDS,
});

// Subcommand callbacks execute during cli() — only start the server when no subcommand ran.
if (!argv.command) {
  main().catch((error) => {
    if (error instanceof UsageError) {
      console.error(error.message);
    } else {
      console.error("Failed to start server:", error);
    }
    process.exit(1);
  });
}

async function main(): Promise<void> {
  // NODE_ENV=cli is a legacy backdoor for stdio mode
  const isStdio = argv.flags.stdio === true || process.env.NODE_ENV === "cli";
  const config = getServerConfig({ ...argv.flags, stdio: isStdio });
  await startServer(config);
}
