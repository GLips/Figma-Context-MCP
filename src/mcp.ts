import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaService, type FigmaAuthOptions } from "./services/figma.js";
import type { SimplifiedDesign } from "./services/simplify-node-response.js";
import { Logger } from "./utils/logger.js";
import { calcStringSize } from "./utils/calc-string-size.js";
import yaml from "js-yaml";

const serverInfo = {
  name: "Figma MCP Server",
  version: process.env.NPM_PACKAGE_VERSION ?? "unknown",
};

type CreateServerOptions = {
  isHTTP?: boolean;
  outputFormat?: "yaml" | "json";
};

function createServer(
  authOptions: FigmaAuthOptions,
  { isHTTP = false, outputFormat = "yaml" }: CreateServerOptions = {},
) {
  const server = new McpServer(serverInfo);
  // const figmaService = new FigmaService(figmaApiKey);
  const figmaService = new FigmaService(authOptions);
  registerTools(server, figmaService, outputFormat);

  Logger.isHTTP = isHTTP;

  return server;
}

const fileKeyDescription =
  "The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/...";
const nodeIdDescription =
  "The ID of the node to fetch, often found as URL parameter node-id=nodeId, always use if provided. If there are multiple node IDs that need to be obtained simultaneously, they can be combined and passed in with commas as separators.";
const depthDescription =
  "Optional parameter, Controls how many levels deep to traverse the node tree";

