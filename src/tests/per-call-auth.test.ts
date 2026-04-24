import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "~/mcp/index.js";
import { downloadFigmaImagesTool, getFigmaDataTool } from "~/mcp/tools/index.js";

const figmaFileResponse = {
  name: "Auth Test File",
  lastModified: "2026-01-01T00:00:00Z",
  thumbnailUrl: "",
  version: "1",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "1:1",
        name: "Page",
        type: "CANVAS",
        visible: true,
        children: [],
      },
    ],
  },
  components: {},
  componentSets: {},
  schemaVersion: 0,
  styles: {},
};

describe("per-call Figma API key authentication", () => {
  let client: Client;
  let server: McpServer;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => Response.json(figmaFileResponse));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    vi.unstubAllGlobals();
  });

  async function connectServer(auth: Parameters<typeof createServer>[0]) {
    server = createServer(auth, { transport: "stdio" });
    client = new Client({ name: "per-call-auth-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  }

  function firstRequestHeaders(): Record<string, string> {
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers?: Record<string, string> };
    return init.headers ?? {};
  }

  it("accepts optional figma_api_key in both tool input schemas", () => {
    expect(
      getFigmaDataTool.parametersSchema.parse({
        fileKey: "abc123",
        figma_api_key: "per-call-key",
      }).figma_api_key,
    ).toBe("per-call-key");

    expect(
      downloadFigmaImagesTool.parametersSchema.parse({
        fileKey: "abc123",
        nodes: [{ nodeId: "1:2", fileName: "asset.png" }],
        localPath: "images",
        figma_api_key: "per-call-key",
      }).figma_api_key,
    ).toBe("per-call-key");
  });

  it("uses per-call figma_api_key instead of the server API key", async () => {
    await connectServer({
      figmaApiKey: "server-key",
      figmaOAuthToken: "",
      useOAuth: false,
    });

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123", figma_api_key: "per-call-key" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBeUndefined();
    expect(firstRequestHeaders()).toMatchObject({ "X-Figma-Token": "per-call-key" });
  });

  it("falls back to server API key when figma_api_key is omitted", async () => {
    await connectServer({
      figmaApiKey: "server-key",
      figmaOAuthToken: "",
      useOAuth: false,
    });

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBeUndefined();
    expect(firstRequestHeaders()).toMatchObject({ "X-Figma-Token": "server-key" });
  });

  it("allows startup without global credentials when figma_api_key is provided", async () => {
    await connectServer({
      figmaApiKey: "",
      figmaOAuthToken: "",
      useOAuth: false,
    });

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123", figma_api_key: "per-call-key" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBeUndefined();
    expect(firstRequestHeaders()).toMatchObject({ "X-Figma-Token": "per-call-key" });
  });

  it("returns a tool error when no credentials are available for the call", async () => {
    await connectServer({
      figmaApiKey: "",
      figmaOAuthToken: "",
      useOAuth: false,
    });

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "abc123" },
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toContain("Figma API authentication is required");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses per-call figma_api_key for download_figma_images", async () => {
    const perCallService = {
      downloadImages: vi.fn(async () => []),
    };
    const serverService = {
      downloadImages: vi.fn(async () => []),
      withApiKey: vi.fn(() => perCallService),
    };
    const extra = {
      sendNotification: vi.fn(async () => {}),
      signal: AbortSignal.timeout(30_000),
    };

    const result = await downloadFigmaImagesTool.handler(
      {
        fileKey: "abc123",
        nodes: [{ nodeId: "1:2", fileName: "asset.png" }],
        localPath: "images",
        pngScale: 2,
        figma_api_key: "per-call-key",
      },
      serverService as unknown as Parameters<typeof downloadFigmaImagesTool.handler>[1],
      process.cwd(),
      "stdio",
      "api_key",
      undefined,
      extra as unknown as Parameters<typeof downloadFigmaImagesTool.handler>[6],
    );

    expect(result.isError).toBeUndefined();
    expect(serverService.withApiKey).toHaveBeenCalledWith("per-call-key");
    expect(perCallService.downloadImages).toHaveBeenCalledOnce();
    expect(serverService.downloadImages).not.toHaveBeenCalled();
  });
});
