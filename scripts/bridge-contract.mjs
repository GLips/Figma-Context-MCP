// Port-free contract check for the PluginBridge's frozen envelope + connection
// hardening (Phase 1, Slice 1.1). Drives the REAL bridge against a fake "plugin"
// WS client that mirrors code.ts's reply contract, asserting the load-bearing
// security/forward-compat guarantees that a refactor could silently undo:
//
//   • Origin:null (the sandboxed Figma iframe) connects; a web origin is refused.
//   • A second connection does NOT displace an established one (anti-hijack).
//   • An unrecognized message type round-trips a readable error FAST — never the
//     15s timeout, never a silent drop.
//   • A reply carries nothing back from its request but the correlation id — the server
//     correlates by id alone and must never depend on pass-through metadata.
//
// Slice 1.2 adds the version handshake, which rides that same envelope:
//   • GET_VERSION round-trips {pluginVersion, protocolVersion} from a current plugin.
//   • detectSkew treats a missing version as the floor (nudge), a current one as clean —
//     never rejects, so it can't brick the stale plugin the nudge exists to rescue.
//   • The bridge's per-connection skew note clears on disconnect.
//
// Slice 2.1 adds the consent gate over the same envelope:
//   • A 4-digit pairing code is minted per connection; SESSION_INFO introduces the identity.
//   • A write before approval is gated (PENDING_APPROVAL) — never runs, never a hard error.
//   • A simulated Allow (UI_DECISION) lets the same write run.
//   • Approval is sticky across reconnects (server echoes the session token → no re-prompt).
//
// Slice 2.1b re-keys sticky approval on a minted session token (security fix to 2.1):
//   • On Allow the sandbox mints a token, hands it to the server (unsolicited SESSION_TOKEN),
//     and the server persists it OUTSIDE the connection-scoped cluster (survives reconnects).
//   • The server echoes the token in every SESSION_INFO, so the legit reconnect stays approved.
//   • A same-path squatter (same identity, NO token) falls back to PENDING_APPROVAL — the
//     forgeable identity no longer carries approval (the regression this slice pins).
//
// Slice 2.2 (arbiter panel UI) adds NOTHING to this contract: the panel show/hide channel and
// the Allow/Deny buttons live entirely in the sandbox↔ui.html postMessage path (SHOW_PANEL/
// HIDE_PANEL/UI_DECISION) and never cross the WS. The WS-facing seams it builds on — SESSION_INFO,
// PENDING_APPROVAL, and the SESSION_TOKEN handover — are already pinned above (Slice 2.1/2.1b). The
// panel's visible render + click flow runs only in Figma; it is verified by hand (see the slice's
// human-verification steps), not here.
//
// Phase 3 Slice 3.1 adds port-range discovery on the server side:
//   • Each server probe-binds the FIRST free port in the block, advancing on EADDRINUSE — two
//     servers sharing one block land on distinct ports (the multi-session foundation).
//   • The manifest's networkAccess.devAllowedDomains mirrors config's WS_PORT_BLOCK exactly, so a
//     session on any block port needs no manifest edit (Done-when #2).
//
// Phase 3 Slice 3.2 adds the plugin-side multi-connection model (ui.html scans the whole block;
// the sandbox keys a per-connection map by source port; one active driver writes). That logic lives
// entirely in the sandbox↔ui.html postMessage path (the __connKey routing, the connection map, the
// active-driver gate) and runs only in Figma, so it is verified by hand, not pinned here — the WS
// envelope the server sees is UNCHANGED (ui.html strips __connKey before ws.send). The one thing
// this harness can pin is the mechanical mirror: ui.html now carries its own WS_PORT_BLOCK literal
// (it scans every port), checked against config's block exactly like the manifest above.
//
// Slice 1.3 adds connection-liveness hardening over the same single slot:
//   • Heartbeat reaps a half-open holder (handshaked but no pong) so the live plugin reconnects;
//     an established holder still blocks a 2nd connection until then (1.1 anti-hijack preserved).
//   • A new connection reclaims the slot from a non-handshaking holder (then handshakes and drives).
//   • A reclaimed connection's late handshake result can't clobber the newcomer (epoch guard).
//
// Usage:  pnpm contract   (or: npx tsx scripts/bridge-contract.mjs)
//
// The fake plugin re-implements code.ts's reply shape rather than importing it —
// code.ts runs only inside Figma's sandbox (figma.* globals, preamble eval), so
// this exercises the server half of the contract against a faithful stand-in.

