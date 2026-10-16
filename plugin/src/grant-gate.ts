/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The grant gate. The plugin is the only authority on grants: a run executes only when this plugin
// holds a grant for its server's project on the document the run names, and that document is the
// one this plugin run was proven to be in. Checked when a run arrives and again when it dequeues.
//
// A server only asks (GRANT_STATUS), and its asking is what opens a prompt: "grant" when a call named
// this file, "select" when it named none and the human must pick one. The human's click is what
// grants. Grants are shared by every plugin instance through storage; GRANT_CHANGED tells the others.
import type { DocumentIdentity, ProvenDocument } from "./document-identity.js";
import type { DocumentGrant, GrantScope, GrantStore } from "./grant-store.js";
import { currentPluginOwner } from "./link-auth.js";
import { reply, toServer, type ReplyTo } from "./outbound.js";
import type { ConnKey } from "./panel.js";
import {
  GRANT_PROMPT_GRACE_MS,
  type GrantPrompt,
  type GrantState,
  type NotGrantedReason,
  type ServerFrame,
} from "./protocol.js";

interface GrantConnection {
  project: string | null;
  framelinkOrigin: string | null;
  // The prompt this server's polls keep open. `picked`: the human chose this file for a "select".
  prompt: { kind: Exclude<GrantPrompt, "none">; askedAt: number; picked: boolean } | null;
  // The human said no to this server. It stays no until they click Allow on its row.
  denied: boolean;
  allowing: boolean;
}

/**
 * What the gate knows about one project on this file: a connected server, or a project granted this
 * file whose server isn't connected (`key` null). The panel adds its own presentation to it.
 */
export interface GrantRow {
  key: ConnKey | null;
  project: string;
  grant: DocumentGrant | null;
  granted: boolean;
  connected: boolean;
  prompt: Exclude<GrantPrompt, "none"> | null;
  denied: boolean;
  allowing: boolean;
}

