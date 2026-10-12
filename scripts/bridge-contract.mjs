/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Port-level contract check for the PluginBridge: the REAL bridge on real sockets, against the REAL
// plugin (ui.ts + code.ts built from source, src/commercial/tests/fixtures/loopback-plugin.ts) wherever
// a current plugin is the counterpart. The only hand-written peers are adversarial ones — a stale
// plugin, a mute squatter, a holder that goes silent — plus raw sockets that drive the reverse
// channel's timing directly. It pins what a refactor could silently undo:
//
//   • Origin:null connects; web origins (figma.com included) are refused; an established plugin is
//     never displaced, while a mute squatter's slot is reclaimable.
//   • The version handshake gates every canvas request: a request racing it HOLDS, a stale or
//     pre-handshake plugin never receives code, and a verdict never outlives its connection.
//   • The consent gate: PENDING_APPROVAL before Allow, the minted token persisted and echoed so a
//     reconnect or a same-port restart stays approved, and a token-less squatter re-prompted.
//   • Port-block discovery: first free port, a restart reclaiming its own port, bounded and
//     cancellable reclaim waits, and the manifest mirroring WS_PORT_BLOCK.
//   • Deadlines cancel (never abandon) and are worded from the plugin's answer; the reverse channel
//     suspends them while serving and refuses requests that aren't a live code run's.
//
// Usage:  pnpm contract   (or: npx tsx scripts/bridge-contract.mjs)

import { WebSocket } from "ws";
import assert from "node:assert";
import net from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PluginBridge } from "../src/commercial/plugin-bridge/bridge.ts";
import { ApprovalStore } from "../src/commercial/plugin-bridge/approval-store.ts";
import { PROTOCOL_VERSION, WS_PORT_BLOCK } from "../plugin/src/protocol.ts";
import { buildSandboxPreamble } from "../plugin/src/preamble/index.mjs";
import { startLoopbackPlugin } from "../src/commercial/tests/fixtures/loopback-plugin.ts";

