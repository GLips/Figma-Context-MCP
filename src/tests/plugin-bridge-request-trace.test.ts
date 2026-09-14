import { afterEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { PluginBridge } from "~/services/plugin-bridge/bridge.js";
import { RequestTrace, type TraceEvent } from "~/services/plugin-bridge/request-trace.js";
import { Logger } from "~/utils/logger.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function connectedBridge(timeout = 100, ceiling = 1000) {
  const sent: { id?: string; type: string; runId?: string }[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as unknown as WebSocket;
  const bridge = new PluginBridge(undefined, { requestTimeoutMs: timeout, runCeilingMs: ceiling });
  // Exercise actual request/timer/message code without opening a network listener.
  bridge["socket"] = socket;
  bridge["compatibility"] = "compatible";
  const receive = (message: object, owner = socket) =>
    bridge["handleMessage"](owner, JSON.stringify(message));
  return { bridge, sent, socket, receive };
}
test("host checkpoints do not reset inactivity or resubmit; late result remains diagnostic only", async () => {
  vi.useFakeTimers();
  vi.spyOn(Logger, "log").mockImplementation(() => {});
  const { bridge, sent, socket, receive } = connectedBridge();
  const result = bridge
    .request({ type: "EXECUTE_CODE", code: "private code", preamble: "private preamble" })
    .catch((error) => error);
  const id = sent[0].id!;
  receive({ type: "RUN_STATE", runId: id, phase: "running" });
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
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Completion is unconfirmed");
  expect(sent.map((frame) => frame.type)).toEqual(["EXECUTE_CODE", "CANCEL"]);
  const replacement = { readyState: WebSocket.OPEN } as WebSocket;
  bridge["socket"] = replacement;
  receive({ id, result: { private: "response content" } }, socket);
  expect(bridge["trace"].snapshot(id).map((event) => event.stage)).toContain("late-reply");
  expect(JSON.stringify(bridge["trace"].snapshot(id))).not.toMatch(
    /secret|private|response content/,
  );
  expect(sent.map((frame) => frame.type)).toEqual(["EXECUTE_CODE", "CANCEL"]);
});
test("trace traffic cannot extend absolute ceiling; wrong socket cannot supply checkpoints", async () => {
  vi.useFakeTimers();
  vi.spyOn(Logger, "log").mockImplementation(() => {});
  const { bridge, sent, receive } = connectedBridge(100, 150);
  const result = bridge
    .request({ type: "EXECUTE_CODE", code: "", preamble: "" })
    .catch((error) => error);
  const id = sent[0].id!;
  await vi.advanceTimersByTimeAsync(80);
  receive({ type: "RUN_STATE", runId: id, phase: "running" });
  receive({ type: "RUN_TRACE", runId: id, stage: "native-start" }, {} as WebSocket);
  receive({ type: "RUN_TRACE", runId: id, stage: "eval-start" });
  await vi.advanceTimersByTimeAsync(70);
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("absolute 150ms");
  const trace = bridge["trace"].snapshot(id);
  expect(trace.some((event) => event.hostStage === "native-start")).toBe(false);
  expect(trace.at(-1)?.stage).toBe("timeout-ceiling");
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
  trace.record("run", owner, "host", "user secret");
  for (let i = 0; i < 1000; i++) trace.record("run", owner, "host", "native-start");
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
    const { bridge, sent, receive } = connectedBridge();
    const controller = new AbortController();
    const result = bridge
      .request({ type: "EXECUTE_CODE", code: "", preamble: "" }, controller.signal)
      .catch((error) => error);
    const id = sent[0].id!;
    receive({ type: "RUN_STATE", runId: id, phase: "queued" });
    receive({ type: "RUN_TRACE", runId: id, stage: "native-start", operation: "page-switch" });
    if (stage === "result") receive({ id, result: "secret" });
    if (stage === "error") receive({ id, type: "ERROR", error: "private native error" });
    if (stage === "caller-cancelled") controller.abort();
    if (stage === "disconnected") bridge["failPending"]("disconnected");
    await result;
    await vi.advanceTimersByTimeAsync(2000);
    const events = bridge["trace"].snapshot(id);
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
  const { bridge, sent, receive } = connectedBridge();
  const result = bridge.request({ type: "EXECUTE_CODE", code: "", preamble: "" });
  const id = sent[0].id!;
  const envelope = {
    id,
    type: "EXECUTE_CODE_RESULT",
    errors: "private execution detail",
    result: null,
  };
  receive(envelope);
  expect(await result).toEqual(envelope);
  expect(bridge["trace"].snapshot(id).at(-1)?.stage).toBe("error");
  expect(JSON.stringify(bridge["trace"].snapshot(id))).not.toContain("private execution detail");
});
