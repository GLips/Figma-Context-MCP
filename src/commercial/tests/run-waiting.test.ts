/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// How a caller waits on a plugin run: liveness from the plugin's RUN_STATUS heartbeat alone, and the
// caller's own policy on top — the MCP tools' 45-second budget and withdraw-behind-a-cancelled-run,
// the CLI's patience. The MCP cases go through a real tool call over a real bridge.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import type { RunWaiting } from "~/commercial/plugin-bridge/run-ledger.js";
import { codeModeExtension } from "~/commercial/tools/code-mode-tools.js";
import { createServer } from "~/mcp/index.js";
import { mintExecutionId } from "~/commercial/execution-id.js";
import type { QueueBlocker } from "@framelink/plugin/protocol";
import { connectFakePlugin, type FakePluginSocket } from "./fixtures/fake-plugin-socket.js";
import {
  TEST_DOCUMENT,
  TEST_SESSION_REQUEST,
  createTestWriteAccess,
  linkedTestResolution,
  targetedTestCall,
} from "./fixtures/write-access.js";

const bridges: PluginBridge[] = [];
afterEach(() => {
  for (const b of bridges.splice(0)) b.stop();
  vi.useRealTimers();
});

async function pluginBridge() {
  const bridge = new PluginBridge();
  bridges.push(bridge);
  const socket = await connectFakePlugin(bridge);
  return { bridge, socket };
}

const runningStatus = (executionId: string, pending: { operation: string; sinceMs: number }[]) => ({
  type: "RUN_STATUS",
  executionId,
  at: Date.now(),
  phase: "running",
  activity: { callsSettled: 3, pending, pendingCount: pending.length },
});
const queuedStatus = (executionId: string, ahead: number, blocker?: QueueBlocker) => ({
  type: "RUN_STATUS",
  executionId,
  at: Date.now(),
  phase: "queued",
  wait: blocker ? { ahead, blocker } : { ahead },
});
const executed = (id: string) => ({
  id,
  type: "EXECUTE_CODE_RESULT",
  result: "done",
  console: [],
  errors: null,
  documentChanged: false,
});
const submitCode = (bridge: PluginBridge, socket: FakePluginSocket, watch = {}) =>
  bridge
    .submitRun(
      socket.link,
      {
        type: "EXECUTE_CODE",
        intent: "Test run",
        session: TEST_SESSION_REQUEST,
        documentId: TEST_DOCUMENT.documentId,
        code: "x",
        preamble: "x",
        lateChangeWindowMs: 60_000,
      },
      mintExecutionId(),
      watch,
    )
    .catch((e: unknown) => e);