import { WebSocket } from "ws";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PluginBridge } from "../src/services/plugin-bridge/bridge.ts";
import { ApprovalStore } from "../src/services/plugin-bridge/approval-store.ts";
import { detectSkew, MIN_PROTOCOL_VERSION } from "../src/services/plugin-bridge/version.ts";
import { SESSION_IDENTITY } from "../src/services/plugin-bridge/approval.ts";
import { WS_PORT_BLOCK } from "../src/services/plugin-bridge/ports.ts";

const PORT = 19876;
const URL = `ws://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Every bridge gets its OWN empty persistence dir, so the durable-approval store (keyed by cwd, one
// file shared by all bridges in this one process) can't cross-contaminate the WS-contract tests — a
// token `bridge` persists on Allow must NOT be reloaded by `squatBridge`, whose whole point is holding
// no token. The dedicated restart test below opts INTO a shared dir on purpose. `mkdtempSync` never
// touches the real ~/.framelink.
const isolatedStore = () => new ApprovalStore(process.cwd(), mkdtempSync(join(tmpdir(), "flcm-approval-")));

// A modeled plugin sandbox's persistent approval state — ONE per Figma plugin, surviving the WS
// reconnects that plugin makes (code.ts's module-level `approvedTokens` Set + `currentToken` both
// outlive any single socket). `approvedTokens` is keyed by the sandbox-minted TOKEN (Slice 2.1b),
// NOT the forgeable identity: that is the security fix — a squatter that never minted/handed over
// a token can't be in the set. `currentToken` is the binding for the live connection.
//
// Why state-as-object, not module globals: most tests reuse `sandbox` (the one persistent plugin),
// but the squatter regression needs the SAME sandbox — still holding a stale `currentToken` and a
// populated `approvedTokens` — to reconnect onto a token-less squatter, so the gating rests on the
// reconnect ACTUALLY clearing/overwriting `currentToken`, not on a fresh closure starting null.
function makeSandbox() {
  return { approvedTokens: new Set(), currentToken: null };
}
const sandbox = makeSandbox();
let mintCounter = 0;

// A faithful stand-in for code.ts's reply contract. Pass `version` to model a CURRENT
// plugin (answers GET_VERSION/NOTIFY); omit it to model a spike-era plugin that predates
// those handlers and falls through to the envelope ERROR — the skew case the nudge rescues.
// Mirrors the Phase 2 sandbox gate: SESSION_INFO binds the connection's token, EXECUTE_CODE is
// gated on it, and `ws.allow()` stands in for the human clicking Allow in the arbiter panel —
// minting a token, approving it, and handing it to the server over the WS (SESSION_TOKEN). Pass
// `state` to share one persistent sandbox across reconnects (defaults to the shared `sandbox`).
function fakePlugin(origin, { version, wsOptions, url = URL, state = sandbox } = {}) {
  const ws = new WebSocket(url, { origin, ...wsOptions });
  // Models ui.html's WS_CONNECTED reset: a fresh socket drops the previous connection's token
  // so a write before the new SESSION_INFO can't ride a stale-but-approved binding. The sticky
  // approvedTokens set is untouched — only this connection's binding clears.
  ws.on("open", () => { state.currentToken = null; });
  ws.allow = () => {
    const token = `tok-${++mintCounter}-${Math.random().toString(36).slice(2)}`;
    state.approvedTokens.add(token);
    state.currentToken = token;
    // Hand the token to the server — unsolicited, id-less, like code.ts's figma.ui.postMessage
    // forwarded verbatim by ui.html. The server persists it and echoes it in later SESSION_INFOs.
    ws.send(JSON.stringify({ type: "SESSION_TOKEN", sessionToken: token }));
  };
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (typeof msg.id !== "string") return;
    // Mirrors code.ts's replyEnvelope: the handler's body plus the correlation id, and nothing
    // else carried over from the request (reply-envelope.ts owns that invariant plugin-side).
    const send = (body) => ws.send(JSON.stringify({ ...body, id: msg.id }));
    if (msg.type === "SESSION_INFO") {
      state.currentToken = typeof msg.sessionToken === "string" ? msg.sessionToken : null;
      send({ type: "SESSION_INFO_ACK" });
    } else if (msg.type === "EXECUTE_CODE") {
      if (state.currentToken && state.approvedTokens.has(state.currentToken)) send({ type: "EXECUTE_CODE_RESULT", result: "ok", console: [], errors: null });
      else send({ type: "PENDING_APPROVAL" });
    } else if (version && msg.type === "GET_VERSION") {
      send({ type: "VERSION", ...version });
    } else if (version && msg.type === "NOTIFY") {
      send({ type: "NOTIFY_RESULT" });
    } else {
      send({ type: "ERROR", error: `Unsupported message type ${JSON.stringify(msg.type)}.` });
    }
  });
  return ws;
}

const refusedOrOpened = (ws) =>
  new Promise((res) => { ws.on("error", () => res("refused")); ws.on("open", () => res("opened")); });

const bridge = new PluginBridge(isolatedStore());
let connected = 0;
bridge.start([PORT], () => connected++);
await wait(150);

const plugin = fakePlugin("null");
await wait(150);
assert.equal(connected, 1, "plugin with Origin:null should connect");

// --- Phase 2: consent gate (Slice 2.1) ---
// A fresh connection mints a 4-digit pairing code; the server introduces itself over
// SESSION_INFO. Until a human approves, a write is GATED (PENDING_APPROVAL) — it never runs
// and is never a hard error, so the agent can relay the code and retry.
const pairingCode = bridge.getPairingCode();
assert.match(String(pairingCode), /^\d{4}$/, "a 4-digit pairing code is minted per connection");
assert.equal(bridge.getSessionToken(), null, "no session token before the first Allow");
await bridge.request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode, sessionToken: bridge.getSessionToken() });
const preApproval = await bridge.request({ type: "EXECUTE_CODE", code: "return 1" });
assert.equal(preApproval.type, "PENDING_APPROVAL", "write before approval is gated, not run");
console.log(`✅ Pre-approval write returns PENDING_APPROVAL (code ${pairingCode} minted, identity introduced)`);

// Simulate the human clicking Allow in the panel (the UI_DECISION control message): the sandbox
// mints a token, approves it, and hands it to the server. Now the same write runs — and the rest
// of the Phase 1 envelope checks ride on this approved session.
plugin.allow();
await wait(50); // let the handed-over SESSION_TOKEN reach and persist on the bridge
assert.match(String(bridge.getSessionToken()), /^tok-/, "the bridge persisted the handed-over session token");
assert.equal((await bridge.request({ type: "EXECUTE_CODE", code: "return 1" })).result, "ok", "approved write runs");
console.log("✅ After Allow, the same write runs (server persisted the minted token)");

const t0 = Date.now();
let rejected = null;
try { await bridge.request({ type: "FUTURE_THING" }); } catch (e) { rejected = e; }
assert.ok(rejected, "unknown type should reject");
assert.match(rejected.message, /Unsupported message type/, "readable error");
assert.ok(Date.now() - t0 < 1000, "rejects fast, not on 15s timeout");
console.log(`✅ Unknown type rejects in ${Date.now() - t0}ms (not a 15s hang)`);

// The reply is a function of the plugin's handler body plus the correlation id — nothing the server
// attached to the request comes back. Pinned from the server side because the alternative (a general
// echo of unrecognized fields) silently turns a field the PLUGIN consumes into what looks like
// metadata a newer server sent. Correlation is by id alone, so no server code may depend on this.
const replied = await bridge.request({ type: "EXECUTE_CODE", code: "return 1", sessionId: "abc-123" });
assert.equal(replied.result, "ok", "the request still resolves — correlation is by id alone");
assert.equal(replied.sessionId, undefined, "a field the server attached must not come back on the reply");
console.log("✅ Replies carry nothing back from the request but its correlation id");

assert.equal(await refusedOrOpened(new WebSocket(URL, { origin: "https://evil.example.com" })), "refused", "web origin refused");
// A real figma.com origin is a script on a figma.com page (web app / extension), NOT
// the sandboxed plugin (which is Origin:null) — it must be refused like any other page.
assert.equal(await refusedOrOpened(new WebSocket(URL, { origin: "https://www.figma.com" })), "refused", "figma.com origin refused");
assert.equal(connected, 1, "web origins must not reach the connection handler");
console.log("✅ Web-origin (incl. figma.com) connections refused");

assert.equal(await refusedOrOpened(fakePlugin("null")), "refused", "second connection refused");
assert.equal((await bridge.request({ type: "EXECUTE_CODE", code: "return 1" })).result, "ok", "original plugin still drives");
console.log("✅ Second connection refused; established plugin keeps the channel");

// A disconnect mid-request rejects the in-flight call immediately, rather than letting
// it hang to the 15s timeout. Drive it with a mute plugin that connects but never replies.
plugin.close();
await wait(150);
const mute = new WebSocket(URL, { origin: "null" });
await new Promise((res) => mute.on("open", res));
const t1 = Date.now();
const inflight = bridge.request({ type: "EXECUTE_CODE", code: "return 1" }).then(() => null, (e) => e);
await wait(50); // let request() register the pending entry before we kill the socket
mute.terminate();
const discErr = await inflight;
assert.ok(discErr instanceof Error && /disconnect/i.test(discErr.message), "in-flight request rejects on disconnect");
assert.ok(Date.now() - t1 < 1000, "rejects fast on disconnect, not 15s");
console.log(`✅ Disconnect rejects in-flight request in ${Date.now() - t1}ms (not a 15s hang)`);

// --- Phase 2: approval is sticky across reconnects (Slice 2.1 + 2.1b) ---
// A fresh plugin reconnects within the same Figma session onto the freed slot. It does NOT call
// allow() again, yet the write runs — the server ECHOES the session token it was handed on the
// first Allow (Slice 2.1b), so the sandbox re-keys sticky approval to it and the human is not
// re-prompted (Done-when #3). The token survived the disconnect on the bridge (it's outside the
// connection-scoped cluster), which is what makes the echo possible.
await wait(150);
const reconnect = fakePlugin("null");
await new Promise((res) => reconnect.on("open", res));
await bridge.request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode: bridge.getPairingCode(), sessionToken: bridge.getSessionToken() });
assert.equal(
  (await bridge.request({ type: "EXECUTE_CODE", code: "return 1" })).result,
  "ok",
  "reconnect within the same Figma session stays approved (server echoes the token → no re-prompt)",
);
console.log("✅ Approval is sticky across reconnects (server echoes the token, no re-prompt)");
reconnect.close();
await wait(150);

// --- Slice 2.1b: the SAME approved sandbox reconnecting onto a token-less squatter re-prompts ---
// The real attack uses ONE persistent Figma sandbox (not a fresh closure): the human approved the
// legit server, so `sandbox` holds the minted token in approvedTokens AND a live currentToken bound
// to it (asserted below). The legit server exits; a DIFFERENT local server grabs the freed port and
// announces the SAME identity (a forgeable label) but holds NO token (it never got an Allow
// handover). The same sandbox auto-reconnects onto it. Because approval keys on the token, the
// squatter's null token must leave the gate closed — proving the forgeable identity carries nothing.
assert.ok(
  sandbox.currentToken && sandbox.approvedTokens.has(sandbox.currentToken),
  "precondition: the shared sandbox is approved (a token was minted and is currently bound)",
);
const PORT_SQUAT = 19878;
const squatBridge = new PluginBridge(isolatedStore());
squatBridge.start([PORT_SQUAT]);
await wait(150);
const squatPlugin = fakePlugin("null", { url: `ws://127.0.0.1:${PORT_SQUAT}`, state: sandbox });
await new Promise((res) => squatPlugin.on("open", res));
assert.equal(squatBridge.getSessionToken(), null, "a squatter server holds no session token");
// Pin the SESSION_INFO overwrite specifically, not just the WS_CONNECTED reset: re-seed a STALE
// approved token as if the open-reset had NOT cleared the binding, then prove the token-less
// SESSION_INFO still nulls it. If code.ts ever stopped overwriting currentToken on a tokenless
// SESSION_INFO, this would catch the resulting auto-approval that the fresh-closure test could not.
sandbox.currentToken = [...sandbox.approvedTokens][0];
await squatBridge.request({
  type: "SESSION_INFO",
  identity: SESSION_IDENTITY, // SAME human-readable label as the approved session
  pairingCode: squatBridge.getPairingCode(),
  sessionToken: squatBridge.getSessionToken(), // null — never approved
});
const squatWrite = await squatBridge.request({ type: "EXECUTE_CODE", code: "return 1" });
assert.equal(
  squatWrite.type,
  "PENDING_APPROVAL",
  "same-path squatter holding no token is re-prompted, even though the sandbox carried a stale approved token",
);
console.log("✅ Same-path squatter (same identity, no token) re-prompts even on the same approved sandbox");
squatPlugin.close();
await wait(150);

