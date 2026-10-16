/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ApprovalStore } from "~/commercial/plugin-bridge/approval-store.js";
import { ApprovalSession } from "~/commercial/plugin-bridge/approval-session.js";
import { TEST_APPROVED_SESSION } from "./fixtures/write-access.js";

const PORT = 19_901;

function restartable() {
  const store = new ApprovalStore(
    "/approval-session-test",
    mkdtempSync(join(tmpdir(), "flcm-as-")),
  );
  return () => {
    const session = new ApprovalSession(store);
    session.bind(PORT);
    return session;
  };
}

it("a handover spends the claim it answered, and a restart reloads the session alone", () => {
  const start = restartable();
  const before = start();
  before.apply({ type: "claimed", claim: "claim-1" });
  expect(before.sessionInfo("https://app.framelink.ai").sessionClaim).toBe("claim-1");

  before.apply({ type: "handedOver", session: TEST_APPROVED_SESSION });

  const after = start().sessionInfo("https://app.framelink.ai");
  expect(after).toMatchObject({ sessionToken: TEST_APPROVED_SESSION.token, sessionClaim: null });
});

// The token can be dead while a fresh request is open: Revoke answers no request, so the claim an
// Allow given while this server was away would be handed over under must survive it.
it("a revoke forgets the session but keeps an open claim, across a restart too", () => {
  const start = restartable();
  const before = start();
  before.apply({ type: "handedOver", session: TEST_APPROVED_SESSION });
  before.apply({ type: "claimed", claim: "claim-2" });

  before.apply({ type: "revoked" });

  expect(before.session).toBeNull();
  expect(start().sessionInfo("https://app.framelink.ai")).toMatchObject({
    sessionToken: null,
    sessionClaim: "claim-2",
  });
});
