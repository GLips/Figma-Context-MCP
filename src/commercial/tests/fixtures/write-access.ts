/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteAccess } from "~/commercial/entitlement/write-access.js";
import { FramelinkApiClient } from "~/commercial/entitlement/framelink-api.js";
import { WriteAccessStore } from "~/commercial/entitlement/write-access-store.js";
import type { ApprovedSession } from "~/commercial/plugin-bridge/approval-session.js";
import type { ApprovalStatus } from "~/commercial/plugin-bridge/bridge.js";
import type { AuthorizingUser, WriteAccessNotice } from "@framelink/plugin/protocol";

export const TEST_AUTHORIZING_USER: AuthorizingUser = {
  figmaUserId: "figma-user-1",
  name: "Test Authorizing User",
};

export const TEST_APPROVED_SESSION: ApprovedSession = {
  token: "test-session-token",
  authorizingUser: TEST_AUTHORIZING_USER,
};

/** A fake bridge's `approvalStatus` that always grants, under TEST_APPROVED_SESSION. */
export async function grantedTestApproval(): Promise<ApprovalStatus> {
  return { type: "APPROVAL_GRANTED", session: TEST_APPROVED_SESSION };
}

/**
 * A WriteAccess over an isolated temp state dir. With no `apiUrl` it points at a closed port, so
 * any request is an outage — tools not about write access still authorize from a fresh allowance.
 */
export function createTestWriteAccess({
  apiUrl = "http://127.0.0.1:9",
  notifyPanel,
}: { apiUrl?: string; notifyPanel?: (notice: WriteAccessNotice) => void } = {}): {
  writeAccess: WriteAccess;
  store: WriteAccessStore;
} {
  const store = new WriteAccessStore(mkdtempSync(join(tmpdir(), "flcm-write-access-")));
  return {
    writeAccess: new WriteAccess(new FramelinkApiClient(apiUrl), store, { notifyPanel }),
    store,
  };
}
