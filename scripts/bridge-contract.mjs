/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Port-level contract check for the PluginBridge: the REAL bridge on real sockets, against the REAL
// plugin (ui.ts + code.ts built from source, src/commercial/tests/fixtures/loopback-plugin.ts) wherever
// a current plugin is the counterpart. The only hand-written peers are adversarial or timing ones — a
// stale plugin, an unpaired stranger, a paired link that goes silent — driven as raw sockets. It pins
// what a refactor could silently undo:
//
//   • Origin:null connects; web origins (figma.com included) are refused; several links coexist,
//     a flood of unauthenticated ones can't lock a plugin out, and an authenticated one is never
//     displaced.
//   • Link setup gates everything: HELLO refuses another protocol outright, AUTHENTICATE proves the
//     installation credential, and an unpaired link is sent nothing but setup frames.
//   • Pairing: the panel shows the code the server offered, and only that code pairs that link.
//   • The grant gate: the plugin refuses a run until a human allows this project on the proven
//     document; the grant lives in the plugin alone, so a reconnect, a restart or a sibling server in
//     the same project needs no second Allow, another installation is asked anew, and Revoke ends it.
//   • Port-block discovery: first free port, a stopped bridge disowning its bind, and the manifest
//     mirroring WS_PORT_BLOCK.
//   • Deadlines cancel (never abandon) and are worded from the plugin's answer; the reverse channel
//     suspends them while serving and refuses requests that aren't a live code run's.
//
// Usage:  pnpm contract   (or: npx tsx scripts/bridge-contract.mjs)

import { WebSocket } from "ws";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PluginBridge } from "../src/commercial/plugin-bridge/bridge.ts";
import { LinkCredentialStore, linkProof } from "../src/commercial/plugin-bridge/link-credential.ts";
import { PROTOCOL_VERSION, WS_PORT_BLOCK } from "../plugin/src/protocol.ts";
import { buildSandboxPreamble } from "../plugin/src/preamble/index.mjs";
import {
  LoopbackFigma,
  startLoopbackPlugin,
} from "../src/commercial/tests/fixtures/loopback-plugin.ts";

