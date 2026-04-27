import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { startHttpServer, stopHttpServer } from "~/server.js";
import type { FigmaAuthOptions } from "~/services/figma.js";

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

const emptyAuth = {
  figmaApiKey: "",
  figmaOAuthToken: "",
  useOAuth: false,
};

describe("HTTP header Figma API key authentication", () => {
  let client: Client;
  let httpServer: Server | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const realFetch = globalThis.fetch;
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://api.figma.com")) {
        return Response.json(figmaFileResponse);
      }
      return realFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await client?.close();
    if (httpServer) {
      await stopHttpServer();
      httpServer = undefined;
    }
    vi.unstubAllGlobals();
  });

  async function connectClient(
    headers?: Record<string, string>,
    baseAuth: FigmaAuthOptions = emptyAuth,
  ) {
    httpServer = await startHttpServer("127.0.0.1", 0, baseAuth, {});
    const port = (httpServer.address() as AddressInfo).port;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: headers ? { headers } : undefined,
    });
    client = new Client({ name: "http-header-auth-test", version: "1.0.0" });
    await client.connect(transport);
  }

  function firstFigmaRequestHeaders(): Record<string, string> {
    const figmaCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("https://api.figma.com"),
    );
    const init = figmaCall?.[1] as RequestInit & { headers?: Record<string, string> };
    return init.headers ?? {};
  }

  function figmaRequestCount(): number {
    return fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("https://api.figma.com"),
    ).length;
  }

  it("uses X-Figma-Token from the HTTP request for get_figma_data", async () => {
    await connectClient({ "X-Figma-Token": "request-key" });

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
    expect(firstFigmaRequestHeaders()).toMatchObject({ "X-Figma-Token": "request-key" });
  });

  it("uses X-Figma-Token from the HTTP request instead of the server API key", async () => {
    await connectClient(
      { "X-Figma-Token": "request-key" },
      { figmaApiKey: "server-key", figmaOAuthToken: "", useOAuth: false },
    );

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
    expect(firstFigmaRequestHeaders()).toMatchObject({ "X-Figma-Token": "request-key" });
  });

  it("returns a tool error when no server or request credentials are available", async () => {
    await connectClient();

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
      expect(result.content[0].text).toContain("send X-Figma-Token on the HTTP request");
    }
    expect(figmaRequestCount()).toBe(0);
  });
});
