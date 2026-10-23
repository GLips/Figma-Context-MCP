import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// posthog-node is the system boundary: everything up to the event it is handed is real.
const captureSpy = vi.fn();
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = captureSpy;
    captureException = vi.fn();
    shutdown = vi.fn(async () => {});
  },
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "~/mcp/index.js";
import { initTelemetry, shutdown as shutdownTelemetry } from "~/telemetry/index.js";

type SentEvent = { event: string; distinctId: string; properties: Record<string, unknown> };
const sent = (name: string): SentEvent[] =>
  captureSpy.mock.calls.map(([args]) => args as SentEvent).filter(({ event }) => event === name);

async function connect(askUserGoal: boolean) {
  const server = createServer(
    { credential: { kind: "pat", token: "figd_test" }, imageDir: process.cwd() },
    { transport: "stdio", askUserGoal },
  );
  const client = new Client({ name: "agent-intent-test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return {
    client,
    call: (name: string, args: Record<string, unknown>) =>
      client.request(
        { method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema,
      ),
    close: () => Promise.all([client.close(), server.close()]),
  };
}

/**
 * The agent's stated goal for a call (fig-138): asked as an optional `userGoal` only while
 * telemetry records it, and sent as PostHog MCP analytics' `$mcp_tool_call` / `$mcp_intent`, the
 * shape its intent digest and clusters read.
 */
describe("agent intent", () => {
  beforeEach(() => {
    captureSpy.mockClear();
    initTelemetry({ enabled: true, immediateFlush: true });
    // Every Figma request fails fast: the call's outcome doesn't matter, only what it reports.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await shutdownTelemetry();
  });

  it("advertises userGoal on every tool only when the server asks", async () => {
    for (const askUserGoal of [true, false]) {
      const { client, close } = await connect(askUserGoal);
      const { tools } = await client.listTools();
      await close();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools)
        expect(Object.keys(tool.inputSchema.properties ?? {}).includes("userGoal")).toBe(
          askUserGoal,
        );
    }
  });

  it("sends the stated goal as $mcp_intent, scrubbed, and only for calls that state one", async () => {
    const { call, close } = await connect(true);
    await call("get_figma_data", {
      fileKey: "abc123",
      userGoal: "  Build the pricing page from figma.com/design/abc123XYZ/Pricing  ",
    });
    await call("get_figma_data", { fileKey: "abc123" });
    await close();

    const [intentEvent, ...more] = sent("$mcp_tool_call");
    expect(more).toEqual([]);
    expect(intentEvent.properties).toMatchObject({
      $mcp_tool_name: "get_figma_data",
      $mcp_is_error: true,
      $session_id: intentEvent.distinctId,
    });
    const intent = intentEvent.properties.$mcp_intent as string;
    expect(intent).toMatch(/^Build the pricing page from /);
    expect(intent).not.toContain("abc123XYZ");

    const toolCalls = sent("tool_called");
    expect(toolCalls.map(({ properties }) => properties.has_intent)).toEqual([true, false]);
    expect(JSON.stringify(toolCalls)).not.toContain("pricing");
  });
});
