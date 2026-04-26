import { z } from "zod";
import { FigmaService } from "~/services/figma.js";
import { Logger } from "~/utils/logger.js";
import { sendProgress, startProgressHeartbeat, type ToolExtra } from "~/mcp/progress.js";
import {
  captureGetFigmaDataCall,
  type AuthMode,
  type ClientInfo,
  type Transport,
} from "~/telemetry/index.js";
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
      "The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided. Use format '1234:5678' for a standard node, or 'I5666:180910;1:10515;1:10336' for a deeply nested instance node (the semicolon-joined path represents the instance override chain - it's still a single node ID, not multiple nodes).",
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

function formatCacheNotice(cachedAt: number, ttlMs: number): string {
  const age = Date.now() - cachedAt;
  const remaining = Math.max(ttlMs - age, 0);

  const formatDuration = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  };

  return `Note: Using cached Figma data (fetched ${formatDuration(age)} ago, expires in ${formatDuration(remaining)}) due to FIGMA_CACHING.`;
}

async function getFigmaData(
  params: GetFigmaDataParams,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
  transport: Transport,
  authMode: AuthMode,
  clientInfo: ClientInfo | undefined,
  extra: ToolExtra,
) {
  try {
    const { fileKey, nodeId: rawNodeId, depth } = parametersSchema.parse(params);

    const nodeId = rawNodeId?.replace(/-/g, ":");

    Logger.log(
      `Fetching ${depth ? `${depth} layers deep` : "all layers"} of ${
        nodeId ? `node ${nodeId} from file` : `full file`
      } ${fileKey}`,
    );

    let stopFetchHeartbeat: (() => Promise<void>) | undefined;
    let stopSimplifyHeartbeat: (() => Promise<void>) | undefined;

    const result = await runGetFigmaData(figmaService, { fileKey, nodeId, depth }, outputFormat, {
      onFetchStart: async () => {
        await sendProgress(extra, 0, 3, "Fetching design data from Figma API");
        stopFetchHeartbeat = startProgressHeartbeat(extra, "Waiting for Figma API response");
      },
      onFetchComplete: async () => {
        await stopFetchHeartbeat?.();
      },
      onSimplifyStart: async (progress) => {
        await sendProgress(extra, 1, 3, "Fetched design data, simplifying");
        stopSimplifyHeartbeat = startProgressHeartbeat(
          extra,
          () => `Simplifying design data (${progress.getNodeCount()} nodes processed)`,
        );
      },
      onSimplifyComplete: async () => {
        await stopSimplifyHeartbeat?.();
      },
      onSerializeStart: async () => {
        await sendProgress(extra, 2, 3, "Simplified design, serializing response");
      },
      onComplete: (outcome) =>
        captureGetFigmaDataCall(outcome, { transport, authMode, clientInfo }),
    });

    let formatted = result.formatted;
    if (result.cacheInfo?.usedCache && result.cacheInfo.cachedAt && result.cacheInfo.ttlMs) {
      formatted = `${formatCacheNotice(result.cacheInfo.cachedAt, result.cacheInfo.ttlMs)}\n\n${formatted}`;
    }

    Logger.log(`Successfully extracted data: ${result.metrics.simplifiedNodeCount} nodes`);
    Logger.log("Sending result to client");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error fetching file ${params.fileKey}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error fetching file: ${message}` }],
    };
  }
}

export const getFigmaDataTool = {
  name: "get_figma_data",
  description:
    "Get comprehensive Figma file data including layout, content, visuals, and component information",
  parametersSchema,
  handler: getFigmaData,
} as const;
