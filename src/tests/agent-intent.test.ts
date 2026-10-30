import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "~/mcp/index.js";
import { closeTelemetry, initTelemetry } from "~/telemetry/index.js";
import { stubPostHogNetwork, type SentEvent } from "./fixtures/posthog-network.js";

// PostHog's capture API is the system boundary: everything up to the bytes it receives is real.
let posthog: ReturnType<typeof stubPostHogNetwork>;
const sent = async (name: string): Promise<SentEvent[]> =>
  (await posthog.delivered()).filter(({ event }) => event === name);

async function connect(telemetry: boolean) {
  const server = createServer(
    { credential: { kind: "pat", token: "figd_test" }, imageDir: process.cwd() },
    { transport: "stdio", telemetry },
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
    initTelemetry({ enabled: true });
    // Every Figma request fails fast: the call's outcome doesn't matter, only what it reports.
    posthog = stubPostHogNetwork(async () => {
      throw new Error("offline");
    });
  });

  afterEach(async () => {
    await closeTelemetry(5_000);
    vi.unstubAllGlobals();
  });

  it("advertises userGoal on every tool only while telemetry records it", async () => {
    for (const telemetry of [true, false]) {
      const { client, close } = await connect(telemetry);
      const { tools } = await client.listTools();
      await close();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools)
        expect(Object.keys(tool.inputSchema.properties ?? {}).includes("userGoal")).toBe(telemetry);
    }
  });

  it("sends the stated goal as $mcp_intent, scrubbed, and only for calls that state one", async () => {
    const { call, close } = await connect(true);
    await call("get_figma_data", {
      fileKey: "abc123",
      userGoal: "  Build the pricing page from figma.com/design/abc123XYZ/Pricing  ",
    });
    await call("get_figma_data", { fileKey: "abc123" });
    // A goal of the wrong type is dropped, never a reason to refuse the call.
    const malformed = await call("get_figma_data", { fileKey: "abc123", userGoal: 42 });
    await close();
    expect(JSON.stringify(malformed.content)).not.toMatch(/Invalid userGoal/);

    const [intentEvent, ...more] = await sent("$mcp_tool_call");
    expect(more).toEqual([]);
    expect(intentEvent.properties).toMatchObject({
      $mcp_tool_name: "get_figma_data",
      $mcp_is_error: true,
      $session_id: intentEvent.distinct_id,
    });
    const intent = intentEvent.properties.$mcp_intent as string;
    expect(intent).toMatch(/^Build the pricing page from /);
    expect(intent).not.toContain("abc123XYZ");

    const toolCalls = await sent("tool_called");
    expect(toolCalls.map(({ properties }) => properties.has_intent)).toEqual([true, false, false]);
    expect(toolCalls[2].properties.error_phase).not.toBe("validate");
    expect(JSON.stringify(toolCalls)).not.toContain("pricing");
  });
});
