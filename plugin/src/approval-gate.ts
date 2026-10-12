/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The consent gate. The sandbox is the SOLE ARBITER (ADR-0008): it holds the durable approval decision
// and refuses to run writes for a session the human hasn't approved. The server only introduces itself
// (SESSION_INFO) and formats the pending reply — it does not own the approval bit.
//
// Approval keys on a TOKEN this sandbox mints on Allow, never on the server's identity (a project path
// — a forgeable label). The token is handed to the approved server and echoed back in every
// SESSION_INFO; a same-path squatter never got the handover, so it has no token and is PENDING.
//
// This is the shell around session-approval.ts: it owns the store, the clocks and the random values,
// and runs the model's effects.
import { createApprovalLifecycle, type ApprovalAnswer, type SettledApproval } from "./approval-lifecycle.js";
import { reply, toServer, type ReplyTo } from "./outbound.js";
import type { ConnKey } from "./panel.js";
import type { AuthorizingUser, ServerFrame } from "./protocol.js";
import {
  NO_PLUGIN_APPROVAL,
  approvalOf,
  approvalRows,
  approvalStatusReply,
  awaitingDecision,
  hasAwayAllow,
  nextRequestLapse,
  pluginApprovalTransition,
  type PluginApprovalEvent,
} from "./session-approval.js";
import type { SessionPanelSource } from "./session-panel.js";

const APPROVED_TOKENS_STORAGE_KEY = "code-mode:approved-tokens";

/**
 * Mint a session token on Allow, or a session claim.
 *
 * Why Math.random is fine (QuickJS has no crypto): the token is a localhost BEARER value. The server
 * re-discloses it in SESSION_INFO, so a local attacker connecting during a drop window can harvest
 * and replay it — closing that needs cryptographic server auth, out of scope; consent is the gate.
 * Claims reach unapproved servers, so a local process can sample the generator — no worse than that.
 */
