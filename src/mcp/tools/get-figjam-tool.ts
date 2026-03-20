import { z } from "zod";
import { FigmaService } from "~/services/figma.js";
import { Logger } from "~/utils/logger.js";
import { extractSparseMetadata, nodeToXml, nodesToXml } from "~/utils/xml-serializer.js";

const parameters = {
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe("The key of the FigJam file"),
  nodeId: z
    .string()
    .regex(
      /^I?\d+[:|-]\d+(?:;\d+[:|-]\d+)*$/,
      "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'",
    )
    .optional()
    .describe(
      "Optional node ID to extract a specific section. If not provided, extracts the entire FigJam board.",
    ),
};

const parametersSchema = z.object(parameters);
export type GetFigJamParams = z.infer<typeof parametersSchema>;

/**
 * FigJam-specific node types that should be recognized
 */
const FIGJAM_NODE_TYPES = new Set([
  "STICKY",
  "SHAPE_WITH_TEXT",
  "CONNECTOR",
  "STAMP",
  "WIDGET",
  "EMBED",
  "LINK_UNFURL",
  "MEDIA",
  "SECTION",
  "WASHI_TAPE",
]);

/**
 * Checks if a node is a FigJam-specific node type
 */
function isFigJamNode(node: any): boolean {
  return FIGJAM_NODE_TYPES.has(node.type);
}

/**
 * Recursively counts FigJam-specific nodes in a tree
 */
function countFigJamNodes(node: any): number {
  let count = isFigJamNode(node) ? 1 : 0;
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      count += countFigJamNodes(child);
    }
  }
  return count;
}

/**
 * Extracts FigJam-specific metadata including text content for certain node types
 */
function extractFigJamMetadata(rawNode: any): any {
  const node = extractSparseMetadata(rawNode);

  // Add FigJam-specific properties
  if (rawNode.type === "STICKY" || rawNode.type === "SHAPE_WITH_TEXT") {
    // Extract text content if present
    if (rawNode.characters) {
      (node as any).text = rawNode.characters;
    }
  }

  if (rawNode.type === "CONNECTOR") {
    // Extract connector endpoints if present
    if (rawNode.connectorStart) {
      (node as any).connectorStart = rawNode.connectorStart.endpointNodeId;
    }
    if (rawNode.connectorEnd) {
      (node as any).connectorEnd = rawNode.connectorEnd.endpointNodeId;
    }
  }

  if (rawNode.type === "SECTION") {
    // Sections are like frames in FigJam
    if (rawNode.sectionContentsHidden !== undefined) {
      (node as any).collapsed = rawNode.sectionContentsHidden;
    }
  }

  return node;
}

/**
 * Generates screenshot URLs for FigJam nodes
 */
async function generateScreenshotUrls(
  fileKey: string,
  nodes: any[],
  figmaService: FigmaService,
): Promise<Record<string, string>> {
  // Collect all node IDs that should have screenshots
  const nodeIds: string[] = [];

  function collectNodeIds(node: any) {
    // Generate screenshots for visual FigJam elements
    if (
      isFigJamNode(node) ||
      node.type === "FRAME" ||
      node.type === "GROUP" ||
      node.type === "SECTION"
    ) {
      nodeIds.push(node.id);
    }

    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        collectNodeIds(child);
      }
    }
  }

  for (const node of nodes) {
    collectNodeIds(node);
  }

  if (nodeIds.length === 0) {
    return {};
  }

  try {
    // Get render URLs for all collected nodes
    const urls = await figmaService.getNodeRenderUrls(fileKey, nodeIds, "png", { pngScale: 2 });
    return urls;
  } catch (error) {
    Logger.log(`Warning: Failed to generate screenshot URLs: ${error}`);
    return {};
  }
}

/**
 * Enhances XML output with screenshot URL attributes
 */
