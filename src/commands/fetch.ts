import { type Command, command } from "cleye";
import { loadEnvFile, parseOutputFormat, resolveAuth } from "~/config.js";
import { FigmaService } from "~/services/figma.js";
import { parseFigmaUrl } from "~/utils/figma-url.js";
import {
  initTelemetry,
  captureGetFigmaDataCall,
  shutdown,
  type AuthMode,
} from "~/telemetry/index.js";
import { getFigmaData } from "~/services/get-figma-data.js";
import type { OutputFormat } from "~/utils/serialize.js";

export const fetchCommand: Command = command(
  {
    name: "fetch",
    description: "Fetch simplified Figma data and print to stdout",
    parameters: ["[url]"],
    flags: {
      fileKey: {
        type: String,
        description: "Figma file key (overrides URL)",
      },
      nodeId: {
        type: String,
        description: "Node ID, format 1234:5678 (overrides URL)",
      },
      depth: {
        type: Number,
        description: "Tree traversal depth",
      },
      json: {
        type: Boolean,
        description: "Output JSON instead of YAML. Back-compat alias for --format=json.",
      },
      format: {
        type: String,
        description: "Output format: yaml (default), json, or tree (experimental).",
      },
      figmaApiKey: {
        type: String,
        description: "Figma API key",
      },
      figmaOauthToken: {
        type: String,
        description: "Figma OAuth token",
      },
      env: {
        type: String,
        description: "Path to .env file",
      },
      noTelemetry: {
        type: Boolean,
        description: "Disable usage telemetry",
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
    console.error("Either a Figma URL or --file-key is required");
    process.exit(1);
  }

  loadEnvFile(flags.env);
  const auth = resolveAuth(flags);

  // Initialize telemetry only after input validation succeeds, so every
  // captured event corresponds to an actual fetch attempt (not a usage error).
  initTelemetry({
    optOut: flags.noTelemetry,
    immediateFlush: true,
    redactFromErrors: [auth.figmaApiKey, auth.figmaOAuthToken],
  });

  const authMode: AuthMode = auth.useOAuth ? "oauth" : "api_key";
  const outputFormat: OutputFormat =
    parseOutputFormat(flags.format, "--format") ?? (flags.json ? "json" : "yaml");

  const result = await getFigmaData(
    new FigmaService(auth),
    { fileKey, nodeId, depth: flags.depth },
    outputFormat,
    {
      onComplete: (outcome) => captureGetFigmaDataCall(outcome, { transport: "cli", authMode }),
    },
  );
  console.log(result.formatted);
}
