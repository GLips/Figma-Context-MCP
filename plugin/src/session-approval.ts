/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The plugin's half of session approval, as pure transitions: `(state, event) → (state, effects)`.
// The plugin is the sole arbiter (ADR-0008); the shell (approval-gate.ts) runs the effects and owns
// the clocks, the random values and the durable token store, which this module only reads.
//
// Per connection there are independent facts. The CREDENTIAL is the token the session presents (or
// was handed); whether it approves anything is the store's answer, never a field here. CONSENT is
// where the human's decision stands: unasked, requested under a session claim, or rejected. An Allow
// IN FLIGHT is a minted token not yet durable. Requests whose socket closed live on as AWAY
// requests, matched back only by the claim the plugin gave that session.
import type { ApprovalAnswer } from "./approval-lifecycle.js";
import type { ConnKey, PanelSession } from "./panel.js";
import { APPROVAL_WAITING_GRACE_MS, type PluginFrame, type PluginReply } from "./protocol.js";

export type Consent =
  | { kind: "unasked" }
  | { kind: "requested"; claim: string; askedAt: number }
  | { kind: "rejected" };

/** A request whose socket closed before the human decided, kept so a late Allow still reaches it. */
export interface AwayRequest {
  identity: string;
  claim: string;
  askedAt: number;
  /** Set by an Allow given while away; the token is minted only for the connection that claims it. */
  allowed?: true;
}

/** The away request an Allow collects, put back if its token never reaches the session. */
export interface CollectedAwayRequest {
  key: ConnKey;
  request: AwayRequest;
}

interface AllowInFlight {
  token: string;
  collecting: boolean;
}

export interface SessionApproval {
  credential: string | null;
  consent: Consent;
  allowing: AllowInFlight | null;
  identity: string | null;
  framelinkOrigin: string | null;
}

export interface PluginApprovalState {
  readonly connections: ReadonlyMap<ConnKey, SessionApproval>;
  readonly away: ReadonlyMap<ConnKey, AwayRequest>;
}

export const NO_PLUGIN_APPROVAL: PluginApprovalState = { connections: new Map(), away: new Map() };

/** The durable store's answer for a token — the only source of "approved". */
export interface ApprovalView {
  approval(token: string): ApprovalAnswer;
}

/** Inputs the shell mints (`now`, `freshToken`, `freshClaim`) so every transition stays pure. */
export type PluginApprovalEvent =
  | { type: "connected"; key: ConnKey }
  | {
      type: "introduced";
      key: ConnKey;
      identity: string;
      sessionToken: string | null;
      sessionClaim: string | null;
      framelinkOrigin: string;
      now: number;
      freshToken: string;
    }
  | { type: "asked"; key: ConnKey; now: number; freshClaim: string }
  | { type: "decided"; key: ConnKey; approve: boolean; freshToken: string }
  | { type: "allowReady"; key: ConnKey; token: string }
  | { type: "allowPersisted"; key: ConnKey; token: string; ok: boolean; from?: CollectedAwayRequest }
  | { type: "revoked"; key: ConnKey }
  | { type: "revokedAll" }
  | { type: "closed"; key: ConnKey; now: number };

export type PluginApprovalEffect =
  | { type: "send"; key: ConnKey; frame: PluginFrame }
  /** Wait for the store to answer for this connection's credential, then apply `allowReady`. */
  | { type: "awaitStore"; key: ConnKey; token: string }
  /** Make the token durable, then apply `allowPersisted` (carrying `from` back). */
  | { type: "persistAllow"; key: ConnKey; token: string; from?: CollectedAwayRequest }
  | { type: "forgetToken"; token: string }
  | { type: "forgetAll" }
  | { type: "cancelRuns"; key: ConnKey }
  /** Once the store answers: open the list if this connection is unapproved, else repaint. */
  | { type: "promptIfUnapproved"; key: ConnKey }
  | { type: "expand" }
  | { type: "collapse" }
  /** Open the list exactly while a connected session still awaits a decision. */
  | { type: "settleExpansion" }
  | { type: "render" };

type Transition = { state: PluginApprovalState; effects: PluginApprovalEffect[] };

