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
//   • A missing version is the floor and is refused, like any other under-minimum plugin — a runtime
//     that can't name its wire contract must not run agent code.
//   • The connection's compatibility verdict is connection-scoped (back to `checking` on disconnect).
//   • fig-41: a canvas request issued INSIDE the handshake window HOLDS for the verdict instead of
//     being sent, so a stale plugin never receives agent code — the race the refusal defeats.
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
// the sandbox keys a per-connection map by source port; approved sessions take the driving baton by
// writing and their writes are serialized). That logic lives entirely in the sandbox↔ui.html
// postMessage path (the __connKey routing, the connection map, the consent gate, the write queue) and
// runs only in Figma, so it is verified by hand, not pinned here — the WS envelope the server sees is
// UNCHANGED (ui.html strips __connKey before ws.send). The one thing
// this harness can pin is the mechanical mirror: ui.html now carries its own WS_PORT_BLOCK literal
// (it scans every port), checked against config's block exactly like the manifest above.
//
// Slice 1.3 adds connection-liveness hardening over the same single slot:
//   • Heartbeat reaps a half-open holder (handshaked but no pong) so the live plugin reconnects;
//     an established holder still blocks a 2nd connection until then (1.1 anti-hijack preserved).
//   • A new connection reclaims the slot from a non-handshaking holder (then handshakes and drives).
//   • A reclaimed connection's late handshake result can't clobber the newcomer (identity guard).
//
// Usage:  pnpm contract   (or: npx tsx scripts/bridge-contract.mjs)
//
// The fake plugin re-implements code.ts's reply shape rather than importing it —
// code.ts runs only inside Figma's sandbox (figma.* globals, preamble eval), so
// this exercises the server half of the contract against a faithful stand-in.

import { WebSocket } from "ws";
import assert from "node:assert";
import net from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PluginBridge } from "../src/services/plugin-bridge/bridge.ts";
import { ApprovalStore } from "../src/services/plugin-bridge/approval-store.ts";
import { MIN_PROTOCOL_VERSION } from "../src/services/plugin-bridge/version.ts";
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

// The version a modeled plugin reports unless the caller says otherwise — CURRENT, so every test
// that isn't ABOUT version skew gets a plugin the server will actually drive. (Since fig-41 the
// bridge holds canvas requests until the handshake settles, so a plugin with no version would be
// refused rather than merely nudged.)
const CURRENT_VERSION = { pluginVersion: "0.1.0", protocolVersion: MIN_PROTOCOL_VERSION };