function mintToken(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/** The human who is clicking right now, as the Allow handover names them. */
function currentAuthorizingUser(): AuthorizingUser | null {
  const user = figma.currentUser;
  return user?.id ? { figmaUserId: user.id, name: user.name } : null;
}

export function createApprovalGate({
  show,
  cancelRuns,
  takeBaton,
}: {
  /** Repaint the panel, optionally moving the list to `expandTo`. */
  show: (expandTo?: boolean) => void;
  /** End a connection's runs: the human revoked its approval. */
  cancelRuns: (key: ConnKey) => void;
  /** An approved session wrote: it drives now. */
  takeBaton: (key: ConnKey) => void;
}) {
  let storageError: string | null = null;
  const store = createApprovalLifecycle(
    {
      load: () => figma.clientStorage.getAsync(APPROVED_TOKENS_STORAGE_KEY),
      save: async (tokens) => {
        await figma.clientStorage.setAsync(APPROVED_TOKENS_STORAGE_KEY, tokens);
        storageError = null;
      },
    },
    (error) => {
      storageError = `Approval storage failed: ${String(error)}. Changes may not survive reopening.`;
      figma.notify(storageError, { error: true, timeout: 15000 });
    },
  );

  let state = NO_PLUGIN_APPROVAL;
  // Settles on the next transition: what a wait on an Allow in flight sleeps on.
  let wake!: () => void;
  let changed = new Promise<void>((resolve) => (wake = resolve));

  function apply(event: PluginApprovalEvent): void {
    const transition = pluginApprovalTransition(state, event, store);
    state = transition.state;
    const woken = wake;
    changed = new Promise<void>((resolve) => (wake = resolve));
    woken();
    let paint: { expandTo?: boolean } | null = null;
    for (const effect of transition.effects) {
      switch (effect.type) {
        case "send":
          toServer(effect.key, effect.frame);
          break;
        case "awaitStore":
          void storeAnswerFor(effect.key).then(() => apply({ type: "allowReady", key: effect.key, token: effect.token }));
          break;
        case "persistAllow":
          void store
            .allow(effect.token)
            .then(() => true, () => false)
            .then((ok) => apply({ type: "allowPersisted", key: effect.key, token: effect.token, ok, from: effect.from }));
          break;
        case "forgetToken":
          void store.revoke(effect.token).catch(() => {}).then(() => show());
          break;
        case "forgetAll":
          void store.revokeAll().catch(() => {}).then(() => show());
          break;
        case "cancelRuns":
          cancelRuns(effect.key);
          break;
        case "promptIfUnapproved":
          whenApprovalKnown(effect.key, (approval) =>
            show(approval === "unapproved" && state.connections.has(effect.key) ? true : undefined),
          );
          break;
        case "expand":
          paint = { expandTo: true };
          break;
        case "collapse":
          paint = { expandTo: false };
          break;
        case "settleExpansion":
          paint = { expandTo: awaitingDecision(state, store) };
          break;
        case "render":
          paint ??= {};
          break;
      }
    }
    if (paint) show(paint.expandTo);
  }

  /** Resolves once the store has a definite answer for this connection's credential. */
  async function storeAnswerFor(key: ConnKey): Promise<void> {
    for (;;) {
      const credential = state.connections.get(key)?.credential ?? null;
      if (credential === null || store.approval(credential) !== "unknown") return;
      await store.settled;
    }
  }

  const approvalOfKey = (key: ConnKey): ApprovalAnswer => approvalOf(state, key, store);

  /** The connection's approval once it is definite: the store settled, and no Allow in flight. */
  async function settledApprovalOf(key: ConnKey): Promise<SettledApproval> {
    for (;;) {
      const answer = approvalOfKey(key);
      if (answer !== "unknown") return answer;
      await (state.connections.get(key)?.allowing ? changed : store.settled);
    }
  }

  /** Act on a definite answer: synchronously when there already is one, else once it settles. */
  function whenApprovalKnown(key: ConnKey, then: (approval: SettledApproval) => void): void {
    const answer = approvalOfKey(key);
    if (answer !== "unknown") then(answer);
    else void settledApprovalOf(key).then(then);
  }

  /** A connection asked for approval and is about to be told PENDING. */
  function asked(key: ConnKey): void {
    apply({ type: "asked", key, now: Date.now(), freshClaim: mintToken() });
  }

  const panelSource: SessionPanelSource = {
    approvalRows: (now) => approvalRows(state, store, now),
    nextRequestLapse: (now) => nextRequestLapse(state, now),
    hasApprovals: () => store.size > 0 || hasAwayAllow(state),
    get storageError() {
      return storageError;
    },
    isConnected: (key) => state.connections.has(key),
    isApproved: (key) => approvalOfKey(key) === "approved",
    identityOf: (key) => state.connections.get(key)?.identity ?? null,
    framelinkOriginOf: (key) => state.connections.get(key)?.framelinkOrigin ?? null,
  };

  return {
    /** Resolves once the stored approvals have loaded. */
    ready: store.ready,
    panelSource,
    isConnected: panelSource.isConnected,
    approvalOf: approvalOfKey,
    settledApprovalOf,

    /** Each socket generation starts with an unapproved session. */
    connected: (key: ConnKey) => apply({ type: "connected", key }),

    /**
     * The server introduces its session: the identity the human approves, the per-connection pairing
     * code shown beside it, the Framelink origin its sign-in pages must be on, and — from an approved
     * server — the token it was handed on a prior Allow. Approval arrives later via the panel.
     */
    introduce(key: ConnKey, msg: Extract<ServerFrame, { type: "SESSION_INFO" }>): void {
      apply({
        type: "introduced",
        key,
        identity: msg.identity,
        pairingCode: msg.pairingCode,
        sessionToken: msg.sessionToken,
        sessionClaim: msg.sessionClaim,
        framelinkOrigin: msg.framelinkOrigin,
        now: Date.now(),
        freshToken: mintToken(),
      });
    },

    closed: (key: ConnKey) => apply({ type: "closed", key, now: Date.now() }),

    /** The human's Allow / Deny on a row, connected or away. */
    decide(key: ConnKey, approve: boolean): void {
      apply({ type: "decided", key, approve, user: currentAuthorizingUser(), freshToken: mintToken() });
    },

    revoke: (key: ConnKey) => apply({ type: "revoked", key }),
    revokeAll: () => apply({ type: "revokedAll" }),

    /**
     * The single write-gate decision and the enforcement point for the consent Invariant, so every
     * write verb shares it. An unapproved session (or an unknown connection — the fail-closed default)
     * is refused with PENDING_APPROVAL and the list opens for an Allow, unless the human already
     * rejected it. "unknown" is admitted into the queue but never run: the dequeue gate asks again.
     * An approved session that isn't driving simply takes the baton: ordering between the human's own
     * approved agents is a lock, not a security decision.
     */
    gateWrite(to: ReplyTo, approval: ApprovalAnswer): boolean {
      if (approval === "unapproved") {
        asked(to.connKey);
        reply(to, { type: "PENDING_APPROVAL" });
        return false;
      }
      if (approval === "approved") takeBaton(to.connKey);
      return true;
    },

    /**
     * Answer an APPROVAL_STATUS poll once the answer is definite. A poll that lands while an Allow is
     * being made durable (or collected from away) waits for it: answering pending then would mint a
     * fresh claim and prompt for a session already allowed.
     */
    answerStatus(to: ReplyTo): void {
      whenApprovalKnown(to.connKey, (approval) => {
        const answer = approvalStatusReply(state, to.connKey, approval);
        if (answer.type === "PENDING_APPROVAL") asked(to.connKey);
        reply(to, answer);
      });
    },
  };
}