/** figma_execute_code over a real bridge, every call targeted at the fake plugin's link. */
async function mcpOverBridge() {
  const { bridge: real, socket } = await pluginBridge();
  const bridge = {
    submitRun: ((_link, ...rest) =>
      real.submitRun(socket.link, ...rest)) as PluginBridge["submitRun"],
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
  const client = new Client({ name: "run-waiting-test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  const execute = () =>
    client.request(
      {
        method: "tools/call",
        params: { name: "figma_execute_code", arguments: { intent: "Test run", code: "x" } },
      },
      CallToolResultSchema,
    );
  /** The execution id once the run is on the wire, advancing fake clocks if they are installed. */
  const submitted = async (): Promise<string> => {
    for (let i = 0; i < 100; i++) {
      const frame = socket.frames.find((f) => f.type === "EXECUTE_CODE");
      if (frame) return frame.id as string;
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error("no EXECUTE_CODE was sent");
  };
  return { socket, execute, submitted, close: () => Promise.all([client.close(), server.close()]) };
}

const textOf = (result: { content: unknown[] }) =>
  (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");

describe("liveness is the plugin's heartbeat", () => {
  it("keeps a heartbeating run alive past the deadline, cancels on 15s of silence naming its pending call, and a stale stamp buys nothing", async () => {
    vi.useFakeTimers();
    const { bridge, socket } = await pluginBridge();
    const call = submitCode(bridge, socket);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    for (let elapsed = 2_000; elapsed <= 20_000; elapsed += 2_000) {
      await vi.advanceTimersByTimeAsync(2_000);
      socket.receive(
        runningStatus(id, [{ operation: "figma.loadFontAsync", sinceMs: elapsed - 2_000 }]),
      );
    }
    expect(socket.frames.some((f) => f.type === "CANCEL")).toBe(false);
    // Arrives now, but stamped long ago: the plugin's thread was held, so it re-arms nothing.
    await vi.advanceTimersByTimeAsync(5_000);
    socket.receive({ ...runningStatus(id, []), at: Date.now() - 30_000 });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(socket.frames.some((f) => f.type === "CANCEL")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.frames.at(-1)).toMatchObject({ type: "CANCEL", executionId: id });
    socket.receive({ type: "CANCEL_RESULT", executionId: id, disposition: "was-running" });
    const error = await call;
    expect(error).toMatchObject({ outcome: "unconfirmed" });
    expect(String(error)).toContain(
      "No plugin status for 15 seconds. Cancellation requested; the plugin confirmed the run was " +
        "executing. It stops at its next flcm verb or top-level figma.* call (one it is awaiting " +
        "is abandoned); writes to nodes it already holds continue until then, and its writes so " +
        "far stay. " +
        "Last seen 15s ago: figma.loadFontAsync pending for 18s, 3 calls settled. Inspect affected " +
        "nodes before retrying.",
    );
  });

  it("lets a caller with no budget wait past 45s while statuses flow, seeing its place in the queue", async () => {
    vi.useFakeTimers();
    const { bridge, socket } = await pluginBridge();
    const waits: RunWaiting["wait"][] = [];
    const call = submitCode(bridge, socket, {
      onWaiting: ({ wait }: RunWaiting) => waits.push(wait),
    });
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    for (let elapsed = 0; elapsed < 60_000; elapsed += 2_000)
      await vi
        .advanceTimersByTimeAsync(2_000)
        .then(() =>
          socket.receive(queuedStatus(id, elapsed < 20_000 ? 3 : elapsed < 40_000 ? 2 : 1)),
        );
    socket.receive(runningStatus(id, []));
    socket.receive(executed(id));
    expect(await call).toMatchObject({ type: "EXECUTE_CODE_RESULT", result: "done" });
    expect([...new Set(waits.map((w) => w.ahead))]).toEqual([3, 2, 1]);
    expect(socket.frames.some((f) => f.type === "CANCEL" || f.type === "WITHDRAW")).toBe(false);
  });
});

describe("the MCP tools' waiting policy", () => {
  const cancelledBlocker = (): QueueBlocker => ({
    executionId: mintExecutionId(),
    kind: "code",
    sameLink: true,
    session: "soft-size-skull-fruit",
    intent: "Shape the new Promo card variants",
    runningForMs: 842_000,
    cancelledForMs: 827_000,
  });

  it("withdraws a call queued behind a cancelled run at once, and answers that its code did not run", async () => {
    const mcp = await mcpOverBridge();
    try {
      const result = mcp.execute();
      const id = await mcp.submitted();
      const blocker = cancelledBlocker();
      mcp.socket.receive(queuedStatus(id, 1, blocker));
      expect(mcp.socket.frames.at(-1)).toEqual({ type: "WITHDRAW", executionId: id });
      mcp.socket.receive({
        type: "WITHDRAW_RESULT",
        executionId: id,
        outcome: "withdrawn",
        blocker,
      });
      const reply = await result;
      expect(reply.isError).toBe(true);
      expect(textOf(reply)).toBe(
        "Your code did not run: it was withdrawn from the plugin's queue, so this request made no " +
          `changes. Run ${blocker.executionId} ("Shape the new Promo card variants", session ` +
          "soft-size-skull-fruit) still occupies the plugin and has run 14m 02s. Cancellation was " +
          "requested 13m 47s ago. Retrying now will queue behind it again.",
      );
      expect(mcp.socket.frames.some((f) => f.type === "CANCEL")).toBe(false);
    } finally {
      await mcp.close();
    }
  });

  it("keeps waiting when the withdrawn run had already started, and returns its reply", async () => {
    const mcp = await mcpOverBridge();
    try {
      const result = mcp.execute();
      const id = await mcp.submitted();
      mcp.socket.receive(queuedStatus(id, 1, cancelledBlocker()));
      mcp.socket.receive({ type: "WITHDRAW_RESULT", executionId: id, outcome: "running" });
      mcp.socket.receive(runningStatus(id, []));
      mcp.socket.receive(executed(id));
      const reply = await result;
      expect(reply.isError).toBeFalsy();
      expect(textOf(reply)).toContain("done");
    } finally {
      await mcp.close();
    }
  });

  it("cancels a run still going at 45 seconds, and says how to fit the work in", async () => {
    vi.useFakeTimers();
    const mcp = await mcpOverBridge();
    try {
      const result = mcp.execute();
      const id = await mcp.submitted();
      const cancelled = () => mcp.socket.frames.some((f) => f.type === "CANCEL");
      for (let i = 0; i < 22 && !cancelled(); i++) {
        mcp.socket.receive(runningStatus(id, [{ operation: "flcm.render", sinceMs: i * 2_000 }]));
        await vi.advanceTimersByTimeAsync(2_000);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mcp.socket.frames.at(-1)).toMatchObject({ type: "CANCEL", executionId: id });
      mcp.socket.receive({ type: "CANCEL_RESULT", executionId: id, disposition: "was-running" });
      const reply = await result;
      expect(reply.isError).toBe(true);
      const text = textOf(reply);
      expect(text).toMatch(/^The call's budget of 45 seconds ran out\. Cancellation requested; /);
      expect(text).toContain("flcm.render pending for");
      expect(text).toMatch(
        /Split the work across smaller calls, or run it with `npx [\w-]+ execute`, which has no 45-second limit\.$/,
      );
    } finally {
      await mcp.close();
    }
  });
});