export function createGrantGate({
  store,
  identity,
  credentialOf,
  authenticatedConnections,
  show,
  cancelRuns,
  takeBaton,
}: {
  store: GrantStore;
  identity: DocumentIdentity;
  credentialOf: (key: ConnKey) => string | null;
  authenticatedConnections: () => ConnKey[];
  /** Repaint the panel, optionally moving the list to `expandTo`. */
  show: (expandTo?: boolean) => void;
  /** End a connection's runs: the human revoked its project's grant. */
  cancelRuns: (key: ConnKey) => void;
  /** A granted server's run passed the dequeue check and is about to touch the document: it drives now. */
  takeBaton: (key: ConnKey) => void;
}) {
  const connections = new Map<ConnKey, GrantConnection>();
  // Grants on this document, for the rows of projects whose servers aren't connected.
  let documentGrants: DocumentGrant[] = [];

  function scopeOf(key: ConnKey, fileKey: string): GrantScope | null {
    const credentialId = credentialOf(key);
    const owner = currentPluginOwner();
    const project = connections.get(key)?.project ?? null;
    if (credentialId === null || owner === null || project === null) return null;
    return { credentialId, ownerId: owner.figmaUserId, project, fileKey };
  }

  function provenScopeOf(key: ConnKey): GrantScope | null {
    const document = identity.document;
    return document ? scopeOf(key, document.fileKey) : null;
  }

  function isLive(prompt: GrantConnection["prompt"], now: number): boolean {
    return prompt !== null && now - prompt.askedAt < GRANT_PROMPT_GRACE_MS;
  }

  /** Keep a prompt open for another poll; a lapsed one starts over, so a stale pick can't carry. */
  function ask(conn: GrantConnection, kind: Exclude<GrantPrompt, "none">): void {
    const now = Date.now();
    const fresh = !isLive(conn.prompt, now) || conn.prompt?.kind !== kind;
    conn.prompt = { kind, askedAt: now, picked: fresh ? false : (conn.prompt?.picked ?? false) };
    show(fresh ? true : undefined);
  }

  async function refreshDocumentGrants(): Promise<void> {
    const document = identity.document;
    const owner = currentPluginOwner();
    if (!document || !owner) return;
    try {
      documentGrants = await store.grantsOnDocument(owner.figmaUserId, document.fileKey);
    } catch {
      // The rows of disconnected projects are a convenience; the gate never reads them.
    }
    show();
  }

  /**
   * Re-read each connection's grant from storage, then repaint. A revoke made in another instance
   * while no server was connected reached nobody, so a cached answer may be stale; while the read
   * is in flight the store answers "unknown" and the gate stays shut.
   */
  function refreshConnectionGrants(keys: Iterable<ConnKey>): void {
    for (const key of keys) {
      const scope = provenScopeOf(key);
      if (scope) void store.refresh(scope).then(() => show());
    }
  }

  function notifyGrantChanged(scope: GrantScope, granted: boolean): void {
    const { project, fileKey } = scope;
    for (const key of authenticatedConnections())
      if (credentialOf(key) === scope.credentialId)
        toServer(key, { type: "GRANT_CHANGED", project, fileKey, granted });
  }

  /** Cancel the runs of every connection the grant covered: every agent of that project, here. */
  function cancelCovered(credentialId: string, project: string): void {
    for (const [key, conn] of connections)
      if (conn.project === project && credentialOf(key) === credentialId) cancelRuns(key);
  }

  function admission(key: ConnKey, fileKey: string): "granted" | "unknown" | NotGrantedReason {
    if (identity.document?.fileKey !== fileKey) return "other-document";
    const scope = scopeOf(key, fileKey);
    if (!scope) return "no-grant";
    const answer = store.answer(scope);
    return answer === "absent" ? "no-grant" : answer;
  }

  function rows(now: number): GrantRow[] {
    const result: GrantRow[] = [];
    const covered = new Set<string>();
    for (const [key, conn] of connections) {
      if (conn.project === null) continue;
      const scope = provenScopeOf(key);
      const granted = scope !== null && store.answer(scope) === "granted";
      if (scope) covered.add(`${scope.credentialId}\n${conn.project}`);
      const prompt = isLive(conn.prompt, now) && !conn.prompt!.picked ? conn.prompt!.kind : null;
      result.push({
        key,
        project: conn.project,
        grant: scope ? { credentialId: scope.credentialId, project: conn.project } : null,
        granted,
        connected: true,
        prompt: granted && prompt === "grant" ? null : prompt,
        denied: conn.denied,
        allowing: conn.allowing,
      });
    }
    for (const grant of documentGrants) {
      if (covered.has(`${grant.credentialId}\n${grant.project}`)) continue;
      result.push({
        key: null,
        project: grant.project,
        grant,
        granted: true,
        connected: false,
        prompt: null,
        denied: false,
        allowing: false,
      });
    }
    return result;
  }

  return {
    /** Each socket generation starts unintroduced, unasked and undenied. */
    connected(key: ConnKey): void {
      connections.set(key, { project: null, framelinkOrigin: null, prompt: null, denied: false, allowing: false });
    },

    closed(key: ConnKey): void {
      connections.delete(key);
      show();
    },

    /** A server says who it is, over an authenticated link; it is answered with this file's claim. */
    introduce(to: ReplyTo, msg: Extract<ServerFrame, { type: "INTRODUCE" }>): void {
      const conn = connections.get(to.connKey);
      if (conn) {
        conn.project = msg.project;
        conn.framelinkOrigin = msg.framelinkOrigin;
      }
      // Before the reply: the server's first question must find the fresh read already in flight.
      refreshConnectionGrants([to.connKey]);
      reply(to, { type: "INTRODUCED", claim: identity.claim() });
      show();
    },

    /** This run's document was proven: what's granted on it can be shown. */
    documentProven(_document: ProvenDocument): void {
      refreshConnectionGrants(connections.keys());
      void refreshDocumentGrants();
    },

    /** Answer a GRANT_STATUS poll, opening or keeping the prompt it asks for. */
    async answerStatus(to: ReplyTo, fileKey: string | null, prompt: GrantPrompt): Promise<void> {
      const answer = (state: GrantState) => reply(to, { type: "GRANT", state });
      const conn = connections.get(to.connKey);
      if (!conn || conn.project === null) return answer("absent");
      if (fileKey === null || identity.document?.fileKey !== fileKey) {
        // An unproven panel can't be picked; asking it to "select" asks the human for its link.
        if (prompt === "select") ask(conn, "select");
        return answer("unproven");
      }
      const scope = scopeOf(to.connKey, fileKey);
      if (!scope) return answer("absent");
      if (prompt === "none") return answer((await store.settledAnswer(scope)) === "granted" ? "granted" : "absent");
      if (conn.denied) return answer("denied");
      if (prompt === "select") {
        if (isLive(conn.prompt, Date.now()) && conn.prompt?.kind === "select" && conn.prompt.picked) {
          conn.prompt = null;
          show();
          return answer("granted");
        }
        ask(conn, "select");
        return answer("pending");
      }
      if ((await store.settledAnswer(scope)) === "granted") {
        if (conn.prompt?.kind === "grant") conn.prompt = null;
        show();
        return answer("granted");
      }
      ask(conn, "grant");
      return answer("pending");
    },

    /** The call this server's prompt served is over. */
    closePrompt(to: ReplyTo): void {
      const conn = connections.get(to.connKey);
      if (conn) conn.prompt = null;
      reply(to, { type: "GRANT_PROMPT_CLOSED_ACK" });
      show();
    },

    /** Another instance of this plugin changed a grant: read it again, and enforce a revoke here too. */
    async changedElsewhere(to: ReplyTo, project: string, fileKey: string): Promise<void> {
      reply(to, { type: "GRANT_CHANGED_ELSEWHERE_ACK" });
      const credentialId = credentialOf(to.connKey);
      const owner = currentPluginOwner();
      if (identity.document?.fileKey !== fileKey || credentialId === null || owner === null) return;
      const scope = { credentialId, ownerId: owner.figmaUserId, project, fileKey };
      await store.refresh(scope);
      if ((await store.settledAnswer(scope)) !== "granted") cancelCovered(credentialId, project);
      void refreshDocumentGrants();
    },

    /** The human's Allow on a row: grant this project the file, and, for a "select", pick it. */
    allow(key: ConnKey): void {
      const conn = connections.get(key);
      const scope = provenScopeOf(key);
      if (!conn || !scope) {
        if (conn && currentPluginOwner() === null)
          figma.notify("Framelink: sign in to Figma to let a project edit this file.", { error: true });
        return;
      }
      conn.denied = false;
      conn.allowing = true;
      show();
      void store
        .grant(scope)
        .then(
          () => {
            if (conn.prompt?.kind === "select") conn.prompt.picked = true;
            notifyGrantChanged(scope, true);
            void refreshDocumentGrants();
          },
          (error: unknown) => figma.notify(`Framelink couldn't save that grant: ${String(error)}`, { error: true }),
        )
        .finally(() => {
          conn.allowing = false;
          show();
        });
    },

    /** The human's No on a row: this server's calls are refused until an Allow. */
    deny(key: ConnKey): void {
      const conn = connections.get(key);
      if (!conn) return;
      conn.denied = true;
      conn.prompt = null;
      show();
    },

    /** Revoke one project's grant on this file: every agent of that project loses it, here and elsewhere. */
    revoke(grant: DocumentGrant): void {
      const document = identity.document;
      const owner = currentPluginOwner();
      if (!document || !owner) return;
      const scope = { ...grant, ownerId: owner.figmaUserId, fileKey: document.fileKey };
      void store.revoke(scope).then(() => {
        notifyGrantChanged(scope, false);
        void refreshDocumentGrants();
      });
      cancelCovered(grant.credentialId, grant.project);
      show();
    },

    /**
     * The check when a run arrives: the grant scope it runs under, or null once it has been answered
     * NOT_GRANTED. A grant still settling in storage admits here and is decided at dequeue.
     */
    admit(to: ReplyTo, fileKey: string): GrantScope | null {
      const answer = admission(to.connKey, fileKey);
      if (answer !== "granted" && answer !== "unknown") {
        reply(to, { type: "NOT_GRANTED", reason: answer });
        return null;
      }
      // Non-null: either answer came from the store, which needs the scope to give one.
      return scopeOf(to.connKey, fileKey)!;
    },

    /** The grant scope a run on this connection would run under, once its document is proven. */
    provenScopeOf,

    /** The check again at dequeue, once storage has a definite answer: null admits. */
    async refusalAtDequeue(key: ConnKey, fileKey: string): Promise<NotGrantedReason | null> {
      if (identity.document?.fileKey !== fileKey) return "other-document";
      const scope = scopeOf(key, fileKey);
      if (!scope || (await store.settledAnswer(scope)) !== "granted") return "no-grant";
      takeBaton(key);
      return null;
    },

    rows,

    /** When the soonest live prompt lapses, or null when none is live. */
    nextPromptLapse(now: number): number | null {
      let soonest: number | null = null;
      for (const { prompt } of connections.values()) {
        if (!isLive(prompt, now)) continue;
        const lapsesAt = prompt!.askedAt + GRANT_PROMPT_GRACE_MS;
        if (soonest === null || lapsesAt < soonest) soonest = lapsesAt;
      }
      return soonest;
    },

    /** Whether any server is waiting on this panel: a prompt to answer, or a link to paste. */
    isAsking(now: number): boolean {
      for (const { prompt } of connections.values()) if (isLive(prompt, now) && !prompt!.picked) return true;
      return false;
    },

    isConnected: (key: ConnKey) => connections.has(key),
    isGranted(key: ConnKey): boolean {
      const scope = provenScopeOf(key);
      return scope !== null && store.answer(scope) === "granted";
    },
    projectOf: (key: ConnKey) => connections.get(key)?.project ?? null,
    framelinkOriginOf: (key: ConnKey) => connections.get(key)?.framelinkOrigin ?? null,
  };
}

export type GrantGate = ReturnType<typeof createGrantGate>;