// A new connection that writes BEFORE re-introducing itself (no SESSION_INFO) must NOT inherit
// the prior session's approval: the WS_CONNECTED reset drops the stale identity, so the write is
// gated. Guards the reconnect/squatter bypass where a different local server grabs the freed port.
const naked = fakePlugin("null");
await new Promise((res) => naked.on("open", res));
const nakedWrite = await bridge.request({ type: "EXECUTE_CODE", code: "return 1" });
assert.equal(nakedWrite.type, "PENDING_APPROVAL", "write before SESSION_INFO is gated, not run on a stale approval");
console.log("✅ Write before SESSION_INFO on a fresh connection is gated (no stale-identity bypass)");
naked.close();
await wait(150);

// --- Durable approval: a restarted server reloads the persisted token; Revoke clears it (this cycle) ---
// The bug this closes: `sessionToken` was in-memory only, so a SERVER restart (dev-watch save-restart,
// or a crash/respawn) lost it and re-prompted — even though the plugin still remembered the token. A
// shared persistence dir + the SAME port models "same project, restarted process": a fresh PluginBridge
// that rebinds that port must reload the token the first one was handed, and re-approve WITHOUT a second
// Allow. The same sandbox is reused across the "restart" — its approvedTokens still holds the token,
// which is why the reloaded echo re-keys approval. Then Revoke must clear the persisted copy.
//
// The restart rebinds the SAME port on purpose: persistence keys on (cwd, PORT), so the restarted
// server only reloads if it reclaims its port — exactly what a real single-server restart does (it frees
// the port on exit and re-probes to the same base). `bridgeR1.stop()` frees the port so `bridgeR2` can
// reclaim it, the honest way to model this in-process. Note the fake sandbox gates on the token alone;
// the plugin's real active-driver (activeKey-by-port) gate is verified in Figma by hand — so a restart
// that instead landed on a DIFFERENT port would reload nothing here (re-prompt), and in production would
// surface as approved-but-inactive (INACTIVE_SESSION → "Switch to drive"), not a fresh Allow.
const sharedDir = mkdtempSync(join(tmpdir(), "flcm-approval-restart-"));
const RESTART_PORT = 19879;
const restartState = makeSandbox();
const bridgeR1 = new PluginBridge(new ApprovalStore(process.cwd(), sharedDir));
bridgeR1.start([RESTART_PORT]);
await wait(150);
const r1 = fakePlugin("null", { url: `ws://127.0.0.1:${RESTART_PORT}`, state: restartState });
await new Promise((res) => r1.on("open", res));
await bridgeR1.request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode: bridgeR1.getPairingCode(), sessionToken: bridgeR1.getSessionToken() });
r1.allow();
await wait(50);
const persistedToken = bridgeR1.getSessionToken();
assert.match(String(persistedToken), /^tok-/, "the approved server persisted the handed-over token");
r1.close();
bridgeR1.stop(); // free the port so the "restarted" server can reclaim it
await wait(150);