const PORT = 19876;
const URL = `ws://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (condition, what, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
};

// The Figma files the real plugins are open in, and the REST read every bridge proves them with.
const figmaFiles = new LoopbackFigma();
const contractFile = figmaFiles.file("CONTRACTfile1", "Contract file");

// The real plugin evals what it is sent, so it gets the real std-lib (ADR-0010).
const PREAMBLE = await buildSandboxPreamble();
const execute = (bridge, link, fields = {}) =>
  bridge.request(link, {
    type: "EXECUTE_CODE",
    fileKey: contractFile.key,
    code: "return 'ok';",
    preamble: PREAMBLE,
    lateChangeWindowMs: 60_000,
    ...fields,
  });
const LOOPBACK_USER = { figmaUserId: "loopback-user", name: "Loopback Human" };

/** Bind a call to `fileKey` (null: let the human pick), waiting `waitMs` for the plugin's answer. */
const target = (bridge, fileKey, waitMs = 5_000) =>
  bridge.targetCall(fileKey, { signal: new AbortController().signal, waitMs, pollMs: 20 });

// Every bridge gets its OWN state dir — the link credential — so nothing one bridge persists is
// reloaded by another in this one process, and nothing touches the operator's real state root. The
// restart and shared-dir checks below opt INTO a shared dir on purpose.
const freshStateDir = () => mkdtempSync(join(tmpdir(), "flcm-contract-"));
function bridgeOn(ports, { stateDir = freshStateDir(), onConnect, ...options } = {}) {
  const bridge = new PluginBridge({
    linkCredentials: new LinkCredentialStore(stateDir),
    documentReader: figmaFiles.reader,
    proofTiming: { pollMs: 20, deadlineMs: 1_000 },
    ...options,
  });
  bridge.start([ports].flat(), onConnect);
  bridge.stateDir = stateDir;
  return bridge;
}

/** The real plugin, dialing `port`, with its socket open. */
async function realPlugin(port, options) {
  const plugin = startLoopbackPlugin(port, options);
  await plugin.opened();
  return plugin;
}

/** The one link `bridge` resolves, waiting out a plugin that is still dialing or setting up. */
async function linkOf(bridge) {
  let resolution;
  await until(
    async () => (resolution = await bridge.resolveLink()).kind === "linked",
    "an authenticated link",
  );
  return resolution.links[0];
}

/** Pair the way a person does: offer, read the code off the real panel, confirm exactly that. */
async function pairByPanel(bridge, plugin) {
  await until(async () => (await bridge.resolveLink()).kind === "unpaired", "an unpaired link");
  const offer = await bridge.offerPairing();
  assert.equal(offer.kind, "offered", "an unpaired link is offered a pairing code");
  const shown = await plugin.pairingCode();
  const confirmed = await bridge.confirmPairing(shown);
  assert.equal(confirmed.kind, "paired", "confirming the code the panel shows pairs it");
  return confirmed.link;
}

// ---- Raw peers ----

// A socket speaking the plugin's half of link setup by hand. `protocolVersion: null` predates HELLO
// and ERRORs every request; `credentialDir` names the state dir whose credential it holds (none:
// unpaired). It claims no document. `received` lists every request type it was sent; `onFrame` sees
// the rest.
function rawPeer(
  url,
  {
    protocolVersion = PROTOCOL_VERSION,
    pluginVersion,
    helloDelayMs = 0,
    credentialDir,
    autoPong = true,
    onFrame = () => {},
  } = {},
) {
  const ws = new WebSocket(url, { origin: "null", autoPong });
  ws.received = [];
  const send = (body) => ws.send(JSON.stringify(body));
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (typeof msg.id === "string") ws.received.push(msg.type);
    if (msg.type === "HELLO") {
      if (protocolVersion === null)
        send({ type: "ERROR", id: msg.id, error: 'Unsupported message type "HELLO".' });
      else
        setTimeout(
          () => send({ type: "HELLO_RESULT", id: msg.id, protocolVersion, pluginVersion }),
          helloDelayMs,
        );
      return;
    }
    if (msg.type === "AUTHENTICATE") {
      const credential = credentialDir && new LinkCredentialStore(credentialDir).readOrCreate();
      send(
        credential
          ? { type: "LINK_PROOF", id: msg.id, proof: linkProof(credential, msg.nonce), owner: null }
          : { type: "LINK_UNPAIRED", id: msg.id },
      );
      return;
    }
    if (msg.type === "INTRODUCE") {
      send({ type: "INTRODUCED", id: msg.id, claim: null });
      return;
    }
    onFrame(msg);
  });
  return ws;
}

const refusedOrOpened = (ws) =>
  new Promise((res) => {
    ws.on("error", () => res("refused"));
    ws.on("open", () => res("opened"));
  });
const opened = (ws) => new Promise((res) => ws.on("open", res));

let signInRequests = 0;
let grantChanges = 0;
let connected = 0;
const bridge = bridgeOn(PORT, {
  onConnect: () => connected++,
  events: {
    onWriteAccessSignIn: () => signInRequests++,
    onGrantChanged: () => grantChanges++,
  },
});
await wait(150);

// --- Pairing: an unpaired plugin is sent setup frames only, until its panel's code is confirmed ---
const pluginStorage = new Map();
const plugin = await realPlugin(PORT, { storage: pluginStorage, file: contractFile });
assert.equal(connected, 1, "the plugin (Origin:null) connects");
await until(async () => (await bridge.resolveLink()).kind === "unpaired", "the unpaired verdict");
const offer = await bridge.offerPairing();
const shown = await plugin.pairingCode();
assert.deepEqual(
  offer.attempts.map((attempt) => attempt.code),
  [shown],
  "the panel shows exactly the code the server offered",
);
assert.equal(
  (await bridge.confirmPairing(shown === "0000-0000" ? "1111-1111" : "0000-0000")).kind,
  "unknown-code",
  "a code no panel shows pairs nothing",
);
const pairing = await bridge.confirmPairing(shown);
assert.equal(pairing.kind, "paired", "the shown code pairs the link showing it");
let link = pairing.link;
assert.deepEqual(link.owner, LOOPBACK_USER, "the link carries the Figma user the plugin runs as");
assert.equal(plugin.showsPairingCode(), false, "the panel stops showing the code once paired");
console.log(
  "✅ The panel shows the offered code, and confirming exactly it pairs and authenticates",
);

// --- The grant gate ---
// A request the plugin can't read is refused BEFORE the grant gate — asking a human to allow a
// doomed write would be asking consent for nothing. An envelope ERROR rejects: it can never be
// mistaken for a run that completed with no result.
await assert.rejects(
  execute(bridge, link, { preamble: undefined }),
  /can't read the server's "EXECUTE_CODE" request/,
  "an EXECUTE_CODE without its std-lib is refused, not gated",
);
// Until a human allows this project on the proven document, the plugin refuses the run outright.
assert.equal((await execute(bridge, link)).type, "NOT_GRANTED", "a write before Allow is refused");
console.log("✅ A write before any grant is refused NOT_GRANTED, unrun");

// A call naming the file proves the link is in it (a nonce read back over REST), then waits on Allow.
const binding = target(bridge, contractFile.key);
await plugin.allow();
const bound = await binding;
assert.equal(bound.kind, "targeted", "Allow binds the call");
assert.deepEqual(
  bound.document,
  { fileKey: contractFile.key, fileName: contractFile.name },
  "to the proven document, named as REST names it",
);
assert.equal(grantChanges, 1, "the grant is announced to the server");
assert.equal((await execute(bridge, bound.link)).result, "ok", "the granted write runs");
assert.equal(
  (await execute(bridge, bound.link, { fileKey: "OTHERfile1" })).type,
  "NOT_GRANTED",
  "a run naming another document is refused, grant or no",
);
console.log("✅ After a proof and an Allow, the same write runs — only in the granted document");

// --- Protocol 8: write-access notices and the panel's sign-in click ---
const notice = { kind: "sign-in-failed", message: "contract" };
assert.equal(
  (await bridge.request(link, { type: "WRITE_ACCESS", notice })).type,
  "WRITE_ACCESS_ACK",
  "the panel acks a write-access notice",
);
plugin.signIn();
await until(() => signInRequests === 1, "the sign-in event");
console.log("✅ WRITE_ACCESS notices are acked and the panel's sign-in click reaches the server");

const t0 = Date.now();
await assert.rejects(
  bridge.request(link, { type: "FUTURE_THING", id: "ignored" }),
  /can't read the server's "FUTURE_THING" request/,
  "an unknown request type is answered with a readable ERROR",
);
assert.ok(Date.now() - t0 < 1000, "rejects fast, not on the 15s timeout");
console.log(`✅ Unknown type rejects in ${Date.now() - t0}ms (not a 15s hang)`);

// --- Origins, strangers, and the links beside the plugin ---
for (const origin of ["https://evil.example.com", "https://www.figma.com"])
  assert.equal(
    await refusedOrOpened(new WebSocket(URL, { origin })),
    "refused",
    `${origin} is refused: a page script, not the sandboxed plugin`,
  );
assert.equal(connected, 1, "web origins never reach the connection handler");
const stranger = rawPeer(URL, {
  onFrame: (msg) => stranger.received.push(msg.type),
});
await opened(stranger);
await wait(100);
stranger.send(
  JSON.stringify({ type: "GRANT_CHANGED", project: "/p", fileKey: "PLANTEDfile1", granted: true }),
);
stranger.send(JSON.stringify({ type: "DOCUMENT_CLAIMED", fileKey: "PLANTEDfile1" }));
stranger.send(
  JSON.stringify({ type: "CHANNEL_REQUEST", id: "q", runId: "r", capability: "images.fetch" }),
);
await wait(100);
assert.deepEqual(
  [...new Set(stranger.received)],
  ["HELLO", "AUTHENTICATE"],
  "an unpaired stranger is sent setup frames and nothing else, not even a channel refusal",
);
assert.equal(grantChanges, 1, "and nothing it sends is heard");
assert.equal((await execute(bridge, link)).result, "ok", "the plugin still drives beside it");
stranger.close();
console.log("✅ Web origins are refused; an unpaired stranger beside the plugin gets nothing");

// A flood of links that never authenticate can't lock a redialing plugin out, or displace one.
const flood = [];
for (let i = 0; i < 12; i++) {
  const mute = new WebSocket(URL, { origin: "null" });
  mute.on("error", () => {});
  flood.push(mute);
  await refusedOrOpened(mute);
}
await wait(100);
assert.equal(bridge.authenticatedLinks().length, 1, "the authenticated plugin is never displaced");
assert.equal((await execute(bridge, link)).result, "ok", "and still drives");
plugin.drop();
await until(
  () => bridge.authenticatedLinks().length === 1 && bridge.authenticatedLinks()[0] !== link,
  "the plugin's redial through the flood",
);
link = await linkOf(bridge);
for (const mute of flood) mute.close();
console.log(
  "✅ A flood of unauthenticated links neither displaces the plugin nor locks out its redial",
);

// --- The grant holds across a reconnect, with no prompt ---
// The redial above is a fresh link: it authenticated with no prompt (the plugin kept its pairing),
// re-claimed the file it was proven in, and was proven again on introduction.
assert.equal(plugin.showsPairingCode(), false, "a paired plugin's redial shows no pairing code");
const rebound = await target(bridge, null);
assert.equal(rebound.kind, "targeted", "a call naming no file runs in the one granted document");
assert.equal(plugin.isPrompting(), false, "without asking the human again");
assert.equal((await execute(bridge, rebound.link)).result, "ok", "a reconnect stays granted");
console.log("✅ A reconnect authenticates without pairing again, and the grant holds unprompted");

// A disconnect mid-request rejects the in-flight call at once, not at its deadline.
plugin.close();
await wait(150);
const silentLinked = rawPeer(URL, { credentialDir: bridge.stateDir });
const muteLink = await linkOf(bridge);
const t1 = Date.now();
const inflight = execute(bridge, muteLink).catch((e) => e);
await wait(50);
silentLinked.terminate();
const discErr = await inflight;
assert.ok(discErr instanceof Error && /disconnect/i.test(discErr.message), "rejects on disconnect");
assert.ok(Date.now() - t1 < 1000, "rejects fast on disconnect, not 15s");
console.log(`✅ Disconnect rejects the in-flight request in ${Date.now() - t1}ms`);
await wait(150);

// --- Another installation in the same project is asked anew ---
// Grants key on the installation credential as well as the project path: a server paired under
// another state dir announces the same project, and the same plugin (same storage, same file) must
// still ask. The path alone is forgeable; the pairing is not.
const PORT_SQUAT = 19878;
const squatBridge = bridgeOn(PORT_SQUAT);
await wait(150);
const squatted = await realPlugin(PORT_SQUAT, { storage: pluginStorage, file: contractFile });
await pairByPanel(squatBridge, squatted);
const squatBinding = await target(squatBridge, contractFile.key, 300);
assert.deepEqual(
  squatBinding,
  { kind: "blocked", block: { kind: "grant-pending", fileName: contractFile.name } },
  "a same-project server on another installation holds no grant",
);
console.log("✅ A same-project server paired under another state dir is asked to Allow anew");
squatted.close();
squatBridge.stop();
await wait(150);

// --- One state dir, one pairing: every server on it authenticates the plugin unprompted ---
const PAIRED_DIR_PORTS = [19893, 19894];
const sharedPairingDir = freshStateDir();
const firstOnDir = bridgeOn(PAIRED_DIR_PORTS[0], { stateDir: sharedPairingDir });
const secondOnDir = bridgeOn(PAIRED_DIR_PORTS[1], { stateDir: sharedPairingDir });
await wait(150);
const both = await realPlugin(PAIRED_DIR_PORTS);
await pairByPanel(firstOnDir, both);
await linkOf(secondOnDir);
assert.equal(both.showsPairingCode(), false, "the second server never offered a code");
console.log("✅ Servers sharing a state dir are paired by one confirmation");
both.close();
firstOnDir.stop();
secondOnDir.stop();
await wait(150);

// --- The grant lives in the plugin: a restart and a sibling find it; Revoke ends it for both ---
// Nothing about grants is on the server's disk, so any server of this installation and project —
// restarted, or a sibling on another port — is granted by the one Allow the plugin stored.
const sharedDir = freshStateDir();
const restartFile = figmaFiles.file("RESTARTfile1", "Restart file");
const restartStorage = new Map();
const bridgeR1 = bridgeOn(19879, { stateDir: sharedDir });
await wait(150);
const r1 = await realPlugin(19879, { storage: restartStorage, file: restartFile });
await pairByPanel(bridgeR1, r1);
const r1Binding = target(bridgeR1, restartFile.key);
await r1.allow();
assert.equal((await r1Binding).kind, "targeted", "precondition: granted");
r1.close();
bridgeR1.stop();
await wait(150);

const bridgeR2 = bridgeOn(19879, { stateDir: sharedDir });
const bridgeSibling = bridgeOn(19883, { stateDir: sharedDir });
await wait(150);
const r2 = await realPlugin([19879, 19883], { storage: restartStorage, file: restartFile });
await linkOf(bridgeR2);
await linkOf(bridgeSibling);
assert.equal(r2.showsPairingCode(), false, "the restarted server needs no pairing");
for (const [server, what] of [
  [bridgeR2, "the restarted server"],
  [bridgeSibling, "a sibling on another port"],
]) {
  const granted = await target(server, null);
  assert.equal(granted.kind, "targeted", `${what} is granted by the stored Allow`);
  assert.equal((await execute(server, granted.link, { fileKey: restartFile.key })).result, "ok");
}
assert.equal(r2.isPrompting(), false, "with no second Allow");
console.log("✅ Pairing and the grant survive a restart, and a same-project sibling shares it");

r2.revoke();
await until(async () => {
  const after = await target(bridgeSibling, restartFile.key, 0);
  return after.kind === "blocked";
}, "the revoke");
console.log("✅ Revoke in the plugin ends the grant for every server in the project");
r2.close();
bridgeR2.stop();
bridgeSibling.stop();
await wait(150);

// A bridge stopped mid-bind disowns the bind the OS already accepted: `listening` fires regardless.
const FREE_PORT = 19886;
const bridgeD4 = bridgeOn(FREE_PORT, { stateDir: sharedDir });
bridgeD4.stop();
await wait(300);
assert.equal(
  await refusedOrOpened(new WebSocket(`ws://127.0.0.1:${FREE_PORT}`, { origin: "null" })),
  "refused",
  "a bridge stopped mid-bind leaves the port free instead of claiming it unclosably",
);
console.log("✅ stop() disowns a bind already in flight");

