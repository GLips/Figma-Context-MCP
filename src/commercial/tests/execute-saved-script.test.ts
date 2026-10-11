/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// figma_execute_code's scriptPath, through a real Client/Server pair and the real asset-root reader
// against a tmpdir. The bridge is mocked, so "submitted" means an EXECUTE_CODE request left the server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "~/mcp/index.js";
import type { BridgeRequest, PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import { createContainedFileReader } from "~/commercial/plugin-bridge/contained-file.js";
import { createSavedScriptReader } from "~/commercial/plugin-bridge/saved-script.js";
import { createTestWriteAccess, TEST_AUTHORIZING_USER } from "./fixtures/write-access.js";

let outer: string;
let root: string;

beforeEach(async () => {
  outer = await mkdtemp(join(tmpdir(), "flcm-scripts-"));
  root = join(outer, "root");
  await mkdir(join(root, "scripts"), { recursive: true });
});

afterEach(async () => {
  await rm(outer, { recursive: true, force: true });
});

function connectedServer() {
  const request = vi
    .fn()
    .mockImplementation(async (payload: BridgeRequest) =>
      payload.type === "APPROVAL_STATUS"
        ? { type: "APPROVAL_GRANTED" }
        : { result: "ran", console: [], errors: null, documentChanged: false },
    );
  const bridge = {
    request,
    getPairingCode: () => "1234",
    protocolRefusal: () => null,
    touchApproval: () => {},
    getAuthorizingUser: () => TEST_AUTHORIZING_USER,
    isPluginConnected: () => true,
  } as unknown as PluginBridge;
  const runtime: PluginBridgeRuntime = {
    bridge,
    writeAccess: createTestWriteAccess().writeAccess,
    readSavedScript: createSavedScriptReader(createContainedFileReader(root)),
    hasEverConnected: () => true,
    onFirstConnect: () => {},
  };
  const server = createServer(
    { figmaApiKey: "test-key", figmaOAuthToken: "", useOAuth: false },
    { transport: "stdio", pluginBridge: runtime },
  );
  const client = new Client({ name: "saved-script-test-client", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const ready = Promise.all([client.connect(clientT), server.connect(serverT)]);
  const call = async (args: Record<string, unknown>) => {
    await ready;
    const result = await client.request(
      { method: "tools/call", params: { name: "figma_execute_code", arguments: args } },
      CallToolResultSchema,
    );
    return { ...result, text: (result.content[0] as { text: string }).text };
  };
  const submitted = () =>
    request.mock.calls
      .map(([payload]) => payload as BridgeRequest)
      .filter((payload) => payload.type === "EXECUTE_CODE");
  return { call, submitted, close: () => Promise.all([client.close(), server.close()]) };
}

describe("figma_execute_code with scriptPath", () => {
  it("runs the file's contents, resolving a relative path against the asset root", async () => {
    await writeFile(join(root, "scripts", "card.js"), "return 'from file';\n");
    const { call, submitted, close } = connectedServer();
    try {
      const reply = await call({ scriptPath: "scripts/card.js" });

      expect(reply.isError).toBeFalsy();
      expect(JSON.parse(reply.text)).toEqual({ result: "ran", console: [], errors: null });
      expect(submitted()).toEqual([
        expect.objectContaining({ type: "EXECUTE_CODE", code: "return 'from file';\n" }),
      ]);
    } finally {
      await close();
    }
  });

  it("refuses a file outside the asset root, or not .js, without submitting anything", async () => {
    await writeFile(join(outer, "outside.js"), "return 'secret';");
    await mkdir(join(outer, "my scripts"));
    await writeFile(join(outer, "my scripts", "outside.js"), "return 'secret';");
    await writeFile(join(root, "scripts", "notes.txt"), "return 1;");
    const { call, submitted, close } = connectedServer();
    try {
      const escaped = await call({ scriptPath: "../outside.js" });
      expect(escaped.isError).toBeFalsy();
      expect(escaped.text).toContain("did not run");
      expect(escaped.text).toContain(`outside the asset root (${root})`);
      expect(escaped.text).toContain("send the script inline as code");
      // The CLI resolves against the shell's cwd, not the root, so the suggestion names the file absolutely.
      expect(escaped.text).toContain(
        `\`npx figma-developer-mcp execute ${join(outer, "outside.js")}\``,
      );

      const spaced = join(outer, "my scripts", "outside.js");
      const absoluteEscape = await call({ scriptPath: spaced });
      expect(absoluteEscape.text).toContain(`outside the asset root (${root})`);
      expect(absoluteEscape.text).toContain(`execute '${spaced}'`);

      const wrongType = await call({ scriptPath: "scripts/notes.txt" });
      expect(wrongType.text).toContain("only .js files are run");

      expect(submitted()).toEqual([]);
    } finally {
      await close();
    }
  });

  it("takes exactly one of code and scriptPath", async () => {
    await writeFile(join(root, "scripts", "card.js"), "return 1;");
    const { call, submitted, close } = connectedServer();
    try {
      const neither = await call({});
      expect(neither.isError).toBeFalsy();
      expect(neither.text).toContain("got neither");
      const both = await call({ code: "return 1", scriptPath: "scripts/card.js" });
      expect(both.isError).toBeFalsy();
      expect(both.text).toContain("got both");
      expect(submitted()).toEqual([]);
    } finally {
      await close();
    }
  });
});