const PORT = 19876;
const URL = `ws://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (condition, what, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
};

// The real plugin evals what it is sent, so it gets the real std-lib (ADR-0010).
const PREAMBLE = await buildSandboxPreamble();
const execute = (bridge, fields = {}) =>
  bridge.request({
    type: "EXECUTE_CODE",
    code: "return 'ok';",
    preamble: PREAMBLE,
    lateChangeWindowMs: 60_000,
    ...fields,
  });
// What index.ts sends every connection: who this server is, and the token proving a prior Allow.
const introduce = (bridge) =>
  bridge.request(bridge.sessionInfo("https://app.framelink.ai"));
const LOOPBACK_USER = { figmaUserId: "loopback-user", name: "Loopback Human" };

// Every bridge gets its OWN empty persistence dir, so one bridge's persisted token can't be reloaded
// by another in this one process. The restart tests below opt INTO a shared dir on purpose.
const isolatedStore = () =>
  new ApprovalStore(process.cwd(), mkdtempSync(join(tmpdir(), "flcm-approval-")));

/** The real plugin, dialing `port`, with its socket open. */
async function realPlugin(port, options) {
  const plugin = startLoopbackPlugin(port, options);
  await plugin.opened();
  return plugin;
}

// ---- Adversarial peers ----

// A plugin on another protocol than this server: answers GET_VERSION with `version` after `delayMs`, or — with
// `version: null` — predates the handshake and ERRORs every request. Never runs anything; `received`
// lists every request it was sent, so a test can prove code never reached it.
function stalePeer(url, version, delayMs = 0) {
  const ws = new WebSocket(url, { origin: "null" });
  ws.received = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (typeof msg.id !== "string") return;
    ws.received.push(msg.type);
    const send = (body) => ws.send(JSON.stringify({ ...body, id: msg.id }));
    if (version && msg.type === "GET_VERSION")
      setTimeout(() => send({ type: "VERSION", ...version }), delayMs);
    else send({ type: "ERROR", error: `Unsupported message type ${JSON.stringify(msg.type)}.` });
  });
  return ws;
}

// A holder that passes the handshake as a current plugin, then goes silent on everything else:
// crashed mid-run, asleep, or half-open (`autoPong: false`). `onFrame` sees every other frame.
function silentHolder(url, { autoPong = true, onFrame = () => {} } = {}) {
  const ws = new WebSocket(url, { origin: "null", autoPong });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "GET_VERSION")
      ws.send(JSON.stringify({ type: "VERSION", id: msg.id, protocolVersion: PROTOCOL_VERSION }));
    else onFrame(msg);
  });
  return ws;
}

// A raw socket driving the reverse channel by hand still has to pass the version handshake, or every
// canvas request it is sent holds on the compatibility gate until refused as the protocol floor.
const answerVersionHandshake = (ws, msg) => {
  if (msg.type === "GET_VERSION" && typeof msg.id === "string") {
    ws.send(JSON.stringify({ type: "VERSION", id: msg.id, protocolVersion: PROTOCOL_VERSION }));
    return true;
  }
  return false;
};

const refusedOrOpened = (ws) =>
  new Promise((res) => {
    ws.on("error", () => res("refused"));
    ws.on("open", () => res("opened"));
  });
const opened = (ws) => new Promise((res) => ws.on("open", res));

const approvedEvents = [];
let signInRequests = 0;
const bridge = new PluginBridge(isolatedStore(), {
  events: {
    onSessionApproved: (session) => approvedEvents.push(session.authorizingUser),
    onWriteAccessSignIn: () => signInRequests++,
  },
});
let connected = 0;
bridge.start([PORT], () => connected++);
await wait(150);

const plugin = await realPlugin(PORT);
await until(() => bridge.protocolCompatibility() === "compatible", "the version verdict");
assert.equal(connected, 1, "the plugin (Origin:null) connects");

// --- Version handshake ---
const version = await bridge.request({ type: "GET_VERSION" });
assert.equal(version.protocolVersion, PROTOCOL_VERSION, "the plugin speaks this server's protocol");
assert.equal(typeof version.pluginVersion, "string", "and names its release");
console.log("✅ Version handshake round-trips {pluginVersion, protocolVersion} with the real plugin");

// --- Consent gate ---
// A fresh connection mints a 4-digit pairing code. Until a human approves, a write is GATED
// (PENDING_APPROVAL) — never run, never a hard error, so the agent can relay the code and retry.
const pairingCode = bridge.getPairingCode();
assert.match(String(pairingCode), /^\d{4}$/, "a 4-digit pairing code is minted per connection");
assert.equal(bridge.approvedSession(), null, "no session token before the first Allow");
await introduce(bridge);
// A request the plugin can't read is refused BEFORE the consent gate — asking a human to approve a
// doomed write would be asking consent for nothing. An envelope ERROR rejects: it can never be
// mistaken for a run that completed with no result.
await assert.rejects(
  execute(bridge, { preamble: undefined }),
  /can't read the server's "EXECUTE_CODE" request/,
  "an EXECUTE_CODE without its std-lib is refused, not gated",
);
assert.equal((await execute(bridge)).type, "PENDING_APPROVAL", "a write before approval is gated");
console.log(`✅ Pre-approval write returns PENDING_APPROVAL (code ${pairingCode} minted)`);

await plugin.allow();
await until(() => bridge.approvedSession() !== null, "the handed-over token");
assert.match(String(bridge.approvedSession()?.token), /^[0-9a-z]{16,64}$/, "the token is persisted");
assert.deepEqual(bridge.approvedSession()?.authorizingUser, LOOPBACK_USER, "writes are attributed to the Allower");
assert.deepEqual(approvedEvents, [LOOPBACK_USER], "each Allow fires onSessionApproved");
assert.equal((await execute(bridge)).result, "ok", "the approved write runs");
console.log("✅ After Allow, the same write runs, attributed to the human who clicked it");

// --- Protocol 8: write-access notices and the panel's sign-in click ---
const notice = { kind: "sign-in-failed", message: "contract" };
assert.equal(
  (await bridge.request({ type: "WRITE_ACCESS", notice })).type,
  "WRITE_ACCESS_ACK",
  "the panel acks a write-access notice",
);
plugin.signIn();
await until(() => signInRequests === 1, "the sign-in event");
console.log("✅ WRITE_ACCESS notices are acked and the panel's sign-in click reaches the server");

const t0 = Date.now();
await assert.rejects(
  bridge.request({ type: "FUTURE_THING", id: "ignored" }),
  /can't read the server's "FUTURE_THING" request/,
  "an unknown request type is answered with a readable ERROR",
);
assert.ok(Date.now() - t0 < 1000, "rejects fast, not on the 15s timeout");
console.log(`✅ Unknown type rejects in ${Date.now() - t0}ms (not a 15s hang)`);

// --- Origins and the single slot ---
for (const origin of ["https://evil.example.com", "https://www.figma.com"])
  assert.equal(
    await refusedOrOpened(new WebSocket(URL, { origin })),
    "refused",
    `${origin} is refused: a page script, not the sandboxed plugin`,
  );
assert.equal(connected, 1, "web origins never reach the connection handler");
assert.equal(
  await refusedOrOpened(new WebSocket(URL, { origin: "null" })),
  "refused",
  "a second connection is refused while an established plugin holds the slot",
);
assert.equal((await execute(bridge)).result, "ok", "the original plugin still drives");
console.log("✅ Web origins and a second connection are refused; the established plugin keeps the slot");

// --- Approval is sticky across a reconnect, but only once the server re-introduces itself ---
// The socket drops (a server blip); the relay redials on its own. A fresh socket starts unapproved,
// so a different server that grabbed the port can't ride the old approval; the server's echo of the
// token it was handed re-keys approval to it, with no second Allow.
plugin.drop();
await until(() => connected === 2, "the relay's redial", 5_000);
await until(() => bridge.protocolCompatibility() === "compatible", "the redial's verdict");
assert.equal((await execute(bridge)).type, "PENDING_APPROVAL", "a write before SESSION_INFO is gated");
await introduce(bridge);
assert.equal((await execute(bridge)).result, "ok", "a reconnect stays approved (token echoed)");
console.log("✅ Approval is sticky across reconnects (server echoes the token), never before SESSION_INFO");

// A disconnect mid-request rejects the in-flight call at once, not at its deadline.
plugin.close();
await wait(150);
const mute = silentHolder(URL);
await opened(mute);
await wait(50); // let the handshake settle, so the write is sent rather than held
const t1 = Date.now();
const inflight = execute(bridge).catch((e) => e);
await wait(50);
mute.terminate();
const discErr = await inflight;
assert.ok(discErr instanceof Error && /disconnect/i.test(discErr.message), "rejects on disconnect");
assert.ok(Date.now() - t1 < 1000, "rejects fast on disconnect, not 15s");
console.log(`✅ Disconnect rejects the in-flight request in ${Date.now() - t1}ms`);
await wait(150);

// --- A same-path squatter holding no token is re-prompted, by the same approved plugin ---
// The human approved the server above; a DIFFERENT local server announces the SAME identity but never
// got an Allow handover, so it echoes no token. The same plugin (same storage) connecting to it must
// gate: approval keys on the token, never on the forgeable identity.
const sharedPluginStorage = new Map();
const owner = await realPlugin(PORT, { storage: sharedPluginStorage });
await until(() => bridge.protocolCompatibility() === "compatible", "the owner's verdict");
await introduce(bridge);
await owner.allow();
assert.equal((await execute(bridge)).result, "ok", "precondition: this plugin approved the server");
owner.close();
const PORT_SQUAT = 19878;
const squatBridge = new PluginBridge(isolatedStore());
squatBridge.start([PORT_SQUAT]);
await wait(150);
const squatted = await realPlugin(PORT_SQUAT, { storage: sharedPluginStorage });
await until(() => squatBridge.protocolCompatibility() === "compatible", "the squatter's verdict");
assert.equal(squatBridge.approvedSession(), null, "a squatter server holds no session token");
await introduce(squatBridge);
assert.equal(
  (await execute(squatBridge)).type,
  "PENDING_APPROVAL",
  "a same-identity squatter with no token is re-prompted",
);
console.log("✅ A same-path squatter with no token re-prompts, even on the same approved plugin");
squatted.close();
squatBridge.stop();
await wait(150);

// --- Durable approval: a restarted server reloads the persisted token; Revoke clears it ---
// Persistence keys on (cwd, port), so a restarted server reloads only if it reclaims its own port —
// what a real single-server restart does. The plugin's storage survives the restart, as in Figma.
const sharedDir = mkdtempSync(join(tmpdir(), "flcm-approval-restart-"));
const sharedStore = () => new ApprovalStore(process.cwd(), sharedDir);
const RESTART_PORT = 19879;
const restartStorage = new Map();
const bridgeR1 = new PluginBridge(sharedStore());
bridgeR1.start([RESTART_PORT]);
await wait(150);
const r1 = await realPlugin(RESTART_PORT, { storage: restartStorage });
await introduce(bridgeR1);
await r1.allow();
await until(() => bridgeR1.approvedSession() !== null, "the persisted token");
const persistedToken = bridgeR1.approvedSession()?.token;
r1.close();
bridgeR1.stop();
await wait(150);

const bridgeR2 = new PluginBridge(sharedStore());
bridgeR2.start([RESTART_PORT]);
await wait(150);
assert.equal(bridgeR2.approvedSession()?.token, persistedToken, "a restart reloads the persisted token");
assert.deepEqual(bridgeR2.approvedSession()?.authorizingUser, LOOPBACK_USER, "and who it's attributed to");
const r2 = await realPlugin(RESTART_PORT, { storage: restartStorage });
await until(() => bridgeR2.protocolCompatibility() === "compatible", "the verdict after restart");
await introduce(bridgeR2);
assert.equal((await execute(bridgeR2)).result, "ok", "the reloaded token re-approves: no second Allow");
console.log("✅ Durable approval survives a same-port server restart (persisted token reloaded)");

// A concurrent same-cwd sibling on a DIFFERENT port inherits nothing: its key names another file.
const bridgeSibling = new PluginBridge(sharedStore());
bridgeSibling.start([19883]);
await wait(150);
assert.equal(bridgeSibling.approvedSession(), null, "a same-cwd server on another port inherits nothing");
console.log("✅ A concurrent same-cwd sibling on another port does not inherit approval (keyed by cwd+port)");
bridgeSibling.stop();

r2.revoke();
await until(() => bridgeR2.approvedSession() === null, "the revoke");
r2.close();
bridgeR2.stop();
await wait(150);
const bridgeR3 = new PluginBridge(sharedStore());
bridgeR3.start([RESTART_PORT]);
await wait(150);
assert.equal(bridgeR3.approvedSession(), null, "after Revoke, a restart reloads nothing");
console.log("✅ Revoke deletes the persisted token so it can't silently re-approve on the next restart");
bridgeR3.stop();

// --- A restart that races its own dying predecessor must reclaim its port, not slip to the next ---
// A dev-watch save-restart is a photo finish: anything that slows the old process's exit makes the
// successor see EADDRINUSE, and slipping one port means an EMPTY approval slot and a fresh pairing
// code after a save nobody thought was a restart. A plain TCP listener models the not-yet-exited
// predecessor: the bind fails the same way.
const SLIP_PORT = 19884;
const bridgeS1 = new PluginBridge(sharedStore());
bridgeS1.start([SLIP_PORT, SLIP_PORT + 1]);
await wait(150);
const s1 = await realPlugin(SLIP_PORT);
await introduce(bridgeS1);
await s1.allow();
await until(() => bridgeS1.approvedSession() !== null, "the pre-restart approval");
const slipToken = bridgeS1.approvedSession()?.token;
s1.close();
bridgeS1.stop();
await wait(150);

const predecessor = net.createServer();
await new Promise((res) => predecessor.listen(SLIP_PORT, "127.0.0.1", res));
const bridgeS2 = new PluginBridge(sharedStore());
bridgeS2.start([SLIP_PORT, SLIP_PORT + 1]);
await wait(300);
// HOLDING OFF, not merely tokenless: had it advanced it would be listening on SLIP_PORT+1 by now.
assert.equal(
  await refusedOrOpened(new WebSocket(`ws://127.0.0.1:${SLIP_PORT + 1}`, { origin: "null" })),
  "refused",
  "the successor holds off on its own occupied port instead of binding the next one",
);
await new Promise((res) => predecessor.close(res));
await wait(400);
assert.equal(bridgeS2.approvedSession()?.token, slipToken, "it reclaims its port and reloads its approval");
console.log("✅ A restart racing its dying predecessor reclaims its own port — no slip, no fresh Allow");
bridgeS2.stop();
await wait(150);

