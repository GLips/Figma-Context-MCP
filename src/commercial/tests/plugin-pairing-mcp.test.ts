/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Pairing from an MCP call: confirmed in the client's own prompt when it has one, and through the
// agent and pair_figma_plugin when it hasn't, or when the prompt goes unanswered.
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { codeModeExtension } from "~/commercial/tools/code-mode-tools.js";
import { createServer } from "~/mcp/index.js";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import { connectFakePlugin, type FakePluginSocket } from "./fixtures/fake-plugin-socket.js";
import { createTestWriteAccess } from "./fixtures/write-access.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** An unpaired plugin that, once paired, grants approval and runs whatever it is sent. */
async function setup(answerPrompt?: (message: string) => ElicitResult) {
  const bridge = new PluginBridge();
  cleanups.push(() => bridge.stop());
  const socket = await connectFakePlugin(bridge, { paired: false });
  socket.onFrame = (frame) => {
    if (frame.type === "APPROVAL_STATUS")
      socket.receive({ type: "APPROVAL_GRANTED", id: frame.id });
    if (frame.type === "EXECUTE_CODE")
      socket.receive({
        type: "EXECUTE_CODE_RESULT",
        id: frame.id,
        result: "ran",
        console: [],
        errors: null,
        documentChanged: false,
      });
  };
  const runtime: PluginBridgeRuntime = {
    bridge,
    writeMeter: createTestWriteAccess().writeMeter,
    readSavedScript: () => Promise.reject(new Error("no saved scripts in this test")),
    readLocalImage: () => Promise.reject(new Error("no local images in this test")),
    pluginPresence: () => "connected",
    onFirstConnect: () => {},
  };
  const server = createServer(
    { credential: { kind: "pat", token: "test" }, imageDir: process.cwd(), plugin: runtime },
    { transport: "stdio", extensions: [codeModeExtension(runtime, { codeMode: false })] },
  );
  const client = new Client(
    { name: "pairing-test", version: "1" },
    { capabilities: answerPrompt ? { elicitation: { form: {} } } : {} },
  );
  const prompts: string[] = [];
  if (answerPrompt)
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params.message);
      return answerPrompt(request.params.message);
    });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  cleanups.push(() => Promise.all([client.close(), server.close()]));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.request(
      { method: "tools/call", params: { name, arguments: args } },
      CallToolResultSchema,
    );
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    return { ...result, text };
  };
  return { bridge, socket, call, prompts };
}

const shownCode = (socket: FakePluginSocket) =>
  String(socket.frames.filter((frame) => frame.type === "PAIRING_OFFER").at(-1)?.code);
const executions = (socket: FakePluginSocket) =>
  socket.frames.filter((frame) => frame.type === "EXECUTE_CODE").length;

it("without a client prompt, the agent is told to confirm the code, and pair_figma_plugin pairs it", async () => {
  const { socket, call } = await setup();

  const blocked = await call("figma_execute_code", { code: "return 1" });
  const code = shownCode(socket);
  expect(blocked.isError).toBeFalsy();
  expect(blocked.text).toContain(`shows the pairing code ${code}`);
  expect(blocked.text).toContain(`pair_figma_plugin with { "code": "${code}" }`);
  expect(executions(socket)).toBe(0);

  expect((await call("pair_figma_plugin", { code })).text).toContain("Paired");
  expect((await call("figma_execute_code", { code: "return 1" })).text).toContain("ran");
  expect(executions(socket)).toBe(1);
});

it("a Yes in the client's prompt pairs and runs the call that asked", async () => {
  const { socket, call, prompts } = await setup(() => ({
    action: "accept",
    content: { shown: true },
  }));

  expect((await call("figma_execute_code", { code: "return 1" })).text).toContain("ran");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(shownCode(socket));
  expect(executions(socket)).toBe(1);
});

it.each([
  ["cancelled", (): ElicitResult => ({ action: "cancel" })],
  [
    "failing",
    (): ElicitResult => {
      throw new Error("the client can't show prompts after all");
    },
  ],
])("a %s prompt falls back to agent guidance, which still pairs", async (_, answer) => {
  const { socket, call } = await setup(answer);

  const blocked = await call("figma_execute_code", { code: "return 1" });
  const code = shownCode(socket);
  expect(blocked.text).toContain(`pair_figma_plugin with { "code": "${code}" }`);
  expect(executions(socket)).toBe(0);
  expect((await call("pair_figma_plugin", { code })).text).toContain("Paired");
});

it("a No in the client's prompt pairs nothing and takes the code off the panel", async () => {
  const { socket, call } = await setup(() => ({ action: "accept", content: { shown: false } }));

  const refused = await call("figma_execute_code", { code: "return 1" });
  const code = shownCode(socket);
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("doesn't show the pairing code");
  expect(socket.frames).toContainEqual(expect.objectContaining({ type: "PAIRING_CLOSED", code }));
  expect((await call("pair_figma_plugin", { code })).text).toContain(
    `No pairing attempt is showing the code ${code}`,
  );
  expect(executions(socket)).toBe(0);
});
