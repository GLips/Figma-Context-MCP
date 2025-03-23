import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaService, StyleToNodeMappingResult } from "./services/figma.js";
import express, { Request, Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { IncomingMessage, ServerResponse } from "http";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SimplifiedDesign } from "./services/simplify-node-response.js";

export const Logger = {
  log: (...args: any[]) => {},
  error: (...args: any[]) => {},
};

export class FigmaMcpServer {
  private readonly server: McpServer;
  private readonly figmaService: FigmaService;
  private sseTransport: SSEServerTransport | null = null;

  constructor(figmaApiKey: string) {
    this.figmaService = new FigmaService(figmaApiKey);
    this.server = new McpServer(
      {
        name: "Figma MCP Server",
        version: "0.1.12",
      },
      {
        capabilities: {
          logging: {},
          tools: {},
        },
      },
    );

    this.registerTools();
  }

  private registerTools(): void {
    // Tool for getting data from Figma
    this.server.tool(
      "get_figma_data",
      "When the nodeId cannot be obtained, obtain the layout information about the entire Figma file",
      {
        fileKey: z
          .string()
          .describe("The key of the Figma file to fetch, often found in a provided URL like figma.com/(file|design)/<fileKey>/..."),
        nodeId: z
          .string()
          .optional()
          .describe("The ID of the node to fetch, often found as URL parameter node-id=<nodeId>, always use if provided"),
        depth: z
          .number()
          .optional()
          .describe("How many levels deep to traverse the node tree, only use if explicitly requested by the user")
      },
      async ({ fileKey, nodeId, depth }) => {
        Logger.log(`Getting Figma data for file: ${fileKey}, node: ${nodeId || "root"}, depth: ${depth || "default"}`);
        try {
          // First, fetch the style information for the file to enhance responses
          let stylesData;
          try {
            stylesData = await this.figmaService.getStyles(fileKey);
            Logger.log(`Successfully fetched ${
              stylesData.paintStyles.length + 
              stylesData.textStyles.length + 
              stylesData.effectStyles.length + 
              stylesData.gridStyles.length
            } styles for file ${fileKey}`);
          } catch (styleError) {
            Logger.error("Error fetching style information:", styleError);
            // Continue with the operation even if styles can't be fetched
          }
          
          // Fetch basic file or node data from Figma
          let figmaData;
          if (nodeId) {
            figmaData = await this.figmaService.getNode(fileKey, nodeId, depth);
          } else {
            figmaData = await this.figmaService.getFile(fileKey, depth);
          }

          // Organize style information for easy reference in the output
          if (stylesData) {
            // Use type assertion to work with the figmaData more flexibly
            const figmaDataAny = figmaData as any;
            
            // Create a section in the response specifically for style information
            figmaDataAny.styleReferences = {
              // Group styles by type
              fills: stylesData.paintStyles.map(style => ({
                name: style.name,
                key: style.key,
                description: style.description || ""
              })),
              text: stylesData.textStyles.map(style => ({
                name: style.name,
                key: style.key,
                description: style.description || ""
              })),
              effects: stylesData.effectStyles.map(style => ({
                name: style.name,
                key: style.key,
                description: style.description || ""
              })),
              grids: stylesData.gridStyles.map(style => ({
                name: style.name,
                key: style.key,
                description: style.description || ""
              }))
            };
            
            // Create a mapping section to show which style variables map to named styles
            if (figmaDataAny.globalVars && figmaDataAny.globalVars.styleInfo) {
              figmaDataAny.styleMapping = Object.entries(figmaDataAny.globalVars.styleInfo)
                .filter(([_, info]: [string, any]) => info.name) // Only include entries with style names
                .reduce((acc: Record<string, any>, [varId, info]: [string, any]) => {
                  acc[varId] = {
                    styleName: info.name,
                    // Don't include the full value to keep the response size reasonable
                    valuePreview: typeof info.value === 'object' ? '[Style Object]' : info.value
                  };
                  return acc;
                }, {});
            }
            
            // Reassign back to figmaData to use in the response
            figmaData = figmaDataAny;
          }

          return {
            content: [{ type: "text", text: JSON.stringify(figmaData) }],
          };
        } catch (error) {
          Logger.error("Error fetching Figma data:", error);
          return {
            isError: true,
            content: [{ type: "text", text: `Error: ${error}` }],
          };
        }
      }
    );

    // TODO: Clean up all image download related code, particularly getImages in Figma service
    // Tool to download images
    this.server.tool(
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
            "The absolute path to the directory where images are stored in the project. Automatically creates directories if needed.",
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
    // Logger.log("Connecting to transport...");
    await this.server.connect(transport);

    Logger.log = (...args: any[]) => {
      this.server.server.sendLoggingMessage({
        level: "info",
        data: args,
      });
    };
    Logger.error = (...args: any[]) => {
      this.server.server.sendLoggingMessage({
        level: "error",
        data: args,
      });
    };

    Logger.log("Server connected and ready to process requests");
  }

  async startHttpServer(port: number): Promise<void> {
    const app = express();

    app.get("/sse", async (req: Request, res: Response) => {
      console.log("New SSE connection established");
      this.sseTransport = new SSEServerTransport(
        "/messages",
        res as unknown as ServerResponse<IncomingMessage>,
      );
      await this.server.connect(this.sseTransport);
    });

    app.post("/messages", async (req: Request, res: Response) => {
      if (!this.sseTransport) {
        res.sendStatus(400);
        return;
      }
      await this.sseTransport.handlePostMessage(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse<IncomingMessage>,
      );
    });

    Logger.log = console.log;
    Logger.error = console.error;

    app.listen(port, () => {
      Logger.log(`HTTP server listening on port ${port}`);
      Logger.log(`SSE endpoint available at http://localhost:${port}/sse`);
      Logger.log(`Message endpoint available at http://localhost:${port}/messages`);
    });
  }
}