// --- The reclaim wait is bounded on both sides, and cancellable ---

// (a) A busy port this project holds NO approval for is advanced past AT ONCE. The window is injected
// and long, so only an immediate advance can have bound by the check.
const NOAPP_PORT = 19880;
const noAppHolder = net.createServer();
await new Promise((res) => noAppHolder.listen(NOAPP_PORT, "127.0.0.1", res));
const bridgeNoApp = new PluginBridge(sharedStore(), { reclaimWindowMs: 5_000 });
bridgeNoApp.start([NOAPP_PORT, NOAPP_PORT + 1]);
await wait(250);
const advancedAtOnce = new WebSocket(`ws://127.0.0.1:${NOAPP_PORT + 1}`, { origin: "null" });
assert.equal(
  await refusedOrOpened(advancedAtOnce),
  "opened",
  "a busy port with no approval of its own is advanced past immediately, not waited on",
);
console.log("✅ A busy port this project never approved is advanced past at once");
advancedAtOnce.close();
bridgeNoApp.stop();
await new Promise((res) => noAppHolder.close(res));
await wait(150);

// (b) A holder that never lets go is abandoned AT THE DEADLINE, or startup hangs with no error.
const STUCK_PORT = 19892;
const bridgeD1 = new PluginBridge(sharedStore());
bridgeD1.start([STUCK_PORT]);
await wait(150);
const d1 = await realPlugin(STUCK_PORT);
await introduce(bridgeD1);
await d1.allow();
await until(() => bridgeD1.approvedSession() !== null, "precondition: the port is approved");
d1.close();
bridgeD1.stop();
await wait(150);