// Restart: a brand-new PluginBridge on the SAME store dir + cwd, rebinding the SAME port.
const bridgeR2 = new PluginBridge(new ApprovalStore(process.cwd(), sharedDir));
bridgeR2.start([RESTART_PORT]);
await wait(150);
assert.equal(bridgeR2.getSessionToken(), persistedToken, "a restarted server reclaiming its port reloads the persisted token (not null)");
const r2 = fakePlugin("null", { url: `ws://127.0.0.1:${RESTART_PORT}`, state: restartState });
await new Promise((res) => r2.on("open", res));
await bridgeR2.request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode: bridgeR2.getPairingCode(), sessionToken: bridgeR2.getSessionToken() });
assert.equal(
  (await bridgeR2.request({ type: "EXECUTE_CODE", code: "return 1" })).result,
  "ok",
  "after a server restart the reloaded token re-approves the same sandbox — no second Allow, no re-prompt",
);
console.log("✅ Durable approval survives a same-port server restart (persisted token reloaded, no re-prompt)");

// A concurrent same-cwd sibling on a DIFFERENT port must NOT inherit the approval (the F1 fix): its
// (cwd, port) key points at a file that was never written, so it reloads nothing and re-prompts.
const bridgeSibling = new PluginBridge(new ApprovalStore(process.cwd(), sharedDir));
bridgeSibling.start([19883]);
await wait(150);
assert.equal(bridgeSibling.getSessionToken(), null, "a concurrent same-cwd server on another port inherits no approval");
console.log("✅ A concurrent same-cwd sibling on another port does not inherit approval (keyed by cwd+port)");
bridgeSibling.stop();

