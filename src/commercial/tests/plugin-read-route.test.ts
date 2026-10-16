/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { codeModeExtension } from "~/commercial/tools/code-mode-tools.js";
import { createServer } from "~/mcp/index.js";
import type { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import { FRAMELINK_PLUGIN_INSTALL_URL } from "~/commercial/tools/plugin-read-route.js";
import { createTestWriteAccess } from "./fixtures/write-access.js";

/**
 * Driven through a real Client/Server pair: what matters is what the agent reads in tools/list and in
 * a failed call, not how the server composes it. Only the Figma REST response is faked.
 */
function connectWithPlugin({ connected }: { connected: boolean }) {
  const firstConnect: (() => void)[] = [];
  let everConnected = connected;
  const bridge = {
    isPluginConnected: () => everConnected,
  } as unknown as PluginBridge;
  const runtime: PluginBridgeRuntime = {
    bridge,
    writeMeter: createTestWriteAccess().writeMeter,
    readSavedScript: () => Promise.reject(new Error("no saved scripts in this test")),
    readLocalImage: () => Promise.reject(new Error("no local images in this test")),
    pluginPresence: () => (everConnected ? "connected" : "absent"),
    onFirstConnect: (cb) => (everConnected ? cb() : firstConnect.push(cb)),
  };
  const server = createServer(
    { credential: { kind: "pat", token: "test-key" }, imageDir: process.cwd(), plugin: runtime },
    { transport: "stdio", extensions: [codeModeExtension(runtime, { codeMode: false })] },
  );
  const client = new Client({ name: "plugin-read-route-test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const ready = Promise.all([client.connect(clientT), server.connect(serverT)]);

  return {
    client,
    ready,
    connectPlugin: () => {
      everConnected = true;
      for (const cb of firstConnect.splice(0)) cb();
    },
    getFigmaDataDescription: async () => {
      await ready;
      const { tools } = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      return tools.find((t) => t.name === "get_figma_data")?.description ?? "";
    },
    callGetFigmaData: async (args: { fileKey: string; nodeId?: string }) => {
      await ready;
      const result = await client.request(
        { method: "tools/call", params: { name: "get_figma_data", arguments: args } },
        CallToolResultSchema,
      );
      const [first] = result.content;
      return first?.type === "text" ? first.text : "";
    },
    close: () => Promise.all([client.close(), server.close()]),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("get_figma_data points agents at the plugin read route", () => {
  it("pitches the plugin until one connects, then tells the agent to prefer it", async () => {
    const session = connectWithPlugin({ connected: false });

    const pitch = await session.getFigmaDataDescription();
    expect(pitch).toContain(FRAMELINK_PLUGIN_INSTALL_URL);
    expect(pitch).not.toContain("figma_execute_code");

    const listChanged = new Promise<void>((resolve) =>
      session.client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()),
    );
    session.connectPlugin();
    await listChanged;

    const paired = await session.getFigmaDataDescription();
    expect(paired).toContain("prefer figma_execute_code");
    expect(paired).not.toContain(FRAMELINK_PLUGIN_INSTALL_URL);
    await session.close();
  });

  it("answers a rate limit with the plugin call for the same node when a plugin is connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429, statusText: "Too Many" })),
    );
    const session = connectWithPlugin({ connected: true });

    const text = await session.callGetFigmaData({ fileKey: "abc123", nodeId: "12-34" });

    expect(text).toContain("rate limit hit (429)");
    expect(text).toContain('flcm.get("12:34")');
    expect(text).toContain("figma.root.name");
    await session.close();
  });

  it("answers a rate limit with the install link when no plugin has ever connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429, statusText: "Too Many" })),
    );
    const session = connectWithPlugin({ connected: false });

    const text = await session.callGetFigmaData({ fileKey: "abc123" });

    expect(text).toContain(FRAMELINK_PLUGIN_INSTALL_URL);
    expect(text).not.toContain("figma_execute_code");
    await session.close();
  });
});
