/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { codeModeExtension } from "~/commercial/tools/code-mode-tools.js";
import { createServer } from "~/mcp/index.js";
import { closeTelemetry, initTelemetry } from "~/telemetry/index.js";
import { stubPostHogNetwork } from "../../tests/fixtures/posthog-network.js";
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
    {
      transport: "stdio",
      telemetry: true,
      extensions: [codeModeExtension(runtime, { codeMode: false })],
    },
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

// PostHog's capture API is the boundary: the events are what it receives.
let posthog: ReturnType<typeof stubPostHogNetwork>;
const delivered = async (name: string) =>
  (await posthog.delivered()).filter(({ event }) => event === name);

beforeEach(() => {
  initTelemetry({ enabled: true });
  posthog = stubPostHogNetwork();
});

afterEach(async () => {
  await closeTelemetry(5_000);
  vi.unstubAllGlobals();
});

describe("code-mode tool telemetry", () => {
  it("attributes an executed run to its Plugin Owner, without the code or its result", async () => {
    const { call, close } = await connectedServer();
    await call("figma_execute_code", {
      intent: "Test run",
      userGoal: "Build the pricing page",
      code: "return 'secret authored code'",
    });
    await close();

    const [event] = await delivered("tool_called");
    expect(event.properties).toMatchObject({
      tool: "figma_execute_code",
      has_intent: true,
      is_error: false,
      figma_user_id: TEST_PLUGIN_OWNER.figmaUserId,
      outcome: "executed",
      script_source: "code",
    });
    // The user's goal, not the panel's per-step intent.
    const [intent] = await delivered("$mcp_tool_call");
    expect(intent.properties.$mcp_intent).toBe("Build the pricing page");
    expect(JSON.stringify(posthog.events)).not.toMatch(/secret/);
  });

  it("reports schema and unknown-param rejects as codes", async () => {
    const { call, close } = await connectedServer();
    await call("get_screenshot", { intent: "Test run", node_id: "1:2" });
    await call("get_screenshot", { intent: "Test run", scale: "big" });
    await close();

    expect(
      (await delivered("tool_called")).map(({ properties }) => ({
        tool: properties.tool,
        field: properties.validation_field,
        rule: properties.validation_rule,
      })),
    ).toEqual([
      { tool: "get_screenshot", field: "node_id", rule: "unknown_param" },
      { tool: "get_screenshot", field: "scale", rule: "invalid_type" },
    ]);
  });
});
