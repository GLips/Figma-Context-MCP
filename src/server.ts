import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaService } from "./services/figma";
import { GitLabService } from "./services/gitlab";
import express, { Request, Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { IncomingMessage, ServerResponse } from "http";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SimplifiedDesign } from "./services/simplify-node-response";
import { generateSwiftUICode } from "./transformers/swiftui";

export const Logger = {
  log: (...args: any[]) => {},
  error: (...args: any[]) => {},
};

export class FigmaMcpServer {
  private readonly server: McpServer;
  private readonly figmaService: FigmaService;
  private readonly gitlabService: GitLabService | null = null;
  private sseTransport: SSEServerTransport | null = null;

  constructor(
    figmaApiKey: string, 
    gitlabToken?: string, 
    gitlabBaseUrl?: string, 
    gitlabProjectId?: string, 
    gitlabBranch?: string
  ) {
    this.figmaService = new FigmaService(figmaApiKey);
    
    // Initialize GitLab service if all required parameters are provided
    if (gitlabToken && gitlabBaseUrl && gitlabProjectId && gitlabBranch) {
      this.gitlabService = new GitLabService(
        gitlabToken,
        gitlabBaseUrl,
        gitlabProjectId,
        gitlabBranch
      );
    }
    
    this.server = new McpServer(
      {
        name: "Figma MCP Server",
        version: "0.1.7",
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
    // Tool to get file information
    this.server.tool(
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
            } of ${nodeId ? `node ${nodeId} from file` : `full file`} ${fileKey} at depth: ${
              depth ?? "all layers"
            }`,
          );

          let file: SimplifiedDesign;
          if (nodeId) {
            file = await this.figmaService.getNode(fileKey, nodeId, depth);
          } else {
            file = await this.figmaService.getFile(fileKey, depth);
          }

          Logger.log(`Successfully fetched file: ${file.name}`);
          const { nodes, globalVars, ...metadata } = file;

          // Stringify each node individually to try to avoid max string length error with big files
          const nodesJson = `[${nodes.map((node) => JSON.stringify(node, null, 2)).join(",")}]`;
          const metadataJson = JSON.stringify(metadata, null, 2);
          const globalVarsJson = JSON.stringify(globalVars, null, 2);
          const resultJson = `{ "metadata": ${metadataJson}, "nodes": ${nodesJson}, "globalVars": ${globalVarsJson} }`;

          return {
            content: [{ type: "text", text: resultJson }],
          };
        } catch (error) {
          Logger.error(`Error fetching file ${fileKey}:`, error);
          return {
            content: [{ type: "text", text: `Error fetching file: ${error}` }],
          };
        }
      },
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
            content: [{ type: "text", text: `Error downloading images: ${error}` }],
          };
        }
      },
    );

    // New tool to generate SwiftUI code
    this.server.tool(
      "generate_swiftui_code",
      "Generate SwiftUI code from a Figma design",
      {
        fileKey: z
          .string()
          .describe(
            "The key of the Figma file to generate code from",
          ),
        nodeId: z
          .string()
          .optional()
          .describe(
            "The ID of the specific node to generate code from",
          ),
        useResponsiveLayout: z
          .boolean()
          .optional()
          .describe(
            "Whether to use responsive layout in the generated code. If not provided, it will be automatically determined based on the design.",
          ),
      },
      async ({ fileKey, nodeId, useResponsiveLayout }) => {
        try {
          console.log('📥 Received SwiftUI generation request:');
          console.log(`   File Key: ${fileKey}`);
          console.log(`   Node ID: ${nodeId || 'entire file'}`);
          console.log(`   Force Responsive Layout: ${useResponsiveLayout !== undefined ? useResponsiveLayout : 'auto'}`);

          let design: SimplifiedDesign;
          if (nodeId) {
            console.log('🔍 Fetching specific node from Figma...');
            design = await this.figmaService.getNode(fileKey, nodeId);
          } else {
            console.log('🔍 Fetching entire file from Figma...');
            design = await this.figmaService.getFile(fileKey);
          }
          console.log(`✅ Successfully fetched Figma design: ${design.name}`);

          const swiftUICode = generateSwiftUICode(design, useResponsiveLayout);
          
          console.log('✨ SwiftUI code generation completed successfully');
          console.log('📤 Sending response...');
          
          return {
            content: [{ type: "text", text: swiftUICode }],
          };
        } catch (error) {
          console.error('❌ Error in SwiftUI generation:', error);
          Logger.error(`Error generating SwiftUI code for file ${fileKey}:`, error);
          return {
            content: [{ type: "text", text: `Error generating SwiftUI code: ${error}` }],
          };
        }
      },
    );

    // Register GitLab tools if GitLab service is available
    if (this.gitlabService) {
      // Tool to commit SwiftUI code to GitLab
      this.server.tool(
        "commit_to_gitlab",
        "Commit generated SwiftUI code to GitLab repository",
        {
          filePath: z
            .string()
            .describe(
              "The path where the file should be saved in the repository (e.g., 'Components/Button.swift')",
            ),
          content: z
            .string()
            .describe(
              "The content to be committed to the repository",
            ),
          commitMessage: z
            .string()
            .describe(
              "The commit message for this change",
            ),
          branch: z
            .string()
            .optional()
            .describe(
              "The branch to commit to (defaults to the configured default branch)",
            ),
        },
        async ({ filePath, content, commitMessage, branch }) => {
          try {
            if (!this.gitlabService) {
              return {
                content: [{ type: "text", text: "GitLab service is not configured" }],
              };
            }

            console.log('📥 Received GitLab commit request:');
            console.log(`   File Path: ${filePath}`);
            console.log(`   Branch: ${branch || 'default configured branch'}`);
            console.log(`   Commit Message: ${commitMessage}`);

            const success = await this.gitlabService.createOrUpdateFile(
              filePath,
              content,
              commitMessage,
              branch
            );

            if (success) {
              console.log('✅ Successfully committed to GitLab');
              return {
                content: [{ 
                  type: "text", 
                  text: `Successfully committed ${filePath} to GitLab repository` 
                }],
              };
            } else {
              console.error('❌ Failed to commit to GitLab');
              return {
                content: [{ 
                  type: "text", 
                  text: "Failed to commit to GitLab repository" 
                }],
              };
            }
          } catch (error) {
            console.error('❌ Error in GitLab commit:', error);
            Logger.error(`Error committing to GitLab:`, error);
            return {
              content: [{ type: "text", text: `Error committing to GitLab: ${error}` }],
            };
          }
        },
      );

      // Tool to get branches from GitLab
      this.server.tool(
        "get_gitlab_branches",
        "Get list of branches from GitLab repository",
        {},
        async () => {
          try {
            if (!this.gitlabService) {
              return {
                content: [{ type: "text", text: "GitLab service is not configured" }],
              };
            }

            console.log('📥 Received GitLab branches request');
            const branches = await this.gitlabService.getBranches();
            
            console.log(`✅ Successfully retrieved ${branches.length} branches from GitLab`);
            return {
              content: [{ 
                type: "text", 
                text: JSON.stringify(branches, null, 2) 
              }],
            };
          } catch (error) {
            console.error('❌ Error getting GitLab branches:', error);
            Logger.error(`Error getting GitLab branches:`, error);
            return {
              content: [{ type: "text", text: `Error getting GitLab branches: ${error}` }],
            };
          }
        },
      );

      // Tool to create a new branch in GitLab
      this.server.tool(
        "create_gitlab_branch",
        "Create a new branch in GitLab repository",
        {
          branchName: z
            .string()
            .describe(
              "The name of the new branch to create",
            ),
          ref: z
            .string()
            .optional()
            .describe(
              "The branch or commit to create from (defaults to the configured default branch)",
            ),
        },
        async ({ branchName, ref }) => {
          try {
            if (!this.gitlabService) {
              return {
                content: [{ type: "text", text: "GitLab service is not configured" }],
              };
            }

            console.log('📥 Received GitLab create branch request:');
            console.log(`   Branch Name: ${branchName}`);
            console.log(`   Reference: ${ref || 'default configured branch'}`);
            
            const branch = await this.gitlabService.createBranch(branchName, ref);
            
            console.log(`✅ Successfully created branch ${branchName} in GitLab`);
            return {
              content: [{ 
                type: "text", 
                text: `Successfully created branch ${branchName} in GitLab repository` 
              }],
            };
          } catch (error) {
            console.error('❌ Error creating GitLab branch:', error);
            Logger.error(`Error creating GitLab branch:`, error);
            return {
              content: [{ type: "text", text: `Error creating GitLab branch: ${error}` }],
            };
          }
        },
      );

      // Tool to get file from GitLab
      this.server.tool(
        "get_gitlab_file",
        "Get a file from GitLab repository",
        {
          filePath: z
            .string()
            .describe(
              "The path of the file to retrieve from the repository",
            ),
          ref: z
            .string()
            .optional()
            .describe(
              "The branch or commit to get the file from (defaults to the configured default branch)",
            ),
        },
        async ({ filePath, ref }) => {
          try {
            if (!this.gitlabService) {
              return {
                content: [{ type: "text", text: "GitLab service is not configured" }],
              };
            }

            console.log('📥 Received GitLab get file request:');
            console.log(`   File Path: ${filePath}`);
            console.log(`   Reference: ${ref || 'default configured branch'}`);
            
            const fileContent = await this.gitlabService.getFile(filePath, ref);
            
            console.log(`✅ Successfully retrieved file ${filePath} from GitLab`);
            return {
              content: [{ 
                type: "text", 
                text: fileContent 
              }],
            };
          } catch (error) {
            console.error('❌ Error getting GitLab file:', error);
            Logger.error(`Error getting GitLab file:`, error);
            return {
              content: [{ type: "text", text: `Error getting GitLab file: ${error}` }],
            };
          }
        },
      );

      // Tool to list files and directories in a GitLab repository
      this.server.tool(
        "list_gitlab_repository",
        "List files and directories in a GitLab repository",
        {
          path: z
            .string()
            .optional()
            .describe(
              "The path in the repository to list (use empty string for root)",
            ),
          ref: z
            .string()
            .optional()
            .describe(
              "The branch or commit to list files from (defaults to the configured default branch)",
            ),
          recursive: z
            .boolean()
            .optional()
            .describe(
              "Whether to list files recursively (defaults to false)",
            ),
        },
        async ({ path = "", ref, recursive = false }) => {
          try {
            if (!this.gitlabService) {
              return {
                content: [{ type: "text", text: "GitLab service is not configured" }],
              };
            }

            console.log('📥 Received GitLab repository listing request:');
            console.log(`   Path: ${path || 'root'}`);
            console.log(`   Reference: ${ref || 'default configured branch'}`);
            console.log(`   Recursive: ${recursive}`);
            
            const treeItems = await this.gitlabService.getRepositoryTree(path, ref, recursive);
            
            // Format the tree items for better readability
            const formattedItems = treeItems.map(item => {
              const icon = item.type === 'tree' ? '📁' : '📄';
              return `${icon} ${item.path}`;
            }).join('\n');
            
            console.log(`✅ Successfully retrieved ${treeItems.length} items from GitLab repository`);
            return {
              content: [{ 
                type: "text", 
                text: formattedItems || "No files found in this path" 
              }],
            };
          } catch (error) {
            console.error('❌ Error listing GitLab repository:', error);
            Logger.error(`Error listing GitLab repository:`, error);
            return {
              content: [{ type: "text", text: `Error listing GitLab repository: ${error}` }],
            };
          }
        },
      );

      // Tool to test the GitLab connection
      this.server.tool(
        "test_gitlab_connection",
        "Test the connection to the GitLab API",
        {},
        async () => {
          try {
            if (!this.gitlabService) {
              return {
                content: [{ type: "text", text: "GitLab service is not configured" }],
              };
            }

            console.log('📥 Received GitLab connection test request');
            
            const result = await this.gitlabService.testConnection();
            
            if (result.success) {
              console.log('✅ GitLab connection test successful');
              return {
                content: [{ 
                  type: "text", 
                  text: `✅ ${result.message}` 
                }],
              };
            } else {
              console.error('❌ GitLab connection test failed');
              return {
                content: [{ 
                  type: "text", 
                  text: `❌ ${result.message}` 
                }],
              };
            }
          } catch (error) {
            console.error('❌ Error testing GitLab connection:', error);
            Logger.error(`Error testing GitLab connection:`, error);
            return {
              content: [{ type: "text", text: `Error testing GitLab connection: ${error}` }],
            };
          }
        },
      );
    }
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
        // @ts-expect-error Not sure why Express types aren't working
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
