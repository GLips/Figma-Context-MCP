import vm from "node:vm";
import { buildSync } from "esbuild";
import { createWarningRegistry } from "../../plugin/src/preamble/warnings.js";
import { afterEach, expect, it, vi } from "vitest";
import { PluginBridge, BridgeRequestError } from "~/services/plugin-bridge/bridge.js";
import { ApprovalStore } from "~/services/plugin-bridge/approval-store.js";

class Socket {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  forward?: (frame: Record<string, unknown>) => void;
  send(raw: string) {
    const frame = JSON.parse(raw);
    this.frames.push(frame);
    this.forward?.(frame);
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
async function running(
  handler: (payload: unknown, context: { signal: AbortSignal }) => Promise<unknown>,
  options = {},
) {
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
      error: { message: expect.stringContaining("unknown server capability") },
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
    error: { message: expect.stringContaining("in flight") },
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
    error: { message: expect.stringContaining("no longer active") },
  });
  release("must not resume");
  await vi.advanceTimersByTimeAsync(0);
  expect(h.socket.frames.at(-1)).toMatchObject({
    id: "first",
    ok: false,
    error: { message: expect.stringContaining("withheld") },
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
      error: { code: "COMPUTATION_FAILED", message: "failure" },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.socket.frames.at(-1)).toMatchObject({ type: "CANCEL" });
    h.bridge.stop();
    await h.result;
  },
);

it("accepts a deeply nested raw payload without reserializing the request", async () => {
  const handler = vi.fn(async () => "processed");
  const h = await running(handler);
  const raw = `{"type":"CHANNEL_REQUEST","id":"deep","runId":${JSON.stringify(h.runId)},"capability":"test.only","payload":${"[".repeat(10000)}0${"]".repeat(10000)}}`;
  expect(Buffer.byteLength(raw)).toBeLessThan(21000);
  expect(() =>
    Reflect.apply(Reflect.get(h.bridge, "handleMessage"), h.bridge, [h.socket, raw]),
  ).not.toThrow();
  await new Promise((resolve) => setImmediate(resolve));
  expect(handler).toHaveBeenCalledOnce();
  expect(h.socket.frames.at(-1)).toMatchObject({ id: "deep", ok: true, payload: "processed" });
  h.bridge.stop();
  await h.result;
});

it("contains malformed envelope and synchronous dispatch failures at the message boundary", async () => {
  const h = await running(async () => null);
  for (const raw of ["null", "[]", "42", "{"]) {
    expect(() =>
      Reflect.apply(Reflect.get(h.bridge, "handleMessage"), h.bridge, [h.socket, raw]),
    ).not.toThrow();
  }
  const dispatch = Reflect.get(h.bridge, "serveChannelRequest");
  Reflect.set(h.bridge, "serveChannelRequest", () => {
    throw new RangeError("validation failure");
  });
  expect(() => h.request("bad")).not.toThrow();
  Reflect.set(h.bridge, "serveChannelRequest", dispatch);
  h.request("good");
  await new Promise((resolve) => setImmediate(resolve));
  expect(h.socket.frames.at(-1)).toMatchObject({ id: "good", ok: true });
  h.bridge.stop();
  await h.result;
});

it.each(["cancel", "complete", "disconnect"])(
  "%s aborts handler work and retains accounting until cleanup settles",
  async (end) => {
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalSeen: AbortSignal | undefined;
    let stopped = false;
    // The delayed cleanup models work that cannot immediately release its resources.
    const h = await running(async (_payload, { signal }) => {
      signalSeen = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            resolve();
          },
          { once: true },
        ),
      );
      await cleanup;
      return "late";
    });
    h.request("work");
    await new Promise((resolve) => setImmediate(resolve));
    expect(signalSeen?.aborted).toBe(false);
    if (end === "complete")
      receive(h.bridge, h.socket, { type: "EXECUTE_CODE_RESULT", id: h.runId });
    else if (end === "disconnect") h.bridge.stop();
    else {
      Reflect.apply(Reflect.get(h.bridge, "cancelPending"), h.bridge, [
        h.runId,
        "caller cancelled",
      ]);
      receive(h.bridge, h.socket, {
        type: "CANCEL_RESULT",
        runId: h.runId,
        disposition: "was-running",
      });
    }
    await h.result;
    expect(stopped).toBe(true);
    expect(signalSeen?.aborted).toBe(true);
    const accounting = Reflect.get(h.bridge, "inFlightServices") as Map<string, number>;
    expect(accounting.get(h.runId as string)).toBe(1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(accounting.has(h.runId as string)).toBe(false);
    expect(h.socket.frames.some((f) => f.id === "work" && f.ok === true)).toBe(false);
  },
);