// Revoke clears the persisted token: the sandbox sends id-less REVOKE_SESSION over the relay; a THIRD
// bridge reclaiming the same port then reloads nothing, so the next connect re-prompts.
r2.send(JSON.stringify({ type: "REVOKE_SESSION" }));
await wait(50);
assert.equal(bridgeR2.getSessionToken(), null, "REVOKE_SESSION clears the in-memory token");
r2.close();
bridgeR2.stop();
await wait(150);
const bridgeR3 = new PluginBridge(new ApprovalStore(process.cwd(), sharedDir));
bridgeR3.start([RESTART_PORT]);
await wait(150);
assert.equal(bridgeR3.getSessionToken(), null, "after Revoke, a restarted server reloads nothing — approval was truly cleared");
console.log("✅ Revoke deletes the persisted token so it can't silently re-approve on the next restart");
bridgeR3.stop();

// --- Version handshake + skew policy (Slice 1.2) ---

// Skew policy is pure logic, so assert it directly: a current protocol is clean; a missing
// or sub-minimum one nudges. The "missing → floor → nudge, never reject" rule is the
// load-bearing one (rejecting would brick the stale plugin), so pin it explicitly.
assert.equal(detectSkew({ protocolVersion: MIN_PROTOCOL_VERSION }), null, "current protocol → no nudge");
assert.ok(detectSkew({}), "missing version → nudge (floor), not silence");
assert.ok(detectSkew({ protocolVersion: MIN_PROTOCOL_VERSION - 1 }), "below-minimum protocol → nudge");
console.log("✅ detectSkew: current is clean; missing/old nudges (never rejects)");

