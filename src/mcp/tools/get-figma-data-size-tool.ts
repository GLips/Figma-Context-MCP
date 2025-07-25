import { z } from "zod";
import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import { FigmaService } from "~/services/figma.js";
import { simplifyRawFigmaObject, allExtractors } from "~/extractors/index.js";
import yaml from "js-yaml";
import { Logger, writeLogs } from "~/utils/logger.js";
import { calcStringSize } from "~/utils/calc-string-size.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const parameters = {
  fileKey: z
    .string()
    .describe(
      "The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
    ),
  nodeId: z
    .string()
    .optional()
    .describe(
      "The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided",
    ),
  depth: z
    .number()
    .optional()
    .describe(
      "OPTIONAL. Do NOT use unless explicitly requested by the user. Controls how many levels deep to traverse the node tree.",
    ),
};

const parametersSchema = z.object(parameters);
export type GetFigmaDataSizeParams = z.infer<typeof parametersSchema>;

// Simplified handler function
async function getFigmaDataSize(
  params: GetFigmaDataSizeParams,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
): Promise<CallToolResult> {
  try {
    const { fileKey, nodeId, depth } = params;

    Logger.log(
      `Fetching ${depth ? `${depth} layers deep` : "all layers"} of ${
        nodeId ? `node ${nodeId} from file` : `full file`
      } ${fileKey}`,
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
    });

    writeLogs("figma-simplified.json", simplifiedDesign);

    Logger.log(
      `Successfully extracted data: ${simplifiedDesign.nodes.length} nodes, ${Object.keys(simplifiedDesign.globalVars.styles).length} styles`,
    );

    const { nodes, globalVars, ...metadata } = simplifiedDesign;
    const result = {
      metadata,
      nodes,
      globalVars,
    };

    Logger.log(`Generating ${outputFormat.toUpperCase()} result from extracted data`);
    const formattedResult =
      outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);


    const size = calcStringSize(formattedResult);
    const sizeResult = [{
      nodeId: nodeId,
      size: size,
    }];

    Logger.log("Sending result to client");

    return {
      content: [{ type: "text", text: yaml.dump(sizeResult) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error fetching file ${params.fileKey}:`, message);
    return {
      isError: true,
      content: [{ type: "text", text: `Error fetching file: ${message}` }],
    };
  }
}

// Export tool configuration
export const getFigmaDataSizeTool = {
  name: "get_figma_data_size",
  description:
    "Obtain the memory size of a figma data, return the nodeId and size in KB, e.g \n- nodeId: '1234:5678'\n  size: 1024 KB",
  parameters,
  handler: getFigmaDataSize,
} as const;
