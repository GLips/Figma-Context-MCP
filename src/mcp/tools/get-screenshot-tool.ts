import { z } from "zod";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
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
  localPath: z
    .string()
    .optional()
    .default("./screenshots")
    .describe(
      "The directory path where the screenshot will be saved. Defaults to './screenshots' if not specified. The directory will be created if it doesn't exist.",
    ),
  fileName: z
    .string()
    .optional()
    .describe(
      "The filename for the screenshot (without extension). If not provided, will use the nodeId as the filename. Extension .png will be added automatically.",
    ),
};

const parametersSchema = z.object(parameters);
export type GetScreenshotParams = z.infer<typeof parametersSchema>;

async function getScreenshot(params: GetScreenshotParams, figmaService: FigmaService) {
  try {
    const { fileKey, nodeId: rawNodeId, localPath, fileName } = parametersSchema.parse(params);

    // Replace - with : in nodeId for our query—Figma API expects :
    const nodeId = rawNodeId.replace(/-/g, ":");

    Logger.log(`Fetching screenshot for node ${nodeId} from file ${fileKey}`);

    const base64Image = await figmaService.getScreenshotBase64(fileKey, nodeId);

    // Sanitize and resolve the path
    const sanitizedPath = path.normalize(localPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const resolvedPath = path.resolve(sanitizedPath);
    
    // Security check: ensure path is within project directory
    if (!resolvedPath.startsWith(path.resolve(process.cwd()))) {
      throw new Error("Invalid path specified. Directory traversal is not allowed.");
    }

    // Create directory if it doesn't exist
    await mkdir(resolvedPath, { recursive: true });

    // Generate filename
    const finalFileName = fileName ? `${fileName}.png` : `${nodeId.replace(/:/g, "-")}.png`;
    const filePath = path.join(resolvedPath, finalFileName);

    // Convert base64 to buffer and save
    const buffer = Buffer.from(base64Image, "base64");
    await writeFile(filePath, buffer);

    Logger.log(`Successfully saved screenshot to ${filePath}`);

    return {
      content: [
        {
          type: "text" as const,
          text: `Screenshot saved successfully:\n- File: ${finalFileName}\n- Path: ${filePath}\n- Node: ${nodeId}`,
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
    "Capture and save a visual screenshot (PNG image) of a specific Figma node to disk. The screenshot is saved to the specified directory (defaults to './screenshots') and can be used for visual comparison, verifying design implementation accuracy, or understanding complex visual elements. The screenshot is rendered at 2x scale for high quality.",
  parametersSchema,
  handler: getScreenshot,
} as const;