// GET_VERSION rides the frozen envelope like any other request. Connect a CURRENT plugin
// onto the slot the terminated mute socket just freed.
await wait(150);
const current = fakePlugin("null", { version: { pluginVersion: "0.1.0", protocolVersion: 1 } });
await new Promise((res) => current.on("open", res));
const ver = await bridge.request({ type: "GET_VERSION" });
assert.equal(ver.protocolVersion, 1, "GET_VERSION round-trips protocolVersion");
assert.equal(ver.pluginVersion, "0.1.0", "GET_VERSION round-trips pluginVersion");
console.log("✅ Version handshake round-trips {pluginVersion, protocolVersion}");

// The skew note is connection-scoped: set while connected, cleared on disconnect so a
// newer plugin reconnecting onto the freed slot can't inherit a stale nudge.
bridge.setSkewNote("update me");
assert.equal(bridge.getSkewNote(), "update me", "skew note readable while connected");
current.close();
await wait(150);
assert.equal(bridge.getSkewNote(), null, "skew note cleared on disconnect");
console.log("✅ Skew note is connection-scoped (cleared on disconnect)");

// --- Slice 1.3: heartbeat reaps a half-open holder ---
// A handshaked plugin whose socket goes half-open (Figma crash / laptop sleep: no TCP FIN,
// so the server's socket stays OPEN and verifyClient would refuse the reconnect forever).
// Model it with autoPong:false — it answers requests (so it's "established") but never pongs.
// The established holder rightly still blocks a 2nd connection (1.1); only the heartbeat,
// detecting the missed pong, reaps it and frees the slot for the live plugin's reconnect.
await wait(150);
const dead = fakePlugin("null", { version: { pluginVersion: "0.1.0", protocolVersion: 1 }, wsOptions: { autoPong: false } });
await new Promise((res) => dead.on("open", res));
assert.equal((await bridge.request({ type: "GET_VERSION" })).protocolVersion, 1, "the half-open holder handshakes first");
assert.equal(
  await refusedOrOpened(fakePlugin("null")),
  "refused",
  "an established holder still blocks a 2nd connection before the heartbeat reaps it (1.1 preserved)",
);
bridge.heartbeatTick(); // pings; dead never pongs (autoPong:false)
await wait(50);
bridge.heartbeatTick(); // missed pong → terminate the half-open socket
await wait(150); // let the server-side close fire and free the slot
const revived = fakePlugin("null");
assert.equal(await refusedOrOpened(revived), "opened", "after the heartbeat reaps the stale holder, the live plugin reconnects");
console.log("✅ Heartbeat reaps a half-open holder so the live plugin can reconnect");
revived.close();
dead.close();
await wait(150);