// --- Heartbeat reaps a half-open link ---
// An authenticated link whose socket goes half-open (crash, laptop sleep: no FIN) never fires
// `close`; only the heartbeat, missing its pong, drops it and the calls it would strand.
await wait(150);
const dead = rawPeer(URL, { credentialDir: bridge.stateDir, autoPong: false });
const deadLink = await linkOf(bridge);
bridge.heartbeatTick();
await wait(50);
bridge.heartbeatTick(); // missed pong → terminate
await until(() => !bridge.authenticatedLinks().includes(deadLink), "the reaped link");
console.log("✅ Heartbeat reaps a half-open link");
dead.close();
await wait(150);

// --- Link setup refuses another protocol: HELLO alone, nothing after, and a call is told why ---
// A call waits out a link still in HELLO rather than guess; whatever the answer, a stale plugin is
// never challenged, offered a code, or sent code.
const RACE_PORT = 19888;
const raceUrl = `ws://127.0.0.1:${RACE_PORT}`;
const raceBridge = bridgeOn(RACE_PORT, { requestTimeoutMs: 500 });
await wait(150);
const stale = rawPeer(raceUrl, {
  protocolVersion: PROTOCOL_VERSION - 1,
  pluginVersion: "0.0.1",
  helloDelayMs: 250,
});
await opened(stale);
const staleResolution = await raceBridge.resolveLink();
assert.equal(staleResolution.kind, "incompatible", "a resolution racing HELLO waits for it");
assert.ok(
  staleResolution.refusal.includes(`plugin v0.0.1 (protocol v${PROTOCOL_VERSION - 1})`),
  "and names the plugin it round-tripped",
);
assert.equal((await raceBridge.offerPairing()).kind, "none", "a stale plugin is offered no code");
assert.deepEqual(stale.received, ["HELLO"], "and is sent nothing after HELLO");
console.log("✅ A plugin on an older protocol is refused at HELLO and sent nothing more");
stale.close();
await wait(150);