// A faithful stand-in for code.ts's reply contract. `version` defaults to CURRENT_VERSION; pass an
// older one to model a stale plugin, or `null` to model a spike-era plugin that predates the
// GET_VERSION/NOTIFY handlers entirely and falls through to the envelope ERROR. `versionDelayMs`
// holds the handshake window open on purpose (the fig-41 race); `ignoreTypes` names message types the
// plugin drops without replying, modeling a plugin that goes silent mid-request.
// Mirrors the Phase 2 sandbox gate: SESSION_INFO binds the connection's token, EXECUTE_CODE is
// gated on it, and `ws.allow()` stands in for the human clicking Allow in the arbiter panel —
// minting a token, approving it, and handing it to the server over the WS (SESSION_TOKEN). Pass
// `state` to share one persistent sandbox across reconnects (defaults to the shared `sandbox`).
// `ws.received` records every message type the plugin was actually SENT, so a test can assert that
// something never reached it.
function fakePlugin(
  origin,
  { version = CURRENT_VERSION, versionDelayMs = 0, ignoreTypes = [], wsOptions, url = URL, state = sandbox } = {},
) {
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
  ws.received = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (typeof msg.id !== "string") return;
    ws.received.push(msg.type);
    if (ignoreTypes.includes(msg.type)) return;
    // Mirrors code.ts's reply(): the handler's body plus the correlation id, and nothing else
    // carried over from the request.
    const send = (body) => ws.send(JSON.stringify({ ...body, id: msg.id }));
    if (msg.type === "SESSION_INFO") {
      state.currentToken = typeof msg.sessionToken === "string" ? msg.sessionToken : null;
      send({ type: "SESSION_INFO_ACK" });
    } else if (msg.type === "EXECUTE_CODE") {
      if (state.currentToken && state.approvedTokens.has(state.currentToken)) send({ type: "EXECUTE_CODE_RESULT", result: "ok", console: [], errors: null });
      else send({ type: "PENDING_APPROVAL" });
    } else if (version && msg.type === "GET_VERSION") {
      if (versionDelayMs) setTimeout(() => send({ type: "VERSION", ...version }), versionDelayMs);
      else send({ type: "VERSION", ...version });
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
assert.equal((await bridge.request({ type: "EXECUTE_CODE", code: "return 1" })).result, "ok", "approved write runs");
console.log("✅ After Allow, the same write runs (server persisted the minted token)");

const t0 = Date.now();
let rejected = null;
try { await bridge.request({ type: "FUTURE_THING" }); } catch (e) { rejected = e; }
assert.ok(rejected, "unknown type should reject");
assert.match(rejected.message, /Unsupported message type/, "readable error");
assert.ok(Date.now() - t0 < 1000, "rejects fast, not on 15s timeout");
console.log(`✅ Unknown type rejects in ${Date.now() - t0}ms (not a 15s hang)`);

// Correlation is by id alone: the request below resolves (it got its reply) while the field the
// server attached does NOT come back. Pinned from the server side so no server code grows a
// dependency on pass-through metadata — the general echo it would need silently turns a field the
// PLUGIN consumes into what looks like metadata a newer server sent.
const replied = await bridge.request({ type: "EXECUTE_CODE", code: "return 1", sessionId: "abc-123" });
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
// it hang to the 15s timeout. Drive it with a plugin that handshakes (so the write is actually SENT
// rather than held on the fig-41 compatibility gate) but never answers the write itself.
plugin.close();
await wait(150);
const mute = fakePlugin("null", { ignoreTypes: ["EXECUTE_CODE"] });
await new Promise((res) => mute.on("open", res));
await wait(50); // let the connection's GET_VERSION handshake settle, so the write is not held
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
// the plugin binds approval per port — so a restart that instead landed on a DIFFERENT port reloads
// nothing here, and in production surfaces as a fresh Allow prompt on the new port. That slip is the
// fig-43 failure, and the reclaim-window scenario further down is what keeps it from happening.
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

// --- A restart that races its own dying predecessor must reclaim its port, not slip to the next ---
// The field failure this closes (fig-43): a dev-watch save-restart is a photo finish — the predecessor
// releases the port ~145ms after SIGTERM while the successor binds ~280ms later, so anything that slows
// the old process's exit inverts the margin. The successor then probe-advances one port, finds an EMPTY
// approval slot, echoes `sessionToken: null`, and the human gets a fresh pairing code after a save they
// never thought was a restart. A plain TCP listener on the port models the not-yet-exited predecessor
// faithfully: the bind fails with the same EADDRINUSE either way.
const SLIP_PORT = 19884;
const slipState = makeSandbox();
const bridgeS1 = new PluginBridge(new ApprovalStore(process.cwd(), sharedDir));
bridgeS1.start([SLIP_PORT, SLIP_PORT + 1]);
await wait(150);
const s1 = fakePlugin("null", { url: `ws://127.0.0.1:${SLIP_PORT}`, state: slipState });
await new Promise((res) => s1.on("open", res));
await bridgeS1.request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode: bridgeS1.getPairingCode(), sessionToken: bridgeS1.getSessionToken() });
s1.allow();
await wait(50);
const slipToken = bridgeS1.getSessionToken();
assert.match(String(slipToken), /^tok-/, "the pre-restart server on the base port was approved and persisted");
s1.close();
bridgeS1.stop();
await wait(150);

const predecessor = net.createServer();
await new Promise((res) => predecessor.listen(SLIP_PORT, "127.0.0.1", res));
const bridgeS2 = new PluginBridge(new ApprovalStore(process.cwd(), sharedDir));
bridgeS2.start([SLIP_PORT, SLIP_PORT + 1]);
await wait(300);
// It is HOLDING OFF, not merely tokenless: had it advanced it would be listening on SLIP_PORT+1 by
// now. Probe that port instead of the token (which reads null under either outcome, and so can't
// tell them apart).
assert.equal(
  await refusedOrOpened(new WebSocket(`ws://127.0.0.1:${SLIP_PORT + 1}`, { origin: "null" })),
  "refused",
  "the successor holds off on its own occupied port instead of binding the next one",
);
await new Promise((res) => predecessor.close(res));
await wait(400);
assert.equal(
  bridgeS2.getSessionToken(),
  slipToken,
  "a restart racing its dying predecessor waits out the port and reloads its approval, instead of slipping to the next port and re-prompting",
);
console.log("✅ A restart racing its dying predecessor reclaims its own port — no slip, no fresh Allow");
bridgeS2.stop();
await wait(150);

