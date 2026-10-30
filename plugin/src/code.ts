/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Plugin sandbox entry. This is the only context where `figma.*` lives. It never touches the network —
// it talks to the relay iframe (ui.ts) via postMessage — and it only routes: link authentication
// (link-auth.ts), the file's stamp (document-identity.ts), the grant gate (grant-gate.ts), the
// runner (run-executor.ts) and the panel (grant-panel.ts) do the work.
import { createActivityFeed } from "./activity-feed.js";
import { createAnnotationChangeLog, readAnnotationChanges, watchAnnotationChanges } from "./annotation-changes.js";
import { watchForFigmaPause } from "./figma-pause.js";
import { createDocumentIdentity } from "./document-identity.js";
import { createPluginPresence } from "./presence.js";
import { createGrantGate } from "./grant-gate.js";
import { createGrantStore, grantKey } from "./grant-store.js";
import { createAgentSessions } from "./agent-sessions.js";
import { createLinkAuth, currentPluginOwner } from "./link-auth.js";
import { createRunExecutor } from "./run-executor.js";
import { createGrantPanel } from "./grant-panel.js";
import { reply, toServer, type ReplyTo } from "./outbound.js";
import {
  LINK_SETUP_REQUEST_TYPES,
  MAX_SELECTION_NAMES,
  PROTOCOL_VERSION,
  parseServerFrame,
  type AnnotationChange,
  type AnnotationCursor,
  type ServerRequestType,
} from "./protocol.js";
import type { ConnKey, HostInbound, PanelControl } from "./panel.js";

// The plugin release, answered beside PROTOCOL_VERSION to the server's HELLO and shown to the human
// in a skew refusal. Informational: the server gates on the protocol alone (protocol.ts).
const PLUGIN_VERSION = "0.1.0";

/** The toast for a server on another protocol. Worded here, so a peer can't author it. */
function skewNotice(serverProtocol: number): string {
  const fix =
    serverProtocol > PROTOCOL_VERSION
      ? "Re-import the latest Framelink plugin (Plugins → Development → Import plugin from manifest…), re-open it, then retry."
      : "Update the Framelink MCP server to the latest figma-developer-mcp, restart it, then retry.";
  return (
    `Framelink: a connected server speaks plugin protocol v${serverProtocol}, and this plugin ` +
    `(v${PLUGIN_VERSION}) speaks v${PROTOCOL_VERSION}, so nothing was run. ${fix}`
  );
}

