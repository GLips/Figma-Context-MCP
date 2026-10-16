/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The agents' `session` stores, one per server-minted handle. Each lives under one grant scope
// (installation, owner, project, document) and only in this plugin run's memory: closing the plugin
// loses every one, and a later call naming an old handle is refused, never handed a fresh store.
//
// Bounded by size, never by idle time: each session's measured size (its data, `last`, and a fixed
// entry overhead) against a per-session budget, and their sum against a total, evicting the least
// recently used. A session with a queued or running execution is pinned and never evicted.
import type { SessionRequest } from "./protocol.js";
import { grantKey, type GrantScope } from "./grant-store.js";

export interface AgentSession {
  readonly handle: string;
  /** The grant scope the session was created under (grant-store.ts grantKey). */
  readonly scope: string;
  /** Built by the server-shipped preamble on the session's first run (FlcmHost.getSession). */
  store: Record<string, unknown> | undefined;
  /** Executions admitted with this session that haven't settled. */
  pins: number;
  /** Measured when its last execution settled. */
  bytes: number;
}

export type SessionAdmission =
  | { kind: "admitted"; session: AgentSession }
  | { kind: "not-found" }
  | { kind: "taken" };

export const SESSION_BUDGET_BYTES = 4 * 1024 * 1024;
export const TOTAL_SESSION_BUDGET_BYTES = 32 * 1024 * 1024;
// Charged to every session, empty or not, so many small sessions still meet the total budget.
export const SESSION_ENTRY_OVERHEAD_BYTES = 1024;

export function createAgentSessions({
  sessionBudgetBytes = SESSION_BUDGET_BYTES,
  totalBudgetBytes = TOTAL_SESSION_BUDGET_BYTES,
}: { sessionBudgetBytes?: number; totalBudgetBytes?: number } = {}) {
  // Insertion order is recency: admitting a session moves it to the end, and eviction starts at
  // the front.
  const sessions = new Map<string, AgentSession>();

  function measure(session: AgentSession): number {
    return SESSION_ENTRY_OVERHEAD_BYTES + measuredBytes(session.store, new Set());
  }

  function evict(session: AgentSession): void {
    sessions.delete(session.handle);
  }

  return {
    /** Whether `handle` names a session under `scope`. A session under another scope is not held. */
    holds(scope: GrantScope, handle: string): boolean {
      return sessions.get(handle)?.scope === grantKey(scope);
    },

    /** Pin the session a run arriving under `grantScope` names, creating it if the server minted it. */
    admit(grantScope: GrantScope, { handle, create }: SessionRequest): SessionAdmission {
      const scope = grantKey(grantScope);
      const held = sessions.get(handle);
      if (create) {
        // Checked against every scope: one handle names one session in this plugin run.
        if (held) return { kind: "taken" };
        const session: AgentSession = { handle, scope, store: undefined, pins: 1, bytes: SESSION_ENTRY_OVERHEAD_BYTES };
        sessions.set(handle, session);
        return { kind: "admitted", session };
      }
      if (!held || held.scope !== scope) return { kind: "not-found" };
      held.pins++;
      sessions.delete(handle);
      sessions.set(handle, held);
      return { kind: "admitted", session: held };
    },

    /**
     * One execution admitted with `session` settled, ran or not. Enforces the budgets now that the
     * session's size can't change under a run, and returns what the agent must be told, if anything.
     */
    release(session: AgentSession): string | null {
      session.pins--;
      let notice: string | null = null;
      session.bytes = measure(session);
      if (session.bytes > sessionBudgetBytes && session.store?.last !== undefined) {
        delete session.store.last;
        session.bytes = measure(session);
        notice = `flcm: session.last was dropped: this session held ${megabytes(session.bytes)} with it, over the ${megabytes(sessionBudgetBytes)} a session may keep.`;
      }
      if (session.bytes > sessionBudgetBytes && session.pins === 0) {
        evict(session);
        return sessionClearedNotice(`it held ${megabytes(session.bytes)}, over the ${megabytes(sessionBudgetBytes)} a session may keep`);
      }
      let total = 0;
      for (const each of sessions.values()) total += each.bytes;
      for (const oldest of [...sessions.values()]) {
        if (total <= totalBudgetBytes) break;
        if (oldest.pins > 0) continue;
        evict(oldest);
        total -= oldest.bytes;
        if (oldest === session)
          return sessionClearedNotice(`the plugin's sessions outgrew their ${megabytes(totalBudgetBytes)} together`);
      }
      return notice;
    },
  };
}

export type AgentSessions = ReturnType<typeof createAgentSessions>;

function sessionClearedNotice(why: string): string {
  return `flcm: this session was cleared after the run because ${why}. Its handle no longer resumes: start a new session, and keep ids and small specs in session rather than whole reads.`;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * An estimate, not an exact heap size: what the stored plain data costs, counting strings at two
 * bytes a character and every property and container a fixed overhead. Session data is plain by
 * construction (preamble/session.ts), and an object stored twice is counted once.
 */
function measuredBytes(value: unknown, seen: Set<object>): number {
  if (typeof value === "string") return 16 + value.length * 2;
  if (value === null || typeof value !== "object") return 8;
  if (seen.has(value)) return 8;
  seen.add(value);
  let bytes = 32;
  for (const key of Object.keys(value))
    bytes += 16 + key.length * 2 + measuredBytes((value as Record<string, unknown>)[key], seen);
  return bytes;
}
