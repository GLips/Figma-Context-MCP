import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaService } from "./services/figma";
import express, { Request, Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { IncomingMessage, ServerResponse } from "http";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export class FigmaMcpServer {
  private readonly server: McpServer;
  private readonly figmaService: FigmaService;
  private sseTransport: SSEServerTransport | null = null;

  constructor(figmaApiKey: string) {
    this.figmaService = new FigmaService(figmaApiKey);
    this.server = new McpServer({
      name: "Figma MCP Server",
      version: "0.1.4",
    });

    this.registerTools();
    this.registerResources();
  }

  private registerTools(): void {
    // Tool to get file information
    this.server.tool(
      "get_file",
      "Get layout information about an entire Figma file",
      {
        fileKey: z.string().describe("The key of the Figma file to fetch"),
        depth: z.number().optional().describe("How many levels deep to traverse the node tree"),
      },
      async ({ fileKey, depth }) => {
        try {
          console.log(`Fetching file: ${fileKey} (depth: ${depth ?? "default"})`);
          const file = await this.figmaService.getFile(fileKey, depth);
          console.log(`Successfully fetched file: ${file.name}`);
          const { nodes, ...metadata } = file;

          // Stringify each node individually to try to avoid max string length error with big files
          const nodesJson = `[${nodes.map((node) => JSON.stringify(node, null, 2)).join(",")}]`;
          const metadataJson = JSON.stringify(metadata, null, 2);
          const resultJson = `{ "metadata": ${metadataJson}, "nodes": ${nodesJson} }`;

          return {
            content: [{ type: "text", text: resultJson }],
          };
        } catch (error) {
          console.error(`Error fetching file ${fileKey}:`, error);
          return {
            content: [{ type: "text", text: `Error fetching file: ${error}` }],
          };
        }
      },
    );

    // Tool to get node information
    this.server.tool(
      "get_node",
      "Get layout information about a specific node in a Figma file",

      {
        fileKey: z.string().describe("The key of the Figma file containing the node"),
        nodeId: z.string().describe("The ID of the node to fetch"),
        depth: z.number().optional().describe("How many levels deep to traverse the node tree"),
      },
      async ({ fileKey, nodeId, depth }) => {
        try {
          console.log(
            `Fetching node: ${nodeId} from file: ${fileKey} (depth: ${depth ?? "default"})`,
          );
          const node = await this.figmaService.getNode(fileKey, nodeId, depth);
          console.log(
            `Successfully fetched node: ${node.name} (ids: ${Object.keys(node.nodes).join(", ")})`,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(node, null, 2) }],
          };
        } catch (error) {
          console.error(`Error fetching node ${nodeId} from file ${fileKey}:`, error);
          return {
            content: [{ type: "text", text: `Error fetching node: ${error}` }],
          };
        }
      },
    );

    // this.server.tool(
    //   "get_node_image",
    //   "Get an image of a node from a Figma file",
    //   {
    //     fileKey: z.string().describe("The key of the Figma file containing the node"),
    //     nodeId: z.string().describe("The ID of the node to fetch"),
    //   },
    //   async ({ fileKey, nodeId }) => {
    //     try {
    //       console.log(`Fetching image for node: ${nodeId} from file: ${fileKey}`);
    //       const imageUrl = await this.figmaService.getNodeImage(fileKey, nodeId);
    //       const imageData = await this.figmaService.fetchImageData(imageUrl);
    //       return {
    //         content: [{ type: "image", mimeType: "image/png", data: imageData }],
    //       };
    //     } catch (error) {
    //       console.error(`Error fetching image for node ${nodeId} from file ${fileKey}:`, error);
    //       return {
    //         content: [{ type: "text", text: `Error fetching image: ${error}` }],
    //       };
    //     }
    //   },
    // );
  }

  private registerResources(): void {
    // Resource to get an image of a node
    this.server.resource(
      "get_node_image",
      new ResourceTemplate("figma://image/{fileKey}/{nodeId}", {
        list: undefined,
      }),
      {
        description:
          "Get an image of a node from a Figma file, useful to understand the layout of a node when metadata isn't enough",
        mimeType: "image/png",
      },
      async (uri, { fileKey, nodeId }) => {
        try {
          console.log(`Fetching image for node: ${nodeId} from file: ${fileKey}`);
          // Get the image URL from Figma
          const imageUrl = await this.figmaService.getNodeImage(
            fileKey as string,
            nodeId as string,
          );
          // Fetch the actual image data
          const imageData = await this.figmaService.fetchImageData(imageUrl);
          console.log(`Successfully fetched image for node: ${nodeId}: ${imageUrl}`);
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "image/png",
                blob: imageData,
              },
            ],
          };
        } catch (error) {
          console.error(`Error fetching image for node ${nodeId} from file ${fileKey}:`, error);
          return {
            contents: [
              {
                uri: uri.href,
                text: `Error fetching image: ${error}`,
              },
            ],
          };
        }
      },
    );
  }

  async connect(transport: Transport): Promise<void> {
    console.log("Connecting to transport...");
    await this.server.connect(transport);
    console.log("Server connected and ready to process requests");
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
        // @ts-expect-error Not sure why Express types aren't working
        res.sendStatus(400);
        return;
      }
      await this.sseTransport.handlePostMessage(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse<IncomingMessage>,
      );
    });

    app.listen(port, () => {
      console.log(`HTTP server listening on port ${port}`);
      console.log(`SSE endpoint available at http://localhost:${port}/sse`);
      console.log(`Message endpoint available at http://localhost:${port}/messages`);
    });
  }
}