let grantStorageError: string | null = null;
const grants = createGrantStore(
  {
    get: (key) => figma.clientStorage.getAsync(key),
    set: async (key, value) => {
      await figma.clientStorage.setAsync(key, value);
      grantStorageError = null;
    },
    delete: (key) => figma.clientStorage.deleteAsync(key),
    keys: () => figma.clientStorage.keysAsync(),
  },
  (error) => {
    grantStorageError = `Grant storage failed: ${String(error)}. Changes may not survive reopening.`;
    figma.notify(grantStorageError, { error: true, timeout: 15000 });
  },
);
const activity = createActivityFeed(() => panel.show());
const linkAuth = createLinkAuth({ show: (expandTo) => panel.show(expandTo) });
const identity = createDocumentIdentity({
  // Queued runs need nothing here: each re-reads the stamp at dequeue and is refused under the old one.
  onChanged: () => {
    sessions.clear();
    gate.documentChanged();
  },
  onReport: (document) => {
    for (const key of linkAuth.authenticatedConnections()) toServer(key, { type: "DOCUMENT_REPORTED", document });
    presence.changed();
    panel.show();
  },
});
const gate = createGrantGate({
  store: grants,
  identity,
  activity,
  credentialOf: linkAuth.credentialOf,
  authenticatedConnections: linkAuth.authenticatedConnections,
  show: (expandTo) => panel.show(expandTo),
  cancelRuns: (key) => {
    panel.dropBaton(key);
    executor.cancelConnection(key, "revoked");
  },
  takeBaton: (key) => panel.takeBaton(key),
});
const panel = createGrantPanel({
  rows: gate.rows,
  prompts: gate.prompts,
  activity: (now) => activity.entries((executionId) => gate.promptLive(executionId, now)),
  nextPromptLapse: gate.nextPromptLapse,
  document: () => {
    if (!linkAuth.authenticatedConnections().length) return null;
    const report = identity.report();
    return report.kind === "identified"
      ? { kind: "identified", fileName: report.fileName, documentId: report.documentId }
      : report;
  },
  pairings: () => linkAuth.pairingRows(),
  get storageError() {
    return grantStorageError;
  },
  isConnected: gate.isConnected,
  isGranted: gate.isGranted,
  projectOf: gate.projectOf,
  framelinkOriginOf: gate.framelinkOriginOf,
});
// One store per session handle, kept across socket generations and pages for this plugin run.
const sessions = createAgentSessions();
const figmaPause = watchForFigmaPause();
const executor = createRunExecutor({
  figmaPause,
  isConnected: gate.isConnected,
  refusalAtDequeue: gate.refusalAtDequeue,
  sessions,
  activity,
});
// Random per plugin run, so a watcher's cursor from before a reload is recognised as stale.
const annotationLog = createAnnotationChangeLog({
  epoch: Math.random().toString(36).slice(2, 14),
  onSettled: (cursor) => {
    for (const key of linkAuth.authenticatedConnections()) toServer(key, { type: "ANNOTATIONS_CHANGED", cursor });
  },
});
watchAnnotationChanges(annotationLog);
identity.start();
// Whether the panel iframe is showing, as it last said: its tab or window is the one in front. True
// until told otherwise, since the human just opened the plugin.
let panelVisible = true;
const presence = createPluginPresence({
  storage: {
    get: (key) => figma.clientStorage.getAsync(key),
    set: (key, value) => figma.clientStorage.setAsync(key, value),
    delete: (key) => figma.clientStorage.deleteAsync(key),
    keys: () => figma.clientStorage.keysAsync(),
  },
  describe: () => {
    const report = identity.report();
    if (report.kind !== "identified" || identity.documentId === null) return null;
    const selection = figma.currentPage.selection;
    return {
      documentId: report.documentId,
      fileName: report.fileName,
      ...(report.fileKey ? { fileKey: report.fileKey } : {}),
      currentPage: figma.currentPage.name,
      pageCount: figma.root.children.length,
      selection: { count: selection.length, names: selection.slice(0, MAX_SELECTION_NAMES).map((node) => node.name) },
      active: panelVisible,
    };
  },
  grantKeysOf: async (documentId) => {
    const owner = currentPluginOwner();
    if (!owner) return [];
    const held = await grants.grantsOnDocument(owner.figmaUserId, documentId);
    return held.map((grant) => grantKey({ ...grant, ownerId: owner.figmaUserId, documentId }));
  },
});
presence.start();
figma.on("selectionchange", () => presence.changed());
figma.on("currentpagechange", () => presence.changed());
panel.render();

figma.ui.onmessage = (inbound: HostInbound) => {
  if (inbound.from === "panel") handlePanelControl(inbound.control);
  else handleServerFrame(inbound.frame, inbound.connKey);
};

/**
 * Local CONTROL from the relay iframe: the human's clicks in the panel, the iframe's own measurements,
 * and the relay's connect/close signals. None traverse the WS, so none carry an id or get a reply.
 */
function handlePanelControl(msg: PanelControl): void {
  switch (msg.type) {
    case "UI_READY":
      // The iframe asks for its first paint once it has loaded.
      panel.render();
      return;
    case "UI_TOGGLE":
      panel.toggle();
      return;
    case "UI_HEIGHT":
      panel.resize(msg.height);
      return;
    case "UI_VISIBILITY":
      panelVisible = msg.visible;
      presence.changed();
      return;
    case "WS_CONNECTED":
      gate.connected(msg.connKey);
      return;
    case "WS_CLOSED":
      // First, kill this server's runs: a reply to their server calls can never arrive, and the
      // server already reported every in-flight caller failed. Then its row goes.
      executor.cancelConnection(msg.connKey, "disconnected");
      panel.forget(msg.connKey);
      linkAuth.closed(msg.connKey);
      gate.closed(msg.connKey);
      return;
    case "UI_DECISION":
      if (msg.approve) gate.allow(msg.promptId);
      else gate.deny(msg.promptId);
      presence.changed();
      return;
    case "UI_DISMISS":
      gate.dismiss(msg.promptId);
      return;
    case "UI_PICK":
      gate.pick(msg.connKey, msg.executionId, msg.documentId);
      return;
    case "UI_RESTAMP":
      void identity.restamp(executor.idle);
      return;
    case "UI_REVOKE":
      gate.revoke({ credentialId: msg.credentialId, project: msg.project });
      presence.changed();
      return;
    case "UI_SIGN_IN":
      panel.requestSignIn(msg.connKey);
      return;
    case "UI_OPEN_SIGN_IN":
      panel.openSignIn(msg.connKey);
      return;
  }
}

