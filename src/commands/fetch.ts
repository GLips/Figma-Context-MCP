import { type Command, command } from "cleye";
import {
  loadEnvFile,
  parseOutputFormat,
  resolveAuth,
  requireGlobalCredentials,
  UsageError,
} from "~/config.js";
import { FigmaService, staticCredentialSource } from "~/services/figma.js";
import { parseFigmaUrl } from "~/utils/figma-url.js";
import { authMode, initTelemetry, captureGetFigmaDataCall, shutdown } from "~/telemetry/index.js";
import { getFigmaData } from "~/services/get-figma-data.js";
import type { OutputFormat } from "~/utils/serialize.js";
import { buildCommandHelp } from "~/utils/cli-help.js";

export const fetchCommand: Command = command(
  {
    name: "fetch",
    parameters: ["[url]"],
    help: buildCommandHelp({
      name: "fetch",
      summary: "Print a Figma file or node as simplified design data, like get_figma_data",
      details:
        "Reads over the Figma REST API, so it needs a token (--figma-api-key or FIGMA_API_KEY).\nA URL's node-id selects the node; without one you get the whole file, which can be large.",
      exampleArgs: [
        `"https://www.figma.com/design/<fileKey>/Name?node-id=12-34"`,
        "--file-key <fileKey> --node-id 12:34 --format json > node.json",
      ],
    }),
    flags: {
      fileKey: {
        type: String,
        placeholder: "<key>",
        description: "Figma file key; overrides the URL's",
      },
      nodeId: {
        type: String,
        placeholder: "<id>",
        description: "Node ID like 1234:5678; overrides the URL's",
      },
      depth: {
        type: Number,
        placeholder: "<n>",
        description: "Limit output to this many levels of children",
      },
      json: {
        type: Boolean,
        description: "Alias for --format json",
      },
      format: {
        type: String,
        placeholder: "<yaml|json|tree>",
        description: "Output format (default yaml; tree is the compact one the MCP server uses)",
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
      noTelemetry: {
        type: Boolean,
        description: "Turn off usage telemetry",
      },
    },
  },
  (argv) => {
    run(argv.flags, argv._)
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      })
      .finally(() => shutdown());
  },
);

async function run(
  flags: {
    fileKey?: string;
    nodeId?: string;
    depth?: number;
    json?: boolean;
    format?: string;
    figmaApiKey?: string;
    figmaOauthToken?: string;
    env?: string;
    noTelemetry?: boolean;
  },
  positionals: string[],
) {
  const url = positionals[0];
  let fileKey = flags.fileKey;
  let nodeId = flags.nodeId;

  if (url) {
    try {
      const parsed = parseFigmaUrl(url);
      fileKey ??= parsed.fileKey;
      nodeId ??= parsed.nodeId;
    } catch (error) {
      if (!fileKey) throw error;
      // fileKey provided via flag — malformed URL is non-fatal
    }
  }

  if (!fileKey) {
    throw new UsageError("Either a Figma URL or --file-key is required");
  }

  loadEnvFile(flags.env);
  const auth = resolveAuth(flags);
  // The fetch CLI has no per-request credential channel (unlike HTTP mode).
  // Fail fast so the user gets an actionable error instead of an HTTP-shaped
  // one from `getAuthHeaders`.
  requireGlobalCredentials(auth);

  // Initialize telemetry only after input validation succeeds, so every
  // captured event corresponds to an actual fetch attempt (not a usage error).
  initTelemetry({
    optOut: flags.noTelemetry,
    immediateFlush: true,
    redactFromErrors: [auth.figmaApiKey, auth.figmaOAuthToken],
  });

  const mode = authMode(auth);
  // The fetch CLI stays yaml-by-default (unlike the MCP server, which defaults
  // to tree): its output is piped into standard tooling (`> out.yaml`, `| jq`),
  // where tree's bespoke indented format isn't parseable. Tree's token-efficiency
  // win is for LLM consumers, not shell pipelines.
  const outputFormat: OutputFormat =
    parseOutputFormat(flags.format, "--format") ?? (flags.json ? "json" : "yaml");

  const result = await getFigmaData(
    new FigmaService(staticCredentialSource(auth)),
    { fileKey, nodeId, depth: flags.depth },
    outputFormat,
    {
      onComplete: (outcome) =>
        captureGetFigmaDataCall(outcome, { transport: "cli", authMode: mode }),
    },
  );
  console.log(result.formatted);
}