const stuck = net.createServer(); // never released
await new Promise((res) => stuck.listen(STUCK_PORT, "127.0.0.1", res));
const bridgeD2 = new PluginBridge(sharedStore(), { reclaimWindowMs: 300 });
bridgeD2.start([STUCK_PORT, STUCK_PORT + 1]);
await wait(700);
const gaveUp = new WebSocket(`ws://127.0.0.1:${STUCK_PORT + 1}`, { origin: "null" });
assert.equal(await refusedOrOpened(gaveUp), "opened", "a held port is abandoned at the deadline");
assert.equal(bridgeD2.approvedSession(), null, "with no approval for the port it settled on");
console.log("✅ A port held past the reclaim deadline is abandoned for the next one (startup is bounded)");
gaveUp.close();
bridgeD2.stop();
await wait(150);

// (c) stop() cancels a re-probe in flight, or a discarded bridge silently rebinds its port.
const bridgeD3 = new PluginBridge(sharedStore(), { reclaimWindowMs: 5_000 });
bridgeD3.start([STUCK_PORT]);
await wait(150);
bridgeD3.stop();
await new Promise((res) => stuck.close(res));
await wait(400);
assert.equal(bridgeD3.approvedSession(), null, "a stopped bridge does not reload an approval");
assert.equal(
  await refusedOrOpened(new WebSocket(`ws://127.0.0.1:${STUCK_PORT}`, { origin: "null" })),
  "refused",
  "a stopped bridge leaves its port free",
);
console.log("✅ stop() cancels an in-flight reclaim retry (a stopped bridge cannot rebind its port)");
await wait(150);

// (d) …and disowns a bind the OS already accepted: its `listening` fires after stop() regardless.
const FREE_PORT = 19886;
const bridgeD4 = new PluginBridge(sharedStore());
bridgeD4.start([FREE_PORT]);
bridgeD4.stop();
await wait(300);
assert.equal(
  await refusedOrOpened(new WebSocket(`ws://127.0.0.1:${FREE_PORT}`, { origin: "null" })),
  "refused",
  "a bridge stopped mid-bind leaves the port free instead of claiming it unclosably",
);
console.log("✅ stop() disowns a bind already in flight");

// --- The compatibility verdict is connection-scoped ---
await wait(150);
const current = await realPlugin(PORT);
await until(() => bridge.protocolCompatibility() === "compatible", "the verdict");
current.close();
await until(() => bridge.protocolCompatibility() === "checking", "the reset on disconnect");
console.log("✅ The compatibility verdict is connection-scoped (back to `checking` on disconnect)");

