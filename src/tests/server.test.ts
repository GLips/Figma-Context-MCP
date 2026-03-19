import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { createServer } from "../mcp/index.js";
import { startHttpServer, stopHttpServer } from "../server.js";
import type { AddressInfo } from "net";
import type { FigmaAuthOptions } from "../services/figma.js";

const dummyAuth: FigmaAuthOptions = {
  figmaApiKey: "test-key-not-used",
  figmaOAuthToken: "",
  useOAuth: false,
};

describe("StreamableHTTP transport", () => {
  let port: number;

  beforeAll(async () => {
    const mcpServer = createServer(dummyAuth, { isHTTP: true });
    const httpServer = await startHttpServer("127.0.0.1", 0, () => mcpServer);
    port = (httpServer.address() as AddressInfo).port;
  }, 15_000);

  afterAll(async () => {
    try {
      await stopHttpServer();
    } catch {
      // Server may not have started
    }
  });

  it("connects, initializes, and lists tools", async () => {
    const client = new Client({ name: "test-streamable", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

    await client.connect(transport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("get_figma_data");
    expect(toolNames).toContain("download_figma_images");

    await transport.terminateSession();
    await client.close();
  }, 15_000);
});

describe("SSE transport", () => {
  let port: number;

  beforeAll(async () => {
    const mcpServer = createServer(dummyAuth, { isHTTP: true });
    const httpServer = await startHttpServer("127.0.0.1", 0, () => mcpServer);
    port = (httpServer.address() as AddressInfo).port;
  }, 15_000);

  afterAll(async () => {
    try {
      await stopHttpServer();
    } catch {
      // Server may not have started
    }
  });

  it("connects, initializes, and lists tools", async () => {
    const client = new Client({ name: "test-sse", version: "1.0.0" });
    const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));

    await client.connect(transport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("get_figma_data");

    await client.close();
  }, 15_000);
});

describe("Negative protocol tests", () => {
  let port: number;

  beforeAll(async () => {
    const mcpServer = createServer(dummyAuth, { isHTTP: true });
    const httpServer = await startHttpServer("127.0.0.1", 0, () => mcpServer);
    port = (httpServer.address() as AddressInfo).port;
  }, 15_000);

  afterAll(async () => {
    try {
      await stopHttpServer();
    } catch {
      // Server may not have started
    }
  });

  it("POST /mcp without session ID and non-initialize body returns 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 1,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /mcp with invalid session ID returns 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "GET",
      headers: { "mcp-session-id": "nonexistent-session" },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /mcp with invalid session ID returns 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": "nonexistent-session" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /messages with unknown sessionId returns 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/messages?sessionId=nonexistent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 1,
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Multi-client test", () => {
  let port: number;

  beforeAll(async () => {
    const httpServer = await startHttpServer("127.0.0.1", 0, () =>
      createServer(dummyAuth, { isHTTP: true }),
    );
    port = (httpServer.address() as AddressInfo).port;
  }, 15_000);

  afterAll(async () => {
    try {
      await stopHttpServer();
    } catch {
      // Server may not have started
    }
  });

  it("StreamableHTTP and SSE clients work concurrently", async () => {
    const streamableClient = new Client({ name: "test-streamable", version: "1.0.0" });
    const streamableTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );

    const sseClient = new Client({ name: "test-sse", version: "1.0.0" });
    const sseTransport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));

    // Connect both concurrently
    await Promise.all([
      streamableClient.connect(streamableTransport),
      sseClient.connect(sseTransport),
    ]);

    // Both should be able to list tools
    const [streamableTools, sseTools] = await Promise.all([
      streamableClient.listTools(),
      sseClient.listTools(),
    ]);

    expect(streamableTools.tools.map((t) => t.name)).toContain("get_figma_data");
    expect(sseTools.tools.map((t) => t.name)).toContain("get_figma_data");

    // Clean up
    await streamableTransport.terminateSession();
    await Promise.all([streamableClient.close(), sseClient.close()]);
  }, 15_000);
});

describe("Session reconnection", () => {
  let port: number;

  beforeAll(async () => {
    const httpServer = await startHttpServer("127.0.0.1", 0, () =>
      createServer(dummyAuth, { isHTTP: true }),
    );
    port = (httpServer.address() as AddressInfo).port;
  }, 15_000);

  afterAll(async () => {
    try {
      await stopHttpServer();
    } catch {
      // Server may not have started
    }
  });

  it("connects, terminates, and reconnects successfully", async () => {
    // First session
    const client1 = new Client({ name: "test-reconnect-1", version: "1.0.0" });
    const transport1 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client1.connect(transport1);
    const { tools: tools1 } = await client1.listTools();
    expect(tools1.map((t) => t.name)).toContain("get_figma_data");

    await transport1.terminateSession();
    await client1.close();

    // Second session after termination
    const client2 = new Client({ name: "test-reconnect-2", version: "1.0.0" });
    const transport2 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client2.connect(transport2);
    const { tools: tools2 } = await client2.listTools();
    expect(tools2.map((t) => t.name)).toContain("get_figma_data");

    await transport2.terminateSession();
    await client2.close();
  }, 15_000);

  it("reconnects after client drops without clean termination", async () => {
    // First session — close abruptly without terminateSession()
    const client1 = new Client({ name: "test-dirty-close-1", version: "1.0.0" });
    const transport1 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client1.connect(transport1);
    await client1.listTools();

    // Simulate unclean disconnect (just close, no terminate)
    await client1.close();

    // Second session should still work
    const client2 = new Client({ name: "test-dirty-close-2", version: "1.0.0" });
    const transport2 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client2.connect(transport2);
    const { tools } = await client2.listTools();
    expect(tools.map((t) => t.name)).toContain("get_figma_data");

    await transport2.terminateSession();
    await client2.close();
  }, 15_000);
});

describe("Server lifecycle", () => {
  it("starts and listens on assigned port", async () => {
    const mcpServer = createServer(dummyAuth, { isHTTP: true });
    const httpServer = await startHttpServer("127.0.0.1", 0, () => mcpServer);
    const port = (httpServer.address() as AddressInfo).port;

    expect(port).toBeGreaterThan(0);

    await stopHttpServer();
  }, 15_000);

  it("stopHttpServer shuts down cleanly without hanging", async () => {
    const mcpServer = createServer(dummyAuth, { isHTTP: true });
    await startHttpServer("127.0.0.1", 0, () => mcpServer);

    // Race stopHttpServer against a deadline
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 5_000).unref(),
    );
    const result = await Promise.race([stopHttpServer().then(() => "stopped" as const), timeout]);

    expect(result).toBe("stopped");
  }, 15_000);
});
