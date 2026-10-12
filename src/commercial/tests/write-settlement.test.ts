/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { FramelinkApiClient } from "~/commercial/entitlement/framelink-api.js";
import type { WriteMeter } from "~/commercial/entitlement/write-meter.js";
import { afterEach, expect, it, vi } from "vitest";
import { createTestWriteAccess, TEST_AUTHORIZING_USER } from "./fixtures/write-access.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** An allowance run that reached the plugin as `runId` and replied "no change". */
async function readOnlyRun(writeMeter: WriteMeter, runId: string) {
  const admission = await writeMeter.authorize(TEST_AUTHORIZING_USER, `${runId}-execution`);
  if (admission.kind !== "authorized") throw new Error("a fresh allowance authorizes");
  admission.charge.submitted(runId);
  return admission.charge;
}

it("drain waits out a read's late window to the ceiling, and an abort leaves no timer behind", async () => {
  vi.useFakeTimers();
  const { writeMeter } = createTestWriteAccess();
  (await readOnlyRun(writeMeter, "run")).replied(false);
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

  (await readOnlyRun(writeMeter, "cancelled-run")).replied(false);
  const controller = new AbortController();
  const cancelled = writeMeter.drain(controller.signal).catch((error: Error) => error);
  controller.abort(new Error("stop"));
  expect(await cancelled).toMatchObject({ message: "stop" });
  expect(vi.getTimerCount()).toBe(0);
});

it("a RUN_SETTLED that beats the caller's reply still leaves nothing to drain", async () => {
  const { writeMeter } = createTestWriteAccess();
  const charge = await readOnlyRun(writeMeter, "quick-run");
  // ws hands over the reply and RUN_SETTLED in one read, ahead of the caller's handling of the reply.
  writeMeter.runEvent({ type: "settled", runId: "quick-run" });
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
    notifyPanel: (notice) => {
      if (notice.kind === "sign-in-pending") notified();
    },
  });
  const signingIn = signIn.start(TEST_AUTHORIZING_USER);
  await pending;
  signIn.stop();
  await signingIn;
  expect(poll).not.toHaveBeenCalled();
});
