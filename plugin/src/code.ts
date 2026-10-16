/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Plugin sandbox entry. This is the only context where `figma.*` lives. It never touches the network —
// it talks to the relay iframe (ui.ts) via postMessage — and it only routes: link authentication
// (link-auth.ts), document identity (document-identity.ts), the grant gate (grant-gate.ts), the
// runner (run-executor.ts) and the panel (session-panel.ts) do the work.
import { createDocumentIdentity } from "./document-identity.js";
import { createGrantGate } from "./grant-gate.js";
import { createGrantStore } from "./grant-store.js";
import { createLinkAuth } from "./link-auth.js";
import { createRunExecutor } from "./run-executor.js";
import { createSessionPanel } from "./session-panel.js";
import { reply, toServer, type ReplyTo } from "./outbound.js";
import { PROTOCOL_VERSION, parseServerFrame } from "./protocol.js";
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
const linkAuth = createLinkAuth({ show: (expandTo) => panel.show(expandTo) });
const identity = createDocumentIdentity({
  show: () => panel.show(),
  onProven: (document) => {
    gate.documentProven(document);
    // Every other server proves it for itself; this saves each of them waiting for a call to ask.
    offerClaim(document.fileKey);
  },
});
function offerClaim(fileKey: string): void {
  for (const key of linkAuth.authenticatedConnections()) toServer(key, { type: "DOCUMENT_CLAIMED", fileKey });
}
const gate = createGrantGate({
  store: grants,
  identity,
  credentialOf: linkAuth.credentialOf,
  authenticatedConnections: linkAuth.authenticatedConnections,
  show: (expandTo) => panel.show(expandTo),
  cancelRuns: (key) => {
    panel.dropBaton(key);
    executor.cancelConnection(key, "revoked");
  },
  takeBaton: (key) => panel.takeBaton(key),
});
const panel = createSessionPanel({
  rows: gate.rows,
  nextPromptLapse: gate.nextPromptLapse,
  document: (now) => {
    if (identity.document) return { kind: "proven", fileName: identity.document.fileName };
    if (!linkAuth.authenticatedConnections().length) return null;
    return { kind: "unproven", asking: gate.isAsking(now), pasted: identity.pastedLink };
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
const executor = createRunExecutor({
  isConnected: gate.isConnected,
  refusalAtDequeue: gate.refusalAtDequeue,
});
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
    case "WS_CONNECTED":
      gate.connected(msg.connKey);
      return;
    case "WS_CLOSED":
      // First, kill this server's runs: a reply to their server calls can never arrive, and the
      // server already reported every in-flight caller failed. Then its row goes.
      executor.cancelConnection(msg.connKey, "disconnected");
      panel.forget(msg.connKey);
      linkAuth.closed(msg.connKey);
      identity.closed(msg.connKey);
      gate.closed(msg.connKey);
      return;
    case "UI_DECISION":
      if (msg.approve) gate.allow(msg.connKey);
      else gate.deny(msg.connKey);
      return;
    case "UI_REVOKE":
      gate.revoke({ credentialId: msg.credentialId, project: msg.project });
      return;
    case "UI_PASTE_LINK": {
      // A claim for every server to prove, never an identity: a pasted link proves nothing itself.
      const fileKey = identity.paste(msg.text);
      if (fileKey === null) {
        figma.notify("Framelink: that isn't a link to a Figma design file.", { error: true });
        return;
      }
      offerClaim(fileKey);
      return;
    }
    case "UI_SIGN_IN":
      panel.requestSignIn(msg.connKey);
      return;
    case "UI_OPEN_SIGN_IN":
      panel.openSignIn(msg.connKey);
      return;
  }
}

/**
 * A frame one server sent over its socket (`key` names the socket generation). Server REQUESTS all
 * carry ids and each gets exactly one reply — including one this plugin can't admit, which is
 * answered ERROR. CANCEL and CHANNEL_RESPONSE are one-way.
 */
function handleServerFrame(raw: unknown, key: ConnKey): void {
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
    executor.cancel(key, msg.runId);
    return;
  }
  // Reverse-direction replies: answers to PLUGIN-issued requests, in the plugin's id namespace.
  if (msg.type === "CHANNEL_RESPONSE") {
    executor.settleServerCall(msg, key);
    return;
  }
  const to: ReplyTo = { id: msg.id, connKey: key };
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
      gate.introduce(to, msg);
      return;
    case "PROVE_DOCUMENT":
      identity.writeProof(to, msg.nonce);
      return;
    case "PROOF_SETTLED":
      identity.proofSettled(to, msg.nonce, msg.outcome);
      return;
    case "GRANT_STATUS":
      void gate.answerStatus(to, msg.fileKey, msg.prompt);
      return;
    case "GRANT_PROMPT_CLOSED":
      gate.closePrompt(to);
      return;
    case "GRANT_CHANGED_ELSEWHERE":
      void gate.changedElsewhere(to, msg.project, msg.fileKey);
      return;
    case "EXECUTE_CODE":
      // The grant gate refuses here and again at dequeue. A request missing its std-lib or its
      // document never got this far: the parser refused it.
      if (gate.admit(to, msg.fileKey))
        executor.runCode(to, msg.fileKey, msg.code, msg.preamble, msg.lateChangeWindowMs);
      return;
    case "SCREENSHOT":
      if (gate.admit(to, msg.fileKey)) {
        const { nodeId, key: nodeKey, scale, context, margin } = msg;
        executor.runScreenshot(to, msg.fileKey, { nodeId, key: nodeKey }, { scale, context, margin });
      }
      return;
    case "WRITE_ACCESS":
      panel.noteWriteAccess(key, msg.notice);
      reply(to, { type: "WRITE_ACCESS_ACK" });
      return;
  }
}