// --- The reclaim wait is bounded on both sides, and cancellable ---
// Three ways that wait could go wrong in production, none of which the test above can see: it could
// fire when it has no business firing (taxing every concurrent session with startup latency), never
// give up (a server that binds nothing at all, in silence), or outlive the bridge that scheduled it.

// (a) A busy port this project holds NO approval for is advanced past AT ONCE. The store read here
// does hold an approval — for SLIP_PORT, not for this port — so a key that drifted back to cwd-alone
// would find it, wait out the whole window, and make every genuinely-concurrent second session pay
// seconds of startup for a port that was never ours.
const NOAPP_PORT = 19880;
const noAppHolder = net.createServer();
await new Promise((res) => noAppHolder.listen(NOAPP_PORT, "127.0.0.1", res));
// A 5s window, injected rather than inherited: the point of this case is that the wait DIDN'T happen,
// so the budget must be unambiguously longer than the sleep below. Left at the production constant it
// would silently stop discriminating the day that constant dropped under 250ms.
const bridgeNoApp = new PluginBridge(new ApprovalStore(process.cwd(), sharedDir), 15_000, 5_000);
bridgeNoApp.start([NOAPP_PORT, NOAPP_PORT + 1]);
await wait(250); // a twentieth of the window — only an immediate advance can have bound by now
const advancedAtOnce = new WebSocket(`ws://127.0.0.1:${NOAPP_PORT + 1}`, { origin: "null" });
assert.equal(
  await refusedOrOpened(advancedAtOnce),
  "opened",
  "a busy port with no approval of its own is advanced past immediately, not waited on",
);
console.log("✅ A busy port this project never approved is advanced past at once (no startup tax on a sibling)");
advancedAtOnce.close();
bridgeNoApp.stop();
await new Promise((res) => noAppHolder.close(res));
await wait(150);

// (b) A holder that never lets go is abandoned AT THE DEADLINE. Without one the re-probe loops
// forever: the server binds nothing, reports nothing, and the plugin's block scan finds no port — a
// startup that hangs with no error to explain it. The window is injected so the deadline is a fact
// here rather than a race against a constant.
const STUCK_PORT = 19892;
const stuckState = makeSandbox();
const bridgeD1 = new PluginBridge(new ApprovalStore(process.cwd(), sharedDir));
bridgeD1.start([STUCK_PORT]);
await wait(150);
const d1 = fakePlugin("null", { url: `ws://127.0.0.1:${STUCK_PORT}`, state: stuckState });
await new Promise((res) => d1.on("open", res));
await bridgeD1.request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode: bridgeD1.getPairingCode(), sessionToken: bridgeD1.getSessionToken() });
d1.allow();
await wait(50);
assert.match(String(bridgeD1.getSessionToken()), /^tok-/, "precondition: the port the successor will wait on is genuinely approved");
d1.close();
bridgeD1.stop();
await wait(150);

const stuck = net.createServer(); // never released — models a predecessor that hangs past the budget
await new Promise((res) => stuck.listen(STUCK_PORT, "127.0.0.1", res));
const bridgeD2 = new PluginBridge(new ApprovalStore(process.cwd(), sharedDir), 15_000, 300);
bridgeD2.start([STUCK_PORT, STUCK_PORT + 1]);
await wait(700); // well past the injected 300ms deadline, with the port still held
const gaveUp = new WebSocket(`ws://127.0.0.1:${STUCK_PORT + 1}`, { origin: "null" });
assert.equal(
  await refusedOrOpened(gaveUp),
  "opened",
  "a holder that outlasts the reclaim budget is abandoned — the server advances rather than probing forever",
);
assert.equal(
  bridgeD2.getSessionToken(),
  null,
  "the server that gave up is honest about it: no approval for the port it settled on, so the human is re-prompted",
);
console.log("✅ A port held past the reclaim deadline is abandoned for the next one (startup is bounded)");
gaveUp.close();
bridgeD2.stop();
await wait(150);