// --- Heartbeat reaps a half-open holder ---
// A handshaked holder whose socket goes half-open (crash, laptop sleep: no FIN) still blocks a second
// connection; only the heartbeat, missing its pong, frees the slot for the live plugin.
await wait(150);
const dead = silentHolder(URL, { autoPong: false });
await opened(dead);
await until(() => bridge.protocolCompatibility() === "compatible", "the holder's handshake");
assert.equal(
  await refusedOrOpened(new WebSocket(URL, { origin: "null" })),
  "refused",
  "an established holder blocks a second connection until the heartbeat reaps it",
);
bridge.heartbeatTick();
await wait(50);
bridge.heartbeatTick(); // missed pong → terminate
await wait(150);
const revived = new WebSocket(URL, { origin: "null" });
assert.equal(await refusedOrOpened(revived), "opened", "the reaped slot takes the next connection");
console.log("✅ Heartbeat reaps a half-open holder so the live plugin can reconnect");
revived.close();
dead.close();
await wait(150);

// --- A new connection reclaims the slot from a non-handshaking squatter ---
const squatter = new WebSocket(URL, { origin: "null" }); // connects, then stays mute
await opened(squatter);
const reclaimer = await realPlugin(PORT);
await until(() => bridge.protocolCompatibility() === "compatible", "the reclaimer's verdict");
await introduce(bridge);
await reclaimer.allow();
assert.equal((await execute(bridge)).result, "ok", "the reclaimer drives once it handshakes");
assert.ok(
  squatter.readyState === WebSocket.CLOSING || squatter.readyState === WebSocket.CLOSED,
  "the displaced squatter is disconnected",
);
console.log("✅ A new connection reclaims the slot from a non-handshaking holder, then drives");
reclaimer.close();
await wait(150);

// --- A displaced socket's close must not reject the newcomer's in-flight handshake ---
// index.ts fires the newcomer's SESSION_INFO synchronously from onConnect; the displaced socket's
// close lands a tick later and must fail only its own requests.
const PORT2 = 19877;
const bridge2 = new PluginBridge(isolatedStore());
const handshakes = [];
bridge2.start([PORT2], () => handshakes.push(introduce(bridge2).catch((e) => e)));
await wait(150);
const sq2 = new WebSocket(`ws://127.0.0.1:${PORT2}`, { origin: "null" });
await opened(sq2);
const real2 = await realPlugin(PORT2);
await wait(150);
const ack = await handshakes.at(-1);
assert.equal(ack?.type, "SESSION_INFO_ACK", "the newcomer's handshake survives the old close");
console.log("✅ A displaced socket's close doesn't reject the newcomer's in-flight handshake");
sq2.close();
real2.close();
bridge2.stop();
await wait(150);

// --- A reclaimed connection's late handshake verdict can't clobber the newcomer ---
// A mute squatter's GET_VERSION orphans when the plugin reclaims the slot and resolves LATE, on its
// timeout, as the protocol floor; landing on the newcomer it would refuse every write.
const GHOST_PORT = 19887;
const ghostBridge = new PluginBridge(isolatedStore(), { requestTimeoutMs: 200 });
ghostBridge.start([GHOST_PORT]);
await wait(150);
const ghost = new WebSocket(`ws://127.0.0.1:${GHOST_PORT}`, { origin: "null" });
await opened(ghost);
await wait(30);
const heir = await realPlugin(GHOST_PORT);
await wait(300); // outlast the orphaned handshake's timeout
assert.equal(ghostBridge.protocolCompatibility(), "compatible", "the late verdict lands nowhere");
console.log("✅ A reclaimed connection's late handshake can't clobber the current plugin's verdict");
heir.close();
ghost.close();
ghostBridge.stop();
await wait(150);

// --- A request held across a slot reclaim runs on the newcomer, instead of hanging ---
const RECLAIM_PORT = 19889;
const reclaimBridge = new PluginBridge(isolatedStore(), { requestTimeoutMs: 5_000 });
reclaimBridge.start([RECLAIM_PORT]);
await wait(150);
const muteSquatter = new WebSocket(`ws://127.0.0.1:${RECLAIM_PORT}`, { origin: "null" });
await opened(muteSquatter);
await wait(30);
assert.equal(reclaimBridge.protocolCompatibility(), "checking", "the squatter's protocol is unknown");
let heldSettled = false;
const heldWrite = execute(reclaimBridge).then(
  (r) => ((heldSettled = true), r),
  (e) => ((heldSettled = true), e),
);
await wait(50);
assert.equal(heldSettled, false, "the write is held, not sent, while the protocol is unknown");
// The newcomer's handshake is held open on purpose, so introducing and approving it happens INSIDE
// the window — the test is about the hold, not about which round trip finishes first.
const takeover = await realPlugin(RECLAIM_PORT, { holdVersionMs: 300 });
await introduce(reclaimBridge);
await takeover.allow();
const heldResult = await Promise.race([heldWrite, wait(1500).then(() => "HUNG")]);
assert.notEqual(heldResult, "HUNG", "a write held across a reclaim must not hang");
assert.equal(heldResult.result, "ok", "it runs against the plugin that took the slot");
console.log("✅ A write held across a slot reclaim runs on the newcomer instead of hanging");
takeover.close();
muteSquatter.close();
reclaimBridge.stop();
await wait(150);

