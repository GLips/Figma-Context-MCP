/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The grant gate. The plugin is the only authority on grants: a run executes only when this plugin
// holds a grant for its server's project on the document the run names, and this file carries that
// document's stamp right now. Checked when a run arrives and again when it dequeues.
//
// A server only asks (GRANT_STATUS), and its asking is what opens a prompt. Prompts belong to one
// call: keyed by the call's execution id and the socket generation that asked, so two calls waiting
// in one panel never share a prompt, a click or a dismissal. "allow" asks to grant the project this
// document; "pick" asks whether this copy is the one the call means, for that call only. Grants are
// shared by every plugin instance through storage; GRANT_CHANGED tells the others.
import type { DocumentIdentity } from "./document-identity.js";
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
}

/** One call's prompt in this panel, open while its server keeps polling. */
interface CallPrompt {
  key: ConnKey;
  executionId: string;
  kind: Exclude<GrantPrompt, "none">;
  // The document the prompt was raised for and shows; an Allow grants this one, never a newer stamp.
  documentId: string;
  askedAt: number;
  // `allowing`: the grant is being saved. `denied` and `picked` wait for the next poll to carry them.
  state: "open" | "allowing" | "denied" | "picked";
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
}

/** A call's live prompt, as the panel draws it. */
export interface GrantPromptRow {
  key: ConnKey;
  executionId: string;
  kind: Exclude<GrantPrompt, "none">;
  project: string;
  documentId: string;
  allowing: boolean;
}

