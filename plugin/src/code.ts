/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Plugin sandbox entry. This is the only context where `figma.*` lives. It never touches the network —
// it talks to the relay iframe (ui.ts) via postMessage — and it only routes: link authentication
// (link-auth.ts), the consent gate (approval-gate.ts), the runner (run-executor.ts) and the panel
// (session-panel.ts) do the work.
import { createApprovalGate } from "./approval-gate.js";
import { createLinkAuth } from "./link-auth.js";
import { createRunExecutor } from "./run-executor.js";
import { createSessionPanel } from "./session-panel.js";
import { reply, type ReplyTo } from "./outbound.js";
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

const gate = createApprovalGate({
  show: (expandTo) => panel.show(expandTo),
  cancelRuns: (key) => executor.cancelConnection(key, "revoked"),
  takeBaton: (key) => panel.takeBaton(key),
});
const linkAuth = createLinkAuth({ show: (expandTo) => panel.show(expandTo) });
const panel = createSessionPanel(gate.panelSource, () => linkAuth.pairingRows());
const executor = createRunExecutor({
  isConnected: gate.isConnected,
  settledApprovalOf: gate.settledApprovalOf,
  gateWrite: gate.gateWrite,
});
void gate.ready.then(() => panel.render());

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
      // First, kill this session's runs: a reply to their server calls can never arrive, and the
      // server already reported every in-flight caller failed. Then its row goes (or turns away).
      executor.cancelConnection(msg.connKey, "disconnected");
      panel.forget(msg.connKey);
      linkAuth.closed(msg.connKey);
      gate.closed(msg.connKey);
      return;
    case "UI_DECISION":
      gate.decide(msg.connKey, msg.approve);
      return;
    case "UI_REVOKE":
      panel.dropBaton(msg.connKey);
      gate.revoke(msg.connKey);
      return;
    case "UI_REVOKE_ALL":
      panel.dropBaton();
      gate.revokeAll();
      return;
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
    case "SESSION_INFO":
      // Acked at once: approval arrives later via the panel, never by blocking here.
      reply(to, { type: "SESSION_INFO_ACK" });
      gate.introduce(key, msg);
      return;
    case "APPROVAL_STATUS":
      gate.answerStatus(to);
      return;
    case "EXECUTE_CODE":
      // The consent gate refuses an unapproved session here and again at dequeue. A request missing
      // its std-lib never got this far: the parser refused it, so no human is asked to consent to
      // something that could not run.
      if (gate.gateWrite(to, gate.approvalOf(key)))
        executor.runCode(to, msg.code, msg.preamble, msg.lateChangeWindowMs);
      return;
    case "SCREENSHOT":
      if (gate.gateWrite(to, gate.approvalOf(key))) {
        const { nodeId, key: nodeKey, scale, context, margin } = msg;
        executor.runScreenshot(to, { nodeId, key: nodeKey }, { scale, context, margin });
      }
      return;
    case "WRITE_ACCESS":
      panel.noteWriteAccess(key, msg.notice);
      reply(to, { type: "WRITE_ACCESS_ACK" });
      return;
  }
}
