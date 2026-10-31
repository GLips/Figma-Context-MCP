/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { afterEach, expect, test, vi } from "vitest";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { RequestTrace, type TraceEvent } from "~/commercial/plugin-bridge/request-trace.js";
import { Logger } from "~/utils/logger.js";
import { connectFakePlugin, type FakePluginSocket } from "./fixtures/fake-plugin-socket.js";
import { TEST_DOCUMENT, TEST_SESSION_REQUEST } from "./fixtures/write-access.js";
import { mintExecutionId, type ExecutionId } from "~/commercial/execution-id.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function connectedBridge() {
  const trace = new RequestTrace(() => {});
  const bridge = new PluginBridge({ trace });
  // Another authenticated link: wired to the bridge, but not the one the runs go out on.
  const stranger = await connectFakePlugin(bridge);
  const socket = await connectFakePlugin(bridge);
  const sent = socket.frames as { id?: string; type: string; executionId?: string }[];
  const receive = (message: Record<string, unknown>, owner: FakePluginSocket = socket) =>
    owner.receive(message);
  return { bridge, trace, sent, socket, stranger, receive, link: socket.link };
}
const running = (id: string, operation: string, extra: Record<string, unknown> = {}) => ({
  type: "RUN_STATUS",
  executionId: id,
  at: Date.now(),
  phase: "running",
  activity: { callsSettled: 2, oldestPending: { operation, sinceMs: 0, ...extra } },
});
test("statuses are logged as counts only, and a late result is diagnostic only", async () => {
  vi.useFakeTimers();
  vi.spyOn(Logger, "log").mockImplementation(() => {});
  const { bridge, link, trace, sent, socket, receive } = await connectedBridge();
  const result = bridge
    .submitRun(
      link,
      {
        type: "EXECUTE_CODE",
        intent: "Test run",
        session: TEST_SESSION_REQUEST,
        documentId: TEST_DOCUMENT.documentId,
        code: "private code",
        preamble: "private preamble",
      },
      mintExecutionId(),
    )
    .catch((error) => error);
  const id = sent[0].id!;
  receive({ ...running(id, "figma.loadFontAsync", { code: "secret" }), code: "secret" });
  bridge.cancelRun(id as ExecutionId);
  receive({ type: "CANCEL_RESULT", executionId: id, disposition: "was-running" });
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Cancelled at your request");
  expect(sent.map((frame) => frame.type)).toEqual(["EXECUTE_CODE", "CANCEL"]);
  await connectFakePlugin(bridge);
  receive({ id, result: { private: "response content" } }, socket);
  expect(trace.snapshot(id).map((event) => event.stage)).toEqual([
    "submitted",
    "status",
    "requested-cancelled",
    "late-reply",
  ]);
  expect(trace.snapshot(id)[1]).toMatchObject({
    phase: "running",
    operation: "figma.loadFontAsync",
    callsSettled: 2,
  });
  expect(JSON.stringify(trace.snapshot(id))).not.toMatch(/secret|private|response content/);
  expect(sent.map((frame) => frame.type)).toEqual(["EXECUTE_CODE", "CANCEL"]);
});
test("another link's status for a run never enters its trace", async () => {
  vi.useFakeTimers();
  vi.spyOn(Logger, "log").mockImplementation(() => {});
  const { bridge, link, trace, sent, stranger, receive } = await connectedBridge();
  const result = bridge
    .submitRun(
      link,
      {
        type: "EXECUTE_CODE",
        intent: "Test run",
        session: TEST_SESSION_REQUEST,
        documentId: TEST_DOCUMENT.documentId,
        code: "",
        preamble: "",
      },
      mintExecutionId(),
    )
    .catch((error) => error);
  const id = sent[0].id!;
  await vi.advanceTimersByTimeAsync(80);
  receive(running(id, "figma.loadFontAsync"), stranger);
  bridge.cancelRun(id as ExecutionId);
  receive({ type: "CANCEL_RESULT", executionId: id, disposition: "was-running" });
  expect(await result).toBeInstanceOf(Error);
  const events = trace.snapshot(id);
  expect(events.some((event) => event.stage === "status")).toBe(false);
  expect(events.at(-1)?.stage).toBe("requested-cancelled");
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
    trace.recordStatus("run", owner, {
      type: "RUN_STATUS",
      executionId: "run",
      at: i,
      phase: "queued",
      wait: { ahead: 1 },
    });
  trace.record("run", owner, "timeout-unanswered");
  trace.record("run", owner, "late-reply");
  trace.record("run", owner, "late-reply");
  expect(emitted).toHaveLength(34);
  expect(trace.snapshot("run")).toHaveLength(32);
  expect(emitted.at(-2)).toMatchObject({ stage: "timeout-unanswered", phase: "queued", ahead: 1 });
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
    const { bridge, link, trace, sent, socket, receive } = await connectedBridge();
    const controller = new AbortController();
    const result = bridge
      .submitRun(
        link,
        {
          type: "EXECUTE_CODE",
          intent: "Test run",
          session: TEST_SESSION_REQUEST,
          documentId: TEST_DOCUMENT.documentId,
          code: "",
          preamble: "",
        },
        mintExecutionId(),
        { signal: controller.signal },
      )
      .catch((error) => error);
    const id = sent[0].id!;
    receive(running(id, "figma.setCurrentPageAsync"));
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
    // Past PLUGIN_ANSWER_MS: a caller's cancel waits that long for the plugin's answer.
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    const events = trace.snapshot(id);
    expect(events.at(-1)).toMatchObject({
      stage,
      phase: "running",
      operation: "figma.setCurrentPageAsync",
    });
    expect(events.some((event) => event.stage.startsWith("timeout"))).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/secret|private/);
    expect(sent.filter((frame) => frame.type === "EXECUTE_CODE")).toHaveLength(1);
  },
);

test("execution error result is traced as error without changing successful envelope delivery", async () => {
  vi.useFakeTimers();
  vi.spyOn(Logger, "log").mockImplementation(() => {});
  const { bridge, link, trace, sent, receive } = await connectedBridge();
  const result = bridge.submitRun(
    link,
    {
      type: "EXECUTE_CODE",
      intent: "Test run",
      session: TEST_SESSION_REQUEST,
      documentId: TEST_DOCUMENT.documentId,
      code: "",
      preamble: "",
    },
    mintExecutionId(),
  );
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
