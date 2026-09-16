import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("connection-owned execution", () => {
  it("uses globally unique IDs and ignores old replies and old approval controls", async () => {
    const bridge = create();
    const old = new Socket();
    install(bridge, old);
    const oldCall = bridge.request({ type: "PING", payload: "old" }).catch(() => {});
    const next = new Socket();
    install(bridge, next);
    const newCall = bridge.request({ type: "PING", payload: "new" });
    const id = next.frames[0].id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(id).not.toBe(old.frames[0].id);
    receive(bridge, old, { id, type: "PONG", echo: "OLD_BODY" });
    receive(bridge, old, { type: "SESSION_TOKEN", sessionToken: "old-token" });
    expect(bridge.getSessionToken()).toBeNull();
    receive(bridge, next, { id, type: "PONG", echo: "NEW_BODY" });
    expect(await newCall).toMatchObject({ echo: "NEW_BODY" });
    bridge.stop();
    await oldCall;
  });
  it("cancels on the originating socket and hedges only when nothing answers the cancellation", async () => {
    vi.useFakeTimers();
    const bridge = create({ requestTimeoutMs: 100 });
    const old = new Socket();
    install(bridge, old);
    const call = bridge
      .request({ type: "EXECUTE_CODE", code: "x", preamble: "x" })
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = old.frames[0].id as string;
    // Submitted, never acknowledged: the inactivity deadline still covers a plugin that says nothing.
    const next = new Socket();
    install(bridge, next);
    await vi.advanceTimersByTimeAsync(100);
    expect(old.frames.at(-1)).toMatchObject({ type: "CANCEL", runId: id });
    // The displaced socket may not narrate the current connection's runs, so this answer is ignored
    // and the caller falls back to the hedge — the one case where "unconfirmed" is the true word.
    receive(bridge, old, { type: "CANCEL_RESULT", runId: id, disposition: "never-executed" });
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await call;
    expect(error).toBeInstanceOf(BridgeRequestError);
    expect(error).toMatchObject({ outcome: "unconfirmed", phase: "submitted" });
    expect(String(error)).toContain("did not confirm what became of the run");
    expect(next.frames).toEqual([]);
  });
  it("leaves a queued run to the run ceiling and rejects it as never executed", async () => {
    vi.useFakeTimers();
    const bridge = create({ requestTimeoutMs: 100, runCeilingMs: 600 });
    const socket = new Socket();
    install(bridge, socket);
    const call = bridge
      .request({ type: "EXECUTE_CODE", code: "x", preamble: "x" })
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    receive(bridge, socket, { type: "RUN_STATE", runId: id, phase: "queued" });
    // Five times the inactivity deadline: a run waiting behind another one is not silence.
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.frames.some((f) => f.type === "CANCEL")).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(socket.frames.at(-1)).toMatchObject({ type: "CANCEL", runId: id });
    receive(bridge, socket, { type: "CANCEL_RESULT", runId: id, disposition: "never-executed" });
    const error = await call;
    expect(error).toMatchObject({ outcome: "not-submitted", phase: "queued" });
    expect(String(error)).toContain("run ceiling");
    expect(String(error)).toContain("never executed");
  });
  it("deadlines a running run on inactivity and reports that its writes may have landed", async () => {
    vi.useFakeTimers();
    const bridge = create({ requestTimeoutMs: 100 });
    const socket = new Socket();
    install(bridge, socket);
    const call = bridge
      .request({ type: "EXECUTE_CODE", code: "x", preamble: "x" })
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    receive(bridge, socket, { type: "RUN_STATE", runId: id, phase: "queued" });
    receive(bridge, socket, { type: "RUN_STATE", runId: id, phase: "running" });
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.frames.at(-1)).toMatchObject({ type: "CANCEL", runId: id });
    receive(bridge, socket, { type: "CANCEL_RESULT", runId: id, disposition: "was-running" });
    const error = await call;
    expect(error).toMatchObject({ outcome: "unconfirmed", phase: "running" });
    expect(String(error)).toContain("was executing when it was cancelled");
  });
  it("caller abort removes tracking, sends one cancellation, and never submits through a cancelled handshake hold", async () => {
    const bridge = create();
    const socket = new Socket();
    install(bridge, socket);
    const abort = new AbortController();
    const call = bridge
      .request({ type: "PING", payload: "x" }, abort.signal)
      .catch((e: unknown) => e);
    abort.abort();
    expect(await call).toMatchObject({ outcome: "unconfirmed" });
    expect(socket.frames.filter((f) => f.type === "CANCEL")).toHaveLength(1);
    Reflect.set(bridge, "compatibility", "checking");
    Reflect.set(bridge, "verdictSettled", new Promise(() => {}));
    const held = new AbortController();
    const hold = bridge
      .request({ type: "EXECUTE_CODE", code: "x", preamble: "x" }, held.signal)
      .catch((e: unknown) => e);
    held.abort(new Error("abandoned"));
    expect(String(await hold)).toContain("abandoned");
    expect(socket.frames.some((f) => f.type === "EXECUTE_CODE")).toBe(false);
  });
  it("withholds an old image service after replacement and leaves new run accounting intact", async () => {
    let release!: (images: Record<string, string>) => void;
    const bridge = create({
      imagesRequestHandler: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    const old = new Socket();
    install(bridge, old);
    const oldCall = bridge
      .request({ type: "EXECUTE_CODE", code: "old", preamble: "x" })
      .catch(() => {});
    await Promise.resolve();
    receive(bridge, old, {
      type: "IMAGES_REQUEST",
      id: "image",
      runId: old.frames[0].id,
      urls: ["x"],
    });
    const next = new Socket();
    install(bridge, next);
    const newCall = bridge.request({ type: "PING", payload: "new" });
    release({ x: "old bytes" });
    await Promise.resolve();
    await Promise.resolve();
    expect(next.frames).toHaveLength(1);
    receive(bridge, next, { id: next.frames[0].id, type: "PONG", echo: "new" });
    expect(await newCall).toMatchObject({ echo: "new" });
    bridge.stop();
    await oldCall;
  });
});