// Enough for a few projects' worth of ended runs; the oldest falls off first. Away requests live in
// memory only, so closing the plugin drops them all.
const MAX_AWAY_REQUESTS = 5;

// Matches the server's session-claim expiry (approval-store.ts TTL_MS): past it the server has
// dropped the claim, so the request could never be collected and its row would only mislead.
const AWAY_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

const unasked: Consent = { kind: "unasked" };

function freshConnection(): SessionApproval {
  return {
    credential: null,
    consent: unasked,
    allowing: null,
    identity: null,
    framelinkOrigin: null,
  };
}

/**
 * The connection's approval. An Allow in flight reads "unknown", like a store write in flight: the
 * gate stays closed, but nothing may treat it as a "no" and prompt the human for it again.
 */
export function approvalOf(state: PluginApprovalState, key: ConnKey, store: ApprovalView): ApprovalAnswer {
  const conn = state.connections.get(key);
  if (!conn) return "unapproved";
  const stored = conn.credential === null ? "unapproved" : store.approval(conn.credential);
  return stored !== "approved" && conn.allowing ? "unknown" : stored;
}

/**
 * Whether an introduced session still needs the human: neither approved nor rejected. A socket the
 * server never introduced is still authenticating or unpaired, and has nothing to approve yet.
 */
export function awaitingDecision(state: PluginApprovalState, store: ApprovalView): boolean {
  for (const [key, conn] of state.connections)
    if (conn.identity !== null && conn.consent.kind !== "rejected" && approvalOf(state, key, store) !== "approved")
      return true;
  return false;
}

/** The answer to an APPROVAL_STATUS poll once the store has a definite answer. */
export function approvalStatusReply(
  state: PluginApprovalState,
  key: ConnKey,
  approval: Exclude<ApprovalAnswer, "unknown">,
): Extract<PluginReply, { type: "APPROVAL_GRANTED" | "APPROVAL_REJECTED" | "PENDING_APPROVAL" }> {
  if (state.connections.get(key)?.consent.kind === "rejected") return { type: "APPROVAL_REJECTED" };
  return { type: approval === "approved" ? "APPROVAL_GRANTED" : "PENDING_APPROVAL" };
}

/** Whether a request is still waiting on a call, or expired with nothing waiting to run. */
function requestState(askedAt: number, now: number): "waiting" | "expired" {
  return now - askedAt < APPROVAL_WAITING_GRACE_MS ? "waiting" : "expired";
}

/** When the soonest waiting request lapses to expired, or null when none is waiting. */
export function nextRequestLapse(state: PluginApprovalState, now: number): number | null {
  let soonest: number | null = null;
  for (const { consent } of state.connections.values()) {
    if (consent.kind !== "requested") continue;
    const lapsesAt = consent.askedAt + APPROVAL_WAITING_GRACE_MS;
    if (lapsesAt > now && (soonest === null || lapsesAt < soonest)) soonest = lapsesAt;
  }
  return soonest;
}

export type ApprovalRow = Omit<PanelSession, "label" | "active" | "writeAccess">;

/** The approval half of every panel row: introduced connections first, then live away requests. */
export function approvalRows(state: PluginApprovalState, store: ApprovalView, now: number): ApprovalRow[] {
  const rows: ApprovalRow[] = [];
  for (const [key, conn] of state.connections) {
    if (conn.identity === null) continue;
    const approved = approvalOf(state, key, store) === "approved";
    const rejected = !approved && conn.consent.kind === "rejected";
    rows.push({
      key,
      identity: conn.identity,
      approved,
      connected: true,
      request: !approved && conn.consent.kind === "requested" ? requestState(conn.consent.askedAt, now) : null,
      rejected,
      allowedWhileAway: false,
    });
  }
  for (const [key, away] of state.away) {
    if (now - away.askedAt > AWAY_REQUEST_TTL_MS) continue;
    rows.push({
      key,
      identity: away.identity,
      approved: false,
      connected: false,
      request: "expired",
      rejected: false,
      allowedWhileAway: away.allowed === true,
    });
  }
  return rows;
}

/** Any remembered Allow not yet in the store: one given to a session while it was away. */
export function hasAwayAllow(state: PluginApprovalState): boolean {
  for (const away of state.away.values()) if (away.allowed) return true;
  return false;
}

