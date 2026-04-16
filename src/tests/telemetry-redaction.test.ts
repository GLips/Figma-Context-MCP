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

describe("telemetry error redaction", () => {
  beforeEach(() => {
    capturedEvents.length = 0;
    vi.resetModules();
  });

  afterEach(async () => {
    const telemetry = await import("~/telemetry/index.js");
    await telemetry.shutdown();
  });

  it("redacts file keys from endpoint-bearing error messages", async () => {
    const telemetry = await import("~/telemetry/index.js");
    telemetry.initTelemetry({ redactFromErrors: ["secret-token"] });

    telemetry.captureGetFigmaDataCall(
      {
        input: { fileKey: "abc123" },
        outputFormat: "yaml",
        durationMs: 1,
        error: new Error(
          "Figma API returned 403 Forbidden for '/files/abc123'. Token secret-token failed.",
        ),
      },
      { transport: "cli", authMode: "api_key" },
    );

    expect(capturedEvents).toHaveLength(1);
    expect(String(capturedEvents[0].properties.error_message)).toContain(
      "/files/[REDACTED_FILE_KEY]",
    );
    expect(String(capturedEvents[0].properties.error_message)).not.toContain("abc123");
    expect(String(capturedEvents[0].properties.error_message)).not.toContain("secret-token");
  });

  it("redacts file keys and ids query params from image endpoint errors", async () => {
    const telemetry = await import("~/telemetry/index.js");
    telemetry.initTelemetry();

    telemetry.captureGetFigmaDataCall(
      {
        input: { fileKey: "abc123", nodeId: "1:2" },
        outputFormat: "yaml",
        durationMs: 1,
        error: new Error(
          "Failed to make request to Figma API endpoint '/images/abc123?ids=1:2,3:4&format=png': Fetch failed with status 403: Forbidden",
        ),
      },
      { transport: "cli", authMode: "api_key" },
    );

    expect(capturedEvents).toHaveLength(1);
    expect(String(capturedEvents[0].properties.error_message)).toContain(
      "/images/[REDACTED_FILE_KEY]",
    );
    expect(String(capturedEvents[0].properties.error_message)).toContain("ids=[REDACTED_NODE_ID]");
    expect(String(capturedEvents[0].properties.error_message)).not.toContain("abc123");
    expect(String(capturedEvents[0].properties.error_message)).not.toContain("1:2,3:4");
  });

  it("redacts node IDs from missing-node error messages", async () => {
    const telemetry = await import("~/telemetry/index.js");
    telemetry.initTelemetry();

    telemetry.captureGetFigmaDataCall(
      {
        input: { fileKey: "abc123", nodeId: "1:2" },
        outputFormat: "yaml",
        durationMs: 1,
        error: new Error(
          "Node 1:2 was not found in the Figma file. Try copying a fresh link from /files/abc123?node-id=1-2",
        ),
      },
      { transport: "cli", authMode: "api_key" },
    );

    expect(capturedEvents).toHaveLength(1);
    expect(String(capturedEvents[0].properties.error_message)).toContain(
      "Node [REDACTED_NODE_ID] was not found",
    );
    expect(String(capturedEvents[0].properties.error_message)).toContain(
      "/files/[REDACTED_FILE_KEY]",
    );
    expect(String(capturedEvents[0].properties.error_message)).toContain(
      "node-id=[REDACTED_NODE_ID]",
    );
    expect(String(capturedEvents[0].properties.error_message)).not.toContain("abc123");
    expect(String(capturedEvents[0].properties.error_message)).not.toContain("1:2");
    expect(String(capturedEvents[0].properties.error_message)).not.toContain("1-2");
  });
});