// --- A canvas request racing the version handshake is HELD, then refused ---
// Without the hold, a write landing between connect and the VERSION answer would reach a plugin
// below this server's protocol and run.
const RACE_PORT = 19888;
const raceUrl = `ws://127.0.0.1:${RACE_PORT}`;
const raceBridge = new PluginBridge(isolatedStore(), { requestTimeoutMs: 500 });
raceBridge.start([RACE_PORT]);
await wait(150);
const stale = stalePeer(
  raceUrl,
  { pluginVersion: "0.0.1", protocolVersion: PROTOCOL_VERSION - 1 },
  250,
);
await opened(stale);
await wait(30);
assert.equal(raceBridge.protocolCompatibility(), "checking", "the protocol is not known yet");
await assert.rejects(
  execute(raceBridge),
  (e) => e.message.includes(`plugin v0.0.1 (protocol v${PROTOCOL_VERSION - 1})`),
  "a write inside the handshake window is refused, naming the plugin it round-tripped",
);
assert.equal(raceBridge.protocolCompatibility(), "incompatible", "the verdict landed meanwhile");
await assert.rejects(execute(raceBridge), /protocol v/, "and it stays refused");
assert.ok(!stale.received.includes("EXECUTE_CODE"), "the stale plugin never received the code");
console.log("✅ A write racing the version handshake HOLDS, then is refused — never sent");
stale.close();
await wait(150);

// A plugin predating the handshake (it ERRORs GET_VERSION) is the floor, refused on the same rule.
const spikeEra = stalePeer(raceUrl, null);
await opened(spikeEra);
await wait(30);
await assert.rejects(execute(raceBridge), /protocol v/, "a plugin with no version is refused");
assert.ok(!spikeEra.received.includes("EXECUTE_CODE"), "and never receives the code");
console.log("✅ A plugin predating the handshake is refused (missing version → floor)");
spikeEra.close();
await wait(150);

// A plugin NEWER than this server is refused too: its FlcmHost isn't the one this preamble targets.
const newer = stalePeer(raceUrl, { pluginVersion: "9.9.9", protocolVersion: PROTOCOL_VERSION + 1 });
await opened(newer);
await wait(30);
await assert.rejects(
  execute(raceBridge),
  (e) => e.message.includes("is newer") && e.message.includes("update this Framelink MCP server"),
  "a newer plugin is refused, telling the human to update the server",
);
assert.ok(!newer.received.includes("EXECUTE_CODE"), "and never receives the code");
console.log("✅ A plugin newer than the server is refused, naming the server as the side to update");
newer.close();
await wait(150);

// The hold DELAYS a current plugin, it doesn't break it.
const currentRacer = await realPlugin(RACE_PORT, { holdVersionMs: 250 });
await introduce(raceBridge);
await currentRacer.allow();
assert.equal(raceBridge.protocolCompatibility(), "checking", "still inside the handshake window");
assert.equal((await execute(raceBridge)).result, "ok", "the held write runs once the verdict lands");
console.log("✅ The hold only delays a current plugin — its write runs once the verdict lands");
currentRacer.close();
await wait(150);

// A disconnect INSIDE the handshake window leaves no false `incompatible` behind: with nothing
// connected the agent must hear that, not be told to reinstall a plugin.
const dropper = await realPlugin(RACE_PORT, { holdVersionMs: 5_000 });
await wait(30);
assert.equal(raceBridge.protocolCompatibility(), "checking", "still inside the handshake window");
dropper.close();
await wait(100);
assert.equal(raceBridge.protocolCompatibility(), "checking", "the disconnect leaves no verdict");
await assert.rejects(
  execute(raceBridge),
  /The Framelink plugin disconnected .* This call was not submitted/,
  "with nothing connected the agent is told exactly that",
);
console.log("✅ A disconnect inside the handshake window leaves no false `incompatible` behind");
raceBridge.stop();
await wait(150);

// --- Port-block discovery: two servers sharing a block bind distinct ports ---
const BLOCK = [19890, 19891];
const bridgeA = new PluginBridge(isolatedStore());
bridgeA.start(BLOCK);
await wait(150);
const bridgeB = new PluginBridge(isolatedStore());
bridgeB.start(BLOCK);
await wait(250);
const onBase = new WebSocket(`ws://127.0.0.1:${BLOCK[0]}`, { origin: "null" });
assert.equal(await refusedOrOpened(onBase), "opened", "the first server bound the base port");
const onNext = new WebSocket(`ws://127.0.0.1:${BLOCK[1]}`, { origin: "null" });
assert.equal(await refusedOrOpened(onNext), "opened", "the second advanced on EADDRINUSE");
console.log("✅ Two servers sharing a block bind distinct ports (probe-bind advances on EADDRINUSE)");
onBase.close();
onNext.close();
bridgeA.stop();
bridgeB.stop();
await wait(150);

// The manifest must list every block port exactly (Figma has no port wildcard), or a session on an
// unlisted port silently fails discovery in a live re-import nobody runs in the build loop. The relay
// reads the block from protocol.ts itself, so it can't drift.
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "../plugin");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
assert.deepEqual(
  [...manifest.networkAccess.devAllowedDomains].sort(),
  WS_PORT_BLOCK.map((port) => `ws://localhost:${port}`).sort(),
  "manifest devAllowedDomains lists exactly the WS_PORT_BLOCK ports",
);
assert.deepEqual(manifest.networkAccess.allowedDomains, ["none"], "no production network access");
console.log(`✅ manifest devAllowedDomains mirrors WS_PORT_BLOCK exactly (${WS_PORT_BLOCK.length} ports)`);