/** The plugin's approval transitions. */
export function pluginApprovalTransition(
  state: PluginApprovalState,
  event: PluginApprovalEvent,
  store: ApprovalView,
): Transition {
  const connections = new Map(state.connections);
  const away = new Map(state.away);
  const next = (effects: PluginApprovalEffect[]): Transition => ({ state: { connections, away }, effects });
  const unchanged: Transition = { state, effects: [] };

  switch (event.type) {
    case "connected":
      connections.set(event.key, freshConnection());
      return next([]);

    case "introduced": {
      // Merged, never replacing: a write that beat the handshake may already have given this socket
      // a claim, and an Allow may be in flight for it.
      const existing = connections.get(event.key) ?? freshConnection();
      const conn: SessionApproval = {
        ...existing,
        identity: event.identity,
        framelinkOrigin: event.framelinkOrigin,
        credential: event.sessionToken ?? existing.credential,
      };
      connections.set(event.key, conn);
      const effects: PluginApprovalEffect[] = [];
      // A session back from away presents the claim its last request was given and takes that
      // request over: allowed while away, it collects its token now; otherwise the request stays
      // expired here, under the claim the server still holds. A token the store already approves
      // still takes the request, only to retire it: nothing is left to collect or ask.
      const taken =
        event.sessionClaim === null ? undefined : takeAwayRequest(away, event.sessionClaim, event.identity, event.now);
      const claimed =
        conn.credential !== null && store.approval(conn.credential) === "approved" ? undefined : taken;
      if (claimed?.request.allowed) {
        conn.allowing = { token: event.freshToken, collecting: true };
        effects.push({ type: "persistAllow", key: event.key, token: event.freshToken, from: claimed });
      } else if (claimed && conn.consent.kind !== "rejected") {
        conn.consent = { kind: "requested", claim: claimed.request.claim, askedAt: claimed.request.askedAt };
      }
      effects.push({ type: "promptIfUnapproved", key: event.key });
      return next(effects);
    }

    // A connection asked and is about to be told PENDING. The first ask mints the claim and gives it
    // to this socket's server alone; later asks keep the same claim and mark the request as waiting.
    case "asked": {
      const conn = connections.get(event.key);
      if (!conn || conn.consent.kind === "rejected") return unchanged;
      const claim = conn.consent.kind === "requested" ? conn.consent.claim : event.freshClaim;
      connections.set(event.key, { ...conn, consent: { kind: "requested", claim, askedAt: event.now } });
      const effects: PluginApprovalEffect[] = [{ type: "expand" }];
      if (conn.consent.kind === "unasked")
        effects.unshift({ type: "send", key: event.key, frame: { type: "SESSION_CLAIM", sessionClaim: claim } });
      return next(effects);
    }

    // The human's Allow or Deny on a row. Deny overtakes an Allow still in flight; an Allow becomes
    // usable only once its token is durable. An away row records the Allow and mints nothing yet.
    case "decided": {
      const conn = connections.get(event.key);
      if (!conn) {
        const request = away.get(event.key);
        if (!request) return unchanged;
        if (event.approve) away.set(event.key, { ...request, allowed: true });
        else away.delete(event.key);
        return next([{ type: "render" }]);
      }
      if (!event.approve) {
        connections.set(event.key, { ...conn, consent: { kind: "rejected" }, allowing: null });
        return next([{ type: "settleExpansion" }]);
      }
      connections.set(event.key, {
        ...conn,
        allowing: { token: event.freshToken, collecting: false },
      });
      return next([{ type: "awaitStore", key: event.key, token: event.freshToken }]);
    }

    case "allowReady": {
      const conn = connections.get(event.key);
      if (conn?.allowing?.token !== event.token) return unchanged;
      // Already approved (a remembered token): nothing to mint, the decision is simply over.
      if (conn.credential !== null && store.approval(conn.credential) === "approved") {
        connections.set(event.key, { ...conn, allowing: null });
        return next([{ type: "settleExpansion" }]);
      }
      return next([{ type: "persistAllow", key: event.key, token: event.token }]);
    }

    // Nothing runs on an Allow. A call that was waiting learns of it from its next status poll and
    // only then submits its code; a call that already gave up has no code here to run.
    case "allowPersisted": {
      const conn = connections.get(event.key);
      const allow = conn?.allowing?.token === event.token ? conn.allowing : null;
      if (conn && allow && event.ok) {
        // The server spends its claim on this handover, so the request it named is over.
        connections.set(event.key, { ...conn, credential: event.token, consent: unasked, allowing: null });
        return next([
          { type: "send", key: event.key, frame: { type: "SESSION_TOKEN", sessionToken: event.token } },
          allow.collecting ? { type: "render" } : { type: "settleExpansion" },
        ]);
      }
      if (conn && allow) connections.set(event.key, { ...conn, allowing: null });
      // Failed or overtaken. A collected away Allow goes back, click and all, rather than being lost
      // without a trace; an overtaken token is durable but reached no session, so it is forgotten.
      if (event.from) retainAwayRequest(away, event.from.key, event.from.request);
      return next(event.ok && !allow ? [{ type: "forgetToken", token: event.token }, { type: "render" }] : [{ type: "render" }]);
    }

    // A de-authorization, not a disconnect: the row stays, and the agent can ask again. Forgetting
    // the token durably is what closes the gate, including for a reconnect echoing it.
    case "revoked": {
      const conn = connections.get(event.key);
      if (!conn) return unchanged;
      connections.set(event.key, { ...conn, credential: null, allowing: null });
      return next([...revokeEffects(event.key, conn), { type: "render" }]);
    }

    // Every remembered token goes, connected or not; every connected holder is told to drop its copy
    // so its next write re-prompts at once rather than on its next reconnect.
    case "revokedAll": {
      const effects: PluginApprovalEffect[] = [{ type: "forgetAll" }];
      for (const [key, conn] of state.connections) {
        connections.set(key, { ...conn, credential: null, allowing: null });
        effects.push(...revokeEffects(key, conn).filter((effect) => effect.type !== "forgetToken"));
      }
      for (const [key, request] of state.away) if (request.allowed) away.delete(key);
      effects.push({ type: "render" });
      return next(effects);
    }

    // A session that asked and was neither approved nor rejected keeps its request as an away
    // request, so a late Allow can still reach it when it reconnects. An Allow in flight for it
    // finds no connection when it lands, and its token is forgotten.
    case "closed": {
      const conn = connections.get(event.key);
      if (!conn) return unchanged;
      connections.delete(event.key);
      const { consent } = conn;
      if (
        consent.kind === "requested" &&
        conn.identity !== null &&
        (conn.credential === null || store.approval(conn.credential) !== "approved")
      )
        retainAwayRequest(away, event.key, {
          identity: conn.identity,
          claim: consent.claim,
          askedAt: consent.askedAt,
        });
      return next([connections.size === 0 ? { type: "collapse" } : { type: "render" }]);
    }
  }
}

function revokeEffects(key: ConnKey, conn: SessionApproval): PluginApprovalEffect[] {
  if (conn.credential === null) return [];
  return [
    { type: "forgetToken", token: conn.credential },
    { type: "cancelRuns", key },
    { type: "send", key, frame: { type: "REVOKE_SESSION" } },
  ];
}

function retainAwayRequest(away: Map<ConnKey, AwayRequest>, key: ConnKey, request: AwayRequest): void {
  away.set(key, request);
  for (const oldest of away.keys()) {
    if (away.size <= MAX_AWAY_REQUESTS) break;
    away.delete(oldest);
  }
}

/**
 * Take the away request a reconnecting session claims. The identity must match too: not as proof
 * (the claim is that), but so a claim can never move a request onto another project.
 */
function takeAwayRequest(
  away: Map<ConnKey, AwayRequest>,
  claim: string,
  identity: string,
  now: number,
): CollectedAwayRequest | undefined {
  for (const [key, request] of away) {
    if (now - request.askedAt > AWAY_REQUEST_TTL_MS) {
      away.delete(key);
      continue;
    }
    if (request.claim !== claim || request.identity !== identity) continue;
    away.delete(key);
    return { key, request };
  }
  return undefined;
}