function isLinkSetupRequest(type: ServerRequestType): boolean {
  return (LINK_SETUP_REQUEST_TYPES as readonly ServerRequestType[]).includes(type);
}

/**
 * A frame one server sent over its socket (`key` names the socket generation). Server REQUESTS all
 * carry ids and each gets exactly one reply — including one this plugin can't admit, which is
 * answered ERROR. CANCEL, WITHDRAW, RUN_STATUS_REQUEST and CHANNEL_RESPONSE are one-way.
 */
function handleServerFrame(raw: unknown, key: ConnKey): void {
  figmaPause.arm();
  presence.touch();
  const msg = parseServerFrame(raw);
  if (!msg) {
    // Frozen-envelope contract: every id-carrying inbound gets a reply, so a newer server against
    // this (older) plugin fails fast and readably rather than at its deadline.
    const id = (raw as { id?: unknown } | null)?.id;
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof id === "string")
      reply({ id, connKey: key }, {
        type: "ERROR",
        error:
          `This Figma plugin (protocol v${PROTOCOL_VERSION}) can't read the server's ${JSON.stringify(type)} ` +
          "request — the server and plugin may be different versions. Update both.",
      });
    return;
  }
  if (msg.type === "CANCEL") {
    executor.cancel(key, msg.executionId);
    return;
  }
  // Before the auth check on purpose: an unauthenticated link tracks no runs, so it hears nothing.
  if (msg.type === "RUN_STATUS_REQUEST") {
    executor.statusRequested(key);
    return;
  }
  if (msg.type === "WITHDRAW") {
    executor.withdraw(key, msg.executionId);
    return;
  }
  // Reverse-direction replies: answers to PLUGIN-issued requests, in the plugin's id namespace.
  if (msg.type === "CHANNEL_RESPONSE") {
    executor.settleServerCall(msg, key);
    return;
  }
  const to: ReplyTo = { id: msg.id, connKey: key };
  if (!isLinkSetupRequest(msg.type) && linkAuth.credentialOf(key) === null) {
    // An unauthenticated socket may be anything on a port in the block: it learns nothing about this
    // file and sees no grant.
    reply(to, { type: "ERROR", error: "This plugin link hasn't authenticated, so the plugin refused that request." });
    return;
  }
  switch (msg.type) {
    case "HELLO":
      // Human channel of a version mismatch: the plugin words the toast from the number, so a peer
      // can never put its own text in front of the human.
      if (msg.serverProtocol !== PROTOCOL_VERSION) figma.notify(skewNotice(msg.serverProtocol), { timeout: 15_000 });
      reply(to, { type: "HELLO_RESULT", pluginVersion: PLUGIN_VERSION, protocolVersion: PROTOCOL_VERSION });
      return;
    case "AUTHENTICATE":
      void linkAuth.authenticate(to, msg.credentialId, msg.nonce);
      return;
    case "PAIRING_OFFER":
      linkAuth.offer(to, msg.code, msg.expiresInMs);
      return;
    case "PAIRING_CLOSED":
      linkAuth.closeOffer(to, msg.code);
      return;
    case "PAIR_CONFIRMED":
      void linkAuth.storeCredential(to, msg.code, msg.credentialId, msg.secret);
      return;
    case "INTRODUCE":
      reply(to, { type: "INTRODUCED", document: gate.introduce(to, msg), instance: presence.instance });
      return;
    case "OPEN_INSTANCES": {
      const credentialId = linkAuth.credentialOf(key);
      const owner = currentPluginOwner();
      const project = gate.projectOf(key);
      const asker =
        credentialId !== null && owner !== null && project !== null
          ? { credentialId, ownerId: owner.figmaUserId, project }
          : null;
      // A storage failure is the server's to see: an ERROR, never a list missing every other file.
      presence.openInstances(asker).then(
        (openInstances) => reply(to, { type: "OPEN_INSTANCES_RESULT", openInstances }),
        (error: unknown) => reply(to, { type: "ERROR", error: `The plugin couldn't read which files are open: ${String(error)}` }),
      );
      return;
    }
    case "GRANT_STATUS":
      void gate.answerStatus(to, msg);
      return;
    case "GRANT_PROMPT_CLOSED":
      gate.closePrompt(to, msg.executionId);
      return;
    case "GRANT_CHANGED_ELSEWHERE":
      void gate.changedElsewhere(to, msg.project, msg.documentId);
      presence.changed();
      return;
    case "SESSION_LOOKUP": {
      const scope = gate.rereadScopeOf(key);
      reply(to, { type: "SESSION_LOOKUP_RESULT", held: scope !== null && sessions.holds(scope, msg.handle) });
      return;
    }
    case "EXECUTE_CODE": {
      // The grant gate refuses here and again at dequeue; the session is checked here only, and
      // pinned until the run settles. A request missing its std-lib, document, session or intent
      // never got this far: the parser refused it.
      activity.arrived(msg.id, msg.intent, gate.projectOf(key));
      if (refuseWhileFigmaPaused(to)) return;
      const scope = gate.admit(to, msg.documentId);
      if (!scope) return;
      const admission = sessions.admit(scope, msg.session);
      if (admission.kind !== "admitted") {
        activity.advance(msg.id, "refused");
        reply(to, { type: admission.kind === "taken" ? "SESSION_HANDLE_TAKEN" : "SESSION_NOT_FOUND" });
        return;
      }
      executor.runCode(to, msg.documentId, admission.session, msg.intent, msg.code, msg.preamble);
      return;
    }
    case "SCREENSHOT":
      activity.arrived(msg.id, msg.intent, gate.projectOf(key));
      if (refuseWhileFigmaPaused(to)) return;
      if (gate.admit(to, msg.documentId)) {
        const { nodeId, key: nodeKey, scale, context, margin } = msg;
        executor.runScreenshot(to, msg.documentId, msg.intent, { nodeId, key: nodeKey }, { scale, context, margin });
      }
      return;
    case "ANNOTATION_CHANGES":
      void answerAnnotationChanges(to, msg.documentId, msg.after);
      return;
    case "WRITE_ACCESS":
      panel.noteWriteAccess(key, msg.notice);
      reply(to, { type: "WRITE_ACCESS_ACK" });
      return;
  }
}

