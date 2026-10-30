/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// How a caller waits on a plugin run: liveness from the plugin's RUN_STATUS answers to the server's
// heartbeat alone, and the caller's own policy on top — the MCP tools' check-in (a run outliving it
// is detached and awaited, never cancelled) and withdraw-behind-a-cancelled-run, the CLI's patience.
// The MCP cases go through a real tool call over a real bridge.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import type { PluginBridgeRuntime } from "~/commercial/plugin-bridge/index.js";
import type { RunWaiting } from "~/commercial/plugin-bridge/run-ledger.js";
import { codeModeExtension } from "~/commercial/tools/code-mode-tools.js";
import { createServer } from "~/mcp/index.js";
import { mintExecutionId, type ExecutionId } from "~/commercial/execution-id.js";
import { RUN_STATUS_INTERVAL_MS, type QueueBlocker } from "@framelink/plugin/protocol";
import { connectFakePlugin, type FakePluginSocket } from "./fixtures/fake-plugin-socket.js";
import {
  TEST_DOCUMENT,
  TEST_PLUGIN_OWNER,
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

const runningStatus = (
  executionId: string,
  oldestPending?: { operation: string; sinceMs: number },
) => ({
  type: "RUN_STATUS",
  executionId,
  at: Date.now(),
  phase: "running",
  activity: { callsSettled: 3, oldestPending },
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
    runState: (id: ExecutionId) => real.runState(id),
    withdrawRun: (id: ExecutionId) => real.withdrawRun(id),
    cancelRun: (id: ExecutionId) => real.cancelRun(id),
    targetCall: targetedTestCall,
    resolveLink: linkedTestResolution,
  } as unknown as PluginBridge;
  const access = createTestWriteAccess();
  const runtime: PluginBridgeRuntime = {
    bridge,
    writeMeter: access.writeMeter,
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
  const callTool = (name: string, args: Record<string, unknown>) =>
    client.request(
      { method: "tools/call", params: { name, arguments: args } },
      CallToolResultSchema,
    );
  const execute = () => callTool("figma_execute_code", { intent: "Test run", code: "x" });
  const awaitRun = (run: string, cancel?: boolean) =>
    callTool("await_figma_execution", cancel ? { run, cancel } : { run });
  /** Executions charged to the test plugin owner. */
  const charged = () =>
    access.store.read().ledger[TEST_PLUGIN_OWNER.figmaUserId]?.executions.length ?? 0;
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
  return {
    socket,
    execute,
    awaitRun,
    charged,
    submitted,
    close: () => Promise.all([client.close(), server.close()]),
  };
}

const textOf = (result: { content: unknown[] }) =>
  (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");

describe("liveness is the plugin's heartbeat", () => {
  it("asks a link for its runs' statuses every interval while it has one outstanding, and stops once it has none", async () => {
    vi.useFakeTimers();
    const { bridge, socket } = await pluginBridge();
    const asked = () => socket.frames.filter((f) => f.type === "RUN_STATUS_REQUEST").length;
    const first = submitCode(bridge, socket);
    const second = submitCode(bridge, socket);
    await Promise.resolve();
    const [firstId, secondId] = socket.frames.map((f) => f.id as string);
    for (const id of [firstId, secondId]) socket.receive(queuedStatus(id, 0));
    await vi.advanceTimersByTimeAsync(RUN_STATUS_INTERVAL_MS);
    expect(asked()).toBe(1);
    socket.receive(executed(firstId));
    await first;
    socket.receive(runningStatus(secondId));
    await vi.advanceTimersByTimeAsync(RUN_STATUS_INTERVAL_MS);
    expect(asked()).toBe(2);
    socket.receive(executed(secondId));
    expect(await second).toMatchObject({ type: "EXECUTE_CODE_RESULT" });
    await vi.advanceTimersByTimeAsync(10 * RUN_STATUS_INTERVAL_MS);
    expect(asked()).toBe(2);
  });

  it("waits out a run that goes silent for a minute, telling the caller how long Figma has been quiet", async () => {
    vi.useFakeTimers();
    const { bridge, socket } = await pluginBridge();
    const quiet: number[] = [];
    const call = submitCode(bridge, socket, { onQuiet: (ms: number) => quiet.push(ms) });
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    socket.receive(runningStatus(id));
    // Figma's thread is held: no status answers any heartbeat for a minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.frames.some((f) => f.type === "CANCEL")).toBe(false);
    expect(quiet.at(-1)).toBe(60_000);
    socket.receive({
      type: "EXECUTE_CODE_RESULT",
      id,
      result: "done",
      console: [],
      errors: null,
      documentChanged: true,
    });
    expect(await call).toMatchObject({ type: "EXECUTE_CODE_RESULT", result: "done" });
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
    socket.receive(runningStatus(id));
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
      mcp.socket.receive(runningStatus(id));
      mcp.socket.receive(executed(id));
      const reply = await result;
      expect(reply.isError).toBeFalsy();
      expect(textOf(reply)).toContain("done");
    } finally {
      await mcp.close();
    }
  });

  /** Keep a run's statuses flowing for `ms`, two seconds at a time. */
  async function runningFor(
    mcp: Awaited<ReturnType<typeof mcpOverBridge>>,
    id: string,
    ms: number,
    oldestPending?: { operation: string; sinceMs: number },
  ) {
    for (let elapsed = 0; elapsed < ms; elapsed += 2_000) {
      mcp.socket.receive(runningStatus(id, oldestPending));
      await vi.advanceTimersByTimeAsync(2_000);
    }
  }
  const handleIn = (text: string) => /Run: (run-[a-z2-9]{20})/.exec(text)?.[1];

  it("checks in on a run still going at 45s without cancelling it, and await_figma_execution returns its real result, billed once", async () => {
    vi.useFakeTimers();
    const mcp = await mcpOverBridge();
    try {
      const result = mcp.execute();
      const id = await mcp.submitted();
      // Figma answers for 20s, then a long export holds its main thread.
      await runningFor(mcp, id, 20_000, { operation: "figma.exportAsync", sinceMs: 0 });
      await vi.advanceTimersByTimeAsync(25_000);
      const checkIn = await result;
      const text = textOf(checkIn);
      expect(checkIn.isError).toBeFalsy();
      // Checked in a second early, leaving room for a queued run's withdraw answer.
      expect(text).toContain("The run is still running after 44s.");
      expect(text).toMatch(/Figma has been quiet for 2\ds/);
      expect(text).toMatch(/oldest pending call is figma\.exportAsync, waiting 2\ds/);
      expect(text).toContain("It has not been cancelled.");
      expect(text).not.toMatch(/retry|did not run/i);
      expect(mcp.socket.frames.some((f) => f.type === "CANCEL" || f.type === "WITHDRAW")).toBe(
        false,
      );
      const handle = handleIn(text)!;
      expect(handle).toBeDefined();

      const awaiting = mcp.awaitRun(handle);
      await vi.advanceTimersByTimeAsync(10_000);
      mcp.socket.receive({ ...executed(id), documentChanged: true });
      const reply = await awaiting;
      expect(reply.isError).toBeFalsy();
      expect(textOf(reply)).toMatch(/Session: [a-z]+-[a-z]+-[a-z]+-[a-z]+ /);
      expect(textOf(reply)).toContain("done");
      // Held for repeat fetches, and charged once, when the run itself settled.
      expect(await mcp.awaitRun(handle)).toEqual(reply);
      expect(mcp.charged()).toBe(1);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const expired = await mcp.awaitRun(handle);
      expect(expired.isError).toBe(true);
      const session = /Session: (\S+)/.exec(textOf(reply))![1];
      expect(textOf(expired)).toMatch(/^Result expired: /);
      expect(textOf(expired)).toContain(
        `Session ${session} may still contain the latest returned value in session.last`,
      );
      expect(mcp.charged()).toBe(1);
    } finally {
      await mcp.close();
    }
  });

  it("withdraws a run still queued at its check-in, and says it did not run only once the plugin confirms", async () => {
    vi.useFakeTimers();
    const mcp = await mcpOverBridge();
    try {
      const result = mcp.execute();
      const id = await mcp.submitted();
      for (let elapsed = 0; elapsed < 44_000; elapsed += 2_000) {
        mcp.socket.receive(queuedStatus(id, 1));
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect(mcp.socket.frames).toContainEqual({ type: "WITHDRAW", executionId: id });
      mcp.socket.receive({ type: "WITHDRAW_RESULT", executionId: id, outcome: "withdrawn" });
      const reply = await result;
      expect(reply.isError).toBe(true);
      expect(textOf(reply)).toBe(
        "Your code did not run: it was withdrawn from the plugin's queue, so this request made no changes. Retry as-is.",
      );
      expect(mcp.socket.frames.some((f) => f.type === "CANCEL")).toBe(false);
      expect(mcp.charged()).toBe(0);
    } finally {
      await mcp.close();
    }
  });

  it("cancels a detached run on request, reporting the plugin's cancel answer", async () => {
    vi.useFakeTimers();
    const mcp = await mcpOverBridge();
    try {
      const result = mcp.execute();
      const id = await mcp.submitted();
      await runningFor(mcp, id, 46_000, { operation: "flcm.render", sinceMs: 0 });
      const handle = handleIn(textOf(await result))!;
      const cancelling = mcp.awaitRun(handle, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(mcp.socket.frames.at(-1)).toMatchObject({ type: "CANCEL", executionId: id });
      mcp.socket.receive({ type: "CANCEL_RESULT", executionId: id, disposition: "was-running" });
      const reply = await cancelling;
      expect(reply.isError).toBe(true);
      expect(textOf(reply)).toMatch(
        /^Cancelled at your request\. Cancellation requested; the plugin confirmed the run was executing\./,
      );
      // A run that may have written is charged, as any lost run is.
      expect(mcp.charged()).toBe(1);
    } finally {
      await mcp.close();
    }
  });
});