// --- Deadlines: cancel, never abandon; the cancel is ANSWERED; a late result still reports ---
// A run that stalls is CANCELLED with a run-scoped, id-less CANCEL, and the caller's rejection is
// worded from the plugin's answer — "never executed; retry" and "inspect the canvas" differ.
const PORT_T = 19895;
const changedRuns = [];
const bridgeT = new PluginBridge(isolatedStore(), {
  requestTimeoutMs: 400,
  events: { onRunDocumentChanged: (runId) => changedRuns.push(runId) },
});
bridgeT.start([PORT_T]);
await wait(150);
const framesT = [];
let disposition = "never-executed";
const silent = silentHolder(`ws://127.0.0.1:${PORT_T}`, {
  onFrame: (msg) => {
    framesT.push(msg);
    if (msg.type === "CANCEL")
      silent.send(JSON.stringify({ type: "CANCEL_RESULT", runId: msg.runId, disposition }));
  },
});
await opened(silent);
const tStall = Date.now();
const timeoutErr = await execute(bridgeT, { code: "stall forever" }).catch((e) => e);
assert.ok(/no traffic/.test(timeoutErr.message), "a stalled run rejects with the inactivity message");
assert.ok(Date.now() - tStall < 2000, "the injected short deadline fired, not the 15s default");
assert.ok(/never executed/.test(timeoutErr.message), "worded from the plugin's cancel answer");
assert.equal(timeoutErr.outcome, "not-submitted", "a run that never executed is safe to retry");
await wait(50);
const cancelFrame = framesT.find((f) => f.type === "CANCEL");
const stalled = framesT.find((f) => f.type === "EXECUTE_CODE");
assert.equal(cancelFrame?.runId, stalled.id, "the CANCEL is scoped to the stalled run");
assert.equal(cancelFrame.id, undefined, "CANCEL is id-less — a notification, never a request");
console.log("✅ A stalled run is cancelled (run-scoped, id-less CANCEL) and rejected with the plugin's answer");

// The holder wakes up: a result for a run its caller gave up on still reports a document change,
// and a late read-only result does not.
disposition = "was-running";
await execute(bridgeT, { code: "changed late" }).catch(() => {});
const lateRun = framesT.filter((f) => f.type === "EXECUTE_CODE").at(-1).id;
const lateResult = (id, documentChanged) =>
  JSON.stringify({ type: "EXECUTE_CODE_RESULT", id, console: [], errors: null, documentChanged });
silent.send(lateResult(stalled.id, false));
silent.send(lateResult(lateRun, true));
await until(() => changedRuns.length === 1, "the late change");
assert.deepEqual(changedRuns, [lateRun], "a late change reaches the server; a late read does not");
console.log("✅ A late changed result reaches the server under its run id; a late read-only one does not");
silent.close();
bridgeT.stop();
await wait(150);

// --- The reverse channel: a mid-run image fetch ---
// The plugin's CHANNEL_REQUEST (its own id namespace, tagged with the run) is answered by a typed
// CHANNEL_RESPONSE; serving SUSPENDS the run's inactivity deadline; a request for a run the server
// no longer tracks is refused. Driven by a raw socket speaking the plugin's half on a timetable.
const PORT_I = 19896;
const servedBatches = [];
const bridgeI = new PluginBridge(isolatedStore(), {
  requestTimeoutMs: 500,
  capabilities: new Map([
    [
      "images.fetch",
      async (urls) => {
        servedBatches.push(urls);
        if (urls.includes("boom")) throw new Error('flcm.image could not load "boom": blocked range');
        await wait(700); // longer than the whole deadline: serving must not count against the run
        return Object.fromEntries(urls.map((u) => [u, "b64-" + u]));
      },
    ],
  ]),
});
bridgeI.start([PORT_I]);
await wait(150);
const framesImg = [];
let imagesReply = null;
const pluginImg = new WebSocket(`ws://127.0.0.1:${PORT_I}`, { origin: "null" });
pluginImg.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  framesImg.push(msg);
  if (answerVersionHandshake(pluginImg, msg)) return;
  if (msg.type === "EXECUTE_CODE") {
    // The urls repeat one entry on purpose: dedupe is the handler's job (the plugin is untrusted).
    const urls = msg.code === "boom run" ? ["boom"] : ["u1", "u1", "u2"];
    const preqId = msg.code === "boom run" ? "preq-2" : "preq-1";
    setTimeout(() => {
      pluginImg.send(
        JSON.stringify({
          type: "CHANNEL_REQUEST",
          capability: "images.fetch",
          id: preqId,
          runId: msg.id,
          payload: urls,
        }),
      );
    }, 100);
    pluginImg.runId = msg.id;
  }
  if (msg.type === "CHANNEL_RESPONSE" && msg.ok === true) {
    imagesReply = msg;
    setTimeout(() => {
      pluginImg.send(
        JSON.stringify({
          type: "EXECUTE_CODE_RESULT",
          id: pluginImg.runId,
          result: msg.payload,
          console: [],
          errors: null,
          documentChanged: false,
        }),
      );
    }, 100);
  }
  if (msg.type === "CHANNEL_RESPONSE" && msg.ok === false && msg.id === "preq-2") {
    pluginImg.send(
      JSON.stringify({
        type: "EXECUTE_CODE_RESULT",
        id: pluginImg.runId,
        console: [],
        errors: msg.error.message,
        documentChanged: false,
      }),
    );
  }
});
await opened(pluginImg);