// (c) `stop()` cancels a re-probe still in flight. That timer is the one thing that can outlive the
// bridge that scheduled it: let it fire after a stop and a discarded bridge silently rebinds the port
// it was just told to release, reloading the persisted approval onto an object nobody holds any more.
// Single-port block, so the only thing it can do is wait — and then, if uncancelled, take the port.
const bridgeD3 = new PluginBridge(new ApprovalStore(process.cwd(), sharedDir), 15_000, 5_000);
bridgeD3.start([STUCK_PORT]);
await wait(150); // a re-probe is scheduled, deep inside the 5s window
bridgeD3.stop();
await new Promise((res) => stuck.close(res)); // free the port that a stopped bridge must NOT take
await wait(400); // several retry ticks' worth
assert.equal(bridgeD3.getSessionToken(), null, "a stopped bridge does not come back and reload a persisted approval");
const stillFree = new WebSocket(`ws://127.0.0.1:${STUCK_PORT}`, { origin: "null" });
assert.equal(
  await refusedOrOpened(stillFree),
  "refused",
  "a stopped bridge leaves its port free — the reclaim retry it had in flight was cancelled",
);
console.log("✅ stop() cancels an in-flight reclaim retry (a stopped bridge cannot rebind its port)");
await wait(150);

// (d) …and it disowns a bind the OS has already accepted. Cancelling the retry timer only covers the
// reclaim path; a plain start-then-stop leaves a WebSocketServer mid-`listen`, and its `listening`
// callback fires afterwards regardless. Unlatched, it takes the port, overwrites the `wss` handle
// stop() just nulled — so nothing can ever close it again — and reloads the persisted approval onto a
// bridge nobody holds. No approval is needed to reach this: it is the ordinary bind path.
const FREE_PORT = 19886;
const bridgeD4 = new PluginBridge(new ApprovalStore(process.cwd(), sharedDir));
bridgeD4.start([FREE_PORT]);
bridgeD4.stop(); // same tick — the bind is in flight and cannot be cancelled, only disowned
await wait(300); // long past the point where `listening` would have fired
const neverBound = new WebSocket(`ws://127.0.0.1:${FREE_PORT}`, { origin: "null" });
assert.equal(
  await refusedOrOpened(neverBound),
  "refused",
  "a bridge stopped while its bind was in flight leaves the port free instead of claiming it unclosably",
);
console.log("✅ stop() disowns a bind already in flight (no unclosable listener on a discarded bridge)");

// --- Version handshake + compatibility policy (Slice 1.2, tightened by fig-41) ---
// The policy itself (current is clean, missing or sub-minimum is refused) is pinned END TO END below,
// over a real socket: `stalePlugin` for sub-minimum, `spikeEra` for missing-version-is-the-floor, and
// `currentRacer` for "a current plugin is only delayed, not refused". Asserting refuseProtocolSkew's
// return value directly here as well would restate those same three branches without a wire in them.

// Connect a CURRENT plugin onto the slot the sticky-approval reconnect left free.
await wait(150);
const current = fakePlugin("null");
await new Promise((res) => current.on("open", res));

// The verdict is connection-scoped: the bridge's own handshake settles it on connect, and a
// disconnect drops it back to `checking` so a newer plugin on the freed slot can't inherit it.
await wait(50);
assert.equal(bridge.protocolCompatibility(), "compatible", "the bridge runs its own handshake and settles the verdict");
current.close();
await wait(150);
assert.equal(bridge.protocolCompatibility(), "checking", "the verdict resets on disconnect");
console.log("✅ The compatibility verdict is connection-scoped (back to `checking` on disconnect)");

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

// --- Slice 1.3: a reclaimed connection's late handshake verdict can't clobber the newcomer ---
// Production hazard: the bridge fires GET_VERSION at every connection. A mute squatter's GET_VERSION
// ORPHANS when the real plugin reclaims the slot (the close-guard can't fail it without hitting the
// newcomer's pending too), so it resolves LATE — on its timeout, as an empty record, which reads as
// the protocol floor. Since fig-41 that verdict GATES canvas requests, so a late one landing on the
// newcomer would refuse every write to a perfectly current plugin. The bridge guards it with the
// socket it was fired for, re-checked after the await.
//
// A dedicated bridge with a short request timeout makes the orphan resolve in 200ms instead of 15s.
const GHOST_PORT = 19887;
const ghostBridge = new PluginBridge(isolatedStore(), 200);
ghostBridge.start([GHOST_PORT]);
await wait(150);
const ghost = new WebSocket(`ws://127.0.0.1:${GHOST_PORT}`, { origin: "null" }); // grabs the slot, never replies
await new Promise((res) => ghost.on("open", res));
await wait(30); // the server installs the socket and fires the GET_VERSION that will orphan
const heir = fakePlugin("null", { url: `ws://127.0.0.1:${GHOST_PORT}`, state: makeSandbox() });
await new Promise((res) => heir.on("open", res));
await wait(300); // outlast the orphaned handshake's timeout — the moment the stale verdict would land
assert.equal(
  ghostBridge.protocolCompatibility(),
  "compatible",
  "a displaced connection's late handshake verdict can't clobber the current plugin's compatibility",
);
console.log("✅ Connection identity guards a reclaimed connection's late handshake from clobbering the current plugin");
heir.close();
ghost.close();
await wait(150);

