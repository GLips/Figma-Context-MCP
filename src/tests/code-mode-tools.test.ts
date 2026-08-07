import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "~/mcp/index.js";
import type { PluginBridge } from "~/services/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/services/plugin-bridge/index.js";

/**
 * Advertisement is driven through a real Client/Server pair rather than by inspecting the registration
 * call: what matters is whether the agent can SEE the write tools, and a disabled tool is invisible to
 * tools/list but still registered.
 */
function listToolsWith({
  hasEverConnected,
  hasRecentApproval,
}: {
  hasEverConnected: boolean;
  hasRecentApproval: boolean;
}) {
  const bridge = {
    request: vi.fn(),
    getPairingCode: () => null,
    getSkewNote: () => null,
    touchApproval: () => {},
    isPluginConnected: () => false,
    hasRecentApproval: () => hasRecentApproval,
  } as unknown as PluginBridge;
  const runtime: PluginBridgeRuntime = {
    bridge,
    hasEverConnected: () => hasEverConnected,
    onFirstConnect: () => {},
  };
  const server = createServer(
    { figmaApiKey: "test-key", figmaOAuthToken: "", useOAuth: false },
    { transport: "http", pluginBridge: runtime },
  );
  const client = new Client({ name: "code-mode-test-client", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const ready = Promise.all([client.connect(clientT), server.connect(serverT)]);
  const names = async () => {
    await ready;
    const result = await client.request({ method: "tools/list" }, ListToolsResultSchema);
    return result.tools.map((t) => t.name);
  };
  return { names, close: () => Promise.all([client.close(), server.close()]) };
}

describe("code-mode write tools are advertised whenever a plugin is expected", () => {
  it("advertises across a server restart, when only the recent approval remembers the plugin", async () => {
    // A dev-watch restart: fresh process (latch off), relay rebound onto an approval used minutes ago,
    // and the plugin a second or two from redialing. Hiding the tools here answered a call that was
    // merely early with "Tool figma_execute_code disabled" — a hard error an agent can't retry past.
    const { names, close } = listToolsWith({
      hasEverConnected: false,
      hasRecentApproval: true,
    });

    expect(await names()).toContain("figma_execute_code");
    await close();
  });

  it("stays hidden on a genuine cold start, so read-only users never see write tools", async () => {
    const { names, close } = listToolsWith({
      hasEverConnected: false,
      hasRecentApproval: false,
    });

    const tools = await names();
    expect(tools).not.toContain("figma_execute_code");
    expect(tools).toContain("get_figma_data");
    await close();
  });
});
