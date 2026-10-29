/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { FramelinkApiClient } from "~/commercial/entitlement/framelink-api.js";
import { afterEach, expect, it, vi } from "vitest";
import { createTestWriteAccess, TEST_PLUGIN_OWNER } from "./fixtures/write-access.js";

afterEach(() => {
  vi.restoreAllMocks();
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
