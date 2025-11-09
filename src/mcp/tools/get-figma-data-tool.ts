import { z } from "zod";
import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import { FigmaService, type CacheInfo } from "~/services/figma.js";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
} from "~/extractors/index.js";
import yaml from "js-yaml";
import { Logger, writeLogs } from "~/utils/logger.js";

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

// Format a human-readable cache notice
function formatCacheNotice(cachedAt: number, ttlMs: number): string {
  const now = Date.now();
  const age = now - cachedAt;
  const remaining = ttlMs - age;

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

  return `ℹ️ Note: Using cached Figma data (fetched ${formatDuration(age)} ago, expires in ${formatDuration(remaining)}) due to FIGMA_CACHING environment variable.`;
}

// Simplified handler function
async function getFigmaData(
  params: GetFigmaDataParams,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
) {
  try {
    const { fileKey, nodeId: rawNodeId, depth } = parametersSchema.parse(params);

    // Replace - with : in nodeId for our query—Figma API expects :
    const nodeId = rawNodeId?.replace(/-/g, ":");

    Logger.log(
      `Fetching ${depth ? `${depth} layers deep` : "all layers"} of ${
        nodeId ? `node ${nodeId} from file` : `full file`
      } ${fileKey}`,
    );

    // Get raw Figma API response
    let rawApiResponse: GetFileResponse | GetFileNodesResponse;
    let cacheInfo: CacheInfo;
    if (nodeId) {
      const result = await figmaService.getRawNode(fileKey, nodeId, depth);
      rawApiResponse = result.data;
      cacheInfo = result.cacheInfo;
    } else {
      const result = await figmaService.getRawFile(fileKey, depth);
      rawApiResponse = result.data;
      cacheInfo = result.cacheInfo;
    }

    // Use unified design extraction (handles nodes + components consistently)
    const simplifiedDesign = simplifyRawFigmaObject(rawApiResponse, allExtractors, {
      maxDepth: depth,
      afterChildren: collapseSvgContainers,
    });

    writeLogs("figma-simplified.json", simplifiedDesign);

    Logger.log(
      `Successfully extracted data: ${simplifiedDesign.nodes.length} nodes, ${
        Object.keys(simplifiedDesign.globalVars.styles).length
      } styles`,
    );

    const { nodes, globalVars, ...metadata } = simplifiedDesign;
    const result = {
      metadata,
      nodes,
      globalVars,
    };

    Logger.log(`Generating ${outputFormat.toUpperCase()} result from extracted data`);
    let formattedResult =
      outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);

    // Prepend cache notice if data came from cache
    if (cacheInfo.usedCache && cacheInfo.cachedAt && cacheInfo.ttlMs) {
      const cacheNotice = formatCacheNotice(cacheInfo.cachedAt, cacheInfo.ttlMs);
      formattedResult = `${cacheNotice}\n\n${formattedResult}`;
    }

    Logger.log("Sending result to client");
    return {
      content: [{ type: "text" as const, text: formattedResult }],
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

// Export tool configuration
export const getFigmaDataTool = {
  name: "get_figma_data",
  description:
    "Get comprehensive Figma file data including layout, content, visuals, and component information",
  parameters,
  handler: getFigmaData,
} as const;
