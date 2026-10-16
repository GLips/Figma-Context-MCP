/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginBridge, BridgeRequestError } from "~/commercial/plugin-bridge/bridge.js";
import { RUN_INACTIVITY_DEADLINE_MS } from "@framelink/plugin/protocol";
import { connectFakePlugin } from "./fixtures/fake-plugin-socket.js";
import { TEST_SESSION_REQUEST } from "./fixtures/write-access.js";
import { mintExecutionId } from "~/commercial/plugin-bridge/execution-id.js";

const bridges: PluginBridge[] = [];
// A request with a trivial reply, for tests about the ledger rather than the payload.
const introduce = () => ({ type: "GRANT_STATUS" as const, fileKey: null, prompt: "none" as const });

function create(options: ConstructorParameters<typeof PluginBridge>[0] = {}) {
  const bridge = new PluginBridge(options);
  bridges.push(bridge);
  return bridge;
}
afterEach(() => {
  for (const b of bridges.splice(0)) b.stop();
  vi.useRealTimers();
});

describe("link-owned execution", () => {
  it("uses globally unique IDs, fails only a dropped link's runs, and ignores replies from another link", async () => {
    const bridge = create();
    const old = await connectFakePlugin(bridge);
    const next = await connectFakePlugin(bridge);
    const oldCall = bridge.request(old.link, introduce()).catch((e: unknown) => e);
    const newCall = bridge.request(next.link, introduce());
    const id = next.frames[0].id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(id).not.toBe(old.frames[0].id);
    // A reply naming another link's request id is not that request's answer.
    old.receive({ id, type: "GRANT", state: "absent" });
    old.terminate();
    // Not a run, so the drop is reported as what it is: nothing was submitted.
    expect(await oldCall).toMatchObject({ outcome: "not-submitted" });
    next.receive({ id, type: "GRANT", state: "absent" });
    expect(await newCall).toMatchObject({ type: "GRANT", state: "absent" });
  });
  it("hedges only when nothing answers the cancellation", async () => {
    vi.useFakeTimers();
    const bridge = create({ requestTimeoutMs: 100 });
    const socket = await connectFakePlugin(bridge);
    const call = bridge
      .submitRun(
        socket.link,
        {
          type: "EXECUTE_CODE",
          session: TEST_SESSION_REQUEST,
          fileKey: "FAKEfile1",
          code: "x",
          preamble: "x",
          lateChangeWindowMs: 60_000,
        },
        mintExecutionId(),
      )
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    // Submitted, never acknowledged: the inactivity deadline still covers a plugin that says nothing.
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.frames.at(-1)).toMatchObject({ type: "CANCEL", executionId: id });
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
      .submitRun(
        socket.link,
        {
          type: "EXECUTE_CODE",
          session: TEST_SESSION_REQUEST,
          fileKey: "FAKEfile1",
          code: "x",
          preamble: "x",
          lateChangeWindowMs: 60_000,
        },
        mintExecutionId(),
      )
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    socket.receive({ type: "RUN_STATE", executionId: id, phase: "queued", at: Date.now() });
    // Five times the inactivity deadline: a run waiting behind another one is not silence.
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.frames.some((f) => f.type === "CANCEL")).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(socket.frames.at(-1)).toMatchObject({ type: "CANCEL", executionId: id });
    socket.receive({ type: "CANCEL_RESULT", executionId: id, disposition: "never-executed" });
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
      .submitRun(
        socket.link,
        {
          type: "EXECUTE_CODE",
          session: TEST_SESSION_REQUEST,
          fileKey: "FAKEfile1",
          code: "x",
          preamble: "x",
          lateChangeWindowMs: 60_000,
        },
        mintExecutionId(),
      )
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    socket.receive({ type: "RUN_STATE", executionId: id, phase: "queued", at: Date.now() });
    socket.receive({ type: "RUN_STATE", executionId: id, phase: "running", at: Date.now() });
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.frames.at(-1)).toMatchObject({ type: "CANCEL", executionId: id });
    socket.receive({ type: "CANCEL_RESULT", executionId: id, disposition: "was-running" });
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
      .submitRun(
        socket.link,
        {
          type: "EXECUTE_CODE",
          session: TEST_SESSION_REQUEST,
          fileKey: "FAKEfile1",
          code: "x",
          preamble: "x",
          lateChangeWindowMs: 60_000,
        },
        mintExecutionId(),
      )
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    const runStartedAt = Date.now();
    const heldThreadMs = 6_000;
    await vi.advanceTimersByTimeAsync(heldThreadMs);
    socket.receive({ type: "RUN_STATE", executionId: id, phase: "queued", at: runStartedAt });
    socket.receive({ type: "RUN_STATE", executionId: id, phase: "running", at: runStartedAt });
    const cancelled = () => socket.frames.some((f) => f.type === "CANCEL");
    // The run's own clock, with no server call in flight: the plugin refuses writes from here.
    const runDeadlinePassed = () => Date.now() - runStartedAt >= RUN_INACTIVITY_DEADLINE_MS;
    await vi.advanceTimersByTimeAsync(RUN_INACTIVITY_DEADLINE_MS - heldThreadMs - 1);
    expect([cancelled(), runDeadlinePassed()]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1);
    expect([cancelled(), runDeadlinePassed()]).toEqual([true, true]);
    socket.receive({ type: "CANCEL_RESULT", executionId: id, disposition: "was-running" });
    expect(await call).toMatchObject({ phase: "running" });
  });
  it("caller abort removes tracking and sends one cancellation", async () => {
    const bridge = create();
    const socket = await connectFakePlugin(bridge);
    const abort = new AbortController();
    const call = bridge
      .request(socket.link, introduce(), { signal: abort.signal })
      .catch((e: unknown) => e);
    abort.abort();
    expect(await call).toMatchObject({ outcome: "not-submitted" });
    expect(socket.frames.filter((f) => f.type === "CANCEL")).toHaveLength(1);
  });
  it("withholds a dropped link's image service and leaves another link's run accounting intact", async () => {
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
    const next = await connectFakePlugin(bridge);
    const oldCall = bridge
      .submitRun(
        old.link,
        {
          type: "EXECUTE_CODE",
          session: TEST_SESSION_REQUEST,
          fileKey: "FAKEfile1",
          code: "old",
          preamble: "x",
          lateChangeWindowMs: 60_000,
        },
        mintExecutionId(),
      )
      .catch(() => {});
    await Promise.resolve();
    old.receive({
      type: "CHANNEL_REQUEST",
      capability: "images.fetch",
      id: "image",
      executionId: old.frames[0].id,
      payload: ["x"],
    });
    await Promise.resolve();
    old.terminate();
    const newCall = bridge.request(next.link, introduce());
    release({ x: "old bytes" });
    await Promise.resolve();
    await Promise.resolve();
    expect(old.frames.some((f) => f.type === "CHANNEL_RESPONSE")).toBe(false);
    expect(next.frames).toHaveLength(1);
    next.receive({ id: next.frames[0].id, type: "GRANT", state: "absent" });
    expect(await newCall).toMatchObject({ type: "GRANT", state: "absent" });
    bridge.stop();
    await oldCall;
  });
});