function registerTools(
  server: McpServer,
  figmaService: FigmaService,
  outputFormat: "yaml" | "json",
): void {
  const sizeLimit = process.env.GET_NODE_SIZE_LIMIT
    ? parseInt(process.env.GET_NODE_SIZE_LIMIT)
    : undefined;

  // Tool to get node size
  server.tool(
    "get_figma_data_size",
    `Obtain the memory size of a figma data, return the nodeId and size in KB, e.g 
- nodeId: '1234:5678'
  size: 1024 KB

Allowed to pass in multiple node IDs to batch obtain the sizes of multiple nodes at one time.
`,
    {
      fileKey: z.string().describe(fileKeyDescription),
      nodeId: z.string().optional().describe(nodeIdDescription),
      depth: z.number().optional().describe(depthDescription),
    },
    async ({ fileKey, nodeId, depth }) => {
      try {
        Logger.log(
          `Getting size for ${nodeId ? `node ${nodeId}` : "full file"} from file ${fileKey}`,
        );

        let file: SimplifiedDesign;
        if (nodeId) {
          file = await figmaService.getNode(fileKey, nodeId, depth);
        } else {
          file = await figmaService.getFile(fileKey, depth);
        }

        const { nodes, globalVars, ...metadata } = file;

        const results = nodes.map((node) => {
          const result = {
            metadata,
            nodes: [node],
            // TODO: globalVars is not very accurate here
            globalVars,
          };
          const yamlResult = yaml.dump(result);
          const sizeInKB = calcStringSize(yamlResult);
          return {
            nodeId: node.id,
            size: `${sizeInKB} KB`,
          };
        });

        return {
          content: [{ type: "text", text: yaml.dump(results) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        Logger.error(`Error getting node size for ${fileKey}:`, message);
        return {
          isError: true,
          content: [{ type: "text", text: `Error getting node size: ${message}` }],
        };
      }
    },
  );

  const needLimitPrompt = sizeLimit && sizeLimit > 0;
  // Tool to get file information
  server.tool(
    "get_figma_data",
    `When the nodeId cannot be obtained, obtain the layout information about the entire Figma file.

Allowed to pass in multiple node IDs to batch obtain data of multiple nodes at one time.

${
  needLimitPrompt
    ? `
## Figma Data Retrieval Strategy

**IMPORTANT: Work incrementally, not comprehensively.**

### Core Principle
Retrieve and implement ONE screen/component at a time. Don't try to understand the entire design upfront.

### Process
1. **Start Small**: Get shallow data (depth: 1) of the main node to see available screens/components
2. **Pick One**: Choose a single screen to implement completely 
3. **Get Full Data**: Retrieve complete data for that one screen only
4. **Implement**: Build the HTML/CSS for that screen before moving on
5. **Repeat**: Move to the next screen only after the current one is done

### Data Size Guidelines
- **Over ${sizeLimit}KB**: Use \`depth: 1\` to get structure only
- **Under ${sizeLimit}KB**: Get full data without depth parameter

### Key Point
**Don't analyze multiple screens in parallel.** Focus on implementing one complete, working screen at a time. This avoids context overload and produces better results.
`
    : ""
}
        `,
    {
      fileKey: z.string().describe(fileKeyDescription),
      nodeId: z.string().optional().describe(nodeIdDescription),
      depth: z
        .number()
        .optional()
        .describe(depthDescription + ",Do NOT use unless explicitly requested."),
    },
    async ({ fileKey, nodeId, depth }) => {
      try {
        Logger.log(
          `Fetching ${
            depth ? `${depth} layers deep` : "all layers"
          } of ${nodeId ? `node ${nodeId} from file` : `full file`} ${fileKey}`,
        );

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
        const formattedResultSize = calcStringSize(formattedResult);

        Logger.log(`Data size: ${formattedResultSize} KB (${outputFormat.toUpperCase()})`);

        if (sizeLimit && formattedResultSize > sizeLimit) {
          Logger.log(`Data size exceeds ${sizeLimit} KB, performing truncated reading`);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `The data size of file ${fileKey} ${nodeId ? `node ${nodeId}` : ""} is ${formattedResultSize} KB, exceeded the limit of ${sizeLimit} KB, please performing truncated reading`,
              },
            ],
          };
        }

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
  );

  // TODO: Clean up all image download related code, particularly getImages in Figma service
  // Tool to download images
  server.tool(
    "download_figma_images",
    "Download SVG and PNG images used in a Figma file based on the IDs of image or icon nodes",
    {
      fileKey: z.string().describe("The key of the Figma file containing the node"),
      nodes: z
        .object({
          nodeId: z
            .string()
            .describe("The ID of the Figma image node to fetch, formatted as 1234:5678"),
          imageRef: z
            .string()
            .optional()
            .describe(
              "If a node has an imageRef fill, you must include this variable. Leave blank when downloading Vector SVG images.",
            ),
          fileName: z.string().describe("The local name for saving the fetched file"),
        })
        .array()
        .describe("The nodes to fetch as images"),
      pngScale: z
        .number()
        .positive()
        .optional()
        .default(2)
        .describe(
          "Export scale for PNG images. Optional, defaults to 2 if not specified. Affects PNG images only.",
        ),
      localPath: z
        .string()
        .describe(
          "The absolute path to the directory where images are stored in the project. If the directory does not exist, it will be created. The format of this path should respect the directory format of the operating system you are running on. Don't use any special character escaping in the path name either.",
        ),
      svgOptions: z
        .object({
          outlineText: z
            .boolean()
            .optional()
            .default(true)
            .describe("Whether to outline text in SVG exports. Default is true."),
          includeId: z
            .boolean()
            .optional()
            .default(false)
            .describe("Whether to include IDs in SVG exports. Default is false."),
          simplifyStroke: z
            .boolean()
            .optional()
            .default(true)
            .describe("Whether to simplify strokes in SVG exports. Default is true."),
        })
        .optional()
        .default({})
        .describe("Options for SVG export"),
    },
    async ({ fileKey, nodes, localPath, svgOptions, pngScale }) => {
      try {
        const imageFills = nodes.filter(({ imageRef }) => !!imageRef) as {
          nodeId: string;
          imageRef: string;
          fileName: string;
        }[];
        const fillDownloads = figmaService.getImageFills(fileKey, imageFills, localPath);
        const renderRequests = nodes
          .filter(({ imageRef }) => !imageRef)
          .map(({ nodeId, fileName }) => ({
            nodeId,
            fileName,
            fileType: fileName.endsWith(".svg") ? ("svg" as const) : ("png" as const),
          }));

        const renderDownloads = figmaService.getImages(
          fileKey,
          renderRequests,
          localPath,
          pngScale,
          svgOptions,
        );

        const downloads = await Promise.all([fillDownloads, renderDownloads]).then(([f, r]) => [
          ...f,
          ...r,
        ]);

        // If any download fails, return false
        const saveSuccess = !downloads.find((success) => !success);
        return {
          content: [
            {
              type: "text",
              text: saveSuccess
                ? `Success, ${downloads.length} images downloaded: ${downloads.join(", ")}`
                : "Failed",
            },
          ],
        };
      } catch (error) {
        Logger.error(`Error downloading images from file ${fileKey}:`, error);
        return {
          isError: true,
          content: [{ type: "text", text: `Error downloading images: ${error}` }],
        };
      }
    },
  );
}

export { createServer };
