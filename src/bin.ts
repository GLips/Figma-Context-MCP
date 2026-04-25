#!/usr/bin/env node

import { cli } from "cleye";
import { getServerConfig } from "./config.js";
import { startServer } from "./server.js";
import { fetchCommand } from "./commands/fetch.js";

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
      description:
        "Output data from tools in JSON format instead of YAML. Back-compat alias for --format=json.",
    },
    format: {
      type: String,
      description:
        "Output format for design data: yaml (default), json, or tree (experimental compact format).",
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
    proxy: {
      type: String,
      description:
        "HTTP proxy URL for networks that require a proxy (e.g. http://proxy:8080). Pass 'none' to ignore HTTP_PROXY/HTTPS_PROXY from the environment and connect directly.",
    },
    stdio: {
      type: Boolean,
      description: "Run in stdio transport mode for MCP clients",
    },
    noTelemetry: {
      type: Boolean,
      description: "Disable usage telemetry (telemetry is on by default)",
    },
  },
  commands: [fetchCommand],
});

// Subcommand callbacks execute during cli() — only start the server when no subcommand ran.
if (!argv.command) {
  // NODE_ENV=cli is a legacy backdoor for stdio mode
  const isStdio = argv.flags.stdio === true || process.env.NODE_ENV === "cli";
  const config = getServerConfig({ ...argv.flags, stdio: isStdio });
  startServer(config).catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