/**
 * A watching server's read. Not in the activity feed: a watcher reads on every notice and every few
 * seconds besides, and would bury every real call. The grant is checked again last, after every
 * await, since it may have been revoked or the file re-stamped while the read ran.
 */
async function answerAnnotationChanges(to: ReplyTo, documentId: string, after: AnnotationCursor | null): Promise<void> {
  const refusedBefore = await gate.readRefusal(to.connKey, documentId);
  if (refusedBefore) return reply(to, { type: "NOT_GRANTED", reason: refusedBefore });
  const slice = annotationLog.slice(after);
  let changes: AnnotationChange[];
  try {
    changes = await readAnnotationChanges(slice.nodeIds);
  } catch (error) {
    return reply(to, { type: "ERROR", error: `The plugin couldn't read the changed annotations: ${String(error)}` });
  }
  const refusedAfter = await gate.readRefusal(to.connKey, documentId);
  if (refusedAfter) return reply(to, { type: "NOT_GRANTED", reason: refusedAfter });
  const { cursor, restarted, overflowed } = slice;
  reply(to, { type: "ANNOTATION_CHANGES_RESULT", cursor, changes, restarted, overflowed });
}

/** A run accepted while Figma has us paused could only queue, unable to finish; refuse it now. */
function refuseWhileFigmaPaused(to: ReplyTo): boolean {
  const pausedMs = figmaPause.pausedForMs();
  if (pausedMs === null) return false;
  activity.advance(to.id, "refused");
  reply(to, { type: "FIGMA_PAUSED", pausedMs });
  return true;
}