const imgRun = await execute(bridgeI, { code: "render with images" });
assert.deepEqual(imgRun.result, { u1: "b64-u1", u2: "b64-u2" }, "the run completed with the bytes");
assert.equal(imagesReply.id, "preq-1", "the reply carries the PLUGIN-issued id");
assert.deepEqual(servedBatches[0], ["u1", "u1", "u2"], "the handler received the raw batch");
// ~900ms of wall clock against a 500ms deadline: only suspend-while-serving lets that succeed.
console.log("✅ Mid-run image fetch round-trips in ONE run, and serving suspends the run's deadline");

const boomRun = await execute(bridgeI, { code: "boom run" });
assert.match(String(boomRun.errors), /could not load "boom"/, "a fetch failure reaches the run");
console.log("✅ A failed fetch rejects the run's await via a typed CHANNEL_RESPONSE failure");

pluginImg.send(
  JSON.stringify({
    type: "CHANNEL_REQUEST",
    capability: "images.fetch",
    id: "preq-9",
    runId: "req-9999",
    payload: ["u3"],
  }),
);
await wait(100);
const refusal = framesImg.find((f) => f.type === "CHANNEL_RESPONSE" && f.id === "preq-9");
assert.ok(
  refusal?.ok === false && /no longer active/.test(refusal.error.message),
  "an image request for an untracked run is refused, not served",
);
console.log("✅ An image request for a dead run is refused (zombie runs die at their await)");
pluginImg.close();
bridgeI.stop();
await wait(150);

// --- Reverse-channel guards: only a code run can be drawn on; suspension is refcounted ---
const PORT_C = 19897;
const bridgeC = new PluginBridge(isolatedStore(), {
  requestTimeoutMs: 500,
  capabilities: new Map([
    [
      "images.fetch",
      async (urls) => {
        await wait(urls.includes("slow") ? 1200 : 50);
        return Object.fromEntries(urls.map((u) => [u, "b64-" + u]));
      },
    ],
  ]),
});
bridgeC.start([PORT_C]);
await wait(150);
const framesC = [];
const pluginC = new WebSocket(`ws://127.0.0.1:${PORT_C}`, { origin: "null" });
pluginC.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  framesC.push(msg);
  answerVersionHandshake(pluginC, msg);
});
await opened(pluginC);

// A handshake request is pending too; drawing on one would let a hostile holder burn fetches against
// a pending it was never granted a run for. The refusal must leave that pending intact.
const infoP = introduce(bridgeC).catch((e) => e);
await wait(50);
const infoId = framesC.find((f) => f.type === "SESSION_INFO").id;
const imageRequest = (id, runId, payload) =>
  pluginC.send(
    JSON.stringify({ type: "CHANNEL_REQUEST", capability: "images.fetch", id, runId, payload }),
  );
imageRequest("preq-g", infoId, ["u1"]);
await wait(100);
const gateRefusal = framesC.find((f) => f.type === "CHANNEL_RESPONSE" && f.id === "preq-g");
assert.ok(
  gateRefusal?.ok === false && /not a code run/.test(gateRefusal.error.message),
  "an image request against a non-EXECUTE_CODE pending is refused",
);
pluginC.send(JSON.stringify({ type: "SESSION_INFO_ACK", id: infoId }));
assert.equal((await infoP).type, "SESSION_INFO_ACK", "the refusal left the pending intact");
console.log("✅ Only an EXECUTE_CODE pending can be drawn on by the reverse channel");

// Two overlapping services for ONE run: the deadline re-arms only when the LAST settles, or the
// fast one's settle would restart a 500ms clock the slow (1200ms) fetch then outruns.
const runP = execute(bridgeC, { code: "two fetches" }).catch((e) => e);
await wait(50);
const runIdC = framesC.find((f) => f.type === "EXECUTE_CODE").id;
imageRequest("preq-f", runIdC, ["fast"]);
await wait(20);
imageRequest("preq-s", runIdC, ["slow"]);
await wait(1400);
const served = (id) => framesC.some((f) => f.type === "CHANNEL_RESPONSE" && f.ok && f.id === id);
assert.ok(served("preq-f") && served("preq-s"), "both services replied");
assert.ok(!framesC.some((f) => f.type === "CANCEL"), "no CANCEL fired while a service was in flight");
pluginC.send(
  JSON.stringify({
    type: "EXECUTE_CODE_RESULT",
    id: runIdC,
    result: "built",
    console: [],
    errors: null,
    documentChanged: true,
  }),
);
assert.equal((await runP).result, "built", "the run finished after both services settled");
console.log("✅ Concurrent services hold ONE suspension (re-arm only on the last settle)");
pluginC.close();
bridgeC.stop();
bridge.stop();
await wait(150);

console.log("\nAll bridge contract checks passed.");
process.exit(0);
