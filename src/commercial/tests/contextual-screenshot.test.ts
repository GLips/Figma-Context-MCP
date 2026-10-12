/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "~/mcp/index.js";
import type { ServerRequest } from "@framelink/plugin/protocol";
import type { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import { createTestWriteAccess, grantedTestApproval } from "./fixtures/write-access.js";

function connectedServer() {
  const request = vi.fn().mockImplementation(async (_payload: ServerRequest) => ({
    type: "SCREENSHOT_RESULT",
    image: "AQ==",
  }));
  const bridge = {
    request,
    getPairingCode: () => "1234",
    protocolRefusal: () => null,
    touchApproval: () => {},
    approvalStatus: grantedTestApproval,
    isPluginConnected: () => true,
  } as unknown as PluginBridge;
  const runtime: PluginBridgeRuntime = {
    bridge,
    writeAccess: createTestWriteAccess().writeAccess,
    readSavedScript: () => Promise.reject(new Error("no saved scripts in this test")),
    pluginPresence: () => "connected",
    onFirstConnect: () => {},
  };
  const server = createServer(
    { kind: "pat", token: "test-key" },
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
  it("forwards opt-in context and margin to the plugin", async () => {
    const { call, request, close } = connectedServer();
    try {
      const result = await call("get_screenshot", { nodeId: "1:2", context: true, margin: 0 });
      expect(request.mock.calls.find(([p]) => p.type === "SCREENSHOT")?.[0]).toMatchObject({
        context: true,
        margin: 0,
      });
      expect(result.content[0].type).toBe("image");
    } finally {
      await close();
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
