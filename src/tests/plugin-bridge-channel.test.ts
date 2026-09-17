import { afterEach, expect, it, vi } from "vitest";
import { PluginBridge, BridgeRequestError } from "~/services/plugin-bridge/bridge.js";
import { ApprovalStore } from "~/services/plugin-bridge/approval-store.js";

class Socket {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  send(raw: string) {
    this.frames.push(JSON.parse(raw));
  }
  terminate() {
    this.readyState = 3;
  }
}
function install(bridge: PluginBridge, socket: Socket) {
  Reflect.set(bridge, "socket", socket);
  Reflect.set(bridge, "compatibility", "compatible");
}
function receive(bridge: PluginBridge, socket: Socket, msg: Record<string, unknown>) {
  Reflect.apply(Reflect.get(bridge, "handleMessage"), bridge, [socket, JSON.stringify(msg)]);
}
const bridges: PluginBridge[] = [];
function create(options: ConstructorParameters<typeof PluginBridge>[1] = {}) {
  const bridge = new PluginBridge(
    new ApprovalStore("/test", "/tmp/execution-test-unused"),
    options,
  );
  bridges.push(bridge);
  return bridge;
}
afterEach(() => {
  for (const b of bridges.splice(0)) b.stop();
  vi.useRealTimers();
});

// A test-only handler proves lifecycle policy without relying on images or their adapter.
async function running(handler: (payload: unknown) => Promise<unknown>, options = {}) {
  const bridge = create({
    capabilities: new Map([["test.only", handler]]),
    requestTimeoutMs: 100,
    runCeilingMs: 1000,
    ...options,
  });
  const socket = new Socket();
  install(bridge, socket);
  const result = bridge.request({ type: "EXECUTE_CODE", code: "x", preamble: "x" }).catch((e) => e);
  await Promise.resolve();
  const runId = socket.frames[0].id;
  const request = (id: string, capability = "test.only", payload: unknown = null) =>
    receive(bridge, socket, { type: "CHANNEL_REQUEST", id, runId, capability, payload });
  return { bridge, socket, runId, result, request };
}

it("refuses unknown names, including prototype names, without invoking any handler", async () => {
  const handler = vi.fn(async (payload: unknown) => payload);
  const h = await running(handler);
  for (const name of ["unknown", "__proto__", "constructor"]) {
    h.request(name, name);
    expect(h.socket.frames.at(-1)).toMatchObject({
      type: "CHANNEL_RESPONSE",
      id: name,
      ok: false,
      error: expect.stringContaining("unknown server capability"),
    });
  }
  expect(handler).not.toHaveBeenCalled();
  h.bridge.stop();
  await h.result;
});

it("suspends until the last service settles, then rearms inactivity; limits concurrent services", async () => {
  vi.useFakeTimers();
  const releases: Array<(payload: unknown) => void> = [];
  const h = await running(() => new Promise((resolve) => releases.push(resolve)));
  for (let i = 0; i < 5; i++) h.request(String(i));
  await vi.advanceTimersByTimeAsync(200);
  expect(releases).toHaveLength(4);
  expect(h.socket.frames.at(-1)).toMatchObject({
    id: "4",
    ok: false,
    error: expect.stringContaining("in flight"),
  });
  // Run-state traffic must not accidentally rearm a suspended clock.
  receive(h.bridge, h.socket, { type: "RUN_STATE", runId: h.runId, phase: "running" });
  releases.slice(0, 3).forEach((resolve) => resolve({ arbitrary: [1, true, null] }));
  await vi.advanceTimersByTimeAsync(200);
  expect(h.socket.frames.some((f) => f.type === "CANCEL")).toBe(false);
  releases[3](42);
  await vi.advanceTimersByTimeAsync(99);
  expect(h.socket.frames.some((f) => f.type === "CANCEL")).toBe(false);
  expect(h.socket.frames.find((f) => f.id === "3")).toMatchObject({
    type: "CHANNEL_RESPONSE",
    ok: true,
    payload: 42,
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(h.socket.frames.at(-1)).toMatchObject({ type: "CANCEL", runId: h.runId });
  receive(h.bridge, h.socket, {
    type: "CANCEL_RESULT",
    runId: h.runId,
    disposition: "was-running",
  });
  expect(await h.result).toBeInstanceOf(BridgeRequestError);
});

it("never suspends the ceiling and refuses both late requests and late service results", async () => {
  vi.useFakeTimers();
  let release!: (payload: unknown) => void;
  const handler = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const h = await running(handler, { runCeilingMs: 300 });
  h.request("first");
  await vi.advanceTimersByTimeAsync(300);
  expect(h.socket.frames.at(-1)).toMatchObject({ type: "CANCEL", runId: h.runId });
  receive(h.bridge, h.socket, {
    type: "CANCEL_RESULT",
    runId: h.runId,
    disposition: "was-running",
  });
  await h.result;
  h.request("late");
  expect(h.socket.frames.at(-1)).toMatchObject({
    id: "late",
    ok: false,
    error: expect.stringContaining("no longer active"),
  });
  release("must not resume");
  await vi.advanceTimersByTimeAsync(0);
  expect(h.socket.frames.at(-1)).toMatchObject({
    id: "first",
    ok: false,
    error: expect.stringContaining("withheld"),
  });
  expect(handler).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "normalizes handler failures and rearms the deadline (async=%s)",
  async (asynchronous) => {
    vi.useFakeTimers();
    const h = await running(() => {
      if (asynchronous) return Promise.reject(new Error("failure"));
      throw new Error("failure");
    });
    h.request("failure");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.socket.frames.at(-1)).toMatchObject({
      type: "CHANNEL_RESPONSE",
      id: "failure",
      ok: false,
      error: "failure",
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.socket.frames.at(-1)).toMatchObject({ type: "CANCEL" });
    h.bridge.stop();
    await h.result;
  },
);
