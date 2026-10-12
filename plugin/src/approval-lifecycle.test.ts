/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApprovalLifecycle } from "./approval-lifecycle.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("revoke before delayed restore stays revoked after reopening", async () => {
  const load = deferred<unknown>();
  let persisted = ["old"];
  const approvals = createApprovalLifecycle({ load: () => load.promise, save: async (t) => { persisted = t; } }, assert.fail);
  const revoke = approvals.revokeAll();
  assert.equal(approvals.approval("old"), "unknown");
  load.resolve(["old"]);
  await revoke;
  assert.equal(approvals.approval("old"), "unapproved");
  const reopened = createApprovalLifecycle({ load: async () => persisted, save: async () => {} }, assert.fail);
  await reopened.ready;
  assert.equal(reopened.approval("old"), "unapproved");
});

test("Allow and revoke persist in order and gates stay closed during a pending write", async () => {
  const saving = deferred<void>();
  const writes: string[][] = [];
  const approvals = createApprovalLifecycle({ load: async () => [], save: async (t) => {
    writes.push(t); if (writes.length === 1) await saving.promise;
  } }, assert.fail);
  await approvals.ready;
  const allow = approvals.allow("new");
  const revoke = approvals.revoke("new");
  await Promise.resolve();
  assert.equal(approvals.approval("new"), "unknown");
  saving.resolve();
  await Promise.all([allow, revoke]);
  assert.deepEqual(writes, [["new"], []]);
  assert.equal(approvals.approval("new"), "unapproved");
  assert.equal(approvals.approval("unknown"), "unapproved");
});

test("storage failures surface, Allow fails closed, and revoke remains effective in memory", async () => {
  const errors: unknown[] = [];
  const approvals = createApprovalLifecycle({ load: async () => ["old"], save: async () => { throw new Error("disk"); } }, (e) => errors.push(e));
  await approvals.ready;
  await assert.rejects(approvals.allow("new"), /disk/);
  assert.equal(approvals.approval("new"), "unapproved");
  await assert.rejects(approvals.revoke("old"), /disk/);
  assert.equal(approvals.approval("old"), "unapproved");
  assert.equal(errors.length, 2);
});
