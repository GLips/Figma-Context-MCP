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

    // Tool to get Figma styles
    this.server.tool(
      "get_figma_styles",
      "Retrieve all local styles (colors, text, effects, grids) from a Figma file",
      {
        fileKey: z
          .string()
          .describe(
            "The key of the Figma file to fetch styles from, often found in a provided URL like figma.com/(file|design)/<fileKey>/...",
          ),
      },
      async ({ fileKey }) => {
        try {
          Logger.log(`Fetching styles from file ${fileKey}`);
          const styles = await this.figmaService.getStyles(fileKey);
          
          Logger.log(`Successfully fetched styles: ${
            styles.paintStyles.length + 
            styles.textStyles.length + 
            styles.effectStyles.length + 
            styles.gridStyles.length
          } total styles`);
          
          return {
            content: [{ type: "text", text: JSON.stringify(styles, null, 2) }],
          };
        } catch (error) {
          Logger.error(`Error fetching styles from file ${fileKey}:`, error);
          return {
            isError: true,
            content: [{ type: "text", text: `Error fetching styles: ${error}` }],
          };
        }
      }
    );

    // Tool to get detailed style information
    this.server.tool(
      "get_figma_style_details",
      "Retrieve detailed information about specific styles including their properties and values",
      {
        styleKeys: z
          .array(z.string())
          .describe("Array of style keys to fetch details for"),
      },
      async ({ styleKeys }) => {
        try {
          Logger.log(`Fetching details for ${styleKeys.length} styles`);
          
          const styleDetails = await this.figmaService.getMultipleStyleDetails(styleKeys);
          
          Logger.log(`Successfully fetched details for ${Object.keys(styleDetails).length} styles`);
          
          return {
            content: [{ type: "text", text: JSON.stringify(styleDetails, null, 2) }],
          };
        } catch (error) {
          Logger.error(`Error fetching style details:`, error);
          return {
            isError: true,
            content: [{ type: "text", text: `Error fetching style details: ${error}` }],
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

    // Tool for detecting style usage
    this.server.tool(
      "detect_figma_style_usage",
      "Detect style usage in a Figma file",
      {
        fileKey: z
          .string()
          .describe("The key of the Figma file to detect style usage in"),
        nodeId: z
          .string()
          .optional()
          .describe("Optional node ID to focus on")
      },
      async ({ fileKey, nodeId }) => {
        try {
          Logger.log(`Detecting style usage in file ${fileKey}${nodeId ? ` for node ${nodeId}` : ''}`);
          
          // Get complete style metadata (including names)
          const allStyles = await this.figmaService.getStyles(fileKey);
          
          // Create a lookup map for style IDs to names
          const styleIdToNameMap: Record<string, { name: string; type: string }> = {};
          
          allStyles.paintStyles.forEach(style => {
            styleIdToNameMap[style.key] = { name: style.name, type: "color" };
          });
          
          allStyles.textStyles.forEach(style => {
            styleIdToNameMap[style.key] = { name: style.name, type: "text" };
          });
          
          allStyles.effectStyles.forEach(style => {
            styleIdToNameMap[style.key] = { name: style.name, type: "effect" };
          });
          
          allStyles.gridStyles.forEach(style => {
            styleIdToNameMap[style.key] = { name: style.name, type: "grid" };
          });
          
          // Get style usage in the design
          const styleUsage = await this.figmaService.detectStyleUsage(fileKey, nodeId);
          
          // Get detailed style information for all used styles
          const usedStyleIds = [
            ...Object.keys(styleUsage.fillStyleIds),
            ...Object.keys(styleUsage.textStyleIds),
            ...Object.keys(styleUsage.effectStyleIds),
            ...Object.keys(styleUsage.gridStyleIds)
          ];
          
          const styleDetails = await this.figmaService.getMultipleStyleDetails(usedStyleIds);
          
          // Create a human-readable format with style names and their values
          const enhancedStyleUsage = {
            colorStyles: Object.entries(styleUsage.fillStyleIds).map(([styleId, nodeIds]) => {
              const style = styleIdToNameMap[styleId];
              const details = styleDetails[styleId];
              
              return {
                id: styleId,
                name: style?.name || "Unknown Style",
                details: details || {},
                usedInNodes: nodeIds.length,
                nodeIds
              };
            }),
            
            textStyles: Object.entries(styleUsage.textStyleIds).map(([styleId, nodeIds]) => {
              const style = styleIdToNameMap[styleId];
              const details = styleDetails[styleId];
              
              return {
                id: styleId,
                name: style?.name || "Unknown Style",
                details: details || {},
                usedInNodes: nodeIds.length,
                nodeIds
              };
            }),
            
            effectStyles: Object.entries(styleUsage.effectStyleIds).map(([styleId, nodeIds]) => {
              const style = styleIdToNameMap[styleId];
              const details = styleDetails[styleId];
              
              return {
                id: styleId,
                name: style?.name || "Unknown Style",
                details: details || {},
                usedInNodes: nodeIds.length,
                nodeIds
              };
            }),
            
            gridStyles: Object.entries(styleUsage.gridStyleIds).map(([styleId, nodeIds]) => {
              const style = styleIdToNameMap[styleId];
              const details = styleDetails[styleId];
              
              return {
                id: styleId,
                name: style?.name || "Unknown Style",
                details: details || {},
                usedInNodes: nodeIds.length,
                nodeIds
              };
            }),
            
            summary: {
              totalStylesUsed: usedStyleIds.length,
              colorStylesCount: Object.keys(styleUsage.fillStyleIds).length,
              textStylesCount: Object.keys(styleUsage.textStyleIds).length,
              effectStylesCount: Object.keys(styleUsage.effectStyleIds).length,
              gridStylesCount: Object.keys(styleUsage.gridStyleIds).length
            }
          };
          
          Logger.log(`Successfully detected style usage in file ${fileKey}`);
          
          return {
            content: [{ type: "text", text: JSON.stringify(enhancedStyleUsage, null, 2) }],
          };
          
        } catch (error) {
          Logger.error(`Error detecting style usage in file ${fileKey}:`, error);
          return {
            isError: true,
            content: [{ type: "text", text: `Error detecting style usage: ${error}` }],
          };
        }
      }
    );

    // Tool for comprehensive style mapping with values
    this.server.tool(
      "map_figma_styles_to_nodes",
      "Maps local styles to their usage in nodes, with comprehensive style values",
      {
        fileKey: z
          .string()
          .describe("The key of the Figma file to map styles to nodes in"),
        nodeId: z
          .string()
          .optional()
          .describe("The ID of the node to map styles to")
      },
      async ({ fileKey, nodeId }) => {
        try {
          Logger.log(`Mapping styles to nodes in file ${fileKey}${nodeId ? ` for node ${nodeId}` : ''}`);
          
          // Get style mappings
          const styleMappings = await this.figmaService.mapNodesToLocalStyles(fileKey, nodeId);
          
          // Get style usage summary for additional context
          const styleUsageSummary = await this.figmaService.createStyleUsageSummary(fileKey, nodeId);
          
          // Combine the detailed mapping with usage summary
          const enhancedStyleMapping = {
            // Detailed style-to-node mappings
            detailedMappings: styleMappings,
            
            // Style usage summary with counts and values
            summary: {
              colors: styleUsageSummary.colors.map(style => ({
                name: style.name,
                styleId: style.styleId,
                value: style.value,
                usageCount: style.usageCount
              })),
              
              textStyles: styleUsageSummary.textStyles.map(style => ({
                name: style.name,
                styleId: style.styleId,
                value: style.value,
                usageCount: style.usageCount
              })),
              
              effectStyles: styleUsageSummary.effectStyles.map(style => ({
                name: style.name,
                styleId: style.styleId,
                value: style.value,
                usageCount: style.usageCount
              })),
              
              gridStyles: styleUsageSummary.gridStyles.map(style => ({
                name: style.name,
                styleId: style.styleId,
                value: style.value,
                usageCount: style.usageCount
              }))
            }
          };
          
          Logger.log(`Successfully mapped styles to nodes in file ${fileKey}`);
          
          return {
            content: [{ type: "text", text: JSON.stringify(enhancedStyleMapping, null, 2) }],
          };
          
        } catch (error) {
          Logger.error(`Error mapping styles to nodes in file ${fileKey}:`, error);
          return {
            isError: true,
            content: [{ type: "text", text: `Error mapping styles to nodes: ${error}` }],
          };
        }
      }
    );

    // Tool for getting comprehensive style report
    this.server.tool(
      "get_figma_style_mapping",
      "Retrieves comprehensive style information with their values and usage",
      {
        fileKey: z
          .string()
          .describe("The key of the Figma file to analyze styles in"),
        nodeId: z
          .string()
          .optional()
          .describe("Optional node ID to focus analysis on")
      },
      async ({ fileKey, nodeId }) => {
        try {
          Logger.log(`Generating style mapping report for file ${fileKey}${nodeId ? ` and node ${nodeId}` : ''}`);
          
          // Get style usage summary
          const styleUsageSummary = await this.figmaService.createStyleUsageSummary(fileKey, nodeId);
          
          // Get all styles
          const allStyles = await this.figmaService.getStyles(fileKey);
          
          // Count total styles defined vs used
          const definedStyleCounts = {
            colors: allStyles.paintStyles.length,
            textStyles: allStyles.textStyles.length,
            effectStyles: allStyles.effectStyles.length,
            gridStyles: allStyles.gridStyles.length,
            total: allStyles.paintStyles.length + allStyles.textStyles.length + 
                   allStyles.effectStyles.length + allStyles.gridStyles.length
          };
          
          const usedStyleCounts = {
            colors: styleUsageSummary.colors.length,
            textStyles: styleUsageSummary.textStyles.length,
            effectStyles: styleUsageSummary.effectStyles.length,
            gridStyles: styleUsageSummary.gridStyles.length,
            total: styleUsageSummary.colors.length + styleUsageSummary.textStyles.length +
                   styleUsageSummary.effectStyles.length + styleUsageSummary.gridStyles.length
          };
          
          // Create a map of style names to their values - useful for AI to understand the design system
          const stylesByName = {
            colors: styleUsageSummary.colors.reduce((map, style) => {
              map[style.name] = style.value;
              return map;
            }, {} as Record<string, any>),
            
            textStyles: styleUsageSummary.textStyles.reduce((map, style) => {
              map[style.name] = style.value;
              return map;
            }, {} as Record<string, any>),
            
            effectStyles: styleUsageSummary.effectStyles.reduce((map, style) => {
              map[style.name] = style.value;
              return map;
            }, {} as Record<string, any>),
            
            gridStyles: styleUsageSummary.gridStyles.reduce((map, style) => {
              map[style.name] = style.value;
              return map;
            }, {} as Record<string, any>)
          };
          
          // Identify most used styles
          const mostUsedStyles = {
            colors: [...styleUsageSummary.colors]
              .sort((a, b) => b.usageCount - a.usageCount)
              .slice(0, 5)
              .map(s => ({ name: s.name, count: s.usageCount, value: s.value })),
            
            textStyles: [...styleUsageSummary.textStyles]
              .sort((a, b) => b.usageCount - a.usageCount)
              .slice(0, 5)
              .map(s => ({ name: s.name, count: s.usageCount, value: s.value })),
            
            effectStyles: [...styleUsageSummary.effectStyles]
              .sort((a, b) => b.usageCount - a.usageCount)
              .slice(0, 5)
              .map(s => ({ name: s.name, count: s.usageCount, value: s.value }))
          };
          
          // Create a clean summary object for AI analysis
          const styleReport = {
            summary: {
              definedStyleCounts,
              usedStyleCounts,
              coverage: {
                colors: definedStyleCounts.colors > 0 ? 
                  (usedStyleCounts.colors / definedStyleCounts.colors * 100).toFixed(1) + '%' : '0%',
                textStyles: definedStyleCounts.textStyles > 0 ?
                  (usedStyleCounts.textStyles / definedStyleCounts.textStyles * 100).toFixed(1) + '%' : '0%',
                effectStyles: definedStyleCounts.effectStyles > 0 ?
                  (usedStyleCounts.effectStyles / definedStyleCounts.effectStyles * 100).toFixed(1) + '%' : '0%',
                gridStyles: definedStyleCounts.gridStyles > 0 ?
                  (usedStyleCounts.gridStyles / definedStyleCounts.gridStyles * 100).toFixed(1) + '%' : '0%',
                total: definedStyleCounts.total > 0 ?
                  (usedStyleCounts.total / definedStyleCounts.total * 100).toFixed(1) + '%' : '0%'
              }
            },
            stylesByName,
            mostUsedStyles,
            // Include full style usage data for reference
            detailedUsage: styleUsageSummary
          };
          
          Logger.log(`Successfully generated style mapping report for file ${fileKey}`);
          
          return {
            content: [{ type: "text", text: JSON.stringify(styleReport, null, 2) }],
          };
          
        } catch (error) {
          Logger.error(`Error generating style mapping report for file ${fileKey}:`, error);
          return {
            isError: true,
            content: [{ type: "text", text: `Error generating style mapping report: ${error}` }],
          };
        }
      }
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
