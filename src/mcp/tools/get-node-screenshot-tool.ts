import { z } from "zod";
import { FigmaService } from "../../services/figma.js";
import { Logger } from "../../utils/logger.js";

const parameters = {
  nodeId: z
    .string()
    .regex(
      /^I?\d+[:|-]\d+(?:;\d+[:|-]\d+)*$/,
      "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'",
    )
    .describe(
      'The ID of the node in the Figma document, eg. "123:456" or "123-456". This should be a valid node ID in the Figma document.',
    ),
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe(
      "The key of the Figma file to use. If the URL is provided, extract the file key from the URL. The given URL must be in the format https://figma.com/design/:fileKey/:fileName?node-id=:int1-:int2. The extracted fileKey would be :fileKey.",
    ),
};

const parametersSchema = z.object(parameters);
export type GetNodeScreenshotParams = z.infer<typeof parametersSchema>;

/**
 * Handler function to get screenshot for a single Figma node.
 */
async function getNodeScreenshot(params: GetNodeScreenshotParams, figmaService: FigmaService) {
  try {
    const { nodeId: rawNodeId, fileKey } = parametersSchema.parse(params);

    // Replace - with : in nodeId for our query—Figma API expects :
    const nodeId = rawNodeId.replace(/-/g, ":");

    Logger.log(`Getting screenshot for node ${nodeId} from file ${fileKey}`);

    const imageData = await figmaService.getNodeScreenshot(fileKey, nodeId);

    if (imageData) {
      Logger.log(`Screenshot retrieved for node ${nodeId}`);
      return {
        content: [
          {
            type: "image" as const,
            data: imageData,
            mimeType: "image/png",
          },
        ],
      };
    }

    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to render node ${nodeId}. The node may not exist or has no renderable content.`,
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Logger.error("Error getting screenshot:", message);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to get screenshot: ${message}`,
        },
      ],
    };
  }
}

export const getNodeScreenshotTool = {
  name: "get_node_screenshot",
  description: "Get a PNG screenshot for a specific Figma node. Requires fileKey and nodeId.",
  parameters,
  handler: getNodeScreenshot,
} as const;
