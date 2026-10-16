/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSessions } from "./agent-sessions.js";

const SCOPE = { credentialId: "credential", ownerId: "owner", project: "/project", fileKey: "FILEkey123" };
const open = (sessions: ReturnType<typeof createAgentSessions>, handle: string) => {
  const admission = sessions.admit(SCOPE, { handle, create: true });
  assert.equal(admission.kind, "admitted");
  return (admission as Extract<typeof admission, { kind: "admitted" }>).session;
};

test("an oversized session loses last first, and is cleared only when its own data is over budget", () => {
  const sessions = createAgentSessions({ sessionBudgetBytes: 10_000, totalBudgetBytes: 1_000_000 });
  const session = open(sessions, "one");
  session.store = { ids: ["1:2"], last: { read: "x".repeat(10_000) } };
  assert.match(sessions.release(session) ?? "", /session\.last was dropped/);
  assert.deepEqual(session.store, { ids: ["1:2"] });
  assert.equal(sessions.holds(SCOPE, "one"), true);

  assert.equal(sessions.admit(SCOPE, { handle: "one", create: false }).kind, "admitted");
  session.store.kept = "x".repeat(10_000);
  assert.match(sessions.release(session) ?? "", /this session was cleared .* no longer resumes/);
  assert.equal(sessions.admit(SCOPE, { handle: "one", create: false }).kind, "not-found");
});

test("past the total budget the least recently used session goes first, and a pinned one never does", () => {
  const sessions = createAgentSessions({ sessionBudgetBytes: 10_000, totalBudgetBytes: 20_000 });
  const fill = () => ({ data: "x".repeat(4_000) });
  // Still running, and the least recently used of all: a pin outlives the budget.
  const pinned = open(sessions, "pinned");
  pinned.store = fill();
  const oldest = open(sessions, "oldest");
  oldest.store = fill();
  sessions.release(oldest);
  const middle = open(sessions, "middle");
  middle.store = fill();
  sessions.release(middle);
  const newest = open(sessions, "newest");
  newest.store = fill();
  assert.equal(sessions.release(newest), null);

  assert.equal(sessions.holds(SCOPE, "oldest"), false);
  assert.equal(sessions.holds(SCOPE, "pinned"), true);
  assert.equal(sessions.holds(SCOPE, "middle"), true);
  assert.equal(sessions.holds(SCOPE, "newest"), true);
});
