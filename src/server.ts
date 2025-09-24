import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "./utils/logger.js";

let httpServer: Server | null = null;
const transports = {
  sse: {} as Record<string, SSEServerTransport>,
};

// Create a single transport for stateless mode
const streamableHttpTransport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // Stateless mode: no session ID
});

export async function startHttpServer(port: number, mcpServer: McpServer): Promise<void> {
  const app = express();

  mcpServer.connect(streamableHttpTransport);

  // Parse JSON requests for the Streamable HTTP endpoint only, will break SSE endpoint
  app.use("/mcp", express.json());

  // Modern Streamable HTTP endpoint (Stateless mode)
  app.post("/mcp", async (req, res) => {
    Logger.log("Received StreamableHTTP request");

    await streamableHttpTransport.handleRequest(req, res, req.body);

    Logger.log("StreamableHTTP request handled");
  });

  // In stateless mode, GET and DELETE endpoints return 405 Method Not Allowed
  app.get("/mcp", async (req, res) => {
    Logger.log("Received GET /mcp request - not allowed in stateless mode");
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed in stateless mode",
      },
      id: null,
    });
  });

  app.delete("/mcp", async (req, res) => {
    Logger.log("Received DELETE /mcp request - not allowed in stateless mode");
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed in stateless mode",
      },
      id: null,
    });
  });

  app.get("/sse", async (req, res) => {
    Logger.log("Establishing new SSE connection");
    const transport = new SSEServerTransport("/messages", res);
    Logger.log(`New SSE connection established for sessionId ${transport.sessionId}`);
    Logger.log("/sse request headers:", req.headers);
    Logger.log("/sse request body:", req.body);

    transports.sse[transport.sessionId] = transport;
    res.on("close", () => {
      delete transports.sse[transport.sessionId];
    });

    await mcpServer.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.sse[sessionId];
    if (transport) {
      Logger.log(`Received SSE message for sessionId ${sessionId}`);
      Logger.log("/messages request headers:", req.headers);
      Logger.log("/messages request body:", req.body);
      await transport.handlePostMessage(req, res);
    } else {
      res.status(400).send(`No transport found for sessionId ${sessionId}`);
      return;
    }
  });

  httpServer = app.listen(port, () => {
    Logger.log(`HTTP server listening on port ${port}`);
    Logger.log(`SSE endpoint available at http://localhost:${port}/sse`);
    Logger.log(`Message endpoint available at http://localhost:${port}/messages`);
    Logger.log(`StreamableHTTP endpoint available at http://localhost:${port}/mcp`);
  });

  process.on("SIGINT", async () => {
    Logger.log("Shutting down server...");

    // Close all active transports to properly clean up resources
    await closeTransports(transports.sse);
    await streamableHttpTransport.close();

    Logger.log("Server shutdown complete");
    process.exit(0);
  });
}

async function closeTransports(transports: Record<string, SSEServerTransport>) {
  for (const sessionId in transports) {
    try {
      await transports[sessionId]?.close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport for session ${sessionId}:`, error);
    }
  }
}

export async function stopHttpServer(): Promise<void> {
  if (!httpServer) {
    throw new Error("HTTP server is not running");
  }

  return new Promise((resolve, reject) => {
    httpServer!.close((err: Error | undefined) => {
      if (err) {
        reject(err);
        return;
      }
      httpServer = null;
      const closing = Object.values(transports.sse).map((transport) => {
        return transport.close();
      });
      Promise.all(closing).then(() => {
        resolve();
      });
    });
  });
}
