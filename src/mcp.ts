import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaService } from "./services/figma.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SimplifiedDesign } from "./services/simplify-node-response.js";
import yaml from "js-yaml";
import { Logger } from "./index.js";

const serverInfo = {
  name: "Figma MCP Server",
  version: "0.2.1",
};

const serverOptions = {
  capabilities: { logging: {}, tools: {} },
};

export class FigmaMcpServer extends McpServer {
  private readonly figmaService: FigmaService;

  constructor(figmaApiKey: string, figmaOAuthToken?: string, useOAuth?: boolean) {
    super(serverInfo, serverOptions);
    this.figmaService = new FigmaService(figmaApiKey, figmaOAuthToken, useOAuth);
    // this.server = new McpServer(this.serverInfo, this.serverOptions);

    this.registerTools();
  }

  private registerTools(): void {
    // Tool to get file information
    this.tool(
      "get_figma_data",
      "When the nodeId cannot be obtained, obtain the layout information about the entire Figma file",
      {
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
            "How many levels deep to traverse the node tree, only use if explicitly requested by the user",
          ),
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
            file = await this.figmaService.getNode(fileKey, nodeId, depth);
          } else {
            file = await this.figmaService.getFile(fileKey, depth);
          }

          Logger.log(`Successfully fetched file: ${file.name}`);
          const { nodes, globalVars, ...metadata } = file;

          const result = {
            metadata,
            nodes,
            globalVars,
          };

          Logger.log("Generating YAML result from file");
          const yamlResult = yaml.dump(result);

          Logger.log("Sending result to client");
          return {
            content: [{ type: "text", text: yamlResult }],
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
    this.tool(
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
        localPath: z
          .string()
          .describe(
            "The absolute path to the directory where images are stored in the project. If the directory does not exist, it will be created. The format of this path should respect the directory format of the operating system you are running on. Don't use any special character escaping in the path name either.",
          ),
      },
      async ({ fileKey, nodes, localPath }) => {
        try {
          const imageFills = nodes.filter(({ imageRef }) => !!imageRef) as {
            nodeId: string;
            imageRef: string;
            fileName: string;
          }[];
          const fillDownloads = this.figmaService.getImageFills(fileKey, imageFills, localPath);
          const renderRequests = nodes
            .filter(({ imageRef }) => !imageRef)
            .map(({ nodeId, fileName }) => ({
              nodeId,
              fileName,
              fileType: fileName.endsWith(".svg") ? ("svg" as const) : ("png" as const),
            }));

          const renderDownloads = this.figmaService.getImages(fileKey, renderRequests, localPath);

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

  async connect(transport: Transport): Promise<void> {
    await super.connect(transport);

    // Ensure stdout is only used for JSON messages
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
      // Only allow JSON messages to pass through
      if (typeof chunk === "string" && !chunk.startsWith("{")) {
        return true; // Silently skip non-JSON messages
      }
      return originalStdoutWrite(chunk, encoding, callback);
    };

    Logger.log("Server connected and ready to process requests");
  }
}
