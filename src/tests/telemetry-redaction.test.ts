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
import { REDACTED_FILE_KEY, REDACTED_NODE_ID } from "~/telemetry/redact-identifiers.js";

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

/**
 * Figma file keys and node IDs are identifiers for a customer's document, and
 * our most useful error strings name them (`/files/<key>/nodes?ids=<nodeId>`,
 * `Node 1:2 was not found`). These tests drive the real producers —
 * `FigmaService` for the endpoint-bearing wraps, the REST adapter for the
 * missing-node throw — so they assert the privacy contract ("no file key or
 * node ID reaches PostHog") rather than the regex shapes in
 * `telemetry/redact-identifiers.ts`.
 */
describe("figma identifier redaction in telemetry error_message", () => {
  const FILE_KEY = "aB3xYz9QpLmN0kRtVwSdEf";
  const NODE_ID = "1234:5678";

  function errorMessagesSent(): string[] {
    return captureSpy.mock.calls
      .map(([args]) => args)
      .filter((args) => args?.properties?.is_error === true)
      .map((args) => String(args.properties.error_message ?? ""));
  }

  async function captureThrown(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
    } catch (error) {
      return error;
    }
    throw new Error("expected the call to throw");
  }

  beforeEach(() => {
    captureSpy.mockClear();
    initTelemetry({ optOut: false, immediateFlush: true, redactFromErrors: [] });
  });

  afterEach(async () => {
    await shutdownTelemetry();
    vi.unstubAllGlobals();
  });

  it("scrubs the file key and node ID from a 403 on the nodes endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"err":"Not allowed"}', {
            status: 403,
            statusText: "Forbidden",
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const { FigmaService } = await import("~/services/figma.js");
    const { captureGetFigmaDataCall } = await import("~/telemetry/index.js");
    const service = new FigmaService({
      figmaApiKey: "figd_test",
      figmaOAuthToken: "",
      useOAuth: false,
    });

    const error = await captureThrown(() => service.getRawNode(FILE_KEY, NODE_ID));

    // Sanity: the user-facing message is *supposed* to name the endpoint —
    // that's what makes a 403 debuggable. Redaction happens at the telemetry
    // boundary, not at the throw site.
    expect(String((error as Error).message)).toContain(FILE_KEY);

    captureGetFigmaDataCall(
      { input: { fileKey: FILE_KEY, nodeId: NODE_ID }, outputFormat: "tree", durationMs: 1, error },
      { transport: "stdio", authMode: "api_key" },
    );

    const [message] = errorMessagesSent();
    expect(message).not.toContain(FILE_KEY);
    expect(message).not.toContain(NODE_ID);
    expect(message).toContain(`/files/${REDACTED_FILE_KEY}`);
    expect(message).toContain(`ids=${REDACTED_NODE_ID}`);

    // The analytics signal survives the scrub.
    const [event] = captureSpy.mock.calls.map(([args]) => args);
    expect(event.properties.http_status).toBe(403);
    expect(event.properties.error_category).toBe("auth");
  });

  it("scrubs the node ID from the REST adapter's missing-node error", async () => {
    const { simplifyRestResponse } = await import("~/adapters/rest/rest.js");
    const { captureGetFigmaDataCall } = await import("~/telemetry/index.js");

    const error = await captureThrown(async () =>
      simplifyRestResponse({ name: "test", nodes: { [NODE_ID]: null } } as never),
    );
    expect(String((error as Error).message)).toContain(NODE_ID);

    captureGetFigmaDataCall(
      { input: { fileKey: FILE_KEY, nodeId: NODE_ID }, outputFormat: "tree", durationMs: 1, error },
      { transport: "stdio", authMode: "api_key" },
    );

    const [message] = errorMessagesSent();
    expect(message).not.toContain(NODE_ID);
    expect(message).toContain(`Node ${REDACTED_NODE_ID} was not found`);
    const [event] = captureSpy.mock.calls.map(([args]) => args);
    expect(event.properties.error_category).toBe("not_found");
  });

  it("scrubs a percent-encoded Figma URL echoed back by a proxy block page", async () => {
    // Corporate proxies splice the blocked URL into their HTML block page, and
    // `buildForbiddenMessage` copies that body verbatim into the 403 message.
    // Many encode the URL they quote, so the separators arrive as %2F/%3F/%3D.
    const { captureGetFigmaDataCall } = await import("~/telemetry/index.js");

    captureGetFigmaDataCall(
      {
        input: { fileKey: FILE_KEY },
        outputFormat: "tree",
        durationMs: 1,
        error: new Error(
          `Response body: <html>Blocked by policy. ` +
            `url=https%3A%2F%2Fapi.figma.com%2Fv1%2Ffiles%2F${FILE_KEY}%2Fnodes%3Fids%3D1%3A2</html>`,
        ),
      },
      { transport: "stdio", authMode: "api_key" },
    );

    const [message] = errorMessagesSent();
    expect(message).not.toContain(FILE_KEY);
    expect(message).not.toContain("1%3A2");
    expect(message).toContain(REDACTED_FILE_KEY);
    // The block-page origin still reads clearly — that's why we keep the body.
    expect(message).toContain("Blocked by policy");
  });

  it("leaves colon-separated values that are not node IDs intact", async () => {
    // Over-redaction has a real cost here: the port distinguishes "proxy
    // refused" from "direct connect refused", and network failures are exactly
    // what the proxy_mode property exists to analyze.
    const { captureGetFigmaDataCall } = await import("~/telemetry/index.js");

    captureGetFigmaDataCall(
      {
        input: { fileKey: FILE_KEY },
        outputFormat: "tree",
        durationMs: 1,
        error: new Error("connect ECONNREFUSED 127.0.0.1:8080 at fetch-json.ts:75:11"),
      },
      { transport: "stdio", authMode: "api_key" },
    );

    const [message] = errorMessagesSent();
    expect(message).toContain("127.0.0.1:8080");
    expect(message).toContain("fetch-json.ts:75:11");
    expect(message).not.toContain(REDACTED_NODE_ID);
  });

  it("scrubs identifiers alongside credentials in an untagged error", async () => {
    await shutdownTelemetry();
    initTelemetry({ optOut: false, immediateFlush: true, redactFromErrors: ["figd_secret"] });
    const { captureGetFigmaDataCall } = await import("~/telemetry/index.js");

    captureGetFigmaDataCall(
      {
        input: { fileKey: FILE_KEY },
        outputFormat: "tree",
        durationMs: 1,
        error: new Error(
          `proxy rejected https://www.figma.com/design/${FILE_KEY}/Board?node-id=1234-5678 ` +
            `(token figd_secret, node ${NODE_ID})`,
        ),
      },
      { transport: "stdio", authMode: "api_key" },
    );

    const [message] = errorMessagesSent();
    expect(message).not.toContain(FILE_KEY);
    expect(message).not.toContain(NODE_ID);
    expect(message).not.toContain("1234-5678");
    expect(message).not.toContain("figd_secret");
  });
});
