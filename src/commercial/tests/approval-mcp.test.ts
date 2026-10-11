/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "~/mcp/index.js";
import { PluginBridge, type BridgeRequest } from "~/commercial/plugin-bridge/bridge.js";
import { APPROVAL_WAIT_MS } from "~/commercial/plugin-bridge/await-approval.js";
import { createTestWriteAccess, TEST_AUTHORIZING_USER } from "./fixtures/write-access.js";

class Bridge extends PluginBridge {
  decision = "PENDING_APPROVAL";
  executions = 0;
  signal?: AbortSignal;
  connected = true;
  outage: number | null = null;
  override isPluginConnected() {
    return this.connected;
  }
  override disconnectedDurationMs() {
    return this.outage;
  }
  override getAuthorizingUser() {
    return TEST_AUTHORIZING_USER;
  }
  override getPairingCode() {
    return "1234";
  }
  override async request(payload: BridgeRequest, signal?: AbortSignal) {
    this.signal = signal;
    if (payload.type === "APPROVAL_STATUS") return { type: this.decision };
    this.executions++;
    return { result: "done", console: [], errors: null, documentChanged: false };
  }
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
async function setup() {
  const bridge = new Bridge();
  const server = createServer(
    { figmaApiKey: "test", figmaOAuthToken: "", useOAuth: false },
    {
      transport: "stdio",
      pluginBridge: {
        bridge,
        writeAccess: createTestWriteAccess().writeAccess,
        hasEverConnected: () => true,
        onFirstConnect: () => {},
      },
    },
  );
  const client = new Client({ name: "approval-test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  return { bridge, client, close: () => Promise.all([client.close(), server.close()]) };
}
afterEach(() => vi.useRealTimers());

it("MCP progress reports waiting without execution and stops before the single approved submission", async () => {
  const h = await setup();
  vi.useFakeTimers();
  const progress: string[] = [];
  const call = h.client.request(
    {
      method: "tools/call",
      params: { name: "figma_execute_code", arguments: { code: "return 1" } },
    },
    CallToolResultSchema,
    { onprogress: (p) => progress.push(p.message ?? "") },
  );
  await flush();
  await vi.advanceTimersByTimeAsync(3000);
  expect(h.bridge.executions).toBe(0);
  expect(progress.some((m) => m.includes("Code has not been submitted"))).toBe(true);
  h.bridge.decision = "APPROVAL_GRANTED";
  await vi.advanceTimersByTimeAsync(750);
  await call;
  expect(h.bridge.executions).toBe(1);
  const count = progress.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(progress).toHaveLength(count);
  await h.close();
});

it.each(["cancel", "disconnect"])(
  "MCP %s abandons local code even if Allow arrives later",
  async (action) => {
    const h = await setup();
    vi.useFakeTimers();
    const abort = new AbortController();
    const call = h.client
      .request(
        {
          method: "tools/call",
          params: { name: "figma_execute_code", arguments: { code: "return 1" } },
        },
        CallToolResultSchema,
        { signal: abort.signal },
      )
      .catch(() => undefined);
    await flush();
    if (action === "cancel") abort.abort();
    else await h.client.close();
    await flush();
    expect(h.bridge.signal?.aborted).toBe(true);
    h.bridge.decision = "APPROVAL_GRANTED";
    await vi.advanceTimersByTimeAsync(6000);
    await call;
    expect(h.bridge.executions).toBe(0);
    await h.close();
  },
);

it.each([null, 2000, 31000])(
  "reconnect guidance is bounded by actual outage %s",
  async (outage) => {
    const h = await setup();
    h.bridge.connected = false;
    h.bridge.outage = outage;
    const result = await h.client.request(
      {
        method: "tools/call",
        params: { name: "figma_execute_code", arguments: { code: "return 1" } },
      },
      CallToolResultSchema,
    );
    const text = JSON.stringify(result.content);
    expect(text).toContain("not submitted");
    if (outage === 2000) expect(text).toContain("Wait a few seconds, then retry");
    else {
      expect(text).toContain("Blocked: the Framelink plugin is disconnected");
      expect(text).toContain("retry only after the plugin is open");
    }
    expect(h.bridge.executions).toBe(0);
    await h.close();
  },
);

it("the client's ordinary timeout cancels approval waiting before a late Allow", async () => {
  const h = await setup();
  vi.useFakeTimers();
  const call = h.client
    .request(
      {
        method: "tools/call",
        params: { name: "figma_execute_code", arguments: { code: "return 1" } },
      },
      CallToolResultSchema,
      { timeout: 1000 },
    )
    .catch(() => undefined);
  await flush();
  await vi.advanceTimersByTimeAsync(1000);
  await call;
  expect(h.bridge.signal?.aborted).toBe(true);
  h.bridge.decision = "APPROVAL_GRANTED";
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.bridge.executions).toBe(0);
  await h.close();
});

it("an expired approval wait names the blocker, the pairing code, and that a later Allow runs nothing", async () => {
  const h = await setup();
  vi.useFakeTimers();
  const call = h.client.request(
    {
      method: "tools/call",
      params: { name: "figma_execute_code", arguments: { code: "return 1" } },
    },
    CallToolResultSchema,
    { timeout: 300_000 },
  );
  await flush();
  await vi.advanceTimersByTimeAsync(APPROVAL_WAIT_MS);
  const text = JSON.stringify((await call).content);
  expect(text).toContain("did not run");
  expect(text).toContain("Blocked: session approval is pending");
  expect(text).toContain("approves pairing code 1234");
  expect(text).toContain("retry only after they confirm the approval");
  expect(text).toContain("Approving later does not run this call");
  expect(h.bridge.executions).toBe(0);
  await h.close();
});
