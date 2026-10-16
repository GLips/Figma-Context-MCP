/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { codeModeExtension } from "~/commercial/tools/code-mode-tools.js";
import { createServer } from "~/mcp/index.js";
import type { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime, PluginPresence } from "~/commercial/plugin-bridge/index.js";
import { createTestWriteAccess } from "./fixtures/write-access.js";

/**
 * Advertisement is driven through a real Client/Server pair rather than by inspecting the registration
 * call: what matters is whether the agent can SEE the write tools, and a disabled tool is invisible to
 * tools/list but still registered.
 */
function listToolsWith(presence: PluginPresence) {
  const bridge = {
    isPluginConnected: () => false,
  } as unknown as PluginBridge;
  const runtime: PluginBridgeRuntime = {
    bridge,
    writeMeter: createTestWriteAccess().writeMeter,
    readSavedScript: () => Promise.reject(new Error("no saved scripts in this test")),
    readLocalImage: () => Promise.reject(new Error("no local images in this test")),
    pluginPresence: () => presence,
    onFirstConnect: () => {},
  };
  const server = createServer(
    { credential: { kind: "pat", token: "test-key" }, imageDir: process.cwd(), plugin: runtime },
    { transport: "http", extensions: [codeModeExtension(runtime, { codeMode: false })] },
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
    const { names, close } = listToolsWith("expected");

    expect(await names()).toContain("figma_execute_code");
    await close();
  });

  it("stays hidden on a genuine cold start, so read-only users never see write tools", async () => {
    const { names, close } = listToolsWith("absent");

    const tools = await names();
    expect(tools).not.toContain("figma_execute_code");
    expect(tools).toContain("get_figma_data");
    await close();
  });
});