function addScreenshotUrls(xmlString: string, screenshotUrls: Record<string, string>): string {
  // Add screenshot URLs as attributes to nodes that have them
  let enhanced = xmlString;

  for (const [nodeId, url] of Object.entries(screenshotUrls)) {
    // Find the node with this ID and add the screenshot attribute
    const pattern = new RegExp(`(<node[^>]*id="${nodeId.replace(/:/g, "\\:")}"[^>]*)(/?>)`, "g");
    enhanced = enhanced.replace(pattern, `$1 screenshot="${url}"$2`);
  }

  return enhanced;
}

async function getFigJam(params: GetFigJamParams, figmaService: FigmaService) {
  try {
    const { fileKey, nodeId: rawNodeId } = parametersSchema.parse(params);

    // Convert node ID format if provided (hyphen to colon)
    const nodeId = rawNodeId?.replace(/-/g, ":");

    Logger.log(
      `Fetching FigJam board: ${fileKey}${nodeId ? ` (node: ${nodeId})` : " (entire board)"}`,
    );

    let rawData: any;
    let targetNodes: any[];

    if (nodeId) {
      // Fetch specific node with depth=2 for context
      const response = await figmaService.getRawNode(fileKey, nodeId, 2);
      const nodeData = response.nodes?.[nodeId];

      if (!nodeData) {
        throw new Error(`Node ${nodeId} not found in file ${fileKey}`);
      }

      rawData = nodeData.document;
      targetNodes = [rawData];
    } else {
      // Fetch entire file
      const response = await figmaService.getRawFile(fileKey);

      // Log file type for debugging (FigJam files typically have CANVAS children)
      Logger.log(`File ${fileKey} document type: ${response.document.type}`);

      rawData = response.document;
      targetNodes = rawData.children || [rawData];
    }

    // Count FigJam-specific nodes
    const figJamNodeCount = targetNodes.reduce((sum, node) => sum + countFigJamNodes(node), 0);

    Logger.log(`Found ${figJamNodeCount} FigJam-specific nodes`);

    // Extract metadata with FigJam-specific handling
    const metadataNodes = targetNodes.map(extractFigJamMetadata);

    // Generate XML representation
    let xmlOutput: string;
    if (metadataNodes.length === 1) {
      xmlOutput = nodeToXml(metadataNodes[0]);
    } else {
      xmlOutput = nodesToXml(metadataNodes, "figjam");
    }

    // Generate screenshot URLs for visual elements
    Logger.log("Generating screenshot URLs for FigJam elements...");
    const screenshotUrls = await generateScreenshotUrls(fileKey, targetNodes, figmaService);
    const screenshotCount = Object.keys(screenshotUrls).length;

    Logger.log(`Generated ${screenshotCount} screenshot URLs`);

    // Enhance XML with screenshot URLs
    if (screenshotCount > 0) {
      xmlOutput = addScreenshotUrls(xmlOutput, screenshotUrls);
    }

    // Add summary comment at the top
    const summary = `<!-- FigJam Board: ${fileKey}${nodeId ? ` | Node: ${nodeId}` : ""} | FigJam Elements: ${figJamNodeCount} | Screenshots: ${screenshotCount} -->`;
    xmlOutput = xmlOutput.replace(
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<?xml version="1.0" encoding="UTF-8"?>\n${summary}`,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: xmlOutput,
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error("Error fetching FigJam board:", message);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Error fetching FigJam board: ${message}`,
        },
      ],
    };
  }
}

export const getFigJamTool = {
  name: "get_figjam",
  description:
    "Converts a FigJam board (whiteboard/diagram file) to XML representation with screenshot URLs for visual elements. Returns structured XML containing FigJam-specific node types like STICKY notes, SHAPE_WITH_TEXT, CONNECTORs, and other diagram elements. Each visual element includes a screenshot URL attribute for reference. Use this tool to extract and analyze FigJam boards, brainstorming sessions, diagrams, and collaborative whiteboard content.",
  parametersSchema,
  handler: getFigJam,
} as const;
