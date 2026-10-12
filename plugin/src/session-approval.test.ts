/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_PLUGIN_APPROVAL,
  approvalOf,
  approvalRows,
  pluginApprovalTransition,
  type ApprovalView,
  type PluginApprovalEffect,
  type PluginApprovalEvent,
  type PluginApprovalState,
} from "./session-approval.js";

const USER = { figmaUserId: "u1", name: "Human" };

/** A store holding exactly `durable`, settled. */
function storeOf(durable: Set<string>): ApprovalView {
  return { approval: (token) => (durable.has(token) ? "approved" : "unapproved") };
}

function run(events: PluginApprovalEvent[], store: ApprovalView, state: PluginApprovalState = NO_PLUGIN_APPROVAL) {
  const effects: PluginApprovalEffect[] = [];
  for (const event of events) {
    const next = pluginApprovalTransition(state, event, store);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const asking: PluginApprovalEvent[] = [
  { type: "connected", key: 1 },
  {
    type: "introduced",
    key: 1,
    identity: "/proj",
    pairingCode: "1111",
    sessionToken: null,
    sessionClaim: null,
    framelinkOrigin: "https://app.framelink.ai",
    now: 0,
    freshToken: "unused",
  },
  { type: "asked", key: 1, now: 0, freshClaim: "claim-1" },
];

// Whatever overtakes an Allow while its token is being written, the token reaches no session: the
// overtaking decision stands, and the durable token is forgotten rather than approving nobody.
for (const overtake of [
  { type: "decided", key: 1, approve: false, user: USER, freshToken: "unused" },
  { type: "revoked", key: 1 },
  { type: "closed", key: 1, now: 0 },
] as const) {
  test(`${overtake.type} overtakes an Allow still being written`, () => {
    const durable = new Set<string>();
    const store = storeOf(durable);
    const allowing = run(
      [...asking, { type: "decided", key: 1, approve: true, user: USER, freshToken: "tok" }, { type: "allowReady", key: 1, token: "tok" }],
      store,
    );
    assert.equal(approvalOf(allowing.state, 1, store), "unknown", "an Allow in flight is not a no");

    const overtaken = run([overtake], store, allowing.state);
    durable.add("tok");
    const landed = run([{ type: "allowPersisted", key: 1, token: "tok", ok: true }], store, overtaken.state);

    assert(!landed.effects.some((e) => e.type === "send" && e.frame.type === "SESSION_TOKEN"));
    assert(landed.effects.some((e) => e.type === "forgetToken" && e.token === "tok"));
    assert.notEqual(approvalOf(landed.state, 1, store), "approved");
  });
}

test("an Allow given while away that fails to persist goes back, click and all", () => {
  const store = storeOf(new Set());
  const away = run([...asking, { type: "closed", key: 1, now: 0 }, { type: "decided", key: 1, approve: true, user: USER, freshToken: "unused" }], store);
  const back = run(
    [
      { type: "connected", key: 2 },
      {
        type: "introduced",
        key: 2,
        identity: "/proj",
        pairingCode: "2222",
        sessionToken: null,
        sessionClaim: "claim-1",
        framelinkOrigin: "https://app.framelink.ai",
        now: 1,
        freshToken: "tok",
      },
    ],
    store,
    away.state,
  );
  const persist = back.effects.find((e) => e.type === "persistAllow");
  assert(persist?.type === "persistAllow");

  const failed = run([{ type: "allowPersisted", key: 2, token: "tok", ok: false, from: persist.from }], store, back.state);

  const row = approvalRows(failed.state, store, 1).find((r) => r.key === 1);
  assert.equal(row?.allowedWhileAway, true);
  assert.equal(approvalOf(failed.state, 2, store), "unapproved");
});
