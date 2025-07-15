import { z } from "zod";
import type { ToolDefinition } from "../index.js";
import { FigmaService } from "../../services/figma.js";
import type { SimplifiedDesign } from "../../services/simplify-node-response.js";
import yaml from "js-yaml";
import { Logger } from "../../utils/logger.js";

const name = "get_figma_data";
const description =
  "When the nodeId cannot be obtained, obtain the layout information about the entire Figma file";
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

type GetFigmaDataOptions = {
  figmaService: FigmaService;
  outputFormat: "yaml" | "json";
};

export function createGetFigmaDataTool(
  options: GetFigmaDataOptions,
): ToolDefinition<typeof parameters> {
  return {
    name,
    description,
    parameters,
    handler:
      () =>
      async ({ fileKey, nodeId, depth }) => {
        try {
          Logger.log(
            `Fetching ${
              depth ? `${depth} layers deep` : "all layers"
            } of ${nodeId ? `node ${nodeId} from file` : `full file`} ${fileKey}`,
          );

          const { figmaService, outputFormat } = options;

          let file: SimplifiedDesign;
          if (nodeId) {
            file = await figmaService.getNode(fileKey, nodeId, depth);
          } else {
            file = await figmaService.getFile(fileKey, depth);
          }

          Logger.log(`Successfully fetched file: ${file.name}`);
          const { nodes, globalVars, ...metadata } = file;

          const result = {
            metadata,
            nodes,
            globalVars,
          };

          Logger.log(`Generating ${outputFormat.toUpperCase()} result from file`);
          const formattedResult =
            outputFormat === "json" ? JSON.stringify(result, null, 2) : yaml.dump(result);

          Logger.log("Sending result to client");
          return {
            content: [{ type: "text", text: formattedResult }],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          Logger.error(`Error fetching file ${fileKey}:`, message);
          return {
            isError: true,
            content: [{ type: "text", text: `Error fetching file: ${message}` }],
          };
        }
      },
    register: (server) => {
      return server.tool(name, description, parameters, createGetFigmaDataTool(options).handler());
    },
  };
}
