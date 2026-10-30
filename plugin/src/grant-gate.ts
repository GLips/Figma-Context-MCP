/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The grant gate. The plugin is the only authority on grants: a run executes only when this plugin
// holds a grant for its server's project on the document the run names, and this file carries that
// document's stamp right now. Checked when a run arrives and again when it dequeues.
//
// A server only asks (GRANT_STATUS), and its asking is what opens a prompt. Two kinds:
// - "allow" asks to grant a project this document. It belongs to the grant scope it would save, not
//   to a call: every call of that project asking here waits on the one prompt, which shows the newest
//   call's intent. It outlives its calls and their sockets, as "stopped waiting", until it is
//   answered, dismissed, the file's stamp changes, or STOPPED_PROMPT_EXPIRY_MS passes.
// - "pick" asks whether this copy is the one a call means. It is that call's alone, keyed by its
//   execution id and the socket generation that asked, and it goes when the call stops polling: a
//   pick only steers the call that asked, so a late one would have nothing to steer.
// Grants are shared by every plugin instance through storage; GRANT_CHANGED tells the others. Each
// call's course goes to the activity feed.
import type { ActivityFeed } from "./activity-feed.js";
import type { DocumentIdentity } from "./document-identity.js";
import { grantKey, type DocumentGrant, type GrantScope, type GrantStore } from "./grant-store.js";
import { currentPluginOwner } from "./link-auth.js";
import { reply, toServer, type ReplyTo } from "./outbound.js";
import type { ConnKey, PanelPrompt } from "./panel.js";
import {
  GRANT_PROMPT_GRACE_MS,
  type DocumentReport,
  type GrantStatusAsk,
  type GrantState,
  type NotGrantedReason,
  type ServerFrame,
} from "./protocol.js";

interface GrantConnection {
  project: string | null;
  framelinkOrigin: string | null;
}

/** One call's pick prompt in this panel, open while its server keeps polling. */
interface PickPrompt {
  key: ConnKey;
  executionId: string;
  // The document the prompt was raised for and shows.
  documentId: string;
  intent: string;
  askedAt: number;
  // `picked` waits for the next poll to carry it.
  state: "open" | "picked";
}

/**
 * One project's Allow prompt on this file. `scope` is captured when it is first asked and is all an
 * Allow ever saves. `waiting`: the calls polling it now, with the socket that asked and their last
 * poll; empty or quiet, the prompt has stopped waiting.
 */
interface AllowPrompt {
  id: string;
  scope: GrantScope;
  // The newest call's: its intent shows, and a Deny is recorded on it.
  executionId: string;
  intent: string;
  lastAskedAt: number;
  waiting: Map<string, { key: ConnKey; polledAt: number }>;
  saving: boolean;
}

/** A prompt as the gate knows it; the panel adds the project's label. */
export type GatePrompt = PanelPrompt extends infer P ? (P extends unknown ? Omit<P, "label"> : never) : never;

/** How long an Allow prompt no call waits on stays in the panel: a working day and the night after. */
export const STOPPED_PROMPT_EXPIRY_MS = 24 * 60 * 60 * 1000;

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

function pickKey(key: ConnKey, executionId: string): string {
  return `${key}\n${executionId}`;
}

