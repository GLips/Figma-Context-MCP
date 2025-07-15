import { z } from "zod";
import { FigmaService } from "../../services/figma.js";
import type { SimplifiedDesign } from "../../services/simplify-node-response.js";
import yaml from "js-yaml";
import { Logger } from "../../utils/logger.js";

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
      "OPTIONAL. Do NOT use unless explicitly requested by the user. Controls how many levels deep to traverse the node tree,",
    ),
};

const parametersSchema = z.object(parameters);
export type GetFigmaDataParams = z.infer<typeof parametersSchema>;

// Simplified handler function
async function getFigmaData(
  params: GetFigmaDataParams,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
) {
  try {
    const { fileKey, nodeId, depth } = params;

    Logger.log(
      `Fetching ${depth ? `${depth} layers deep` : "all layers"} of ${
        nodeId ? `node ${nodeId} from file` : `full file`
      } ${fileKey}`,
    );

    let file: SimplifiedDesign;
    if (nodeId) {
      file = await figmaService.getNode(fileKey, nodeId, depth);
    } else {
      file = await figmaService.getFile(fileKey, depth);
    }

    Logger.log(`Successfully fetched file: ${file.name}`);
    const { nodes, globalVars, ...metadata } = file;

    const result = { metadata, nodes, globalVars };

    Logger.log(`Generating ${outputFormat.toUpperCase()} result from file`);
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
    "When the nodeId cannot be obtained, obtain the layout information about the entire Figma file",
  parameters,
  handler: getFigmaData,
} as const;
