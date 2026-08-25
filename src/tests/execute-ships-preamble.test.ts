// ADR-0010's load-bearing seam, pinned at the level that can actually regress: does a real
// figma_execute_code call put the real flcm std-lib on the wire?
//
// scripts/bridge-contract.mjs already pins the ENVELOPE — that the plugin refuses a request without
// a preamble — but its fake plugin and stand-in string are both written by us, so it stays green if
// the TOOL quietly stops attaching one. This closes that: a real Client/Server pair, a mocked
// bridge, and an assertion about the outgoing request. Delete the `preamble:` field from
// code-mode-tools.ts and this is what fails.
//
// It also carries the generator's own invariants, which is why they need no separate test: vitest
// builds the REAL preamble for this file (the hook in vitest.config.ts), and buildSandboxPreamble
// throws on a zod leak or an unresolvable fragment — so either one fails the run right here.
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "~/mcp/index.js";
import type { BridgeRequest, PluginBridge } from "~/services/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/services/plugin-bridge/index.js";

function connectedServer() {
  const request = vi.fn().mockResolvedValue({ result: "ok", console: [], errors: null });
  const bridge = {
    request,
    getPairingCode: () => "1234",
    getSkewNote: () => null,
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

describe("figma_execute_code ships the flcm std-lib", () => {
  it("attaches the real preamble to the outgoing EXECUTE_CODE request", async () => {
    const { call, request, close } = connectedServer();
    try {
      await call("figma_execute_code", { code: "return 1" });

      expect(request).toHaveBeenCalledTimes(1);
      // Named against the real union member, not a hand-written shape: drop `preamble` from
      // BridgeRequest and this file stops compiling rather than quietly asserting on `undefined`.
      const sent = request.mock.calls[0][0] as Extract<BridgeRequest, { type: "EXECUTE_CODE" }>;
      expect(sent.type).toBe("EXECUTE_CODE");
      expect(sent.code).toBe("return 1");

      // Substance, not just presence: the real generated bundle, in the shape the plugin calls.
      // A stub would satisfy `toBeDefined()` and ship a plugin that can't run.
      expect(sent.preamble).toContain("(function (__flcmHost) {");
      expect(sent.preamble).toContain("render");
    } finally {
      await close();
    }
  });
});
