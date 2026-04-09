import { z } from "zod";
import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import { FigmaService } from "~/services/figma.js";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
  getNodesProcessed,
} from "~/extractors/index.js";
import { Logger, writeLogs } from "~/utils/logger.js";
import { serializeResult } from "~/utils/serialize.js";
import { sendProgress, startProgressHeartbeat, type ToolExtra } from "~/mcp/progress.js";
import { captureToolCall, type AuthMode, type Transport } from "~/services/telemetry.js";

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

// Simplified handler function
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

    // Replace - with : in nodeId for our query—Figma API expects :
    const nodeId = rawNodeId?.replace(/-/g, ":");

    Logger.log(
      `Fetching ${depth ? `${depth} layers deep` : "all layers"} of ${
        nodeId ? `node ${nodeId} from file` : `full file`
      } ${fileKey}`,
    );

    await sendProgress(extra, 0, 4, "Fetching design data from Figma API");
    const stopHeartbeat = startProgressHeartbeat(extra, "Waiting for Figma API response");

    // Get raw Figma API response
    let rawApiResponse: GetFileResponse | GetFileNodesResponse;
    let rawResult: { data: GetFileResponse | GetFileNodesResponse; rawSize: number };
    try {
      if (nodeId) {
        rawResult = await figmaService.getRawNode(fileKey, nodeId, depth);
      } else {
        rawResult = await figmaService.getRawFile(fileKey, depth);
      }
      rawApiResponse = rawResult.data;
      rawSizeKb = rawResult.rawSize / 1024;
    } finally {
      stopHeartbeat();
    }

    await sendProgress(extra, 1, 4, "Fetched design data, simplifying");
    const stopSimplifyHeartbeat = startProgressHeartbeat(
      extra,
      () => `Simplifying design data (${getNodesProcessed()} nodes processed)`,
    );

    // Use unified design extraction (handles nodes + components consistently)
    let simplifiedDesign;
    try {
      simplifiedDesign = await simplifyRawFigmaObject(rawApiResponse, allExtractors, {
        maxDepth: depth,
        afterChildren: collapseSvgContainers,
      });
    } finally {
      stopSimplifyHeartbeat();
    }

    nodeCount = simplifiedDesign.nodes.length;

    writeLogs("figma-simplified.json", simplifiedDesign);

    Logger.log(
      `Successfully extracted data: ${simplifiedDesign.nodes.length} nodes, ${
        Object.keys(simplifiedDesign.globalVars.styles).length
      } styles`,
    );

    await sendProgress(extra, 2, 4, "Simplified design, serializing response");

    const { nodes, globalVars, ...metadata } = simplifiedDesign;
    const result = {
      metadata,
      nodes,
      globalVars,
    };

    Logger.log(`Generating ${outputFormat.toUpperCase()} result from extracted data`);
    const formattedResult = serializeResult(result, outputFormat);
    simplifiedSizeKb = Buffer.byteLength(formattedResult, "utf8") / 1024;

    await sendProgress(extra, 3, 4, "Serialized, sending response");

    Logger.log("Sending result to client");
    return {
      content: [{ type: "text" as const, text: formattedResult }],
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
