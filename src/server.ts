import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "./utils/logger.js";
import { createServer } from "./mcp/index.js";
import { getServerConfig } from "./config.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

let httpServer: Server | null = null;

/**
 * Start the MCP server in either stdio or HTTP mode.
 */
export async function startServer(): Promise<void> {
  const config = getServerConfig();

  const serverOptions = {
    isHTTP: !config.isStdioMode,
    outputFormat: config.outputFormat as "yaml" | "json",
    skipImageDownloads: config.skipImageDownloads,
    imageDir: config.imageDir,
  };

  if (config.isStdioMode) {
    const server = createServer(config.auth, serverOptions);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    const createMcpServer = () => createServer(config.auth, serverOptions);
    console.log(`Initializing Figma MCP Server in HTTP mode on ${config.host}:${config.port}...`);
    await startHttpServer(config.host, config.port, createMcpServer);

    process.on("SIGINT", async () => {
      Logger.log("Shutting down server...");
      await stopHttpServer();
      Logger.log("Server shutdown complete");
      process.exit(0);
    });
  }
}

export async function startHttpServer(
  host: string,
  port: number,
  createMcpServer: () => McpServer,
): Promise<Server> {
  if (httpServer) {
    throw new Error("HTTP server is already running");
  }

  const app = express();

  const handlePost = async (req: Request, res: Response) => {
    try {
      Logger.log("Received StreamableHTTP request");
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      Logger.log("StreamableHTTP request handled");
    } catch (error) {
      Logger.log("Error handling StreamableHTTP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  const handleMethodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  };

  // Mount stateless StreamableHTTP on both /mcp and /sse.
  // Serving StreamableHTTP at /sse lets existing client configs keep working —
  // modern MCP clients probe with a POST before falling back to SSE.
  for (const path of ["/mcp", "/sse"]) {
    app.post(path, express.json(), handlePost);
    app.get(path, handleMethodNotAllowed);
    app.delete(path, handleMethodNotAllowed);
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      Logger.log(`HTTP server listening on port ${port}`);
      Logger.log(`StreamableHTTP endpoint available at http://${host}:${port}/mcp`);
      Logger.log(
        `StreamableHTTP endpoint available at http://${host}:${port}/sse (backward compat)`,
      );
      resolve(server);
    });
    server.once("error", (err) => {
      httpServer = null;
      reject(err);
    });
    httpServer = server;
  });
}

export async function stopHttpServer(): Promise<void> {
  if (!httpServer) {
    throw new Error("HTTP server is not running");
  }

  return new Promise((resolve, reject) => {
    httpServer!.close((err) => {
      httpServer = null;
      if (err) reject(err);
      else resolve();
    });
  });
}
