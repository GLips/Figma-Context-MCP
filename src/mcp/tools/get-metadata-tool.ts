import { z } from "zod";
import { FigmaService } from "~/services/figma.js";
import { Logger } from "~/utils/logger.js";
import { extractSparseMetadata, nodeToXml, nodesToXml } from "~/utils/xml-serializer.js";

const parameters = {
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe(
      "The key of the Figma file to fetch metadata from, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
    ),
  nodeId: z
    .string()
    .regex(
      /^I?\d+[:|-]\d+(?:;\d+[:|-]\d+)*$/,
      "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'",
    )
    .optional()
    .describe(
      "The ID of the node to fetch metadata for, often found as URL parameter node-id=<nodeId>. Use format '1234:5678' or 'I5666:180910;1:10515;1:10336' for multiple nodes.",
    ),
};

const parametersSchema = z.object(parameters);
export type GetMetadataParams = z.infer<typeof parametersSchema>;

async function getMetadata(params: GetMetadataParams, figmaService: FigmaService) {
  try {
    const { fileKey, nodeId: rawNodeId } = parametersSchema.parse(params);

    // Replace - with : in nodeId for our query—Figma API expects :
    const nodeId = rawNodeId?.replace(/-/g, ":");

    Logger.log(
      `Fetching sparse metadata for ${nodeId ? `node ${nodeId} from file` : `full file`} ${fileKey}`,
    );

    // Fetch with depth=2 for sparse layer tree
    const depth = 2;
    const rawApiResponse = nodeId
      ? await figmaService.getRawNode(fileKey, nodeId, depth)
      : await figmaService.getRawFile(fileKey, depth);

    // Extract sparse metadata from response
    let sparseNodes;
    if ("nodes" in rawApiResponse && rawApiResponse.nodes) {
      // GetFileNodesResponse - extract from nodes object
      const nodeKeys = Object.keys(rawApiResponse.nodes);
      sparseNodes = nodeKeys.map((key) => {
        const nodeData = rawApiResponse.nodes[key];
        return extractSparseMetadata(nodeData.document);
      });
    } else if ("document" in rawApiResponse) {
      // GetFileResponse - extract from document
      sparseNodes = [extractSparseMetadata(rawApiResponse.document)];
    } else {
      throw new Error("Unexpected API response format");
    }

    Logger.log(`Successfully extracted metadata for ${sparseNodes.length} node(s)`);

    // Convert to XML
    const xmlResult =
      sparseNodes.length === 1
        ? nodeToXml(sparseNodes[0], true)
        : nodesToXml(sparseNodes, "nodes", true);

    Logger.log("Sending XML metadata to client");
    return {
      content: [{ type: "text" as const, text: xmlResult }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error fetching metadata for file ${params.fileKey}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error fetching metadata: ${message}` }],
    };
  }
}

export const getMetadataTool = {
  name: "get_metadata",
  description:
    "Get sparse XML metadata for a Figma file or node, including basic layer properties (names, types, IDs, bounding boxes) without full design details. Returns a lightweight XML representation useful for quick discovery and navigation of the layer hierarchy before fetching full design context. Uses depth=2 to limit tree traversal for performance.",
  parametersSchema,
  handler: getMetadata,
} as const;
