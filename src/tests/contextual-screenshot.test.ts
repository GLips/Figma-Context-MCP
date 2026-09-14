import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "~/mcp/index.js";
import type { BridgeRequest, PluginBridge } from "~/services/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/services/plugin-bridge/index.js";

function connectedServer(capture?: "contextual") {
  const request = vi
    .fn()
    .mockImplementation(async (payload: BridgeRequest) =>
      payload.type === "APPROVAL_STATUS"
        ? { type: "APPROVAL_GRANTED" }
        : { image: "AQ==", ...(capture ? { capture } : {}) },
    );
  const bridge = {
    request,
    getPairingCode: () => "1234",
    protocolRefusal: () => null,
    touchApproval: () => {},
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
  const client = new Client({ name: "preamble-test-client", version: "1.0.0" });
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

describe("contextual screenshot boundary", () => {
  it("forwards opt-in margin and refuses an old host's isolated response", async () => {
    for (const capture of [undefined, "contextual"] as const) {
      const { call, request, close } = connectedServer(capture);
      try {
        const result = await call("get_screenshot", { nodeId: "1:2", context: true, margin: 0 });
        expect(request.mock.calls.find(([p]) => p.type === "SCREENSHOT")?.[0]).toMatchObject({
          context: true,
          margin: 0,
        });
        if (capture) expect(result.content[0].type).toBe("image");
        else {
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain("does not support contextual capture");
        }
      } finally {
        await close();
      }
    }
  });
  it("rejects invalid context arguments before touching the bridge", async () => {
    const { call, request, close } = connectedServer();
    try {
      await call("get_screenshot", { context: true });
      await call("get_screenshot", { nodeId: "1:2", margin: 8 });
      await call("get_screenshot", { nodeId: "1:2", context: true, margin: -1 });
      expect(request).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