// A plugin predating HELLO (it ERRORs the request) is the floor, refused on the same rule.
const spikeEra = rawPeer(raceUrl, { protocolVersion: null });
await opened(spikeEra);
assert.match(
  (await raceBridge.resolveLink()).refusal ?? "",
  /protocol v0/,
  "a plugin with no version is refused",
);
assert.deepEqual(spikeEra.received, ["HELLO"], "and is sent nothing after HELLO");
console.log("✅ A plugin predating HELLO is refused (missing version → floor)");
spikeEra.close();
await wait(150);

// A plugin NEWER than this server is refused too: its FlcmHost isn't the one this preamble targets.
const newer = rawPeer(raceUrl, { protocolVersion: PROTOCOL_VERSION + 1, pluginVersion: "9.9.9" });
await opened(newer);
const newerRefusal = (await raceBridge.resolveLink()).refusal ?? "";
assert.ok(
  newerRefusal.includes("is newer") && newerRefusal.includes("update this Framelink MCP server"),
  "a newer plugin is refused, telling the human to update the server",
);
console.log(
  "✅ A plugin newer than the server is refused, naming the server as the side to update",
);
newer.close();
await wait(150);

// A disconnect INSIDE the HELLO window leaves no false `incompatible` behind: with nothing connected
// the agent must hear that, not be told to reinstall a plugin.
const dropper = await realPlugin(RACE_PORT, { holdHelloMs: 5_000 });
await wait(30);
const pendingResolution = raceBridge.resolveLink();
dropper.close();
assert.equal(
  (await pendingResolution).kind,
  "disconnected",
  "a link that drops inside HELLO resolves as a disconnection",
);
console.log("✅ A disconnect inside the HELLO window leaves no false `incompatible` behind");
raceBridge.stop();
await wait(150);