function promptKey(key: ConnKey, executionId: string): string {
  return `${key}\n${executionId}`;
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
  const prompts = new Map<string, CallPrompt>();
  // Grants on this document, for the rows of projects whose servers aren't connected.
  let documentGrants: DocumentGrant[] = [];

  function scopeOf(key: ConnKey, documentId: string): GrantScope | null {
    const credentialId = credentialOf(key);
    const owner = currentPluginOwner();
    const project = connections.get(key)?.project ?? null;
    if (credentialId === null || owner === null || project === null) return null;
    return { credentialId, ownerId: owner.figmaUserId, project, documentId };
  }

  /** The grant scope a run on this connection would run under, in the file's current document. */
  function currentScopeOf(key: ConnKey): GrantScope | null {
    const documentId = identity.documentId;
    return documentId ? scopeOf(key, documentId) : null;
  }

  function isLive(prompt: CallPrompt, now: number): boolean {
    return now - prompt.askedAt < GRANT_PROMPT_GRACE_MS && prompt.documentId === identity.documentId;
  }

  /** Keep a call's prompt open for another poll; a lapsed one starts over, so no stale click carries. */
  function ask(key: ConnKey, executionId: string, kind: CallPrompt["kind"], documentId: string): void {
    const now = Date.now();
    const id = promptKey(key, executionId);
    const held = prompts.get(id);
    if (held && held.kind === kind && held.documentId === documentId && isLive(held, now)) {
      held.askedAt = now;
      return;
    }
    prompts.set(id, { key, executionId, kind, documentId, askedAt: now, state: "open" });
    show(true);
  }

  function closePromptOf(key: ConnKey, executionId: string): void {
    if (prompts.delete(promptKey(key, executionId))) show();
  }

  async function refreshDocumentGrants(): Promise<void> {
    const documentId = identity.documentId;
    const owner = currentPluginOwner();
    if (!documentId || !owner) return;
    try {
      documentGrants = await store.grantsOnDocument(owner.figmaUserId, documentId);
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
      const scope = currentScopeOf(key);
      if (scope) void store.refresh(scope).then(() => show());
    }
  }

  function notifyGrantChanged(scope: GrantScope, granted: boolean): void {
    const { project, documentId } = scope;
    for (const key of authenticatedConnections())
      if (credentialOf(key) === scope.credentialId)
        toServer(key, { type: "GRANT_CHANGED", project, documentId, granted });
  }

  /** Cancel the runs of every connection the grant covered: every agent of that project, here. */
  function cancelCovered(credentialId: string, project: string): void {
    for (const [key, conn] of connections)
      if (conn.project === project && credentialOf(key) === credentialId) cancelRuns(key);
  }

  function admission(key: ConnKey, documentId: string): "granted" | "unknown" | NotGrantedReason {
    if (identity.current() !== documentId) return "other-document";
    const scope = scopeOf(key, documentId);
    if (!scope) return "no-grant";
    const answer = store.answer(scope);
    return answer === "absent" ? "no-grant" : answer;
  }

  function rows(): GrantRow[] {
    const result: GrantRow[] = [];
    const covered = new Set<string>();
    for (const [key, conn] of connections) {
      if (conn.project === null) continue;
      const scope = currentScopeOf(key);
      if (scope) covered.add(`${scope.credentialId}\n${conn.project}`);
      result.push({
        key,
        project: conn.project,
        grant: scope ? { credentialId: scope.credentialId, project: conn.project } : null,
        granted: scope !== null && store.answer(scope) === "granted",
        connected: true,
      });
    }
    for (const grant of documentGrants) {
      if (covered.has(`${grant.credentialId}\n${grant.project}`)) continue;
      result.push({ key: null, project: grant.project, grant, granted: true, connected: false });
    }
    return result;
  }

  return {
    /** Each socket generation starts unintroduced and unasked. */
    connected(key: ConnKey): void {
      connections.set(key, { project: null, framelinkOrigin: null });
    },

    closed(key: ConnKey): void {
      connections.delete(key);
      for (const [id, prompt] of prompts) if (prompt.key === key) prompts.delete(id);
      show();
    },

    /** A server says who it is, over an authenticated link; it is answered with this file's report. */
    introduce(to: ReplyTo, msg: Extract<ServerFrame, { type: "INTRODUCE" }>): void {
      const conn = connections.get(to.connKey);
      if (conn) {
        conn.project = msg.project;
        conn.framelinkOrigin = msg.framelinkOrigin;
      }
      // Before the reply: the server's first question must find the fresh read already in flight.
      refreshConnectionGrants([to.connKey]);
      identity.current();
      reply(to, { type: "INTRODUCED", document: identity.report() });
      show();
    },

    /** The file's stamp is new: grants and prompts on the old one no longer apply here. */
    documentChanged(): void {
      for (const [id, prompt] of prompts) if (prompt.documentId !== identity.documentId) prompts.delete(id);
      refreshConnectionGrants(connections.keys());
      void refreshDocumentGrants();
    },

    /** Answer a GRANT_STATUS poll for one call, opening or keeping the prompt it asks for. */
    async answerStatus(
      to: ReplyTo,
      { executionId, documentId, prompt }: Extract<ServerFrame, { type: "GRANT_STATUS" }>,
    ): Promise<void> {
      const answer = (state: GrantState) => reply(to, { type: "GRANT", state });
      const conn = connections.get(to.connKey);
      if (!conn || conn.project === null) return answer("absent");
      if (identity.current() !== documentId) {
        closePromptOf(to.connKey, executionId);
        return answer("other-document");
      }
      const scope = scopeOf(to.connKey, documentId);
      if (!scope) return answer("absent");
      if (prompt === "none") return answer((await store.settledAnswer(scope)) === "granted" ? "granted" : "absent");
      const held = prompts.get(promptKey(to.connKey, executionId));
      const decided = held?.kind === prompt && held.documentId === documentId ? held.state : "open";
      if (decided === "picked" || decided === "denied") {
        closePromptOf(to.connKey, executionId);
        return answer(decided);
      }
      if (prompt === "allow" && (await store.settledAnswer(scope)) === "granted") {
        closePromptOf(to.connKey, executionId);
        return answer("granted");
      }
      ask(to.connKey, executionId, prompt, documentId);
      return answer("pending");
    },

    /** The call this prompt served is over. */
    closePrompt(to: ReplyTo, executionId: string): void {
      closePromptOf(to.connKey, executionId);
      reply(to, { type: "GRANT_PROMPT_CLOSED_ACK" });
    },

    /** Another instance of this plugin changed a grant: read it again, and enforce a revoke here too. */
    async changedElsewhere(to: ReplyTo, project: string, documentId: string): Promise<void> {
      reply(to, { type: "GRANT_CHANGED_ELSEWHERE_ACK" });
      const credentialId = credentialOf(to.connKey);
      const owner = currentPluginOwner();
      if (identity.documentId !== documentId || credentialId === null || owner === null) return;
      const scope = { credentialId, ownerId: owner.figmaUserId, project, documentId };
      await store.refresh(scope);
      if ((await store.settledAnswer(scope)) !== "granted") cancelCovered(credentialId, project);
      void refreshDocumentGrants();
    },

    /**
     * The human's Allow on one call's prompt: grant its project the document the prompt showed. If
     * the file was given another identity since, nothing is granted, and the call is refused.
     */
    allow(key: ConnKey, executionId: string, documentId: string): void {
      const prompt = prompts.get(promptKey(key, executionId));
      if (!prompt || prompt.kind !== "allow" || prompt.documentId !== documentId || prompt.state !== "open") return;
      if (identity.current() !== documentId) return;
      const scope = scopeOf(key, documentId);
      if (!scope) {
        if (currentPluginOwner() === null)
          figma.notify("Framelink: sign in to Figma to let a project edit this file.", { error: true });
        return;
      }
      prompt.state = "allowing";
      show();
      void store
        .grant(scope)
        .then(
          () => {
            notifyGrantChanged(scope, true);
            void refreshDocumentGrants();
          },
          (error: unknown) => figma.notify(`Framelink couldn't save that grant: ${String(error)}`, { error: true }),
        )
        .finally(() => {
          // Granted, the next poll answers so from storage; refused, the prompt asks again.
          if (prompt.state === "allowing") prompt.state = "open";
          show();
        });
    },

    /** The human's Deny on one call's prompt: that call is refused. The next call asks again. */
    deny(key: ConnKey, executionId: string): void {
      const prompt = prompts.get(promptKey(key, executionId));
      if (!prompt || prompt.kind !== "allow" || prompt.state !== "open") return;
      prompt.state = "denied";
      show();
    },

    /** The human chose this copy for one call. It grants nothing. */
    pick(key: ConnKey, executionId: string, documentId: string): void {
      const prompt = prompts.get(promptKey(key, executionId));
      if (!prompt || prompt.kind !== "pick" || prompt.documentId !== documentId || prompt.state !== "open") return;
      prompt.state = "picked";
      show();
    },

    /** Revoke one project's grant on this file: every agent of that project loses it, here and elsewhere. */
    revoke(grant: DocumentGrant): void {
      const documentId = identity.documentId;
      const owner = currentPluginOwner();
      if (!documentId || !owner) return;
      const scope = { ...grant, ownerId: owner.figmaUserId, documentId };
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
    admit(to: ReplyTo, documentId: string): GrantScope | null {
      const answer = admission(to.connKey, documentId);
      if (answer !== "granted" && answer !== "unknown") {
        reply(to, { type: "NOT_GRANTED", reason: answer });
        return null;
      }
      // Non-null: either answer came from the store, which needs the scope to give one.
      return scopeOf(to.connKey, documentId)!;
    },

    currentScopeOf,

    /** The check again at dequeue, once storage has a definite answer: null admits. */
    async refusalAtDequeue(key: ConnKey, documentId: string): Promise<NotGrantedReason | null> {
      if (identity.current() !== documentId) return "other-document";
      const scope = scopeOf(key, documentId);
      if (!scope || (await store.settledAnswer(scope)) !== "granted") return "no-grant";
      takeBaton(key);
      return null;
    },

    rows,

    /** Every call's prompt still waiting on the human, oldest first. */
    prompts(now: number): GrantPromptRow[] {
      const result: GrantPromptRow[] = [];
      for (const prompt of prompts.values()) {
        const project = connections.get(prompt.key)?.project ?? null;
        if (project === null || !isLive(prompt, now) || (prompt.state !== "open" && prompt.state !== "allowing"))
          continue;
        const { key, executionId, kind, documentId } = prompt;
        result.push({ key, executionId, kind, project, documentId, allowing: prompt.state === "allowing" });
      }
      return result;
    },

    /** When the soonest live prompt lapses, or null when none is live. */
    nextPromptLapse(now: number): number | null {
      let soonest: number | null = null;
      for (const prompt of prompts.values()) {
        if (!isLive(prompt, now)) continue;
        const lapsesAt = prompt.askedAt + GRANT_PROMPT_GRACE_MS;
        if (soonest === null || lapsesAt < soonest) soonest = lapsesAt;
      }
      return soonest;
    },

    isConnected: (key: ConnKey) => connections.has(key),
    isGranted(key: ConnKey): boolean {
      const scope = currentScopeOf(key);
      return scope !== null && store.answer(scope) === "granted";
    },
    projectOf: (key: ConnKey) => connections.get(key)?.project ?? null,
    framelinkOriginOf: (key: ConnKey) => connections.get(key)?.framelinkOrigin ?? null,
  };
}

export type GrantGate = ReturnType<typeof createGrantGate>;
