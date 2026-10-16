/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { FramelinkApiClient } from "~/commercial/entitlement/framelink-api.js";
import type { WriteMeter } from "~/commercial/entitlement/write-meter.js";
import { writesUsedThisMonth } from "~/commercial/entitlement/write-ledger.js";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { executePluginCode } from "~/commercial/plugin-bridge/execution.js";
import { mintExecutionId, type ExecutionId } from "~/commercial/execution-id.js";
import { afterEach, expect, it, vi } from "vitest";
import { connectFakePlugin } from "./fixtures/fake-plugin-socket.js";
import {
  createTestWriteAccess,
  TEST_DOCUMENT,
  TEST_INTENT,
  TEST_PLUGIN_LINK,
  TEST_PLUGIN_OWNER,
} from "./fixtures/write-access.js";

const bridges: PluginBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** An allowance run under `executionId` that replied "no change". */
async function readOnlyRun(writeMeter: WriteMeter, executionId: ExecutionId) {
  const admission = await writeMeter.authorize(TEST_PLUGIN_LINK, executionId);
  if (admission.kind !== "authorized") throw new Error("a fresh allowance authorizes");
  return admission.charge;
}

it("drain waits out a read's late window to the ceiling, and an abort leaves no timer behind", async () => {
  vi.useFakeTimers();
  const { writeMeter } = createTestWriteAccess();
  (await readOnlyRun(writeMeter, mintExecutionId())).replied(false);
  let remaining = 0;
  let drained = false;
  const done = writeMeter
    .drain(new AbortController().signal, (ms) => {
      remaining = ms;
    })
    .then(() => {
      drained = true;
    });
  expect(remaining).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(remaining - 1);
  expect(drained).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await done;
  expect(drained).toBe(true);

  (await readOnlyRun(writeMeter, mintExecutionId())).replied(false);
  const controller = new AbortController();
  const cancelled = writeMeter.drain(controller.signal).catch((error: Error) => error);
  controller.abort(new Error("stop"));
  expect(await cancelled).toMatchObject({ message: "stop" });
  expect(vi.getTimerCount()).toBe(0);
});

it("a RUN_SETTLED that beats the caller's reply still leaves nothing to drain", async () => {
  const { writeMeter } = createTestWriteAccess();
  const executionId = mintExecutionId();
  const charge = await readOnlyRun(writeMeter, executionId);
  // ws hands over the reply and RUN_SETTLED in one read, ahead of the caller's handling of the reply.
  writeMeter.runEvent({ type: "settled", executionId, link: TEST_PLUGIN_LINK });
  charge.replied(false);
  let waited = false;
  await writeMeter.drain(new AbortController().signal, () => {
    waited = true;
  });
  expect(waited).toBe(false);
});

it("runtime shutdown interrupts device polling without another authentication request", async () => {
  vi.spyOn(FramelinkApiClient.prototype, "requestDeviceSignIn").mockResolvedValue({
    deviceCode: "test",
    userCode: "test",
    verificationUri: "https://example.test",
    expiresInMs: 60_000,
    intervalMs: 30_000,
  });
  const poll = vi.spyOn(FramelinkApiClient.prototype, "pollDeviceToken");
  let notified!: () => void;
  const pending = new Promise<void>((resolve) => {
    notified = resolve;
  });
  const { signIn } = createTestWriteAccess({
    notifyOwnerPanels: (_figmaUserId, notice) => {
      if (notice.kind === "sign-in-pending") notified();
    },
  });
  const signingIn = signIn.start(TEST_PLUGIN_OWNER);
  await pending;
  signIn.stop();
  await signingIn;
  expect(poll).not.toHaveBeenCalled();
});

it("a late event for a run from another plugin link is ignored and charges nothing", async () => {
  const { writeMeter, store } = createTestWriteAccess();
  const bridge = new PluginBridge({
    events: { onRunEvent: (event) => writeMeter.runEvent(event) },
  });
  bridges.push(bridge);
  // Two plugins of the same Figma user: only the link a run went out on may speak for it.
  const ran = await connectFakePlugin(bridge);
  const other = await connectFakePlugin(bridge);
  ran.onFrame = (frame) => {
    if (frame.type === "EXECUTE_CODE")
      queueMicrotask(() =>
        ran.receive({
          type: "EXECUTE_CODE_RESULT",
          id: frame.id,
          console: [],
          errors: null,
          documentChanged: false,
        }),
      );
  };
  const outcome = await executePluginCode(
    { bridge, writeMeter, readLocalImage: () => Promise.reject(new Error("no images")) },
    {
      executionId: mintExecutionId(),
      intent: TEST_INTENT,
      link: ran.link,
      document: TEST_DOCUMENT,
      session: null,
    },
    "return 1;",
  );
  expect(outcome.kind).toBe("executed");
  const executionId = ran.frames.find((frame) => frame.type === "EXECUTE_CODE")!.id;
  const writesUsed = () =>
    writesUsedThisMonth(store.read().ledger, TEST_PLUGIN_OWNER.figmaUserId, new Date());

  other.receive({ type: "RUN_CHANGED", executionId });
  other.receive({
    type: "EXECUTE_CODE_RESULT",
    id: executionId,
    console: [],
    errors: null,
    documentChanged: true,
  });
  other.receive({ type: "RUN_SETTLED", executionId });
  expect(writesUsed()).toBe(0);

  // The run's own link is still heard: its late window was neither closed nor charged above.
  ran.receive({ type: "RUN_CHANGED", executionId });
  expect(writesUsed()).toBe(1);
});