// --- Slice 1.3: a new connection reclaims the slot from a non-handshaking holder ---
// A squatter grabs the single slot first but never speaks the envelope (replies to nothing),
// so it never becomes "established". The real plugin connects and is ADMITTED (reclaim is gated
// on the HOLDER being non-handshaked, not on the newcomer proving itself first); it displaces
// the squatter, then completes its OWN handshake and drives — a reply that would have hung
// forever against the mute squatter, proving the slot was reclaimed.
const squatter = new WebSocket(URL, { origin: "null" }); // connects, then stays mute
await new Promise((res) => squatter.on("open", res));
const reclaimer = fakePlugin("null");
await new Promise((res) => reclaimer.on("open", res));
await bridge.request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode: bridge.getPairingCode(), sessionToken: bridge.getSessionToken() });
reclaimer.allow();
assert.equal(
  (await bridge.request({ type: "EXECUTE_CODE", code: "return 1" })).result,
  "ok",
  "a new connection reclaims the slot from a non-handshaking squatter and drives once it handshakes",
);
await wait(50);
assert.ok(
  squatter.readyState === WebSocket.CLOSING || squatter.readyState === WebSocket.CLOSED,
  "the displaced squatter is disconnected",
);
console.log("✅ A new connection reclaims the slot from a non-handshaking holder, then handshakes and drives");
reclaimer.close();
await wait(150);

// --- Slice 1.3: a displaced socket's close must not reject the newcomer's in-flight handshake ---
// Reproduces the production ordering the main bridge can't: index.ts fires the newcomer's
// handshake (PING/GET_VERSION/SESSION_INFO) SYNCHRONOUSLY from onConnect, then the displaced
// socket's terminate()-close fires a tick LATER. A close that failed pending unconditionally
// would reject that fresh handshake. A dedicated bridge whose onConnect fires a request exercises it.
const PORT2 = 19877;
const URL2 = `ws://127.0.0.1:${PORT2}`;
const bridge2 = new PluginBridge(isolatedStore());
const handshakes = [];
bridge2.start([PORT2], () => {
  handshakes.push(
    bridge2
      .request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode: bridge2.getPairingCode(), sessionToken: bridge2.getSessionToken() })
      .catch((e) => e),
  );
});
await wait(150);
const sq2 = new WebSocket(URL2, { origin: "null" }); // mute squatter grabs the slot, never handshakes
await new Promise((res) => sq2.on("open", res));
const real2 = fakePlugin("null", { url: URL2 }); // displaces it, answers the onConnect handshake
await new Promise((res) => real2.on("open", res));
await wait(150); // let the displaced squatter's close fire (the tick where the bug would strike)
const ack = await handshakes[handshakes.length - 1];
assert.ok(ack && ack.type === "SESSION_INFO_ACK", "newcomer's onConnect handshake survives the displaced socket's close");
console.log("✅ A displaced socket's close doesn't reject the newcomer's in-flight handshake");
sq2.close();
real2.close();
await wait(150);

// --- Slice 1.3: a reclaimed connection's late handshake result can't clobber the newcomer ---
// Production hazard: index.ts fires GET_VERSION at every connection. A squatter's GET_VERSION
// orphans when the real plugin reclaims (the close-guard can't fail it without hitting the
// newcomer's pending), so it resolves LATE (15s timeout → {} → a skew nudge). index.ts guards
// that with a connection epoch — captured before the await, re-checked after. Mirror that guard
// here and prove the stale result bails instead of stamping a nudge on the current plugin.
const applyHandshakeResult = (capturedEpoch, note) => {
  if (bridge.currentEpoch() !== capturedEpoch) return; // stale connection — a newer one owns the slot
  bridge.setSkewNote(note);
};
const ghost = new WebSocket(URL, { origin: "null" }); // squatter grabs the slot, never replies
await new Promise((res) => ghost.on("open", res));
const ghostEpoch = bridge.currentEpoch();
bridge.request({ type: "GET_VERSION" }).catch(() => {}); // orphans on reclaim, resolves late
const heir = fakePlugin("null", { version: { pluginVersion: "0.1.0", protocolVersion: 1 } });
await new Promise((res) => heir.on("open", res));
const heirEpoch = bridge.currentEpoch();
assert.notEqual(heirEpoch, ghostEpoch, "a reclaim bumps the connection epoch");
await bridge.request({ type: "GET_VERSION" }); // heir handshakes
applyHandshakeResult(heirEpoch, null); // heir is current → no nudge (what index.ts sets)
applyHandshakeResult(ghostEpoch, "STALE NUDGE — must never land"); // the ghost's late result must bail
assert.equal(bridge.getSkewNote(), null, "a displaced connection's late handshake result can't clobber the current plugin's skew note");
console.log("✅ Connection epoch guards a reclaimed connection's late handshake from clobbering the current plugin");
heir.close();
await wait(150);

