import { type Command, command } from "cleye";
import { loadEnvFile, resolveAuth, resolveTelemetryEnabled } from "~/config.js";
import { FigmaService } from "~/services/figma.js";
import { parseFigmaUrl } from "~/utils/figma-url.js";
import { initTelemetry, captureToolCall, shutdown } from "~/services/telemetry.js";
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
  const telemetryEnabled = resolveTelemetryEnabled(flags.noTelemetry);
  const figmaService = new FigmaService(auth);

  const depth = flags.depth;
  const outputFormat = flags.json ? "json" : "yaml";

  // Initialize telemetry only after input validation succeeds, so every
  // captured event corresponds to an actual fetch attempt (not a usage error).
  initTelemetry({
    enabled: telemetryEnabled,
    figmaApiKey: auth.figmaApiKey,
    figmaOAuthToken: auth.figmaOAuthToken,
    immediateFlush: true,
  });

  const startedAt = Date.now();
  let isError = false;
  let errorType: string | undefined;
  let errorMessage: string | undefined;
  let rawSizeKb: number | undefined;
  let simplifiedSizeKb: number | undefined;
  let nodeCount: number | undefined;

  try {
    const result = await getFigmaData(figmaService, { fileKey, nodeId, depth }, outputFormat);
    rawSizeKb = result.metrics.rawSizeKb;
    simplifiedSizeKb = result.metrics.simplifiedSizeKb;
    nodeCount = result.metrics.nodeCount;
    console.log(result.formatted);
  } catch (error) {
    isError = true;
    errorType = error instanceof Error ? error.constructor.name : "Unknown";
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    captureToolCall({
      tool: "get_figma_data",
      duration_ms: Date.now() - startedAt,
      transport: "cli",
      output_format: outputFormat,
      auth_mode: auth.useOAuth ? "oauth" : "api_key",
      is_error: isError,
      error_type: errorType,
      error_message: errorMessage,
      raw_size_kb: rawSizeKb,
      simplified_size_kb: simplifiedSizeKb,
      node_count: nodeCount,
      depth: flags.depth ?? null,
      has_node_id: Boolean(nodeId),
    });
  }
}
