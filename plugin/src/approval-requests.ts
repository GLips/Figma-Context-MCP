/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Approval requests that outlive the call, or the connection, that made them.
//
// A session asks for approval by polling APPROVAL_STATUS while its call waits. Once the polls stop, the
// call has given up: nothing is waiting to run, and an Allow can only approve the session's NEXT call.
// When the session's socket closes too (the `execute` CLI run ended, the server restarted), its request
// is kept here as an away request, so the human can still Allow it and the approval reaches the
// session when it reconnects.
//
// "The same session" is decided by the session claim alone: a random value minted here the first time
// a connection asks, sent only on that connection's socket, and presented back by the server in a
// later SESSION_INFO. A matching project path or pairing code is a label, never a match. A claim is
// spent by the one connection that presents it.

import { APPROVAL_WAITING_GRACE_MS } from "./protocol.js";

// Enough for a few projects' worth of ended runs; the oldest falls off first. Away requests live in
// memory only, so closing the plugin drops them all.
const MAX_AWAY_REQUESTS = 5;

// Matches the server's session-claim expiry (approval-store.ts TTL_MS): past it the server has dropped
// the claim, so the request could never be collected and its row would only mislead.
const AWAY_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export type ApprovalRequestState = "waiting" | "expired";

/** Whether a connection's last request is still waiting, or null if it has never asked. */
export function approvalRequestState(
  askedAt: number | undefined,
  now: number,
): ApprovalRequestState | null {
  if (askedAt === undefined) return null;
  return now - askedAt < APPROVAL_WAITING_GRACE_MS ? "waiting" : "expired";
}

export interface AwayRequest<User> {
  identity: string;
  pairingCode: string | null;
  sessionClaim: string;
  askedAt: number;
  // Set when the human clicks Allow while the session is away: who approved it, handed over with the
  // token once the session reconnects.
  allowed?: { authorizingUser: User };
}

export interface ClaimedAwayRequest<User> {
  key: number;
  request: AwayRequest<User>;
}

/** The away requests, keyed by the connection key of the socket that made them. */
export function createAwayRequests<User>() {
  const requests = new Map<number, AwayRequest<User>>();
  return {
    /** The live away requests, dropping any past the server's claim expiry. */
    entries(now: number) {
      for (const [key, request] of requests)
        if (now - request.askedAt > AWAY_REQUEST_TTL_MS) requests.delete(key);
      return requests.entries();
    },
    get: (key: number) => requests.get(key),
    get allowedCount() {
      let count = 0;
      for (const request of requests.values()) if (request.allowed) count++;
      return count;
    },
    retain(key: number, request: AwayRequest<User>): void {
      requests.set(key, request);
      for (const oldest of requests.keys()) {
        if (requests.size <= MAX_AWAY_REQUESTS) break;
        requests.delete(oldest);
      }
    },
    allow(key: number, authorizingUser: User): void {
      const request = requests.get(key);
      if (request) request.allowed = { authorizingUser };
    },
    dismiss: (key: number) => requests.delete(key),
    dismissAllowed(): void {
      for (const [key, request] of requests) if (request.allowed) requests.delete(key);
    },
    /**
     * Take the away request a reconnecting session claims, or undefined. The identity must match too:
     * not as proof (the claim is that), but so a claim can never move a request onto another project.
     */
    claim(sessionClaim: string, identity: string | null): ClaimedAwayRequest<User> | undefined {
      for (const [key, request] of requests) {
        if (request.sessionClaim !== sessionClaim || request.identity !== identity) continue;
        requests.delete(key);
        return { key, request };
      }
      return undefined;
    },
  };
}
