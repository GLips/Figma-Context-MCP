/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/telemetry/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/telemetry/index.js")>()),
  captureToolCall: vi.fn(),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { codeModeExtension } from "~/commercial/tools/code-mode-tools.js";
import { createServer } from "~/mcp/index.js";
import * as telemetry from "~/telemetry/index.js";
import type { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import {
  TEST_PLUGIN_OWNER,
  createTestWriteAccess,
  targetedTestCall,
  linkedTestResolution,
} from "./fixtures/write-access.js";

/**
 * Code-mode tools are reported through the same seam as the read tools: one `tool_called` per call,
 * schema and unknown-param rejects included, attributed to the Figma user the plugin link is signed in as.
 */
async function connectedServer() {
  const bridge = {
    submitRun: vi.fn().mockResolvedValue({
      type: "EXECUTE_CODE_RESULT",
      result: "secret design text",
      console: [],
      errors: null,
      documentChanged: false,
    }),
    targetCall: targetedTestCall,
    resolveLink: linkedTestResolution,
  } as unknown as PluginBridge;
  const runtime: PluginBridgeRuntime = {
    bridge,
    writeMeter: createTestWriteAccess().writeMeter,
    readSavedScript: () => Promise.reject(new Error("no saved scripts in this test")),
    readLocalImage: () => Promise.reject(new Error("no local images in this test")),
    pluginPresence: () => "connected",
    onFirstConnect: () => {},
  };
  const server = createServer(
    { credential: { kind: "pat", token: "test-key" }, imageDir: process.cwd(), plugin: runtime },
    { transport: "stdio", extensions: [codeModeExtension(runtime, { codeMode: false })] },
  );
  const client = new Client({ name: "code-mode-telemetry-test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  const call = (name: string, args: Record<string, unknown>) =>
    client.request(
      { method: "tools/call", params: { name, arguments: args } },
      CallToolResultSchema,
    );
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

const reported = () => vi.mocked(telemetry.captureToolCall).mock.calls.map(([event]) => event);

afterEach(() => vi.mocked(telemetry.captureToolCall).mockClear());

describe("code-mode tool telemetry", () => {
  it("attributes an executed run to its Plugin Owner, without the code or its result", async () => {
    const { call, close } = await connectedServer();
    await call("figma_execute_code", { code: "return 'secret authored code'" });
    await close();

    const [event] = reported();
    expect(event).toMatchObject({
      tool: "figma_execute_code",
      isError: false,
      properties: {
        figma_user_id: TEST_PLUGIN_OWNER.figmaUserId,
        outcome: "executed",
        script_source: "code",
      },
    });
    expect(JSON.stringify(event)).not.toMatch(/secret/);
  });

  it("reports schema and unknown-param rejects as codes", async () => {
    const { call, close } = await connectedServer();
    await call("get_screenshot", { node_id: "1:2" });
    await call("get_screenshot", { scale: "big" });
    await close();

    expect(reported().map(({ tool, rejection }) => ({ tool, rejection }))).toEqual([
      { tool: "get_screenshot", rejection: { field: "node_id", rule: "unknown_param" } },
      {
        tool: "get_screenshot",
        rejection: expect.objectContaining({ field: "scale", rule: "invalid_type" }),
      },
    ]);
  });
});
