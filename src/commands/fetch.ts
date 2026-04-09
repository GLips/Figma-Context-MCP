import { type Command, command } from "cleye";
import { loadEnvFile, resolveAuth, resolveTelemetryEnabled } from "~/config.js";
import { FigmaService } from "~/services/figma.js";
import { parseFigmaUrl } from "~/utils/figma-url.js";
import {
  initTelemetry,
  captureGetFigmaDataCall,
  shutdown,
  type AuthMode,
} from "~/services/telemetry.js";
import { getFigmaData } from "~/services/get-figma-data.js";

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
        description: "Output JSON instead of YAML",
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
        description: "Disable anonymous usage telemetry",
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
    enabled: resolveTelemetryEnabled(flags.noTelemetry),
    figmaApiKey: auth.figmaApiKey,
    figmaOAuthToken: auth.figmaOAuthToken,
    immediateFlush: true,
  });

  const authMode: AuthMode = auth.useOAuth ? "oauth" : "api_key";
  const outputFormat = flags.json ? "json" : "yaml";

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
