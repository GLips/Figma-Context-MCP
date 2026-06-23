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

const PER_REQUEST_KEY = "figd_TENANT_SECRET_xyz789";

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
        params: { name: "get_figma_data", arguments: { fileKey: "abc123" } },
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
    }
  });
});