// --- Phase 3, Slice 3.1: server probe-binds the first free port in the block (advance on EADDRINUSE) ---
// Two servers sharing one 2-port block must NOT collide: the first binds the base, the second hits
// EADDRINUSE and advances to the next free port. The OS guarantees no double-bind, so this only ever
// advances — it is what lets N concurrent sessions land on N distinct ports for the plugin to scan.
const BLOCK = [19890, 19891];
const bridgeA = new PluginBridge(isolatedStore());
bridgeA.start(BLOCK);
await wait(150);
const bridgeB = new PluginBridge(isolatedStore());
bridgeB.start(BLOCK); // base already held by bridgeA → EADDRINUSE → advance to BLOCK[1]
await wait(250); // let the EADDRINUSE error fire and the retry bind
const onBase = new WebSocket(`ws://127.0.0.1:${BLOCK[0]}`, { origin: "null" });
assert.equal(await refusedOrOpened(onBase), "opened", "first server bound the base port");
const onNext = new WebSocket(`ws://127.0.0.1:${BLOCK[1]}`, { origin: "null" });
assert.equal(
  await refusedOrOpened(onNext),
  "opened",
  "second server advanced to the next free port on EADDRINUSE (nothing else binds BLOCK[1])",
);
console.log("✅ Two servers sharing a block bind distinct ports (probe-bind advances on EADDRINUSE)");
onBase.close();
onNext.close();
await wait(150);

// --- Phase 3, Slice 3.1: the manifest's devAllowedDomains mirrors the config block EXACTLY ---
// Done-when #2 — "a session binding any port in the block needs no manifest edit" — holds ONLY if
// every block port is already enumerated in the manifest (Figma has no port wildcard, and a host-only
// entry matches just :80). Pin the mirror BOTH ways: widening WS_PORT_BLOCK without updating the
// manifest (a port that would silently fail discovery), or leaving a stale/extra manifest entry, both
// fail the contract here instead of in a live Figma re-import nobody runs in the build loop.
// fileURLToPath, not `new URL(...)`: this module shadows the global URL with a `const URL` (the WS
// address) up top, so `new URL` would throw. Resolve plugin files relative to this harness file.
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "../plugin");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
const devDomains = new Set(manifest.networkAccess.devAllowedDomains);
for (const port of WS_PORT_BLOCK) {
  assert.ok(
    devDomains.has(`ws://localhost:${port}`),
    `manifest devAllowedDomains must list ws://localhost:${port} to mirror WS_PORT_BLOCK`,
  );
}
assert.equal(
  devDomains.size,
  WS_PORT_BLOCK.length,
  "manifest devAllowedDomains must list EXACTLY the block — no stale or extra ports",
);
assert.deepEqual(
  manifest.networkAccess.allowedDomains,
  ["none"],
  "dev-mode-only plugin declares no production network access",
);
console.log(`✅ manifest devAllowedDomains mirrors WS_PORT_BLOCK exactly (${WS_PORT_BLOCK.length} ports)`);

// ui.html opens one persistent connection per block port (Slice 3.2's multi-connection scan), so it
// carries its OWN copy of the block as a literal (it can't import the TS config). config.ts names
// ui.html a mirror of the block, so pin THAT mirror — symmetric with the manifest test: a
// WS_PORT_BLOCK change must not silently leave ui.html scanning a stale set of ports, the exact drift
// "caught only in a live re-import nobody runs" that these mechanical mirror tests exist to prevent.
const uiHtml = readFileSync(join(pluginDir, "ui.html"), "utf8");
const blockMatch = uiHtml.match(/var WS_PORT_BLOCK = \[([\s\S]*?)\]/);
assert.ok(blockMatch, "ui.html declares a WS_PORT_BLOCK literal");
const uiPorts = blockMatch[1]
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
assert.deepEqual(
  uiPorts,
  WS_PORT_BLOCK,
  "ui.html WS_PORT_BLOCK must mirror config's WS_PORT_BLOCK exactly (same ports, same order)",
);
console.log(`✅ ui.html WS_PORT_BLOCK mirrors config's WS_PORT_BLOCK exactly (${WS_PORT_BLOCK.length} ports)`);

console.log("\nAll frozen-envelope + hardening + version-handshake + consent-gate + port-range checks passed.");
process.exit(0);
