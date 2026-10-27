import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// posthog-node is the system boundary for batched events; a report skips it for a confirmed send.
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = vi.fn();
    captureException = vi.fn();
    shutdown = vi.fn(async () => {});
  },
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { runReportIssue } from "~/commands/report-issue.js";
import { createServer } from "~/mcp/index.js";
import { initTelemetry, shutdown as shutdownTelemetry } from "~/telemetry/index.js";

type CapturePost = { event: string; distinct_id: string; properties: Record<string, unknown> };

async function connect(telemetry: boolean) {
  const server = createServer(
    { credential: { kind: "pat", token: "figd_test" }, imageDir: process.cwd() },
    { transport: "stdio", telemetry },
  );
  const client = new Client({ name: "report-issue-test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return {
    client,
    report: (args: Record<string, unknown>) =>
      client.request(
        { method: "tools/call", params: { name: "report_framelink_issue", arguments: args } },
        CallToolResultSchema,
      ),
    close: () => Promise.all([client.close(), server.close()]),
  };
}

describe("report_framelink_issue", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const posts = (): CapturePost[] =>
    fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

  beforeEach(() => {
    initTelemetry({ enabled: true, redactFromTelemetry: ["figd_secret"] });
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await shutdownTelemetry();
  });

  it("exists only while telemetry records the server's calls", async () => {
    for (const telemetry of [true, false]) {
      const { client, close } = await connect(telemetry);
      const { tools } = await client.listTools();
      await close();
      expect(tools.some((tool) => tool.name === "report_framelink_issue")).toBe(telemetry);
    }
  });

  it("files a bug as an Agent feedback survey response, scrubbed, in the agent's session", async () => {
    const { report, close } = await connect(true);
    const result = await report({
      kind: "bug",
      summary: "Auto layout script fails on nested frames",
      attempted: "Restyle the cards in figma.com/design/abc123XYZ/Pricing",
      tool: "figma_execute_code",
      actual: "403 for token figd_secret",
    });
    await close();

    expect(result.isError).toBeFalsy();
    const [post] = posts();
    expect(post.event).toBe("survey sent");
    expect(post.properties).toMatchObject({
      $survey_id: expect.any(String),
      $session_id: post.distinct_id,
    });
    const answers = Object.entries(post.properties).filter(([key]) =>
      key.startsWith("$survey_response_"),
    );
    expect(answers.map(([, answer]) => answer)).toEqual(
      expect.arrayContaining(["bug", "figma_execute_code"]),
    );
    expect(JSON.stringify(post)).not.toContain("abc123XYZ");
    expect(JSON.stringify(post)).not.toContain("figd_secret");
  });

  it("files a capability gap where MCP Analytics' Missing capabilities view reads it", async () => {
    const { report, close } = await connect(true);
    await report({
      kind: "missing_capability",
      summary: "No way to export a variable collection",
      attempted: "Sync design tokens to code",
    });
    await close();

    const [post] = posts();
    expect(post.event).toBe("$mcp_missing_capability");
    expect(post.properties.$mcp_intent).toMatch(
      /^No way to export a variable collection\nAttempted: Sync design tokens to code$/,
    );
  });

  it("tells the agent when the report didn't arrive", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("offline");
    });
    const { report, close } = await connect(true);
    const result = await report({ kind: "friction", summary: "x", attempted: "y" });
    await close();

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Not sent");
  });

  it("scrubs the environment's Figma token from a CLI report", async () => {
    await shutdownTelemetry();
    vi.stubEnv("FIGMA_API_KEY", "figd_from_env");
    const code = await runReportIssue({
      kind: "friction",
      summary: "Had to retry execute",
      attempted: "Restyle the cards",
      actual: "rejected figd_from_env",
    });
    vi.unstubAllEnvs();

    expect(code).toBe(0);
    expect(JSON.stringify(posts())).not.toContain("figd_from_env");
  });
});