it.each([false, true])(
  "structured failure survives server, JSON wire, installed host and preamble (Error=%s)",
  async (asError) => {
    const failure = {
      code: "DENIED",
      message: "not allowed",
      details: { nested: [null, { permissions: ["read", false] }] },
      retry: { after: 3 },
    };
    const request = { arbitrary: [1, { bytes: "AA==", options: null }], version: 19 };
    const handler = vi.fn(async (_payload: unknown) => {
      throw asError ? Object.assign(new Error(failure.message), failure) : failure;
    });
    const bridge = create({ capabilities: new Map([["test.future.v19", handler]]) });
    const socket = new Socket();
    install(bridge, socket);
    const figma = {
      showUI() {},
      notify() {},
      currentPage: { name: "test" },
      clientStorage: { getAsync: async () => [], setAsync: async () => {} },
      ui: {
        resize() {},
        onmessage: (_msg: Record<string, unknown>) => {},
        postMessage: (msg: Record<string, unknown>) => receive(bridge, socket, msg),
      },
    };
    const code = buildSync({
      entryPoints: [new URL("../../plugin/src/code.ts", import.meta.url).pathname],
      bundle: true,
      write: false,
      format: "iife",
      logLevel: "silent",
    }).outputFiles[0].text;
    vm.runInContext(
      code,
      vm.createContext({
        figma,
        createWarningRegistry,
        __html__: "",
        console: { ...console },
        setTimeout,
      }),
    );
    // The ordinary UI connection envelope is reproduced after a JSON round trip in Socket.send.
    socket.forward = (frame) => figma.ui.onmessage({ ...frame, __connKey: 1 });
    figma.ui.onmessage({ type: "WS_CONNECTED", __connKey: 1 });
    figma.ui.onmessage({ type: "SESSION_INFO", id: "session", identity: "test", __connKey: 1 });
    figma.ui.onmessage({ type: "UI_DECISION", approve: true, __connKey: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    const result = (await bridge.request({
      type: "EXECUTE_CODE",
      // Only this test's server/preamble knows the capability. No image-shaped fields or host edits.
      preamble: `(host) => ({ flcm: { test: payload => host.callServer("test.future.v19", payload) }, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0 })`,
      code: `try { await flcm.test(${JSON.stringify(request)}); } catch (error) { return JSON.stringify({ detail: error.detail, message: error.message }); }`,
    })) as { result: string; errors: string | null };
    expect(result.errors).toBeNull();
    expect(handler.mock.calls[0]?.[0]).toEqual(request);
    expect(JSON.parse(result.result)).toEqual({ detail: failure, message: failure.message });
    expect(socket.frames.find((f) => f.type === "CHANNEL_RESPONSE")).toMatchObject({
      ok: false,
      error: failure,
    });
  },
);

it("rejects oversized raw frames before JSON.parse, including whitespace lost by reserialization", () => {
  const bridge = create();
  const socket = new Socket();
  install(bridge, socket);
  const raw = '{"type":"CHANNEL_REQUEST"}' + " ".repeat(100 * 1024 * 1024);
  const parse = vi.spyOn(JSON, "parse");
  try {
    Reflect.apply(Reflect.get(bridge, "handleMessage"), bridge, [socket, raw]);
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

it.each([false, true])(
  "unencodable handler output produces a structured refusal (failure=%s)",
  async (failure) => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const h = await running(async () => {
      if (failure) throw { code: "CUSTOM", details: cyclic };
      return cyclic;
    });
    h.request("cyclic");
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.socket.frames.at(-1)).toMatchObject({
      id: "cyclic",
      ok: false,
      error: { code: "SERIALIZATION_FAILED" },
    });
    h.bridge.stop();
    await h.result;
  },
);
