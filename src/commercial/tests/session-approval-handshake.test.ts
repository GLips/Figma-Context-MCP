/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Both sides' approval models run against each other, with the wire reduced to the frames that carry
// approval: what each side holds after a sequence must agree, socket-free.
import { expect, it } from "vitest";
import {
  NO_SERVER_APPROVAL,
  serverApprovalTransition,
  type ServerApprovalEvent,
  type ServerApprovalState,
} from "~/commercial/plugin-bridge/approval-session.js";
import {
  NO_PLUGIN_APPROVAL,
  approvalOf,
  pluginApprovalTransition,
  type PluginApprovalEvent,
  type PluginApprovalState,
} from "@framelink/plugin/session-approval";
import { TEST_AUTHORIZING_USER } from "./fixtures/write-access.js";

function pair() {
  const durable = new Set<string>();
  const store = {
    approval: (token: string) => (durable.has(token) ? "approved" : "unapproved"),
  } as const;
  let server: ServerApprovalState = NO_SERVER_APPROVAL;
  let plugin: PluginApprovalState = NO_PLUGIN_APPROVAL;
  const frames: string[] = [];
  let minted = 0;

  const toServer = (event: ServerApprovalEvent) => {
    server = serverApprovalTransition(server, event).state;
  };
  const toPlugin = (event: PluginApprovalEvent): void => {
    const { state, effects } = pluginApprovalTransition(plugin, event, store);
    plugin = state;
    for (const effect of effects) {
      if (effect.type === "send") {
        frames.push(effect.frame.type);
        if (effect.frame.type === "SESSION_CLAIM")
          toServer({ type: "claimed", claim: effect.frame.sessionClaim });
        if (effect.frame.type === "SESSION_TOKEN")
          toServer({
            type: "handedOver",
            session: {
              token: effect.frame.sessionToken,
              authorizingUser: effect.frame.authorizingUser,
            },
          });
        if (effect.frame.type === "REVOKE_SESSION") toServer({ type: "revoked" });
      }
      if (effect.type === "awaitStore")
        toPlugin({ type: "allowReady", key: effect.key, token: effect.token });
      if (effect.type === "persistAllow") {
        durable.add(effect.token);
        toPlugin({
          type: "allowPersisted",
          key: effect.key,
          token: effect.token,
          ok: true,
          from: effect.from,
        });
      }
      if (effect.type === "forgetToken") durable.delete(effect.token);
    }
  };
  /** A connection, introduced with what the server holds right now (its SESSION_INFO). */
  const connect = (key: number) => {
    toPlugin({ type: "connected", key });
    toPlugin({
      type: "introduced",
      key,
      identity: "/proj",
      pairingCode: String(key).repeat(4),
      sessionToken: server.session?.token ?? null,
      sessionClaim: server.claim,
      framelinkOrigin: "https://app.framelink.ai",
      now: 0,
      freshToken: `token-${++minted}`,
    });
  };
  return {
    connect,
    ask: (key: number) => toPlugin({ type: "asked", key, now: 0, freshClaim: `claim-${++minted}` }),
    allow: (key: number) =>
      toPlugin({
        type: "decided",
        key,
        approve: true,
        user: TEST_AUTHORIZING_USER,
        freshToken: `token-${++minted}`,
      }),
    close: (key: number) => toPlugin({ type: "closed", key, now: 0 }),
    revoke: (key: number) => toPlugin({ type: "revoked", key }),
    approved: (key: number) => approvalOf(plugin, key, store) === "approved",
    get server() {
      return server;
    },
    frames,
  };
}

it("an Allow given while the session was away reaches it on reconnect, and both sides agree on the token", () => {
  const sides = pair();
  sides.connect(1);
  sides.ask(1);
  expect(sides.server.claim).not.toBeNull();
  // The call gives up, the socket goes, and only then does the human click Allow.
  sides.close(1);
  sides.allow(1);
  expect(sides.frames).not.toContain("SESSION_TOKEN");

  sides.connect(2);

  expect(sides.approved(2)).toBe(true);
  expect(sides.server).toMatchObject({
    session: { authorizingUser: TEST_AUTHORIZING_USER },
    claim: null,
  });
});

it("a reconnect presenting the handed-over token is approved without asking, until a revoke", () => {
  const sides = pair();
  sides.connect(1);
  sides.ask(1);
  sides.allow(1);
  const claimsBefore = sides.frames.filter((f) => f === "SESSION_CLAIM").length;

  sides.close(1);
  sides.connect(2);
  expect(sides.approved(2)).toBe(true);
  expect(sides.frames.filter((f) => f === "SESSION_CLAIM")).toHaveLength(claimsBefore);

  sides.revoke(2);
  expect(sides.server.session).toBeNull();
  sides.connect(3);
  expect(sides.approved(3)).toBe(false);
});
