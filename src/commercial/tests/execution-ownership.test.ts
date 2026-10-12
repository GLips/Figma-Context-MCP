/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginBridge, BridgeRequestError } from "~/commercial/plugin-bridge/bridge.js";
import { ApprovalStore } from "~/commercial/plugin-bridge/approval-store.js";
import { RUN_INACTIVITY_DEADLINE_MS } from "@framelink/plugin/protocol";
import { connectFakePlugin } from "./fixtures/fake-plugin-socket.js";

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
  it("uses globally unique IDs, fails a replaced connection's runs, and ignores its replies and approval controls", async () => {
    const bridge = create();
    const old = await connectFakePlugin(bridge);
    const oldCall = bridge.request({ type: "PING", payload: "old" }).catch((e: unknown) => e);
    const next = await connectFakePlugin(bridge);
    const newCall = bridge.request({ type: "PING", payload: "new" });
    const id = next.frames[0].id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(id).not.toBe(old.frames[0].id);
    expect(await oldCall).toMatchObject({ outcome: "unconfirmed" });
    expect(String(await oldCall)).toContain("Figma connection replaced");
    old.receive({ id, type: "PONG", echo: "OLD_BODY" });
    old.receive({ type: "SESSION_TOKEN", sessionToken: "oldsessiontoken000000" });
    expect(bridge.approvedSession()).toBeNull();
    next.receive({ id, type: "PONG", echo: "NEW_BODY" });
    expect(await newCall).toMatchObject({ echo: "NEW_BODY" });
  });
  it("hedges only when nothing answers the cancellation", async () => {
    vi.useFakeTimers();
    const bridge = create({ requestTimeoutMs: 100 });
    const socket = await connectFakePlugin(bridge);
    const call = bridge
      .request({ type: "EXECUTE_CODE", code: "x", preamble: "x", lateChangeWindowMs: 60_000 })
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    // Submitted, never acknowledged: the inactivity deadline still covers a plugin that says nothing.
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.frames.at(-1)).toMatchObject({ type: "CANCEL", runId: id });
    // Nothing answers the cancellation — the one case where "unconfirmed" is the true word.
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await call;
    expect(error).toBeInstanceOf(BridgeRequestError);
    expect(error).toMatchObject({ outcome: "unconfirmed", phase: "submitted" });
    expect(String(error)).toContain("did not confirm what became of the run");
  });
  it("leaves a queued run to the run ceiling and rejects it as never executed", async () => {
    vi.useFakeTimers();
    const bridge = create({ requestTimeoutMs: 100, runCeilingMs: 600 });
    const socket = await connectFakePlugin(bridge);
    const call = bridge
      .request({ type: "EXECUTE_CODE", code: "x", preamble: "x", lateChangeWindowMs: 60_000 })
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    socket.receive({ type: "RUN_STATE", runId: id, phase: "queued", at: Date.now() });
    // Five times the inactivity deadline: a run waiting behind another one is not silence.
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.frames.some((f) => f.type === "CANCEL")).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(socket.frames.at(-1)).toMatchObject({ type: "CANCEL", runId: id });
    socket.receive({ type: "CANCEL_RESULT", runId: id, disposition: "never-executed" });
    const error = await call;
    expect(error).toMatchObject({ outcome: "not-submitted", phase: "queued" });
    expect(String(error)).toContain("run ceiling");
    expect(String(error)).toContain("never executed");
  });
  it("deadlines a running run on inactivity and reports that its writes may have landed", async () => {
    vi.useFakeTimers();
    const bridge = create({ requestTimeoutMs: 100 });
    const socket = await connectFakePlugin(bridge);
    const call = bridge
      .request({ type: "EXECUTE_CODE", code: "x", preamble: "x", lateChangeWindowMs: 60_000 })
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    socket.receive({ type: "RUN_STATE", runId: id, phase: "queued", at: Date.now() });
    socket.receive({ type: "RUN_STATE", runId: id, phase: "running", at: Date.now() });
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.frames.at(-1)).toMatchObject({ type: "CANCEL", runId: id });
    socket.receive({ type: "CANCEL_RESULT", runId: id, disposition: "was-running" });
    const error = await call;
    expect(error).toMatchObject({ outcome: "unconfirmed", phase: "running" });
    expect(String(error)).toContain("was executing when it was cancelled");
  });
  // The plugin's RUN_STATE leaves only once its thread goes idle, so a run that opens with synchronous
  // work announces "running" late. Both clocks count from the stamp, so the server cancels exactly when
  // the run's own copy of the deadline starts refusing writes.
  it("counts a late-delivered running from the plugin's stamp, in step with the run's own clock", async () => {
    vi.useFakeTimers();
    const bridge = create();
    const socket = await connectFakePlugin(bridge);
    const call = bridge
      .request({ type: "EXECUTE_CODE", code: "x", preamble: "x", lateChangeWindowMs: 60_000 })
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    const runStartedAt = Date.now();
    const heldThreadMs = 6_000;
    await vi.advanceTimersByTimeAsync(heldThreadMs);
    socket.receive({ type: "RUN_STATE", runId: id, phase: "queued", at: runStartedAt });
    socket.receive({ type: "RUN_STATE", runId: id, phase: "running", at: runStartedAt });
    const cancelled = () => socket.frames.some((f) => f.type === "CANCEL");
    // The run's own clock, with no server call in flight: the plugin refuses writes from here.
    const runDeadlinePassed = () => Date.now() - runStartedAt >= RUN_INACTIVITY_DEADLINE_MS;
    await vi.advanceTimersByTimeAsync(RUN_INACTIVITY_DEADLINE_MS - heldThreadMs - 1);
    expect([cancelled(), runDeadlinePassed()]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1);
    expect([cancelled(), runDeadlinePassed()]).toEqual([true, true]);
    socket.receive({ type: "CANCEL_RESULT", runId: id, disposition: "was-running" });
    expect(await call).toMatchObject({ phase: "running" });
  });
  it("caller abort removes tracking, sends one cancellation, and never submits through a cancelled handshake hold", async () => {
    const bridge = create();
    const socket = await connectFakePlugin(bridge);
    const abort = new AbortController();
    const call = bridge
      .request({ type: "PING", payload: "x" }, abort.signal)
      .catch((e: unknown) => e);
    abort.abort();
    expect(await call).toMatchObject({ outcome: "unconfirmed" });
    expect(socket.frames.filter((f) => f.type === "CANCEL")).toHaveLength(1);
    // A connection that never answers its version handshake: the request holds for a verdict.
    const silent = await connectFakePlugin(bridge, { answersVersion: false });
    const held = new AbortController();
    const hold = bridge
      .request(
        { type: "EXECUTE_CODE", code: "x", preamble: "x", lateChangeWindowMs: 60_000 },
        held.signal,
      )
      .catch((e: unknown) => e);
    held.abort(new Error("abandoned"));
    expect(String(await hold)).toContain("abandoned");
    expect(silent.frames.some((f) => f.type === "EXECUTE_CODE")).toBe(false);
  });
  it("withholds an old image service after replacement and leaves new run accounting intact", async () => {
    let release!: (images: Record<string, string>) => void;
    const bridge = create({
      capabilities: new Map([
        [
          "images.fetch",
          () =>
            new Promise((r) => {
              release = r;
            }),
        ],
      ]),
    });
    const old = await connectFakePlugin(bridge);
    const oldCall = bridge
      .request({ type: "EXECUTE_CODE", code: "old", preamble: "x", lateChangeWindowMs: 60_000 })
      .catch(() => {});
    await Promise.resolve();
    old.receive({
      type: "CHANNEL_REQUEST",
      capability: "images.fetch",
      id: "image",
      runId: old.frames[0].id,
      payload: ["x"],
    });
    await Promise.resolve();
    const next = await connectFakePlugin(bridge);
    const newCall = bridge.request({ type: "PING", payload: "new" });
    release({ x: "old bytes" });
    await Promise.resolve();
    await Promise.resolve();
    expect(next.frames).toHaveLength(1);
    next.receive({ id: next.frames[0].id, type: "PONG", echo: "new" });
    expect(await newCall).toMatchObject({ echo: "new" });
    bridge.stop();
    await oldCall;
  });
});
