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
  assert.equal(approvals.has("old"), false);
  load.resolve(["old"]);
  await revoke;
  assert.equal(approvals.has("old"), false);
  const reopened = createApprovalLifecycle({ load: async () => persisted, save: async () => {} }, assert.fail);
  await reopened.ready;
  assert.equal(reopened.has("old"), false);
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
  assert.equal(approvals.has("new"), false);
  saving.resolve();
  await Promise.all([allow, revoke]);
  assert.deepEqual(writes, [["new"], []]);
  assert.equal(approvals.has("new"), false);
  assert.equal(approvals.has("unknown"), false);
});

test("storage failures surface, Allow fails closed, and revoke remains effective in memory", async () => {
  const errors: unknown[] = [];
  const approvals = createApprovalLifecycle({ load: async () => ["old"], save: async () => { throw new Error("disk"); } }, (e) => errors.push(e));
  await approvals.ready;
  await assert.rejects(approvals.allow("new"), /disk/);
  assert.equal(approvals.has("new"), false);
  await assert.rejects(approvals.revoke("old"), /disk/);
  assert.equal(approvals.has("old"), false);
  assert.equal(errors.length, 2);
});
