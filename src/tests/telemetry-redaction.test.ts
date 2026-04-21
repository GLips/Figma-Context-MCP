import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturedEvents: Array<{ event: string; properties: Record<string, unknown> }> = [];

vi.mock("posthog-node", () => ({
  PostHog: class MockPostHog {
    capture(payload: { event: string; properties: Record<string, unknown> }) {
      capturedEvents.push(payload);
    }

    async shutdown() {}
  },
}));

/**
 * Run a callback that is expected to throw, returning the thrown error.
 * Keeps tests readable when the producer we care about is the throw site.
 */
async function captureThrown(fn: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the callback to throw, but it did not");
}

/**
 * These tests go through the real producers: `fetchJSON` (HTTP error wrap),
 * `FigmaService.requestWithSize` (403/generic wrapping with endpoint context),
 * and `simplifyRawFigmaObject` (missing-node path). That couples the tests to
 * the actual privacy contract — "no file keys or node IDs reach telemetry" —
 * instead of to the regex shapes in `client.ts`.
 *
 * A future reword of any upstream error message (e.g. "Could not find node X"
 * in design-extractor) cannot silently re-open the leak: telemetry now reads
 * `safe_message` from the structured error meta, and the regex pass remains
 * only as a belt-and-braces fallback for untagged errors.
 */
describe("telemetry error redaction (real producers)", () => {
  beforeEach(() => {
    capturedEvents.length = 0;
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    const telemetry = await import("~/telemetry/index.js");
    await telemetry.shutdown();
    vi.unstubAllGlobals();
  });

  it("does not leak the file key from a real Figma 403 error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("forbidden", {
            status: 403,
            statusText: "Forbidden",
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const { FigmaService } = await import("~/services/figma.js");
    const telemetry = await import("~/telemetry/index.js");
    telemetry.initTelemetry({ redactFromErrors: ["secret-token"] });

    const service = new FigmaService({
      figmaApiKey: "secret-token",
      figmaOAuthToken: "",
      useOAuth: false,
    });

    const error = await captureThrown(() => service.getRawFile("abc123"));

    telemetry.captureGetFigmaDataCall(
      {
        input: { fileKey: "abc123" },
        outputFormat: "yaml",
        durationMs: 1,
        error,
      },
      { transport: "cli", authMode: "api_key" },
    );

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0].properties;
    expect(String(event.error_message)).not.toContain("abc123");
    expect(String(event.error_message)).not.toContain("secret-token");
    // Category + status still flow so analytics can group 403s.
    expect(event.error_category).toBe("auth");
    expect(event.http_status).toBe(403);
  });

  it("does not leak the file key or node IDs from a real image-render 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("forbidden", {
            status: 403,
            statusText: "Forbidden",
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const { FigmaService } = await import("~/services/figma.js");
    const telemetry = await import("~/telemetry/index.js");
    telemetry.initTelemetry();

    const service = new FigmaService({
      figmaApiKey: "secret-token",
      figmaOAuthToken: "",
      useOAuth: false,
    });

    const error = await captureThrown(() =>
      service.getNodeRenderUrls("abc123", ["1:2", "3:4"], "png"),
    );

    telemetry.captureGetFigmaDataCall(
      {
        input: { fileKey: "abc123", nodeId: "1:2" },
        outputFormat: "yaml",
        durationMs: 1,
        error,
      },
      { transport: "cli", authMode: "api_key" },
    );

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0].properties;
    expect(String(event.error_message)).not.toContain("abc123");
    expect(String(event.error_message)).not.toContain("1:2,3:4");
    expect(String(event.error_message)).not.toContain("1:2");
    expect(event.http_status).toBe(403);
  });

  it("does not leak the node ID from the real missing-node extractor path", async () => {
    const { simplifyRawFigmaObject } = await import("~/extractors/design-extractor.js");
    const telemetry = await import("~/telemetry/index.js");
    telemetry.initTelemetry();

    const error = await captureThrown(() =>
      simplifyRawFigmaObject(
        {
          name: "test",
          // GetFileNodesResponse shape with a null node triggers the
          // not_found branch in design-extractor.
          nodes: { "1:2": null as never },
        } as unknown as Parameters<typeof simplifyRawFigmaObject>[0],
        [],
      ),
    );

    telemetry.captureGetFigmaDataCall(
      {
        input: { fileKey: "abc123", nodeId: "1:2" },
        outputFormat: "yaml",
        durationMs: 1,
        error,
      },
      { transport: "cli", authMode: "api_key" },
    );

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0].properties;
    expect(String(event.error_message)).not.toContain("1:2");
    expect(String(event.error_message)).not.toContain("1-2");
    expect(event.error_category).toBe("not_found");
  });

  it("regex fallback still redacts when an error is not tagged with safe_message", async () => {
    const telemetry = await import("~/telemetry/index.js");
    telemetry.initTelemetry({ redactFromErrors: ["secret-token"] });

    // Plain, untagged Error simulating a third-party library path that doesn't
    // know about our `tagError` meta. The regex pass in `client.ts` is the
    // last line of defence for these.
    telemetry.captureGetFigmaDataCall(
      {
        input: { fileKey: "abc123" },
        outputFormat: "yaml",
        durationMs: 1,
        error: new Error(
          "Unexpected failure at /files/abc123?ids=1:2 using Token secret-token (Node 1:2 context)",
        ),
      },
      { transport: "cli", authMode: "api_key" },
    );

    expect(capturedEvents).toHaveLength(1);
    const event = capturedEvents[0].properties;
    const message = String(event.error_message);
    expect(message).toContain("/files/[REDACTED_FILE_KEY]");
    expect(message).toContain("ids=[REDACTED_NODE_ID]");
    expect(message).toContain("Node [REDACTED_NODE_ID]");
    expect(message).not.toContain("abc123");
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("1:2");
  });
});
