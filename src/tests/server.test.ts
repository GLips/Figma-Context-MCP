import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

  it("connects, initializes, and lists tools via /mcp", async () => {
    const client = new Client({ name: "test-streamable", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

    await client.connect(transport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("get_figma_data");
    expect(toolNames).toContain("download_figma_images");

    await client.close();
  }, 15_000);

  it("connects, initializes, and lists tools via /sse (backward compat)", async () => {
    const client = new Client({ name: "test-sse-compat", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/sse`));

    await client.connect(transport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("get_figma_data");
    expect(toolNames).toContain("download_figma_images");

    await client.close();
  }, 15_000);

  it("responses contain no mcp-session-id header", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
        id: 1,
      }),
    });
    expect(res.headers.get("mcp-session-id")).toBeNull();
  }, 15_000);
});

describe("Method not allowed", () => {
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

  it("GET /mcp returns 405", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("DELETE /mcp returns 405", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("GET /sse returns 405", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sse`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("DELETE /sse returns 405", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sse`, { method: "DELETE" });
    expect(res.status).toBe(405);
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

  it("multiple StreamableHTTP clients work concurrently", async () => {
    const clientA = new Client({ name: "test-a", version: "1.0.0" });
    const transportA = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

    const clientB = new Client({ name: "test-b", version: "1.0.0" });
    const transportB = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/sse`));

    await Promise.all([clientA.connect(transportA), clientB.connect(transportB)]);

    const [toolsA, toolsB] = await Promise.all([clientA.listTools(), clientB.listTools()]);

    expect(toolsA.tools.map((t) => t.name)).toContain("get_figma_data");
    expect(toolsB.tools.map((t) => t.name)).toContain("get_figma_data");

    await Promise.all([clientA.close(), clientB.close()]);
  }, 15_000);
});

describe("Server lifecycle", () => {
  it("starts and listens on assigned port", async () => {
    const httpServer = await startHttpServer("127.0.0.1", 0, () =>
      createServer(dummyAuth, { isHTTP: true }),
    );
    const port = (httpServer.address() as AddressInfo).port;

    expect(port).toBeGreaterThan(0);

    await stopHttpServer();
  }, 15_000);

  it("stopHttpServer shuts down cleanly without hanging", async () => {
    await startHttpServer("127.0.0.1", 0, () => createServer(dummyAuth, { isHTTP: true }));

    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 5_000).unref(),
    );
    const result = await Promise.race([stopHttpServer().then(() => "stopped" as const), timeout]);

    expect(result).toBe("stopped");
  }, 15_000);
});
