/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The server's half of session approval. The plugin is the sole arbiter (ADR-0008): it alone decides
// whether a token approves anything. What the server holds are two independent facts it presents in
// every SESSION_INFO — a session the plugin handed over on Allow, and the plugin's claim on the
// approval request this server last made — kept in memory and in two 0600 files so a restart reloads
// both (approval-store.ts).
//
// They are independent on purpose. A held token can be dead (revoked while this server was offline)
// while a fresh request is open under a claim; only the plugin can tell, so neither fact clears the
// other except where the plugin says so: the handover spends the claim.
import { Logger } from "~/utils/logger.js";
import { SESSION_IDENTITY } from "./approval.js";
import type { ApprovalStore } from "./approval-store.js";
import type { ServerRequest } from "@framelink/plugin/protocol";

/** An Allow, as the plugin handed it over: the token approval keys on. */
export interface ApprovedSession {
  readonly token: string;
}

export interface ServerApprovalState {
  readonly session: ApprovedSession | null;
  readonly claim: string | null;
}

export type ServerApprovalEvent =
  | { type: "reloaded"; session: ApprovedSession | null; claim: string | null }
  | { type: "handedOver"; session: ApprovedSession }
  | { type: "claimed"; claim: string }
  | { type: "revoked" };

export type ServerApprovalEffect =
  | { type: "persistSession"; session: ApprovedSession }
  | { type: "forgetSession" }
  | { type: "persistClaim"; claim: string }
  | { type: "forgetClaim" };

export const NO_SERVER_APPROVAL: ServerApprovalState = { session: null, claim: null };

/** The server's approval transitions: pure, so every rule is a line here rather than a field write. */
export function serverApprovalTransition(
  state: ServerApprovalState,
  event: ServerApprovalEvent,
): { state: ServerApprovalState; effects: ServerApprovalEffect[] } {
  switch (event.type) {
    case "reloaded":
      return { state: { session: event.session, claim: event.claim }, effects: [] };
    // The handover spends the claim: approval now rides the token, and a stale claim must not
    // outlive the request it was minted for.
    case "handedOver":
      return {
        state: { session: event.session, claim: null },
        effects: [{ type: "persistSession", session: event.session }, { type: "forgetClaim" }],
      };
    case "claimed":
      return {
        state: { ...state, claim: event.claim },
        effects: [{ type: "persistClaim", claim: event.claim }],
      };
    // The plugin already forgot the token; forgetting it here too means no later SESSION_INFO (and no
    // restart) presents it again. An open claim is untouched: Revoke answers no request.
    case "revoked":
      return { state: { ...state, session: null }, effects: [{ type: "forgetSession" }] };
  }
}

// How recently a persisted approval must have been USED for this server to treat a plugin as probably
// around (see hasRecentApproval). Sized to span the quiet gaps inside one working session while
// expiring long before "closed Figma and moved on". Deliberately unrelated to the store's 24h TTL:
// that one answers "must the human re-approve?", this one "is a plugin plausibly there?".
const RECENT_APPROVAL_MS = 30 * 60 * 1000;

/**
 * The shell around the model: runs its effects against the store, keyed by the port this server bound
 * (persistence is per (cwd, port) — ADR-0008).
 */
export class ApprovalSession {
  private state: ServerApprovalState = NO_SERVER_APPROVAL;
  private port: number | null = null;
  // `lastUsedAt` of the approval found at bind, fixed then and never refreshed: it answers "when was
  // code mode last used HERE, before this process existed" (see hasRecentApproval).
  private reloadedLastUsedAt: number | null = null;

  constructor(private readonly store: ApprovalStore) {}

  /** The session this server holds a token for, or null. */
  get session(): ApprovedSession | null {
    return this.state.session;
  }

  /**
   * Reload a prior approval the instant the port is bound — before any connection can be accepted
   * (and thus before the first SESSION_INFO), so a plugin reconnecting onto this port is not
   * re-prompted. Keyed by THIS port: a sibling on another port reloads nothing (fail-closed).
   */
  bind(port: number): void {
    this.port = port;
    const now = Date.now();
    const record = this.store.loadRecord(port, now);
    this.reloadedLastUsedAt = record?.lastUsedAt ?? null;
    this.apply({
      type: "reloaded",
      session: record ? { token: record.token } : null,
      claim: this.store.loadSessionClaim(port, now),
    });
    if (record)
      Logger.log(
        "Reloaded a persisted session token — it will be offered on the next SESSION_INFO; the plugin decides whether the prior Allow still holds",
      );
  }

  /**
   * Whether this project holds an unexpired approval for `port`, deleting nothing. READ-ONLY on
   * purpose: the port being asked about is one some OTHER live process may hold, and pruning its
   * expired record would delete a running peer's approval behind its back.
   */
  holdsApprovalFor(port: number): boolean {
    return this.store.hasUnexpiredApproval(port, Date.now());
  }

  apply(event: ServerApprovalEvent): void {
    const { state, effects } = serverApprovalTransition(this.state, event);
    this.state = state;
    for (const effect of effects) this.run(effect);
  }

  /** What this server says about itself to every authenticated link. */
  sessionInfo(framelinkOrigin: string): Extract<ServerRequest, { type: "SESSION_INFO" }> {
    return {
      type: "SESSION_INFO",
      identity: SESSION_IDENTITY,
      sessionToken: this.state.session?.token ?? null,
      sessionClaim: this.state.claim,
      framelinkOrigin,
    };
  }

  /**
   * Was code mode used on this (cwd, port) within the last few minutes, according to the approval
   * found at bind? The ONLY cross-process evidence the relay has that a plugin is around: every other
   * signal is per-process state a restart clears to "no plugin has ever been here", indistinguishable
   * from a genuine cold start. Recency, not the store's 24h expiry, or someone who approved yesterday
   * and closed Figma would see write tools all day. Too generous only shows a few extra tools; too
   * strict reports a live capability as absent — so the window leans long.
   */
  hasRecentApproval(): boolean {
    if (this.reloadedLastUsedAt === null) return false;
    return Date.now() - this.reloadedLastUsedAt <= RECENT_APPROVAL_MS;
  }

  /**
   * Slide the persisted approval's TTL forward after a real write by `session`. The store's
   * compare-and-set refuses to roll back a file a peer has since replaced.
   */
  touch(session: ApprovedSession): void {
    if (this.port !== null) this.store.touch(this.port, session.token, Date.now());
  }

  private run(effect: ServerApprovalEffect): void {
    // Unbound means a test bridge that never started: there is no (cwd, port) to persist under.
    const port = this.port;
    switch (effect.type) {
      case "persistSession":
        if (port !== null)
          this.store.save(port, effect.session.token, SESSION_IDENTITY, Date.now());
        Logger.log("Stored session token handed over by the sandbox after Allow (persisted)");
        return;
      case "forgetSession":
        if (port !== null) this.store.clear(port);
        Logger.log("Session approval revoked by the human — cleared the persisted token");
        return;
      case "persistClaim":
        if (port !== null) this.store.saveSessionClaim(port, effect.claim, Date.now());
        return;
      case "forgetClaim":
        if (port !== null) this.store.clearSessionClaim(port);
        return;
    }
  }
}
