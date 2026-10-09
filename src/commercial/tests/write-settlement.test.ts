/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { FramelinkApiClient } from "~/commercial/entitlement/framelink-api.js";
import { afterEach, expect, it, vi } from "vitest";
import { createTestWriteAccess, TEST_AUTHORIZING_USER } from "./fixtures/write-access.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("settlement uses existing late-run expiry and abort cleans waiting without charging a read", async () => {
  vi.useFakeTimers();
  const { writeAccess } = createTestWriteAccess();
  await writeAccess.authorizeWriteExecution(TEST_AUTHORIZING_USER, "read");
  writeAccess.releaseWriteExecution("read", "run");
  let remaining = 0;
  let settled = false;
  const done = writeAccess
    .waitForWriteSettlement("run", new AbortController().signal, (ms) => {
      remaining = ms;
    })
    .then(() => {
      settled = true;
    });
  expect(remaining).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(remaining - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await done;
  expect(settled).toBe(true);
  await writeAccess.authorizeWriteExecution(TEST_AUTHORIZING_USER, "cancelled");
  writeAccess.releaseWriteExecution("cancelled", "cancelled-run");
  const controller = new AbortController();
  const cancelled = writeAccess
    .waitForWriteSettlement("cancelled-run", controller.signal)
    .catch((error) => error);
  controller.abort(new Error("stop"));
  expect((await cancelled).message).toBe("stop");
  expect(vi.getTimerCount()).toBe(0);
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
  const { writeAccess } = createTestWriteAccess({
    notifyPanel: (notice) => {
      if (notice.kind === "sign-in-pending") notified();
    },
  });
  const signingIn = writeAccess.startDeviceSignIn(TEST_AUTHORIZING_USER);
  await pending;
  writeAccess.stop();
  await signingIn;
  expect(poll).not.toHaveBeenCalled();
});
