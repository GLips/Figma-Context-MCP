/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { afterEach, expect, test, vi } from "vitest";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { RequestTrace, type TraceEvent } from "~/commercial/plugin-bridge/request-trace.js";
import { Logger } from "~/utils/logger.js";
import { connectFakePlugin, type FakePluginSocket } from "./fixtures/fake-plugin-socket.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function connectedBridge(timeout = 100, ceiling = 1000) {
  const trace = new RequestTrace(() => {});
  const bridge = new PluginBridge(undefined, {
    requestTimeoutMs: timeout,
    runCeilingMs: ceiling,
    trace,
  });
  // Displaced before the holder connects: still wired to the bridge, but no longer the holder.
  const stranger = await connectFakePlugin(bridge);
  const socket = await connectFakePlugin(bridge);
  const sent = socket.frames as { id?: string; type: string; runId?: string }[];
  const receive = (message: Record<string, unknown>, owner: FakePluginSocket = socket) =>
    owner.receive(message);
  return { bridge, trace, sent, socket, stranger, receive };
}
test("host checkpoints do not reset inactivity or resubmit; late result remains diagnostic only", async () => {
  vi.useFakeTimers();
  vi.spyOn(Logger, "log").mockImplementation(() => {});
  const { bridge, trace, sent, socket, receive } = await connectedBridge();
  const result = bridge
    .request({
      type: "EXECUTE_CODE",
      code: "private code",
      preamble: "private preamble",
      lateChangeWindowMs: 60_000,
    })
    .catch((error) => error);
  const id = sent[0].id!;
  receive({ type: "RUN_STATE", runId: id, phase: "running", at: Date.now() });
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(20);
    receive({
      type: "RUN_TRACE",
      runId: id,
      stage: "native-start",
      elapsedMs: i * 20,
      code: "secret",
    });
  }
  await vi.advanceTimersByTimeAsync(20);
  // The deadline's CANCEL is answered from the plugin's own phase, and that answer is what the
  // caller's rejection is worded from (protocol 6).
  receive({ type: "CANCEL_RESULT", runId: id, disposition: "was-running" });
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("was executing when it was cancelled");
  expect(sent.map((frame) => frame.type)).toEqual(["EXECUTE_CODE", "CANCEL"]);
  await connectFakePlugin(bridge);
  receive({ id, result: { private: "response content" } }, socket);
  expect(trace.snapshot(id).map((event) => event.stage)).toContain("late-reply");
  expect(JSON.stringify(trace.snapshot(id))).not.toMatch(/secret|private|response content/);
  expect(sent.map((frame) => frame.type)).toEqual(["EXECUTE_CODE", "CANCEL"]);
});
test("trace traffic cannot extend absolute ceiling; wrong socket cannot supply checkpoints", async () => {
  vi.useFakeTimers();
  vi.spyOn(Logger, "log").mockImplementation(() => {});
  const { bridge, trace, sent, stranger, receive } = await connectedBridge(100, 150);
  const result = bridge
    .request({ type: "EXECUTE_CODE", code: "", preamble: "", lateChangeWindowMs: 60_000 })
    .catch((error) => error);
  const id = sent[0].id!;
  await vi.advanceTimersByTimeAsync(80);
  receive({ type: "RUN_STATE", runId: id, phase: "running", at: Date.now() });
  receive({ type: "RUN_TRACE", runId: id, stage: "native-start", elapsedMs: 0 }, stranger);
  receive({ type: "RUN_TRACE", runId: id, stage: "eval-start", elapsedMs: 0 });
  await vi.advanceTimersByTimeAsync(70);
  receive({ type: "CANCEL_RESULT", runId: id, disposition: "was-running" });
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("absolute 150ms");
  const events = trace.snapshot(id);
  expect(events.some((event) => event.hostStage === "native-start")).toBe(false);
  expect(events.at(-1)?.stage).toBe("timeout-ceiling");
});
test("trace is bounded, stage-only, expires terminal entries, and keeps timeout context after noise", () => {
  let now = 0;
  const emitted: TraceEvent[] = [];
  const owner = {};
  const trace = new RequestTrace(
    (event) => emitted.push(event),
    () => now,
  );
  trace.start("run", owner);
  for (let i = 0; i < 1000; i++)
    trace.recordHost("run", owner, { stage: "native-start", elapsedMs: i });
  trace.record("run", owner, "timeout-inactivity");
  trace.record("run", owner, "late-reply");
  trace.record("run", owner, "late-reply");
  expect(emitted).toHaveLength(34);
  expect(trace.snapshot("run")).toHaveLength(32);
  expect(emitted.at(-2)?.lastHostStage).toBe("native-start");
  now = 60_000;
  expect(trace.snapshot("run")).toEqual([]);
  for (let i = 0; i < 129; i++) trace.start(String(i), owner);
  expect(trace.snapshot("0")).toEqual([]);
  expect(trace.snapshot("128")).toHaveLength(1);
});

test.each(["result", "error", "caller-cancelled", "disconnected"] as const)(
  "%s records a terminal stage and clears request timers",
  async (stage) => {
    vi.useFakeTimers();
    vi.spyOn(Logger, "log").mockImplementation(() => {});
    const { bridge, trace, sent, socket, receive } = await connectedBridge();
    const controller = new AbortController();
    const result = bridge
      .request(
        { type: "EXECUTE_CODE", code: "", preamble: "", lateChangeWindowMs: 60_000 },
        controller.signal,
      )
      .catch((error) => error);
    const id = sent[0].id!;
    receive({ type: "RUN_STATE", runId: id, phase: "queued", at: Date.now() });
    receive({
      type: "RUN_TRACE",
      runId: id,
      stage: "native-start",
      elapsedMs: 0,
      operation: "page-switch",
    });
    if (stage === "result")
      receive({
        id,
        type: "EXECUTE_CODE_RESULT",
        result: "secret",
        console: [],
        errors: null,
        documentChanged: false,
      });
    if (stage === "error") receive({ id, type: "ERROR", error: "private native error" });
    if (stage === "caller-cancelled") controller.abort();
    if (stage === "disconnected") socket.terminate();
    await result;
    await vi.advanceTimersByTimeAsync(2000);
    const events = trace.snapshot(id);
    expect(events.at(-1)).toMatchObject({
      stage,
      lastHostStage: "native-start",
      operation: "page-switch",
    });
    expect(events.some((event) => event.stage.startsWith("timeout"))).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/secret|private/);
    expect(sent.filter((frame) => frame.type === "EXECUTE_CODE")).toHaveLength(1);
  },
);

test("execution error result is traced as error without changing successful envelope delivery", async () => {
  vi.useFakeTimers();
  vi.spyOn(Logger, "log").mockImplementation(() => {});
  const { bridge, trace, sent, receive } = await connectedBridge();
  const result = bridge.request({
    type: "EXECUTE_CODE",
    code: "",
    preamble: "",
    lateChangeWindowMs: 60_000,
  });
  const id = sent[0].id!;
  const reply = {
    type: "EXECUTE_CODE_RESULT",
    errors: "private execution detail",
    result: null,
    console: [],
    documentChanged: false,
  };
  receive({ id, ...reply });
  expect(await result).toEqual(reply);
  expect(trace.snapshot(id).at(-1)?.stage).toBe("error");
  expect(JSON.stringify(trace.snapshot(id))).not.toContain("private execution detail");
});
