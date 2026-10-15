import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock posthog-node so we can observe what the telemetry client sends without
// hitting the network. We're testing OUR code (withRequestSecrets, ALS
// propagation, the scrub) end-to-end — only the system boundary is mocked.
const captureSpy = vi.fn();
const captureExceptionSpy =
  vi.fn<(error: Error, distinctId: string, properties: Record<string, unknown>) => void>();
const shutdownSpy = vi.fn(async () => {});
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = captureSpy;
    captureException = captureExceptionSpy;
    shutdown = shutdownSpy;
  },
}));

/** Every byte handed to PostHog: events, and reported errors' messages and stacks. */
function everythingSent(): string {
  const events = captureSpy.mock.calls.map(([args]) => JSON.stringify(args));
  const exceptions = captureExceptionSpy.mock.calls.map(([error, distinctId, props]) =>
    [error.message, error.stack, distinctId, JSON.stringify(props)].join("\n"),
  );
  return [...events, ...exceptions].join("\n");
}

/** The errors sent to error tracking, as PostHog receives them. */
function exceptionsSent(): Error[] {
  return captureExceptionSpy.mock.calls.map(([error]) => error);
}

function resetPostHogSpies() {
  captureSpy.mockClear();
  captureExceptionSpy.mockClear();
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "http";
import { homedir } from "os";
import type { AddressInfo } from "net";
import { startHttpServer, stopHttpServer } from "~/server.js";
import { initTelemetry, shutdown as shutdownTelemetry } from "~/telemetry/index.js";
import { REDACTED_FILE_KEY, REDACTED_NODE_ID } from "~/telemetry/redact-identifiers.js";
import { figmaFileKey, figmaNodeId } from "~/utils/figma-url.js";

const PER_REQUEST_KEY = "figd_TENANT_SECRET_xyz789";

describe("per-request telemetry redaction", () => {
  let client: Client;
  let httpServer: Server | undefined;

  beforeEach(() => {
    resetPostHogSpies();
    // Init with NO global redaction secrets so the assertion proves the
    // per-request AsyncLocalStorage path is what's doing the scrubbing.
    initTelemetry({ enabled: true, immediateFlush: true, redactFromTelemetry: [] });

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

  it("scrubs a per-request X-Figma-Token from everything sent to PostHog", async () => {
    httpServer = await startHttpServer(
      "127.0.0.1",
      0,
      { credential: undefined, imageDir: null, plugin: null },
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

    // An untagged fetch failure is unexpected, so it went to error tracking — scrubbed.
    const [reported] = exceptionsSent();
    expect(reported.message).toContain("[REDACTED]");
    expect(everythingSent()).not.toContain(PER_REQUEST_KEY);
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
describe("figma identifier redaction in telemetry", () => {
  const FILE_KEY = figmaFileKey("aB3xYz9QpLmN0kRtVwSdEf");
  const NODE_ID = figmaNodeId("1234:5678");

  function onlyExceptionMessage(): string {
    const [reported, ...rest] = exceptionsSent();
    expect(rest).toEqual([]);
    return reported.message;
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
    resetPostHogSpies();
    initTelemetry({ enabled: true, immediateFlush: true, redactFromTelemetry: [] });
  });

  afterEach(async () => {
    await shutdownTelemetry();
    vi.unstubAllGlobals();
  });

  it("scrubs the file key and node ID from a 403 on a targeted read", async () => {
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

    const { FigmaService, staticCredentialSource } = await import("~/services/figma.js");
    const { captureGetFigmaDataCall } = await import("~/telemetry/index.js");
    const service = new FigmaService(staticCredentialSource({ kind: "pat", token: "figd_test" }));

    const error = await captureThrown(() => service.getRawNodeInContext(FILE_KEY, NODE_ID));

    // Sanity: the user-facing message is *supposed* to name the endpoint —
    // that's what makes a 403 debuggable. Redaction happens at the telemetry
    // boundary, not at the throw site.
    expect(String((error as Error).message)).toContain(FILE_KEY);

    captureGetFigmaDataCall(
      { input: { fileKey: FILE_KEY, nodeId: NODE_ID }, outputFormat: "tree", durationMs: 1, error },
      { transport: "stdio", authMode: "api_key" },
    );

    // An expected failure travels as codes only; nothing quotes the endpoint.
    expect(exceptionsSent()).toEqual([]);
    expect(everythingSent()).not.toContain(FILE_KEY);
    expect(everythingSent()).not.toContain(NODE_ID);
    const [event] = captureSpy.mock.calls.map(([args]) => args);
    expect(event.properties.http_status).toBe(403);
    expect(event.properties.error_category).toBe("auth");
  });

  it("scrubs the node ID from the REST adapter's missing-node error", async () => {
    const { parseRestResponse } = await import("~/adapters/rest/decode/response.js");
    const { captureGetFigmaDataCall } = await import("~/telemetry/index.js");

    const error = await captureThrown(async () =>
      parseRestResponse({ name: "test", nodes: { [NODE_ID]: null } } as never),
    );
    expect(String((error as Error).message)).toContain(NODE_ID);

    captureGetFigmaDataCall(
      { input: { fileKey: FILE_KEY, nodeId: NODE_ID }, outputFormat: "tree", durationMs: 1, error },
      { transport: "stdio", authMode: "api_key" },
    );

    expect(exceptionsSent()).toEqual([]);
    expect(everythingSent()).not.toContain(NODE_ID);
    const [event] = captureSpy.mock.calls.map(([args]) => args);
    expect(event.properties.error_category).toBe("not_found");
  });

  it("fingerprints a proxy block page instead of sending its body", async () => {
    // Block pages print who was blocked and from where. The user needs that to
    // talk to IT; PostHog must only learn which vendor answered.
    const blockPage = `<!DOCTYPE html><html><head><title>Website Blocked</title></head><body>
      <img src="https://login.zscloud.net/img/zscaler-logo.png">
      <p>Access to api.figma.com/v1/files/${FILE_KEY} is blocked by your organization.</p>
      <p>User: jane.doe@acme-corp.com</p><p>Client IP: 10.42.7.19</p>
      <p>Gateway: zs-gw-03.internal.acme-corp.com</p></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(blockPage, {
            status: 403,
            statusText: "Forbidden",
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    const { FigmaService, staticCredentialSource } = await import("~/services/figma.js");
    const { captureGetFigmaDataCall } = await import("~/telemetry/index.js");
    const service = new FigmaService(staticCredentialSource({ kind: "pat", token: "figd_test" }));
    const error = await captureThrown(() => service.getRawFile(FILE_KEY));
    expect(String((error as Error).message)).toContain("jane.doe@acme-corp.com");

    captureGetFigmaDataCall(
      { input: { fileKey: FILE_KEY }, outputFormat: "tree", durationMs: 1, error },
      { transport: "stdio", authMode: "api_key" },
    );

    for (const leak of ["jane.doe", "10.42.7.19", "zs-gw-03", "acme-corp", FILE_KEY]) {
      expect(everythingSent()).not.toContain(leak);
    }
    const [event] = captureSpy.mock.calls.map(([args]) => args);
    expect(event.properties.response_fingerprint).toContain("vendor=zscaler");
    expect(event.properties.response_fingerprint).toContain('title="Website Blocked"');
  });

  it("scrubs a branch URL's keys and file-name slug", async () => {
    const { captureGetFigmaDataCall } = await import("~/telemetry/index.js");

    captureGetFigmaDataCall(
      {
        input: { fileKey: FILE_KEY },
        outputFormat: "tree",
        durationMs: 1,
        error: new Error(
          `bad link https://www.figma.com/design/${FILE_KEY}/branch/BrKey987654321/Acme-Secret-Rebrand?node-id=1-2`,
        ),
      },
      { transport: "stdio", authMode: "api_key" },
    );

    const message = onlyExceptionMessage();
    expect(message).not.toContain(FILE_KEY);
    expect(message).not.toContain("BrKey987654321");
    expect(message).not.toContain("Acme-Secret-Rebrand");
    expect(message).toContain(`figma.com/design/${REDACTED_FILE_KEY}?node-id=${REDACTED_NODE_ID}`);
  });

  it("replaces the home directory with ~", async () => {
    const { captureGetFigmaDataCall } = await import("~/telemetry/index.js");

    captureGetFigmaDataCall(
      {
        input: { fileKey: FILE_KEY },
        outputFormat: "tree",
        durationMs: 1,
        error: new Error(`EACCES: permission denied, open '${homedir()}/clients/acme/hero.png'`),
      },
      { transport: "stdio", authMode: "api_key" },
    );

    const message = onlyExceptionMessage();
    expect(message).toContain("'~/clients/acme/hero.png'");
    // The stack's frames are absolute paths too.
    expect(exceptionsSent()[0].stack).toMatch(/^\s+at /m);
    expect(everythingSent()).not.toContain(homedir());
  });

  it("scrubs a percent-encoded Figma URL quoted from a proxy block page", async () => {
    // An untagged error can still quote a block page, and many encode the URL
    // they echo, so the separators arrive as %2F/%3F/%3D.
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

    const message = onlyExceptionMessage();
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

    const message = onlyExceptionMessage();
    expect(message).toContain("127.0.0.1:8080");
    expect(message).toContain("fetch-json.ts:75:11");
    expect(message).not.toContain(REDACTED_NODE_ID);
  });

  it("scrubs identifiers alongside credentials in an untagged error", async () => {
    await shutdownTelemetry();
    initTelemetry({ enabled: true, immediateFlush: true, redactFromTelemetry: ["figd_secret"] });
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

    const message = onlyExceptionMessage();
    expect(message).not.toContain(FILE_KEY);
    expect(message).not.toContain(NODE_ID);
    expect(message).not.toContain("1234-5678");
    expect(everythingSent()).not.toContain("figd_secret");
  });
});
