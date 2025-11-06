import { z } from "zod";
import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import { FigmaService } from "~/services/figma.js";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
} from "~/extractors/index.js";
import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
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
  optimizeForAndroid: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "OPTIONAL. When true, removes unnecessary data for Android UI development (invisible nodes, slices, design metadata).",
    ),
};

const parametersSchema = z.object(parameters);
export type GetFigmaDataParams = z.infer<typeof parametersSchema>;

/**
 * Simplify data specifically for Android UI development
 * Removes metadata and properties not needed for Android implementation
 */
function simplifyForAndroid(design: SimplifiedDesign): SimplifiedDesign {
  const simplifiedNodes = design.nodes.map((node) => simplifyNodeForAndroid(node));
  
  return {
    name: design.name,
    nodes: simplifiedNodes,
    components: design.components,
    componentSets: design.componentSets,
    globalVars: design.globalVars,
  };
}

/**
 * Recursively simplify a node for Android development
 */
function simplifyNodeForAndroid(node: SimplifiedNode): SimplifiedNode {
  const simplified: SimplifiedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
  };
  
  // Keep essential layout and appearance data
  if (node.layout) simplified.layout = node.layout;
  if (node.text) simplified.text = node.text;
  if (node.textStyle) simplified.textStyle = node.textStyle;
  if (node.fills) simplified.fills = node.fills;
  if (node.strokes) simplified.strokes = node.strokes;
  if (node.strokeWeight) simplified.strokeWeight = node.strokeWeight;
  if (node.effects) simplified.effects = node.effects;
  if (node.opacity) simplified.opacity = node.opacity;
  if (node.borderRadius) simplified.borderRadius = node.borderRadius;
  
  // Keep component information
  if (node.componentId) simplified.componentId = node.componentId;
  if (node.componentProperties) simplified.componentProperties = node.componentProperties;
  
  // Recursively process children
  if (node.children && node.children.length > 0) {
    simplified.children = node.children.map((child) => simplifyNodeForAndroid(child));
  }
  
  return simplified;
}

/**
 * Round numeric values to reduce precision
 */
function roundNumericValues<T>(obj: T, precision: number = 2): T {
  if (typeof obj === 'number') {
    return Number(obj.toFixed(precision)) as T;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => roundNumericValues(item, precision)) as T;
  }
  
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = roundNumericValues(value, precision);
    }
    return result as T;
  }
  
  return obj;
}

// Simplified handler function
async function getFigmaData(
  params: GetFigmaDataParams,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
) {
  try {
    const { fileKey, nodeId: rawNodeId, depth, optimizeForAndroid } = parametersSchema.parse(params);

    // Replace - with : in nodeId for our query—Figma API expects :
    const nodeId = rawNodeId?.replace(/-/g, ":");

    Logger.log(
      `Fetching ${depth ? `${depth} layers deep` : "all layers"} of ${
        nodeId ? `node ${nodeId} from file` : `full file`
      } ${fileKey}${optimizeForAndroid ? " (Android optimized)" : ""}`,
    );

    // Get raw Figma API response
    let rawApiResponse: GetFileResponse | GetFileNodesResponse;
    if (nodeId) {
      rawApiResponse = await figmaService.getRawNode(fileKey, nodeId, depth);
    } else {
      rawApiResponse = await figmaService.getRawFile(fileKey, depth);
    }

    // Use unified design extraction (handles nodes + components consistently)
    const simplifiedDesign = simplifyRawFigmaObject(rawApiResponse, allExtractors, {
      maxDepth: depth,
      nodeFilter: (node) => {
        // Always filter out invisible nodes and slices when optimizing for Android
        if (optimizeForAndroid) {
          if ("visible" in node && node.visible === false) {
            return false;
          }
          if (node.type === "SLICE") {
            return false;
          }
        }
        
        return true;
      },
      afterChildren: collapseSvgContainers,
    });

    writeLogs("figma-simplified.json", simplifiedDesign);

    Logger.log(
      `Successfully extracted data: ${simplifiedDesign.nodes.length} nodes, ${
        Object.keys(simplifiedDesign.globalVars.styles).length
      } styles`,
    );

    // Apply Android-specific simplification if requested
    let finalDesign = simplifiedDesign;
    if (optimizeForAndroid) {
      Logger.log("Applying Android optimization: removing unnecessary properties");
      finalDesign = simplifyForAndroid(simplifiedDesign);
      
      // Round numeric values to reduce precision
      finalDesign.globalVars = roundNumericValues(finalDesign.globalVars, 2);
      
      Logger.log("Android optimization complete");
    }

    const { nodes, globalVars, ...metadata } = finalDesign;
    const result = {
      metadata,
      nodes,
      globalVars,
    };

    Logger.log(`Generating ${outputFormat.toUpperCase()} result from extracted data`);
    const formattedResult =
      outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);

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
