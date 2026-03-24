import { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "./utils/logger.js";
import { createServer } from "./mcp/index.js";
import { getServerConfig } from "./config.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

let httpServer: Server | null = null;

type ActiveConnection = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};
const activeConnections = new Set<ActiveConnection>();

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

  const app = createMcpExpressApp({ host });

  const handlePost = async (req: Request, res: Response) => {
    Logger.log("Received StreamableHTTP request");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = createMcpServer();
    const conn: ActiveConnection = { transport, server: mcpServer };
    activeConnections.add(conn);
    res.on("close", () => {
      activeConnections.delete(conn);
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
    Logger.log("StreamableHTTP request handled");
  };

  const handleMethodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  };

  // Mount stateless StreamableHTTP on both /mcp and /sse.
  // Serving StreamableHTTP at /sse lets existing client configs keep working —
  // modern MCP clients probe with a POST before falling back to SSE.
  for (const path of ["/mcp", "/sse"]) {
    app.post(path, handlePost);
    app.get(path, handleMethodNotAllowed);
    app.delete(path, handleMethodNotAllowed);
  }

  // Express 5 forwards rejected promises from async handlers here.
  // Return a JSON-RPC error instead of Express's default HTML 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    Logger.log("Unhandled error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: ErrorCode.InternalError, message: "Internal server error" },
        id: null,
      });
    }
  });

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

  // Gracefully close all active MCP connections before tearing down the server
  for (const conn of activeConnections) {
    await conn.transport.close();
    await conn.server.close();
  }
  activeConnections.clear();

  return new Promise((resolve, reject) => {
    httpServer!.close((err) => {
      httpServer = null;
      if (err) reject(err);
      else resolve();
    });
    httpServer!.closeAllConnections();
  });
}
