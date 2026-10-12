/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "~/mcp/index.js";
import { CLI_COMMANDS, MCP_TOOL_CLI_COUNTERPARTS } from "~/commands/index.js";
import type { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import { createTestWriteAccess, TEST_AUTHORIZING_USER } from "./fixtures/write-access.js";

// Every tool the server can advertise: the plugin bridge plus codeMode puts the write tools in
// tools/list, and image downloads are on by default.
async function listEveryTool(): Promise<Map<string, string[]>> {
  const bridge = {
    request: vi.fn(),
    getPairingCode: () => null,
    protocolRefusal: () => null,
    touchApproval: () => {},
    getAuthorizingUser: () => TEST_AUTHORIZING_USER,
    isPluginConnected: () => false,
    hasRecentApproval: () => false,
  } as unknown as PluginBridge;
  const runtime: PluginBridgeRuntime = {
    bridge,
    writeAccess: createTestWriteAccess().writeAccess,
    readSavedScript: () => Promise.reject(new Error("no saved scripts in this test")),
    hasEverConnected: () => false,
    onFirstConnect: () => {},
  };
  const server = createServer(
    { kind: "pat", token: "test-key" },
    { transport: "http", pluginBridge: runtime, codeMode: true },
  );
  const client = new Client({ name: "cli-counterparts-test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  const { tools } = await client.request({ method: "tools/list" }, ListToolsResultSchema);
  await Promise.all([client.close(), server.close()]);
  return new Map(
    tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {}).sort()]),
  );
}

const kebab = (flag: string) => "--" + flag.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

it("gives every MCP tool input a CLI carrier, or the tool an explicit exemption", async () => {
  const tools = await listEveryTool();
  const commands = new Map(CLI_COMMANDS.map((command) => [command.options.name, command.options]));

  expect(Object.keys(MCP_TOOL_CLI_COUNTERPARTS).sort()).toEqual([...tools.keys()].sort());
  for (const [tool, counterpart] of Object.entries(MCP_TOOL_CLI_COUNTERPARTS)) {
    if ("exempt" in counterpart) continue;
    const command = commands.get(counterpart.command);
    expect(command, tool).toBeDefined();
    const carriers = new Set([
      ...Object.keys(command!.flags ?? {}).map(kebab),
      ...(command!.parameters ?? []),
    ]);
    expect(Object.keys(counterpart.inputs).sort(), tool).toEqual(tools.get(tool));
    for (const carrier of Object.values(counterpart.inputs))
      expect(carriers, tool).toContain(carrier);
    if (counterpart.figmaRest) {
      expect(carriers, tool).toContain("--figma-api-key");
      expect(carriers, tool).toContain("--figma-oauth-token");
    }
  }
});