// --- Port-block discovery: two servers sharing a block bind distinct ports ---
const BLOCK = [19890, 19891];
const bridgeA = bridgeOn(BLOCK);
await wait(150);
const bridgeB = bridgeOn(BLOCK);
await wait(250);
const onBase = new WebSocket(`ws://127.0.0.1:${BLOCK[0]}`, { origin: "null" });
assert.equal(await refusedOrOpened(onBase), "opened", "the first server bound the base port");
const onNext = new WebSocket(`ws://127.0.0.1:${BLOCK[1]}`, { origin: "null" });
assert.equal(await refusedOrOpened(onNext), "opened", "the second advanced on EADDRINUSE");
console.log(
  "✅ Two servers sharing a block bind distinct ports (probe-bind advances on EADDRINUSE)",
);
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
console.log(
  `✅ manifest devAllowedDomains mirrors WS_PORT_BLOCK exactly (${WS_PORT_BLOCK.length} ports)`,
);

// --- Deadlines: cancel, never abandon; the cancel is ANSWERED; a late result still reports ---
// A run that stalls is CANCELLED with a run-scoped, id-less CANCEL, and the caller's rejection is
// worded from the plugin's answer — "never executed; retry" and "inspect the canvas" differ.
const PORT_T = 19895;
const orphanReplies = [];
const bridgeT = bridgeOn(PORT_T, {
  requestTimeoutMs: 400,
  events: {
    onRunEvent: (event) => {
      if (event.type === "orphanReply")
        orphanReplies.push([event.runId, event.reply.documentChanged]);
    },
  },
});
await wait(150);
const framesT = [];
let disposition = "never-executed";
const silent = rawPeer(`ws://127.0.0.1:${PORT_T}`, {
  credentialDir: bridgeT.stateDir,
  onFrame: (msg) => {
    framesT.push(msg);
    if (msg.type === "CANCEL")
      silent.send(JSON.stringify({ type: "CANCEL_RESULT", runId: msg.runId, disposition }));
  },
});
const silentLink = await linkOf(bridgeT);
const tStall = Date.now();
const timeoutErr = await execute(bridgeT, silentLink, { code: "stall forever" }).catch((e) => e);
assert.ok(
  /no traffic/.test(timeoutErr.message),
  "a stalled run rejects with the inactivity message",
);
assert.ok(Date.now() - tStall < 2000, "the injected short deadline fired, not the 15s default");
assert.ok(/never executed/.test(timeoutErr.message), "worded from the plugin's cancel answer");
assert.equal(timeoutErr.outcome, "not-submitted", "a run that never executed is safe to retry");
await wait(50);
const cancelFrame = framesT.find((f) => f.type === "CANCEL");
const stalled = framesT.find((f) => f.type === "EXECUTE_CODE");
assert.equal(cancelFrame?.runId, stalled.id, "the CANCEL is scoped to the stalled run");
assert.equal(cancelFrame.id, undefined, "CANCEL is id-less — a notification, never a request");
console.log(
  "✅ A stalled run is cancelled (run-scoped, id-less CANCEL) and rejected with the plugin's answer",
);

