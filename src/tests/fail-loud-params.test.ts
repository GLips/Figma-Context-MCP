import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "~/mcp/index.js";
import type { PluginBridge } from "~/services/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/services/plugin-bridge/index.js";

/**
 * The point of these tests is the SDK parse seam, not our string formatting — so they drive a real
 * Client/Server pair over InMemoryTransport. Anything less (calling the handler directly) would pass
 * even if the SDK silently stripped the bad key on the way in, which is the exact bug this closes.
 */
function connectedServer(request = vi.fn().mockResolvedValue({ image: "iVBORw0KGgo=" })) {
  const bridge = {
    request,
    getPairingCode: () => "1234",
    getSkewNote: () => null,
    touchApproval: () => {},
    // A plugin is on the wire in these tests, so the disconnect reply never fires.
    isPluginConnected: () => true,
  } as unknown as PluginBridge;
  const runtime: PluginBridgeRuntime = {
    bridge,
    hasEverConnected: () => true,
    onFirstConnect: () => {},
  };
  const server = createServer(
    { figmaApiKey: "test-key", figmaOAuthToken: "", useOAuth: false },
    { transport: "stdio", pluginBridge: runtime },
  );
  const client = new Client({ name: "fail-loud-test-client", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const ready = Promise.all([client.connect(clientT), server.connect(serverT)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    await ready;
    return client.request(
      { method: "tools/call", params: { name, arguments: args } },
      CallToolResultSchema,
    );
  };
  return { call, request, close: () => Promise.all([client.close(), server.close()]) };
}

const textOf = (result: { content: unknown[] }) =>
  result.content.map((c) => (c as { text?: string }).text ?? "").join("\n");

describe("unknown MCP tool params fail loud", () => {
  it("names the bad key, suggests the real one, and does not run the call", async () => {
    const { call, request, close } = connectedServer();
    const result = await call("get_screenshot", { node_id: "1:2" });

    // Retryable, NOT terminal: an isError reply is what made the agent abandon node-targeting.
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('"node_id"');
    expect(textOf(result)).toContain('"nodeId"');
    expect(request).not.toHaveBeenCalled();
    await close();
  });

  it("still runs a call whose params are all known", async () => {
    const { call, request, close } = connectedServer();
    const result = await call("get_screenshot", { nodeId: "1:2", scale: 2 });

    expect(request).toHaveBeenCalledWith({ type: "SCREENSHOT", nodeId: "1:2", scale: 2 });
    expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    await close();
  });

  it("applies to every code-mode tool, not just get_screenshot", async () => {
    const { call, close } = connectedServer();
    const result = await call("get_flcm_reference", { section: ["props"] });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('"section"');
    // No near-miss suggestion here (singular/plural isn't a case/separator slip) — the listed valid
    // params carry the fix instead.
    expect(textOf(result)).toContain("Valid parameter: sections.");
    await close();
  });
});

describe("get_screenshot target and scale checks", () => {
  it("rejects two targets at once rather than picking one", async () => {
    const { call, request, close } = connectedServer();
    const result = await call("get_screenshot", { nodeId: "1:2", key: "card" });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/ambiguous/i);
    expect(request).not.toHaveBeenCalled();
    await close();
  });

  it("rejects an out-of-range scale", async () => {
    const { call, request, close } = connectedServer();
    const result = await call("get_screenshot", { scale: 40 });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("40");
    expect(request).not.toHaveBeenCalled();
    await close();
  });
});
