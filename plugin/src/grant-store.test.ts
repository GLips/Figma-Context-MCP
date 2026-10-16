/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGrantStore, type GrantStorage } from "./grant-store.js";

const scope = { credentialId: "cred-1", ownerId: "user-1", project: "/proj", documentId: "0123456789abcdef" };

function memoryStorage(): GrantStorage & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    records,
    get: async (key) => records.get(key),
    set: async (key, value) => void records.set(key, value),
    delete: async (key) => void records.delete(key),
    keys: async () => [...records.keys()],
  };
}

test("two plugin instances share grants through storage, one record per grant", async () => {
  const storage = memoryStorage();
  const here = createGrantStore(storage, () => {});
  const there = createGrantStore(storage, () => {});
  await here.grant(scope);
  await here.grant({ ...scope, project: "/other" });
  assert.equal(await there.settledAnswer(scope), "granted");
  assert.equal(await there.settledAnswer({ ...scope, documentId: "fedcba9876543210" }), "absent");
  assert.deepEqual(
    (await there.grantsOnDocument("user-1", "0123456789abcdef")).map((grant) => grant.project).sort(),
    ["/other", "/proj"],
  );
  // The other instance's revoke reaches this one when it is told to read again.
  await there.revoke(scope);
  assert.equal(here.answer(scope), "granted");
  await here.refresh(scope);
  assert.equal(await here.settledAnswer(scope), "absent");
  assert.equal(storage.records.size, 1);
});

test("the store fails closed: an unreadable grant is absent, a failed save rejects, a failed revoke still closes", async () => {
  const storage = memoryStorage();
  const reported: unknown[] = [];
  const grants = createGrantStore(storage, (error) => reported.push(error));
  // A grant with an operation in flight is "unknown", never "granted".
  const saving = grants.grant(scope);
  assert.equal(grants.answer(scope), "unknown");
  await saving;
  assert.equal(grants.answer(scope), "granted");

  storage.delete = async () => {
    throw new Error("disk full");
  };
  void grants.revoke(scope);
  assert.equal(grants.answer(scope), "unknown");
  assert.equal(await grants.settledAnswer(scope), "absent");

  storage.set = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(grants.grant(scope));
  assert.equal(await grants.settledAnswer(scope), "absent");

  const unreadable = createGrantStore(
    { ...memoryStorage(), get: async () => Promise.reject(new Error("corrupt")) },
    (error) => reported.push(error),
  );
  assert.equal(await unreadable.settledAnswer(scope), "absent");
  assert.equal(reported.length, 3);
});
