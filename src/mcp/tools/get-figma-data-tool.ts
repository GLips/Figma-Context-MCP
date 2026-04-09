import { z } from "zod";
import { FigmaService } from "~/services/figma.js";
import { getNodesProcessed } from "~/extractors/index.js";
import { Logger } from "~/utils/logger.js";
import { sendProgress, startProgressHeartbeat, type ToolExtra } from "~/mcp/progress.js";
import { captureToolCall, type AuthMode, type Transport } from "~/services/telemetry.js";
import { getFigmaData as runGetFigmaData } from "~/services/get-figma-data.js";

const parameters = {
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe(
      "The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
    ),
  nodeId: z
    .string()
    .regex(
      /^I?\d+[:|-]\d+(?:;\d+[:|-]\d+)*$/,
      "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'",
    )
    .optional()
    .describe(
      "The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided. Use format '1234:5678' or 'I5666:180910;1:10515;1:10336' for multiple nodes.",
    ),
  depth: z
    .number()
    .optional()
    .describe(
      "OPTIONAL. Do NOT use unless explicitly requested by the user. Controls how many levels deep to traverse the node tree.",
    ),
};

const parametersSchema = z.object(parameters);
export type GetFigmaDataParams = z.infer<typeof parametersSchema>;

async function getFigmaData(
  params: GetFigmaDataParams,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
  transport: Transport,
  authMode: AuthMode,
  extra: ToolExtra,
) {
  const startedAt = Date.now();
  let isError = false;
  let errorType: string | undefined;
  let errorMessage: string | undefined;
  let rawSizeKb: number | undefined;
  let simplifiedSizeKb: number | undefined;
  let nodeCount: number | undefined;
  // Defaults cover the parse-failure path where these values were never bound.
  let depthForEvent: number | null = null;
  let hasNodeIdForEvent = false;

  try {
    const { fileKey, nodeId: rawNodeId, depth } = parametersSchema.parse(params);
    depthForEvent = depth ?? null;
    hasNodeIdForEvent = Boolean(rawNodeId);

    // Replace - with : in nodeId for our query — Figma API expects :.
    // MCP-specific input quirk, so it lives here rather than in the shared core.
    const nodeId = rawNodeId?.replace(/-/g, ":");

    Logger.log(
      `Fetching ${depth ? `${depth} layers deep` : "all layers"} of ${
        nodeId ? `node ${nodeId} from file` : `full file`
      } ${fileKey}`,
    );

    let stopFetchHeartbeat: (() => void) | undefined;
    let stopSimplifyHeartbeat: (() => void) | undefined;

    const result = await runGetFigmaData(figmaService, { fileKey, nodeId, depth }, outputFormat, {
      onFetchStart: async () => {
        await sendProgress(extra, 0, 4, "Fetching design data from Figma API");
        stopFetchHeartbeat = startProgressHeartbeat(extra, "Waiting for Figma API response");
      },
      onFetchComplete: () => {
        stopFetchHeartbeat?.();
      },
      onSimplifyStart: async () => {
        await sendProgress(extra, 1, 4, "Fetched design data, simplifying");
        stopSimplifyHeartbeat = startProgressHeartbeat(
          extra,
          () => `Simplifying design data (${getNodesProcessed()} nodes processed)`,
        );
      },
      onSimplifyComplete: () => {
        stopSimplifyHeartbeat?.();
      },
      onSerializeStart: async () => {
        await sendProgress(extra, 2, 4, "Simplified design, serializing response");
      },
    });

    rawSizeKb = result.metrics.rawSizeKb;
    simplifiedSizeKb = result.metrics.simplifiedSizeKb;
    nodeCount = result.metrics.nodeCount;

    Logger.log(`Successfully extracted data: ${nodeCount} nodes`);
    await sendProgress(extra, 3, 4, "Serialized, sending response");
    Logger.log("Sending result to client");

    return {
      content: [{ type: "text" as const, text: result.formatted }],
    };
  } catch (error) {
    isError = true;
    errorType = error instanceof Error ? error.constructor.name : "Unknown";
    errorMessage = error instanceof Error ? error.message : String(error);
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error fetching file ${params.fileKey}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error fetching file: ${message}` }],
    };
  } finally {
    captureToolCall({
      tool: "get_figma_data",
      duration_ms: Date.now() - startedAt,
      transport,
      output_format: outputFormat,
      auth_mode: authMode,
      is_error: isError,
      error_type: errorType,
      error_message: errorMessage,
      raw_size_kb: rawSizeKb,
      simplified_size_kb: simplifiedSizeKb,
      node_count: nodeCount,
      depth: depthForEvent,
      has_node_id: hasNodeIdForEvent,
    });
  }
}

// Export tool configuration
export const getFigmaDataTool = {
  name: "get_figma_data",
  description:
    "Get comprehensive Figma file data including layout, content, visuals, and component information",
  parametersSchema,
  handler: getFigmaData,
} as const;
