/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// A server bound to a network address gives remote callers none of the operator's resources: no
// Figma token, no disk, no plugin. Driven through the real HTTP edge, because that is where the
// caller context is decided.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { startHttpServer, stopHttpServer } from "~/server.js";
import { codeModeExtension } from "~/commercial/tools/code-mode-tools.js";
import type { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import {
  createTestWriteAccess,
  targetedTestCall,
  linkedTestResolution,
  TEST_PLUGIN_LINK,
} from "./fixtures/write-access.js";

const request = vi.fn();
const readSavedScript = vi.fn();
const plugin: PluginBridgeRuntime = {
  bridge: {
    request,
    targetCall: targetedTestCall,
    resolveLink: linkedTestResolution,
  } as unknown as PluginBridge,
  writeMeter: createTestWriteAccess().writeMeter,
  readSavedScript,
  readLocalImage: () => Promise.reject(new Error("no local images in this test")),
  pluginPresence: () => "connected",
  onFirstConnect: () => {},
};

let httpServer: Server | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  if (httpServer) await stopHttpServer();
  httpServer = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function connect(host: string, headers: Record<string, string>) {
  httpServer = await startHttpServer(
    host,
    0,
    { credential: { kind: "pat", token: "operator-token" }, imageDir: process.cwd(), plugin },
    { extensions: [codeModeExtension(plugin, { codeMode: false })] },
  );
  const { port } = httpServer.address() as AddressInfo;
  client = new Client({ name: "remote-caller-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers },
    }),
  );
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.request(
    { method: "tools/call", params: { name, arguments: args } },
    CallToolResultSchema,
  );
  const [first] = result.content;
  return { isError: result.isError, text: first?.type === "text" ? first.text : "" };
}

describe("a non-loopback bind", () => {
  it("refuses a request that brings no Figma token, rather than spending the operator's", async () => {
    await expect(connect("0.0.0.0", {})).rejects.toThrow(/must bring its own Figma token/);
  });

  it("refuses downloads and the plugin tools to a caller with a token, even with a plugin connected", async () => {
    const client = await connect("0.0.0.0", { "X-Figma-Token": "caller-token" });

    const download = await callText(client, "download_figma_images", {});
    expect(download).toMatchObject({ isError: true });
    expect(download.text).toContain("unavailable to remote callers");

    for (const [name, args] of [
      ["figma_execute_code", { scriptPath: "secrets.js" }],
      ["get_screenshot", {}],
    ] as const) {
      const reply = await callText(client, name, args);
      expect(reply).toMatchObject({ isError: true });
      expect(reply.text).toContain("Local writes need a loopback server");
    }
    expect(request).not.toHaveBeenCalled();
    expect(readSavedScript).not.toHaveBeenCalled();
  });

  it("refuses the plugin tools by name before any plugin has connected, revealing nothing of it", async () => {
    vi.spyOn(plugin, "pluginPresence").mockReturnValue("absent");
    const client = await connect("0.0.0.0", { "X-Figma-Token": "caller-token" });

    const reply = await callText(client, "get_screenshot", {});
    expect(reply.text).toContain("Local writes need a loopback server");
  });
});

describe("a loopback bind", () => {
  it("grants the operator's plugin, as it always has", async () => {
    request.mockResolvedValue({ type: "SCREENSHOT_RESULT", image: "AQ==" });
    const client = await connect("127.0.0.1", {});

    const result = await client.request(
      { method: "tools/call", params: { name: "get_screenshot", arguments: {} } },
      CallToolResultSchema,
    );
    expect(result.isError).toBeUndefined();
    expect(request).toHaveBeenCalledWith(
      TEST_PLUGIN_LINK,
      expect.objectContaining({ type: "SCREENSHOT" }),
      expect.anything(),
    );
  });
});