export function createGrantGate({
  store,
  identity,
  activity,
  credentialOf,
  authenticatedConnections,
  show,
  cancelRuns,
  takeBaton,
}: {
  store: GrantStore;
  identity: DocumentIdentity;
  activity: ActivityFeed;
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
  const picks = new Map<string, PickPrompt>();
  // Keyed by grantKey(scope): one per credential, owner, project and document.
  const allows = new Map<string, AllowPrompt>();
  // Calls whose Allow prompt was denied, by execution id: each hears "denied" on its next poll.
  const deniedCalls = new Map<string, { key: ConnKey; at: number }>();
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

  function isLivePick(prompt: PickPrompt, now: number): boolean {
    return now - prompt.askedAt < GRANT_PROMPT_GRACE_MS && prompt.documentId === identity.documentId;
  }

  /** Whether any call still polls this Allow prompt: one that stopped polling has stopped waiting. */
  function isWaitedOn(prompt: AllowPrompt, now: number): boolean {
    for (const { polledAt } of prompt.waiting.values()) if (now - polledAt < GRANT_PROMPT_GRACE_MS) return true;
    return false;
  }

  /**
   * Whether an Allow prompt still asks anything: not expired, on the file's current stamp, and its
   * scope not granted since (by another instance, say). One that doesn't is dropped.
   */
  function stillAsks(prompt: AllowPrompt, now: number): boolean {
    const asks =
      now - prompt.lastAskedAt < STOPPED_PROMPT_EXPIRY_MS &&
      prompt.scope.documentId === identity.documentId &&
      store.answer(prompt.scope) !== "granted";
    if (!asks && !prompt.saving) allows.delete(prompt.id);
    return asks;
  }

  /** Keep a call's pick open for another poll; a lapsed one starts over, so no stale pick carries. */
  function askPick(key: ConnKey, project: string, { executionId, documentId, intent }: Extract<GrantStatusAsk, { intent: string }>): void {
    const now = Date.now();
    const id = pickKey(key, executionId);
    const held = picks.get(id);
    if (held && held.documentId === documentId && isLivePick(held, now)) {
      held.askedAt = now;
      return;
    }
    picks.set(id, { key, executionId, documentId, intent, askedAt: now, state: "open" });
    activity.waiting(executionId, intent, project);
    show(true);
  }

  /**
   * A call waits on its project's Allow prompt here: the one already showing for this scope, or a new
   * one. A call new to the prompt makes its intent the one shown.
   */
  function askAllow(key: ConnKey, scope: GrantScope, executionId: string, intent: string): void {
    const now = Date.now();
    const id = grantKey(scope);
    let prompt = allows.get(id);
    if (!prompt) {
      prompt = { id, scope, executionId, intent, lastAskedAt: now, waiting: new Map(), saving: false };
      allows.set(id, prompt);
    }
    const joined = !prompt.waiting.has(executionId);
    prompt.waiting.set(executionId, { key, polledAt: now });
    prompt.lastAskedAt = now;
    if (!joined) return;
    prompt.executionId = executionId;
    prompt.intent = intent;
    activity.waiting(executionId, intent, scope.project);
    show(true);
  }

  /** The call `executionId` on `key` stopped waiting: its pick goes, and it leaves any Allow prompt. */
  function forgetCall(key: ConnKey, executionId: string): void {
    const pickClosed = picks.delete(pickKey(key, executionId));
    deniedCalls.delete(executionId);
    let left = false;
    for (const prompt of allows.values())
      if (prompt.waiting.get(executionId)?.key === key) left = prompt.waiting.delete(executionId) || left;
    if (pickClosed || left) show();
  }

  /** The Allow prompt `executionId` waits on, if any. */
  function allowPromptOf(executionId: string): AllowPrompt | null {
    for (const prompt of allows.values()) if (prompt.waiting.has(executionId)) return prompt;
    return null;
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
    if (identity.rereadDocumentId() !== documentId) return "other-document";
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

    /** A socket closed: its picks go, its calls leave their Allow prompts, and the prompts stay. */
    closed(key: ConnKey): void {
      connections.delete(key);
      for (const [id, prompt] of picks) if (prompt.key === key) picks.delete(id);
      for (const prompt of allows.values())
        for (const [executionId, waiter] of prompt.waiting) if (waiter.key === key) prompt.waiting.delete(executionId);
      for (const [executionId, denied] of deniedCalls) if (denied.key === key) deniedCalls.delete(executionId);
      show();
    },

    /**
     * A server says who it is, over an authenticated link. Returns this file's report for the reply,
     * which the caller sends: the server's first question must find the fresh grant read in flight.
     */
    introduce(to: ReplyTo, msg: Extract<ServerFrame, { type: "INTRODUCE" }>): DocumentReport {
      const conn = connections.get(to.connKey);
      if (conn) {
        conn.project = msg.project;
        conn.framelinkOrigin = msg.framelinkOrigin;
      }
      refreshConnectionGrants([to.connKey]);
      show();
      return identity.rereadReport();
    },

    /** The file's stamp is new: grants and prompts on the old one no longer apply here. */
    documentChanged(): void {
      for (const [id, prompt] of picks) if (prompt.documentId !== identity.documentId) picks.delete(id);
      for (const [id, prompt] of allows) if (prompt.scope.documentId !== identity.documentId) allows.delete(id);
      refreshConnectionGrants(connections.keys());
      void refreshDocumentGrants();
    },

    /** Answer a GRANT_STATUS poll for one call, opening or keeping the prompt it asks for. */
    async answerStatus(to: ReplyTo, request: Extract<ServerFrame, { type: "GRANT_STATUS" }>): Promise<void> {
      const { executionId, documentId } = request;
      const answer = (state: GrantState) => reply(to, { type: "GRANT", state });
      const conn = connections.get(to.connKey);
      if (!conn || conn.project === null) return answer("absent");
      const { project } = conn;
      if (identity.rereadDocumentId() !== documentId) {
        forgetCall(to.connKey, executionId);
        return answer("other-document");
      }
      const scope = scopeOf(to.connKey, documentId);
      if (!scope) return answer("absent");
      if (request.prompt === "none") return answer((await store.settledAnswer(scope)) === "granted" ? "granted" : "absent");
      if (request.prompt === "pick") {
        const held = picks.get(pickKey(to.connKey, executionId));
        if (held?.documentId === documentId && held.state === "picked") {
          activity.advance(executionId, "picked");
          forgetCall(to.connKey, executionId);
          return answer("picked");
        }
        askPick(to.connKey, project, request);
        return answer("pending");
      }
      if (deniedCalls.get(executionId)?.key === to.connKey) {
        forgetCall(to.connKey, executionId);
        return answer("denied");
      }
      if ((await store.settledAnswer(scope)) === "granted") {
        // Only a call that waited here has a feed entry to move on; one already granted has none yet.
        if (allowPromptOf(executionId)) activity.advance(executionId, "allowed");
        forgetCall(to.connKey, executionId);
        return answer("granted");
      }
      askAllow(to.connKey, scope, executionId, request.intent);
      return answer("pending");
    },

    /**
     * The call `executionId` stopped waiting. Its pick goes; an Allow prompt it waited on stays, as
     * stopped waiting, for the human to answer for the project's next call.
     */
    closePrompt(to: ReplyTo, executionId: string): void {
      forgetCall(to.connKey, executionId);
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
     * The human's Allow on a project's prompt, waited on or not: save exactly the scope the prompt
     * captured when asked and showed (credential, owner, project, this document) and nothing else.
     * A newer stamp is never granted: if the file was given another identity since, nothing is. It
     * runs nothing either: a grant only admits calls that arrive later, each checked again on
     * arrival and at dequeue. So a late click carries no further than what the human saw.
     */
    allow(promptId: string): void {
      const prompt = allows.get(promptId);
      if (!prompt || prompt.saving || !stillAsks(prompt, Date.now())) return;
      const { scope } = prompt;
      if (identity.rereadDocumentId() !== scope.documentId) return;
      prompt.saving = true;
      show();
      void store
        .grant(scope)
        .then(
          () => {
            notifyGrantChanged(scope, true);
            void refreshDocumentGrants();
            // Calls still polling move on at their next poll, which reads the grant from storage.
            allows.delete(promptId);
          },
          (error: unknown) => figma.notify(`Framelink couldn't save that grant: ${String(error)}`, { error: true }),
        )
        .finally(() => {
          prompt.saving = false;
          show();
        });
    },

    /**
     * The human's Deny on a project's prompt: every call waiting on it is refused, and the newest
     * call's entry in the feed reads denied. The project's next call asks again.
     */
    deny(promptId: string): void {
      const prompt = allows.get(promptId);
      if (!prompt || prompt.saving) return;
      allows.delete(promptId);
      const now = Date.now();
      for (const [executionId, { key }] of prompt.waiting) {
        deniedCalls.set(executionId, { key, at: now });
        activity.advance(executionId, "denied");
      }
      activity.advance(prompt.executionId, "denied");
      show();
    },

    /** The human put away a prompt no call waits on any more. Nothing is granted or recorded. */
    dismiss(promptId: string): void {
      const prompt = allows.get(promptId);
      if (!prompt || prompt.saving || isWaitedOn(prompt, Date.now())) return;
      allows.delete(promptId);
      show();
    },

    /** The human chose this copy for one call. It grants nothing. */
    pick(key: ConnKey, executionId: string, documentId: string): void {
      const prompt = picks.get(pickKey(key, executionId));
      if (!prompt || prompt.documentId !== documentId || prompt.state !== "open") return;
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
        activity.advance(to.id, "refused");
        reply(to, { type: "NOT_GRANTED", reason: answer });
        return null;
      }
      // Non-null: either answer came from the store, which needs the scope to give one.
      return scopeOf(to.connKey, documentId)!;
    },

    /** The grant scope a run on this connection would run under, after re-reading the stamp. */
    rereadScopeOf(key: ConnKey): GrantScope | null {
      const documentId = identity.rereadDocumentId();
      return documentId ? scopeOf(key, documentId) : null;
    },

    /** The check again at dequeue, once storage has a definite answer: null admits. */
    async refusalAtDequeue(key: ConnKey, documentId: string): Promise<NotGrantedReason | null> {
      if (identity.rereadDocumentId() !== documentId) return "other-document";
      const scope = scopeOf(key, documentId);
      if (!scope || (await store.settledAnswer(scope)) !== "granted") return "no-grant";
      takeBaton(key);
      return null;
    },

    /**
     * The check for a read that is no run (ANNOTATION_CHANGES): the dequeue check's settled answer,
     * without taking the baton, since a read doesn't drive the document. Null admits.
     */
    async readRefusal(key: ConnKey, documentId: string): Promise<NotGrantedReason | null> {
      if (identity.rereadDocumentId() !== documentId) return "other-document";
      const scope = scopeOf(key, documentId);
      return scope && (await store.settledAnswer(scope)) === "granted" ? null : "no-grant";
    },

    rows,

    /**
     * Every prompt for the human, oldest first: each call's live pick, and each project's Allow
     * prompt, waited on or not.
     */
    prompts(now: number): GatePrompt[] {
      const result: GatePrompt[] = [];
      for (const prompt of allows.values()) {
        if (!stillAsks(prompt, now)) continue;
        const { id, scope, intent, saving } = prompt;
        result.push({ kind: "allow", id, project: scope.project, intent, waitedOn: isWaitedOn(prompt, now), allowing: saving });
      }
      for (const prompt of picks.values()) {
        const project = connections.get(prompt.key)?.project ?? null;
        if (project === null || !isLivePick(prompt, now) || prompt.state !== "open") continue;
        const { key, executionId, documentId, intent } = prompt;
        result.push({ kind: "pick", key, executionId, project, documentId, intent });
      }
      return result;
    },

    /** Whether the call `executionId` still waits on a prompt here, in any connection. */
    promptLive(executionId: string, now: number): boolean {
      for (const prompt of picks.values())
        if (prompt.executionId === executionId && isLivePick(prompt, now)) return true;
      const waiter = allowPromptOf(executionId)?.waiting.get(executionId);
      return waiter !== undefined && now - waiter.polledAt < GRANT_PROMPT_GRACE_MS;
    },

    /** When the panel next changes on its own: a call stops waiting, or a stopped prompt expires. */
    nextPromptLapse(now: number): number | null {
      let soonest: number | null = null;
      const consider = (at: number) => {
        if (at > now && (soonest === null || at < soonest)) soonest = at;
      };
      for (const prompt of picks.values()) if (isLivePick(prompt, now)) consider(prompt.askedAt + GRANT_PROMPT_GRACE_MS);
      for (const prompt of allows.values()) {
        for (const { polledAt } of prompt.waiting.values()) consider(polledAt + GRANT_PROMPT_GRACE_MS);
        consider(prompt.lastAskedAt + STOPPED_PROMPT_EXPIRY_MS);
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
