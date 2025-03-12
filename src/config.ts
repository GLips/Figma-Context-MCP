import { config } from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// Load environment variables from .env file
config();

interface ServerConfig {
  figmaApiKey: string;
  port: number;
  gitlabToken: string;
  gitlabBaseUrl: string;
  gitlabProjectId: string;
  gitlabBranch: string;
  configSources: {
    figmaApiKey: "cli" | "env";
    port: "cli" | "env" | "default";
    gitlabToken: "cli" | "env" | "none";
    gitlabBaseUrl: "cli" | "env" | "none";
    gitlabProjectId: "cli" | "env" | "none";
    gitlabBranch: "cli" | "env" | "none";
  };
}

function maskApiKey(key: string): string {
  if (key.length <= 4) return "****";
  return `****${key.slice(-4)}`;
}

interface CliArgs {
  "figma-api-key"?: string;
  port?: number;
  "gitlab-token"?: string;
  "gitlab-base-url"?: string;
  "gitlab-project-id"?: string;
  "gitlab-branch"?: string;
}

export function getServerConfig(isStdioMode: boolean): ServerConfig {
  // Parse command line arguments
  const argv = yargs(hideBin(process.argv))
    .options({
      "figma-api-key": {
        type: "string",
        description: "Figma API key",
      },
      port: {
        type: "number",
        description: "Port to run the server on",
      },
      "gitlab-token": {
        type: "string",
        description: "GitLab API token",
      },
      "gitlab-base-url": {
        type: "string",
        description: "GitLab API base URL",
      },
      "gitlab-project-id": {
        type: "string",
        description: "GitLab project ID or path",
      },
      "gitlab-branch": {
        type: "string",
        description: "GitLab branch to use",
      },
    })
    .help()
    .parseSync() as CliArgs;

  const config: ServerConfig = {
    figmaApiKey: "",
    port: 3333,
    gitlabToken: "",
    gitlabBaseUrl: "",
    gitlabProjectId: "",
    gitlabBranch: "",
    configSources: {
      figmaApiKey: "env",
      port: "default",
      gitlabToken: "none",
      gitlabBaseUrl: "none",
      gitlabProjectId: "none",
      gitlabBranch: "none",
    },
  };

  // Handle FIGMA_API_KEY
  if (argv["figma-api-key"]) {
    config.figmaApiKey = argv["figma-api-key"];
    config.configSources.figmaApiKey = "cli";
  } else if (process.env.FIGMA_API_KEY) {
    config.figmaApiKey = process.env.FIGMA_API_KEY;
    config.configSources.figmaApiKey = "env";
  }

  // Handle PORT
  if (argv.port) {
    config.port = argv.port;
    config.configSources.port = "cli";
  } else if (process.env.PORT) {
    config.port = parseInt(process.env.PORT, 10);
    config.configSources.port = "env";
  }

  // Handle GITLAB_TOKEN
  if (argv["gitlab-token"]) {
    config.gitlabToken = argv["gitlab-token"];
    config.configSources.gitlabToken = "cli";
  } else if (process.env.GITLAB_TOKEN) {
    config.gitlabToken = process.env.GITLAB_TOKEN;
    config.configSources.gitlabToken = "env";
  }

  // Handle GITLAB_BASE_URL
  if (argv["gitlab-base-url"]) {
    config.gitlabBaseUrl = argv["gitlab-base-url"];
    config.configSources.gitlabBaseUrl = "cli";
  } else if (process.env.GITLAB_BASE_URL) {
    config.gitlabBaseUrl = process.env.GITLAB_BASE_URL;
    config.configSources.gitlabBaseUrl = "env";
  }

  // Handle GITLAB_PROJECT_ID
  if (argv["gitlab-project-id"]) {
    config.gitlabProjectId = argv["gitlab-project-id"];
    config.configSources.gitlabProjectId = "cli";
  } else if (process.env.GITLAB_PROJECT_ID) {
    config.gitlabProjectId = process.env.GITLAB_PROJECT_ID;
    config.configSources.gitlabProjectId = "env";
  }

  // Handle GITLAB_BRANCH
  if (argv["gitlab-branch"]) {
    config.gitlabBranch = argv["gitlab-branch"];
    config.configSources.gitlabBranch = "cli";
  } else if (process.env.GITLAB_BRANCH) {
    config.gitlabBranch = process.env.GITLAB_BRANCH;
    config.configSources.gitlabBranch = "env";
  }

  // Validate configuration
  if (!config.figmaApiKey) {
    console.error("FIGMA_API_KEY is required (via CLI argument --figma-api-key or .env file)");
    process.exit(1);
  }

  // Log configuration sources
  if (!isStdioMode) {
    console.log("\nConfiguration:");
    console.log(
      `- FIGMA_API_KEY: ${maskApiKey(config.figmaApiKey)} (source: ${config.configSources.figmaApiKey})`,
    );
    console.log(`- PORT: ${config.port} (source: ${config.configSources.port})`);
    
    // Log GitLab configuration if available
    if (config.gitlabToken) {
      console.log(
        `- GITLAB_TOKEN: ${maskApiKey(config.gitlabToken)} (source: ${config.configSources.gitlabToken})`,
      );
      console.log(
        `- GITLAB_BASE_URL: ${config.gitlabBaseUrl} (source: ${config.configSources.gitlabBaseUrl})`,
      );
      console.log(
        `- GITLAB_PROJECT_ID: ${config.gitlabProjectId} (source: ${config.configSources.gitlabProjectId})`,
      );
      console.log(
        `- GITLAB_BRANCH: ${config.gitlabBranch} (source: ${config.configSources.gitlabBranch})`,
      );
    }
    
    console.log(); // Empty line for better readability
  }

  return config;
}