// --- fig-41: a request held across a slot reclaim runs on the newcomer, instead of hanging ---
// The hold suspends on ONE promise object. A reclaim installs the newcomer's promise and drops the
// resolver for the old one, so unless the outgoing connection's gate is settled at the swap, the held
// request waits forever — and nothing rescues it, because it was never sent and so has no timeout.
// Sequence: a mute squatter takes the slot (verdict stays `checking`), a write is issued and holds,
// then the real plugin reclaims and handshakes. The write must run against the newcomer.
const RECLAIM_PORT = 19889;
const reclaimBridge = new PluginBridge(isolatedStore(), 5_000); // long timeout: only the settle can free it
reclaimBridge.start([RECLAIM_PORT]);
await wait(150);
const reclaimUrl = `ws://127.0.0.1:${RECLAIM_PORT}`;
const reclaimState = makeSandbox();
const muteSquatter = new WebSocket(reclaimUrl, { origin: "null" }); // never replies, so never handshakes
await new Promise((res) => muteSquatter.on("open", res));
await wait(30);
assert.equal(reclaimBridge.protocolCompatibility(), "checking", "the squatter's protocol is unknown, so a write holds");
let heldSettled = false;
const heldWrite = reclaimBridge
  .request({ type: "EXECUTE_CODE", code: "return 1" })
  .then((r) => { heldSettled = true; return r; }, (e) => { heldSettled = true; return e; });
await wait(50);
assert.equal(heldSettled, false, "the write is held, not sent, while the holder's protocol is unknown");
const takeover = fakePlugin("null", { url: reclaimUrl, state: reclaimState });
await new Promise((res) => takeover.on("open", res));
await reclaimBridge.request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode: reclaimBridge.getPairingCode(), sessionToken: reclaimBridge.getSessionToken() });
takeover.allow();
const heldResult = await Promise.race([heldWrite, wait(1500).then(() => "HUNG")]);
assert.notEqual(heldResult, "HUNG", "a write held across a slot reclaim must not hang — the reclaim settles the old gate");
assert.equal(heldResult.result, "ok", "it runs against the plugin that took the slot");
console.log("✅ A write held across a slot reclaim runs on the newcomer instead of hanging");
takeover.close();
muteSquatter.close();
reclaimBridge.stop();
await wait(150);

// --- fig-41: a canvas request racing the version handshake is HELD, then refused ---
// GET_VERSION is asked the instant a plugin connects, but the answer is a round-trip away. Before
// this gate a figma_execute_code landing inside that window was sent straight through, so a plugin
// below MIN_PROTOCOL_VERSION RECEIVED the agent's code and ran it — the refusal the minimum exists to
// produce never got the chance to fire. The connection now carries a compatibility state, and a
// canvas request holds while it is `checking`.
//
// `versionDelayMs` holds the window open long enough to fire inside it deterministically.
const RACE_PORT = 19888;
const raceBridge = new PluginBridge(isolatedStore(), 500);
raceBridge.start([RACE_PORT]);
await wait(150);
const raceUrl = `ws://127.0.0.1:${RACE_PORT}`;
const raceState = makeSandbox();
const stalePlugin = fakePlugin("null", {
  url: raceUrl,
  state: raceState,
  version: { pluginVersion: "0.0.1", protocolVersion: MIN_PROTOCOL_VERSION - 1 },
  versionDelayMs: 250,
});
await new Promise((res) => stalePlugin.on("open", res));
await wait(30); // let the server install the socket and fire its GET_VERSION — still deep inside the window
assert.equal(raceBridge.protocolCompatibility(), "checking", "a just-connected plugin's protocol is not known yet");
let raceErr = null;
try {
  // Fired INSIDE the window, before the verdict can possibly have landed — the exact call fig-41 is about.
  await raceBridge.request({ type: "EXECUTE_CODE", code: "return 1" });
} catch (e) {
  raceErr = e;
}
assert.ok(raceErr, "a write issued inside the handshake window must not run");
// Match the WHOLE refusal, not just "protocol v": the plugin version in it comes from the peer's
// GET_VERSION reply, and `refuseProtocolSkew` degrades silently to "the connected plugin" when that
// field is missing. Pinning the full text is what keeps `pluginVersion` round-tripping — a reply,
// parse, or message change that dropped it would otherwise pass every check in this file.
assert.match(
  raceErr.message,
  /plugin v0\.0\.1 \(protocol v0\)/,
  "it is refused with the update-the-plugin message, naming the plugin version it round-tripped",
);
assert.equal(raceBridge.protocolCompatibility(), "incompatible", "the verdict landed while the write was held");
assert.ok(!stalePlugin.received.includes("EXECUTE_CODE"), "the stale plugin never received the code");
console.log("✅ A write racing the version handshake HOLDS, then is refused — the stale plugin never receives it");

