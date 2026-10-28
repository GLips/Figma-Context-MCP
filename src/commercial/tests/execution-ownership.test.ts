/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginBridge, BridgeRequestError } from "~/commercial/plugin-bridge/bridge.js";
import { connectFakePlugin } from "./fixtures/fake-plugin-socket.js";
import { TEST_DOCUMENT, TEST_SESSION_REQUEST } from "./fixtures/write-access.js";
import { mintExecutionId } from "~/commercial/execution-id.js";

const bridges: PluginBridge[] = [];
// A request with a trivial reply, for tests about the ledger rather than the payload.
const introduce = () => ({
  type: "GRANT_STATUS" as const,
  executionId: mintExecutionId(),
  documentId: TEST_DOCUMENT.documentId,
  prompt: "none" as const,
});

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
          intent: "Test run",
          session: TEST_SESSION_REQUEST,
          documentId: TEST_DOCUMENT.documentId,
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
    expect(error).toMatchObject({ outcome: "unconfirmed" });
    expect(String(error)).toContain(
      "No plugin status for 100ms. Cancellation requested; the run may still be executing. The plugin sent no status for this run.",
    );
  });
  it("rejects a run its budget cut off while queued as never executed, naming what it waited behind", async () => {
    vi.useFakeTimers();
    const bridge = create();
    const socket = await connectFakePlugin(bridge);
    const blocker = mintExecutionId();
    const call = bridge
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
        { budgetMs: 600 },
      )
      .catch((e: unknown) => e);
    await Promise.resolve();
    const id = socket.frames[0].id as string;
    socket.receive({
      type: "RUN_STATUS",
      executionId: id,
      at: Date.now(),
      phase: "queued",
      wait: { ahead: 1 },
    });
    await vi.advanceTimersByTimeAsync(599);
    expect(socket.frames.some((f) => f.type === "CANCEL")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.frames.at(-1)).toMatchObject({ type: "CANCEL", executionId: id });
    socket.receive({
      type: "CANCEL_RESULT",
      executionId: id,
      disposition: "never-executed",
      blocker: {
        executionId: blocker,
        kind: "code",
        sameLink: true,
        session: "soft-size-skull-fruit",
        intent: "Shape the new Promo card variants",
        runningForMs: 842_000,
        cancelledForMs: 827_000,
        activity: {
          callsSettled: 412,
          oldestPending: { operation: "figma.loadFontAsync", sinceMs: 130_000 },
        },
      },
    });
    const error = await call;
    expect(error).toMatchObject({ outcome: "not-submitted", stoppedBy: "budget" });
    expect(String(error)).toContain(
      "The call's budget of 600ms ran out. Your code did not run; this request made no changes. " +
        `Run ${blocker} ("Shape the new Promo card variants", session soft-size-skull-fruit) still ` +
        "occupies the plugin and has run 14m 02s. Cancellation was requested 13m 47s ago. Its last " +
        "status: figma.loadFontAsync pending for 2m 10s, 412 calls settled. Retrying now will queue " +
        "behind it again.",
    );
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
          intent: "Test run",
          session: TEST_SESSION_REQUEST,
          documentId: TEST_DOCUMENT.documentId,
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