// The link wakes up: a result for a run its caller gave up on still reaches the meter, as it
// came — whether it costs a Write is the meter's call.
disposition = "was-running";
await execute(bridgeT, silentLink, { code: "changed late" }).catch(() => {});
const lateRun = framesT.filter((f) => f.type === "EXECUTE_CODE").at(-1).id;
const lateResult = (id, documentChanged) =>
  JSON.stringify({ type: "EXECUTE_CODE_RESULT", id, console: [], errors: null, documentChanged });
silent.send(lateResult(stalled.id, false));
silent.send(lateResult(lateRun, true));
await until(() => orphanReplies.length === 2, "the late results");
assert.deepEqual(
  orphanReplies,
  [
    [stalled.id, false],
    [lateRun, true],
  ],
  "a late result reaches the meter with what it says about the document",
);
console.log("✅ A late result reaches the meter under its run id, with its documentChanged");
silent.close();
bridgeT.stop();
await wait(150);

// --- The reverse channel: a mid-run image fetch ---
// The plugin's CHANNEL_REQUEST (its own id namespace, tagged with the run) is answered by a typed
// CHANNEL_RESPONSE; serving SUSPENDS the run's inactivity deadline; a request for a run the server
// no longer tracks is refused. Driven by a raw socket speaking the plugin's half on a timetable.
const PORT_I = 19896;
const servedBatches = [];
const bridgeI = bridgeOn(PORT_I, {
  requestTimeoutMs: 500,
  capabilities: new Map([
    [
      "images.fetch",
      async (urls) => {
        servedBatches.push(urls);
        if (urls.includes("boom"))
          throw new Error('flcm.image could not load "boom": blocked range');
        await wait(700); // longer than the whole deadline: serving must not count against the run
        return Object.fromEntries(urls.map((u) => [u, "b64-" + u]));
      },
    ],
  ]),
});
await wait(150);
const framesImg = [];
let imagesReply = null;
const pluginImg = rawPeer(`ws://127.0.0.1:${PORT_I}`, {
  credentialDir: bridgeI.stateDir,
  onFrame: (msg) => {
    framesImg.push(msg);
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
  },
});
const imgLink = await linkOf(bridgeI);

