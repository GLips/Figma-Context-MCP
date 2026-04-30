import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock posthog-node so we can observe what the telemetry client sends without
// hitting the network. We're testing OUR code (withRequestSecrets, ALS
// propagation, redactErrorMessage merge logic) end-to-end — only the system
// boundary is mocked.
const captureSpy = vi.fn();
const shutdownSpy = vi.fn(async () => {});
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = captureSpy;
    shutdown = shutdownSpy;
  },
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { startHttpServer, stopHttpServer } from "~/server.js";
import { initTelemetry, shutdown as shutdownTelemetry } from "~/telemetry/index.js";
import { redactFigmaIdentifiers } from "~/telemetry/client.js";

const PER_REQUEST_KEY = "figd_TENANT_SECRET_xyz789";
const TEST_FILE_KEY = "lJDkSwHeX0eLHJ8E2qV6Wf";

describe("per-request telemetry redaction", () => {
  let client: Client;
  let httpServer: Server | undefined;

  beforeEach(() => {
    captureSpy.mockClear();
    // Init with NO global redaction secrets so the assertion proves the
    // per-request AsyncLocalStorage path is what's doing the scrubbing.
    initTelemetry({ optOut: false, immediateFlush: true, redactFromErrors: [] });

    // Stub fetch to fail with the per-request token embedded in the error
    // message. FigmaService wraps the original message into a new Error, so
    // the secret survives into `outcome.error.message` and reaches captureEvent.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("https://api.figma.com")) {
          throw new Error(`upstream failure (token=${PER_REQUEST_KEY})`);
        }
        return realFetch(input, init);
      }),
    );
  });

  afterEach(async () => {
    await client?.close();
    if (httpServer) {
      await stopHttpServer();
      httpServer = undefined;
    }
    await shutdownTelemetry();
    vi.unstubAllGlobals();
  });

  it("scrubs per-request X-Figma-Token from telemetry error_message", async () => {
    httpServer = await startHttpServer(
      "127.0.0.1",
      0,
      { figmaApiKey: "", figmaOAuthToken: "", useOAuth: false },
      {},
    );
    const port = (httpServer.address() as AddressInfo).port;

    client = new Client({ name: "redaction-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { "X-Figma-Token": PER_REQUEST_KEY } },
      }),
    );

    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "get_figma_data", arguments: { fileKey: TEST_FILE_KEY } },
      },
      CallToolResultSchema,
    );
    // Sanity: the tool call should fail (fetch threw), so we know the error
    // path actually fired.
    expect(result.isError).toBe(true);

    const errorEvents = captureSpy.mock.calls
      .map(([args]) => args)
      .filter((args) => args?.properties?.is_error === true);
    expect(errorEvents.length).toBeGreaterThan(0);

    for (const event of errorEvents) {
      const message = String(event.properties.error_message ?? "");
      expect(message, `event ${event.event} leaked the per-request token`).not.toContain(
        PER_REQUEST_KEY,
      );
      expect(message).toContain("[REDACTED]");
      // The endpoint path FigmaService interpolates into its error message
      // contains the file key (`/files/<key>`); covered by issue #354.
      expect(message, `event ${event.event} leaked the file key`).not.toContain(TEST_FILE_KEY);
      expect(message).toContain("[FILE_KEY]");
    }
  });
});

describe("redactFigmaIdentifiers", () => {
  it("redacts file keys in /files/ paths", () => {
    expect(
      redactFigmaIdentifiers("Failed to make request to Figma API endpoint '/files/abc123def'"),
    ).toBe("Failed to make request to Figma API endpoint '/files/[FILE_KEY]'");
  });

  it("redacts file keys in /files/<key>/<path> sub-paths", () => {
    expect(
      redactFigmaIdentifiers(
        "Request to Figma API endpoint '/files/lJDkSwHeX0eLHJ8E2qV6Wf/nodes' returned 403",
      ),
    ).toBe("Request to Figma API endpoint '/files/[FILE_KEY]/nodes' returned 403");
  });

  it("redacts file keys in /images/ paths", () => {
    expect(redactFigmaIdentifiers("/images/lJDkSwHeX0eLHJ8E2qV6Wf?ids=1:2")).toBe(
      "/images/[FILE_KEY]?ids=[NODE_ID]",
    );
  });

  it("redacts node IDs in ?ids=, &node-id=, and &nodeId= query params", () => {
    expect(redactFigmaIdentifiers("/files/abc123def/nodes?ids=1:2,3:4&depth=2")).toBe(
      "/files/[FILE_KEY]/nodes?ids=[NODE_ID]&depth=2",
    );
    expect(redactFigmaIdentifiers("https://figma.com/file/x?node-id=1-2")).toBe(
      "https://figma.com/file/x?node-id=[NODE_ID]",
    );
    expect(redactFigmaIdentifiers("?nodeId=I123:456;789:0")).toBe("?nodeId=[NODE_ID]");
  });

  it("redacts bare 'Node <id>' strings from extractor errors", () => {
    expect(redactFigmaIdentifiers("Node 1:2 was not found in the Figma file.")).toBe(
      "Node [NODE_ID] was not found in the Figma file.",
    );
    expect(redactFigmaIdentifiers("Node I123:456;789:0 was not found")).toBe(
      "Node [NODE_ID] was not found",
    );
  });

  it("does not clobber unrelated short paths", () => {
    expect(redactFigmaIdentifiers("/files/x not found")).toBe("/files/x not found");
    expect(redactFigmaIdentifiers("ENOENT: no such file or directory")).toBe(
      "ENOENT: no such file or directory",
    );
  });
});
