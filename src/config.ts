import { config as loadEnv } from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { resolve } from "path";

interface ServerConfig {
  port: number;
  host: string;
  outputFormat: "yaml" | "json";
  skipImageDownloads?: boolean;
}

interface CliArgs {
  env?: string;
  port?: number;
  host?: string;
  json?: boolean;
  "skip-image-downloads"?: boolean;
}

export function getServerConfig(isStdioMode: boolean): ServerConfig {
  const argv = yargs(hideBin(process.argv))
    .options({
      env: {
        type: "string",
        description: "Path to custom .env file to load environment variables from",
      },
      port: {
        type: "number",
        description: "Port to run the server on",
      },
      host: {
        type: "string",
        description: "Host to run the server on",
      },
      json: {
        type: "boolean",
        description: "Output data from tools in JSON format instead of YAML",
        default: false,
      },
      "skip-image-downloads": {
        type: "boolean",
        description: "Do not register the download_figma_images tool (skip image downloads)",
        default: false,
      },
    })
    .help()
    .version(process.env.NPM_PACKAGE_VERSION ?? "unknown")
    .parseSync() as CliArgs;

  const envFilePath = argv["env"] ? resolve(argv["env"]) : resolve(process.cwd(), ".env");
  loadEnv({ path: envFilePath, override: true });

  const config: ServerConfig = {
    port: 3333,
    host: "127.0.0.1",
    outputFormat: "yaml",
    skipImageDownloads: false,
  };

  if (argv.port) {
    config.port = argv.port;
  } else if (process.env.FRAMELINK_PORT) {
    config.port = parseInt(process.env.FRAMELINK_PORT, 10);
  } else if (process.env.PORT) {
    config.port = parseInt(process.env.PORT, 10);
  }

  if (argv.host) {
    config.host = argv.host;
  } else if (process.env.FRAMELINK_HOST) {
    config.host = process.env.FRAMELINK_HOST;
  }

  if (argv.json) {
    config.outputFormat = "json";
  } else if (process.env.OUTPUT_FORMAT) {
    config.outputFormat = process.env.OUTPUT_FORMAT as "yaml" | "json";
  }

  if (argv["skip-image-downloads"] || process.env.SKIP_IMAGE_DOWNLOADS === "true") {
    config.skipImageDownloads = true;
  }

  if (!isStdioMode) {
    console.log("\nConfiguration:");
    console.log(`- FRAMELINK_PORT: ${config.port}`);
    console.log(`- FRAMELINK_HOST: ${config.host}`);
    console.log(`- OUTPUT_FORMAT: ${config.outputFormat}`);
    console.log(`- SKIP_IMAGE_DOWNLOADS: ${config.skipImageDownloads}`);
    console.log();
  }

  return config;
}