const imgRun = await execute(bridgeI, imgLink, { code: "render with images" });
assert.deepEqual(imgRun.result, { u1: "b64-u1", u2: "b64-u2" }, "the run completed with the bytes");
assert.equal(imagesReply.id, "preq-1", "the reply carries the PLUGIN-issued id");
assert.deepEqual(servedBatches[0], ["u1", "u1", "u2"], "the handler received the raw batch");
// ~900ms of wall clock against a 500ms deadline: only suspend-while-serving lets that succeed.
console.log(
  "✅ Mid-run image fetch round-trips in ONE run, and serving suspends the run's deadline",
);

const boomRun = await execute(bridgeI, imgLink, { code: "boom run" });
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
const bridgeC = bridgeOn(PORT_C, {
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
await wait(150);
const framesC = [];
const pluginC = rawPeer(`ws://127.0.0.1:${PORT_C}`, {
  credentialDir: bridgeC.stateDir,
  onFrame: (msg) => framesC.push(msg),
});
const linkC = await linkOf(bridgeC);

// A GRANT_STATUS is pending too; drawing on one would let a hostile link burn fetches against a
// pending it was never granted a run for. The refusal must leave that pending intact.
const statusP = bridgeC.grantStatus(linkC, null, "none").catch((e) => e);
await wait(50);
const infoId = framesC.find((f) => f.type === "GRANT_STATUS").id;
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
pluginC.send(JSON.stringify({ type: "GRANT", id: infoId, state: "absent" }));
assert.equal(await statusP, "absent", "the refusal left the pending intact");
console.log("✅ Only an EXECUTE_CODE pending can be drawn on by the reverse channel");

// Two overlapping services for ONE run: the deadline re-arms only when the LAST settles, or the
// fast one's settle would restart a 500ms clock the slow (1200ms) fetch then outruns.
const runP = execute(bridgeC, linkC, { code: "two fetches" }).catch((e) => e);
await wait(50);
const runIdC = framesC.find((f) => f.type === "EXECUTE_CODE").id;
imageRequest("preq-f", runIdC, ["fast"]);
await wait(20);
imageRequest("preq-s", runIdC, ["slow"]);
await wait(1400);
const served = (id) => framesC.some((f) => f.type === "CHANNEL_RESPONSE" && f.ok && f.id === id);
assert.ok(served("preq-f") && served("preq-s"), "both services replied");
assert.ok(
  !framesC.some((f) => f.type === "CANCEL"),
  "no CANCEL fired while a service was in flight",
);
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