// …and it stays refused once the verdict is in, so the race is closed at both ends.
raceErr = null;
try { await raceBridge.request({ type: "EXECUTE_CODE", code: "return 1" }); } catch (e) { raceErr = e; }
assert.ok(raceErr && /protocol v/.test(raceErr.message), "an under-minimum plugin stays refused after the verdict lands");
assert.ok(!stalePlugin.received.includes("EXECUTE_CODE"), "still never sent");
console.log("✅ An under-minimum plugin stays refused after its verdict lands");
stalePlugin.close();
await wait(150);

// A plugin predating the handshake entirely (envelope-ERRORs GET_VERSION) is the protocol floor, and
// is refused on the same rule — no special case for "couldn't tell us".
const spikeEra = fakePlugin("null", { url: raceUrl, state: raceState, version: null });
await new Promise((res) => spikeEra.on("open", res));
await wait(30);
raceErr = null;
try { await raceBridge.request({ type: "EXECUTE_CODE", code: "return 1" }); } catch (e) { raceErr = e; }
assert.ok(raceErr && /protocol v/.test(raceErr.message), "a plugin that can't answer GET_VERSION is refused, not driven");
assert.ok(!spikeEra.received.includes("EXECUTE_CODE"), "the pre-handshake plugin never received the code");
console.log("✅ A plugin predating the handshake is refused (missing version → floor)");
spikeEra.close();
await wait(150);

// The gate DELAYS a current plugin, it doesn't break it: the same immediately-issued write holds for
// the verdict and then runs. Without this, "refuse while checking" would look like a passing test.
const currentRacer = fakePlugin("null", { url: raceUrl, state: raceState, versionDelayMs: 250 });
await new Promise((res) => currentRacer.on("open", res));
await wait(30);
await raceBridge.request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode: raceBridge.getPairingCode(), sessionToken: raceBridge.getSessionToken() });
currentRacer.allow();
assert.equal(raceBridge.protocolCompatibility(), "checking", "still inside the handshake window");
const heldThenRan = await raceBridge.request({ type: "EXECUTE_CODE", code: "return 1" });
assert.equal(heldThenRan.result, "ok", "a current plugin's write holds for the verdict and then runs");
console.log("✅ The hold only delays a current plugin — its write runs once the verdict lands");
currentRacer.close();
await wait(150);

// A disconnect INSIDE the handshake window must not leave a false `incompatible` behind. `close` fails
// the in-flight GET_VERSION, so the handshake's catch runs a microtask later with an empty record —
// the protocol floor. Applying that would park a bridge with NO plugin in `incompatible`, and every
// canvas call would then tell the agent to reinstall the plugin when the truth is that nothing is
// connected. The handshake bails on socket identity, which (unlike a connection epoch) also moves on
// a disconnect.
const dropper = fakePlugin("null", { url: raceUrl, state: raceState, versionDelayMs: 5_000 });
await new Promise((res) => dropper.on("open", res));
await wait(30);
assert.equal(raceBridge.protocolCompatibility(), "checking", "still inside the handshake window");
dropper.close();
await wait(100); // let close fail the pending GET_VERSION and its catch run
assert.equal(
  raceBridge.protocolCompatibility(),
  "checking",
  "a disconnect inside the handshake window leaves no verdict behind",
);
let goneErr = null;
try { await raceBridge.request({ type: "EXECUTE_CODE", code: "return 1" }); } catch (e) { goneErr = e; }
assert.match(
  goneErr.message,
  /No Figma plugin connected/,
  "with nothing connected the agent is told exactly that — not to go reinstall a plugin",
);
console.log("✅ A disconnect inside the handshake window leaves no false `incompatible` behind");
raceBridge.stop();
ghostBridge.stop();
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
