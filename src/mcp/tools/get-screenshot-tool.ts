import { z } from "zod";
import { FigmaService } from "~/services/figma.js";
import { Logger } from "~/utils/logger.js";

const parameters = {
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, "File key must be alphanumeric")
    .describe(
      "The key of the Figma file containing the node, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
    ),
  nodeId: z
    .string()
    .regex(/^I?\d+[:|-]\d+$/, "Node ID must be like '1234:5678' or 'I5666:180910'")
    .describe(
      "The ID of the node to capture as a screenshot, often found as URL parameter node-id=<nodeId>. Use format '1234:5678'.",
    ),
};

const parametersSchema = z.object(parameters);
export type GetScreenshotParams = z.infer<typeof parametersSchema>;

async function getScreenshot(params: GetScreenshotParams, figmaService: FigmaService) {
  try {
    const { fileKey, nodeId: rawNodeId } = parametersSchema.parse(params);

    // Replace - with : in nodeId for our query—Figma API expects :
    const nodeId = rawNodeId.replace(/-/g, ":");

    Logger.log(`Fetching screenshot for node ${nodeId} from file ${fileKey}`);

    const base64Image = await figmaService.getScreenshotBase64(fileKey, nodeId);

    Logger.log(`Successfully captured screenshot for node ${nodeId}`);

    return {
      content: [
        {
          type: "image" as const,
          data: base64Image,
          mimeType: "image/png",
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    Logger.error(`Error fetching screenshot for node ${params.nodeId}:`, message);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error fetching screenshot: ${message}` }],
    };
  }
}

export const getScreenshotTool = {
  name: "get_screenshot",
  description:
    "Get a visual screenshot (PNG image) of a specific Figma node. Returns the image as base64-encoded data that can be visually inspected by AI agents. Useful for verifying visual appearance, checking design implementation accuracy, or understanding complex visual elements. The screenshot is rendered at 2x scale for high quality.",
  parametersSchema,
  handler: getScreenshot,
} as const;
