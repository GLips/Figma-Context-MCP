/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import vm from "node:vm";
import { buildSync } from "esbuild";
import { createWarningRegistry } from "../../../plugin/src/preamble/warnings.js";
import { afterEach, expect, it, vi } from "vitest";
import { PluginBridge, BridgeRequestError } from "~/commercial/plugin-bridge/bridge.js";
import type { FigmaService } from "~/services/figma.js";
import { figmaFileKey } from "~/utils/figma-url.js";
import { connectFakePlugin } from "./fixtures/fake-plugin-socket.js";
import { TEST_DOCUMENT, TEST_SESSION_REQUEST } from "./fixtures/write-access.js";
import { mintExecutionId } from "~/commercial/execution-id.js";

const bridges: PluginBridge[] = [];
function create(options: ConstructorParameters<typeof PluginBridge>[0] = {}) {
  const bridge = new PluginBridge(options);
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
  signal?: AbortSignal,
) {
  const bridge = create({
    capabilities: new Map([["test.only", handler]]),
    requestTimeoutMs: 100,
    runCeilingMs: 1000,
    ...options,
  });
  const socket = await connectFakePlugin(bridge);
  const result = bridge
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
      { signal },
    )
    .catch((e) => e);
  await Promise.resolve();
  const executionId = socket.frames[0].id;
  const request = (id: string, capability = "test.only", payload: unknown = null) =>
    socket.receive({ type: "CHANNEL_REQUEST", id, executionId, capability, payload });
  return { bridge, socket, executionId, result, request };
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
  h.socket.receive({
    type: "RUN_STATE",
    executionId: h.executionId,
    phase: "running",
    at: Date.now(),
  });
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
  expect(h.socket.frames.at(-1)).toMatchObject({ type: "CANCEL", executionId: h.executionId });
  h.socket.receive({
    type: "CANCEL_RESULT",
    executionId: h.executionId,
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
  expect(h.socket.frames.at(-1)).toMatchObject({ type: "CANCEL", executionId: h.executionId });
  h.socket.receive({
    type: "CANCEL_RESULT",
    executionId: h.executionId,
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
  const raw = `{"type":"CHANNEL_REQUEST","id":"deep","executionId":${JSON.stringify(h.executionId)},"capability":"test.only","payload":${"[".repeat(10000)}0${"]".repeat(10000)}}`;
  expect(Buffer.byteLength(raw)).toBeLessThan(21000);
  expect(() => h.socket.receiveRaw(raw)).not.toThrow();
  await new Promise((resolve) => setImmediate(resolve));
  expect(handler).toHaveBeenCalledOnce();
  expect(h.socket.frames.at(-1)).toMatchObject({ id: "deep", ok: true, payload: "processed" });
  h.bridge.stop();
  await h.result;
});

it("contains malformed envelopes at the message boundary", async () => {
  const h = await running(async () => null);
  for (const raw of ["null", "[]", "42", "{"]) expect(() => h.socket.receiveRaw(raw)).not.toThrow();
  h.request("good");
  await new Promise((resolve) => setImmediate(resolve));
  expect(h.socket.frames.at(-1)).toMatchObject({ id: "good", ok: true });
  h.bridge.stop();
  await h.result;
});

it.each(["cancel", "complete", "shutdown"])(
  "%s aborts handler work and withholds its late result",
  async (end) => {
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalSeen: AbortSignal | undefined;
    let stopped = false;
    const caller = new AbortController();
    // The delayed cleanup models work that cannot immediately release its resources.
    const h = await running(
      async (_payload, { signal }) => {
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
      },
      {},
      caller.signal,
    );
    h.request("work");
    await new Promise((resolve) => setImmediate(resolve));
    expect(signalSeen?.aborted).toBe(false);
    if (end === "complete") h.socket.receive({ type: "EXECUTE_CODE_RESULT", id: h.executionId });
    else if (end === "shutdown") h.bridge.stop();
    else {
      caller.abort(new Error("caller cancelled"));
      h.socket.receive({
        type: "CANCEL_RESULT",
        executionId: h.executionId,
        disposition: "was-running",
      });
    }
    await h.result;
    expect(stopped).toBe(true);
    expect(signalSeen?.aborted).toBe(true);
    release();
    await new Promise((resolve) => setImmediate(resolve));
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
    const socket = await connectFakePlugin(bridge);
    // The page and change-event registration the host meters every run by (document-changes.ts).
    const page = { id: "0:1", name: "test", on() {}, off() {} };
    // The plugin is driven through pairing, its stamp and Allow directly: its replies settle these
    // waiters, never a count of event-loop turns, since the host stores and replies asynchronously.
    const credential = { id: "credential-id-1", secret: "secret-0123456789abcdef" };
    const storage = new Map<string, unknown>([
      ["code-mode:link-credential:" + credential.id, credential.secret],
    ]);
    const pluginData = new Map<string, string>();
    const waiters: Array<(frame: Record<string, unknown>) => boolean> = [];
    const awaitFrame = (match: (frame: Record<string, unknown>) => boolean) =>
      new Promise<void>((resolve) =>
        waiters.push((frame) => (match(frame) ? (resolve(), true) : false)),
      );
    const figma = {
      showUI() {},
      notify() {},
      // Grants belong to a signed-in Figma user.
      currentUser: { id: "figma-user-1", name: "Test" },
      currentPage: page,
      root: {
        name: "Fake file",
        children: [page],
        getPluginData: (key: string) => pluginData.get(key) ?? "",
        setPluginData: (key: string, value: string) => void pluginData.set(key, value),
      },
      on() {},
      off() {},
      clientStorage: {
        getAsync: async (key: string) => storage.get(key),
        setAsync: async (key: string, value: unknown) => void storage.set(key, value),
        deleteAsync: async (key: string) => void storage.delete(key),
        keysAsync: async () => [...storage.keys()],
      },
      ui: {
        resize() {},
        onmessage: (_msg: Record<string, unknown>) => {},
        postMessage: (msg: { to: string; frame?: Record<string, unknown> }) => {
          if (msg.to !== "server" || !msg.frame) return;
          const frame = msg.frame;
          for (const waiter of [...waiters])
            if (waiter(frame)) waiters.splice(waiters.indexOf(waiter), 1);
          // Only run traffic reaches the bridge: the bridge already authenticated this fake socket.
          const setup = ["LINK_PROOF", "INTRODUCED", "DOCUMENT_REPORTED", "GRANT", "GRANT_CHANGED"];
          if (!setup.includes(String(frame.type))) socket.receive(frame);
        },
      },
    };
    const code = buildSync({
      entryPoints: [new URL("../../../plugin/src/code.ts", import.meta.url).pathname],
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
        clearTimeout,
        setInterval: (callback: () => void, ms: number) => setInterval(callback, ms).unref(),
      }),
    );
    // The relay's two envelopes: server frames (after a JSON round trip in the fake socket) and panel input.
    socket.onFrame = (frame) => figma.ui.onmessage({ from: "server", connKey: 1, frame });
    const panel = (control: Record<string, unknown>) =>
      figma.ui.onmessage({ from: "panel", control: { ...control, connKey: 1 } });
    const ask = async (request: Record<string, unknown>) => {
      const replied = awaitFrame((frame) => frame.id === request.id);
      figma.ui.onmessage({ from: "server", connKey: 1, frame: request });
      await replied;
    };
    panel({ type: "WS_CONNECTED" });
    await ask({
      type: "AUTHENTICATE",
      id: "auth",
      credentialId: credential.id,
      nonce: "nonce-1-0000",
    });
    await ask({
      type: "INTRODUCE",
      id: "intro",
      project: "/proj",
      framelinkOrigin: "https://app.framelink.ai",
    });
    // The plugin stamped its file on start; the call's Allow prompt binds to that stamp.
    const documentId = [...pluginData.values()][0];
    const executionId = mintExecutionId();
    await ask({
      type: "GRANT_STATUS",
      id: "status",
      executionId,
      documentId,
      prompt: "allow",
      intent: "Test run",
    });
    const granted = awaitFrame((frame) => frame.type === "GRANT_CHANGED");
    panel({ type: "UI_DECISION", approve: true, executionId, documentId });
    await granted;
    const result = (await bridge.submitRun(
      socket.link,
      {
        type: "EXECUTE_CODE",
        intent: "Test run",
        session: TEST_SESSION_REQUEST,
        documentId,
        lateChangeWindowMs: 60_000,
        // Only this test's server/preamble knows the capability. No image-shaped fields or host edits.
        preamble: `(host) => ({ flcm: { test: payload => host.callServer("test.future.v19", payload) }, session: host.getSession(() => ({})), warnings: createWarningRegistry(), mutationQueueIdle: async () => 0, committedVerbCount: () => 0, projectForEgress: (value) => value })`,
        code: `try { await flcm.test(${JSON.stringify(request)}); } catch (error) { return JSON.stringify({ detail: error.detail, message: error.message }); }`,
      },
      executionId,
    )) as { result: string; errors: string | null };
    expect(result.errors).toBeNull();
    expect(handler.mock.calls[0]?.[0]).toEqual(request);
    expect(JSON.parse(result.result)).toEqual({ detail: failure, message: failure.message });
    expect(socket.frames.find((f) => f.type === "CHANNEL_RESPONSE")).toMatchObject({
      ok: false,
      error: failure,
    });
  },
);

it("rejects oversized raw frames before JSON.parse, including whitespace lost by reserialization", async () => {
  const bridge = create();
  const socket = await connectFakePlugin(bridge);
  const raw = '{"type":"CHANNEL_REQUEST"}' + " ".repeat(100 * 1024 * 1024);
  const parse = vi.spyOn(JSON, "parse");
  try {
    socket.receiveRaw(raw);
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

it.each(["code", "message"])(
  "failure %s getter is snapshotted once before validation",
  async (field) => {
    let reads = 0;
    const failure = { code: "CUSTOM", message: "keep me" };
    Object.defineProperty(failure, field, {
      enumerable: true,
      get: () => (++reads <= 2 ? "snapshot" : 42),
    });
    const h = await running(async () => {
      throw failure;
    });
    h.request("getter");
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.socket.frames.at(-1)).toMatchObject({ ok: false, error: { [field]: "snapshot" } });
    expect(reads).toBe(1);
    h.bridge.stop();
    await h.result;
  },
);

it.each(["root", "nested"])(
  "failure rejects %s serialization hooks without invoking them",
  async (location) => {
    const hook = vi.fn(() => ({ lost: true }));
    const failure = {
      code: "CUSTOM",
      message: "keep me",
      ...(location === "root" ? { toJSON: hook } : { details: { toJSON: hook } }),
    };
    const h = await running(async () => {
      throw failure;
    });
    h.request("hook");
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.socket.frames.at(-1)).toMatchObject({
      ok: false,
      error: { code: "SERIALIZATION_FAILED" },
    });
    expect(hook).not.toHaveBeenCalled();
    h.bridge.stop();
    await h.result;
  },
);

// Strictness here is the contract, not an oversight: JSON.stringify would quietly drop `undefined`
// and coerce NaN to null, so a capability could ship a field the plugin never sees. Refusing the
// whole envelope is louder, and SERIALIZATION_FAILED still carries string code and message.
it.each([
  ["undefined field", { details: undefined }],
  ["non-finite number", { attempts: NaN }],
  ["enumerable nested Error", { cause: new Error("inner") }],
])("failure refuses a %s rather than silently dropping it", async (_label, extra) => {
  const h = await running(async () => {
    throw { code: "CUSTOM", message: "keep me", ...extra };
  });
  h.request("unrepresentable");
  await new Promise((resolve) => setImmediate(resolve));
  expect(h.socket.frames.at(-1)).toMatchObject({
    ok: false,
    error: { code: "SERIALIZATION_FAILED" },
  });
  h.bridge.stop();
  await h.result;
});

it("failure snapshots shared nested getters once and preserves JSON fields named toJSON", async () => {
  let reads = 0;
  const shared = {
    get value() {
      reads++;
      return [null, true, { toJSON: "data" }];
    },
  };
  const h = await running(async () => {
    throw { code: "CUSTOM", message: "keep me", details: [shared, shared] };
  });
  h.request("shared");
  await new Promise((resolve) => setImmediate(resolve));
  expect(h.socket.frames.at(-1)).toMatchObject({
    ok: false,
    error: {
      code: "CUSTOM",
      message: "keep me",
      details: [
        { value: [null, true, { toJSON: "data" }] },
        { value: [null, true, { toJSON: "data" }] },
      ],
    },
  });
  expect(reads).toBe(1);
  h.bridge.stop();
  await h.result;
});

it("hands each channel request the credentials of the request that started its run", async () => {
  const seen: unknown[] = [];
  const bridge = create({
    capabilities: new Map([["test.who", async (_payload, { run }) => void seen.push(run.figma)]]),
  });
  const socket = await connectFakePlugin(bridge);
  const alice = { user: "alice" } as unknown as FigmaService;
  const bob = { user: "bob" } as unknown as FigmaService;
  const runs = [alice, bob].map((figma) =>
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
        {
          runContext: {
            figma,
            fileKey: figmaFileKey("FAKEfile1"),
            uploadHandles: new Set(),
            readLocalImage: null,
          },
        },
      )
      .catch((e) => e),
  );
  await Promise.resolve();
  const [aliceRun, bobRun] = socket.frames.map((frame) => frame.id);
  for (const executionId of [bobRun, aliceRun])
    socket.receive({
      type: "CHANNEL_REQUEST",
      id: `q-${executionId}`,
      executionId,
      capability: "test.who",
    });
  await vi.waitFor(() => expect(seen).toEqual([bob, alice]));
  bridge.stop();
  await Promise.all(runs);
});
