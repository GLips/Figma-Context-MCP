// Plugin sandbox entry. This is the only context where `figma.*` lives. It never
// touches the network — it talks to the headless ui.html bridge via postMessage.

// The std-lib source string, generated from the typed preamble/ fragments and baked in at build time
// by build.mjs via esbuild `define` (it can't be generated in-sandbox — flattening runs esbuild).
declare const SANDBOX_PREAMBLE: string;

// Load the bridge iframe. It is BOTH the network transport (the only context with WS access —
// the sandbox has none) AND, since Slice 2.2, the visible arbiter panel the human uses to
// Allow/Deny a connecting session. It starts hidden and is raised (figma.ui.show) only when an
// unapproved session needs a decision. show/hide toggles visibility WITHOUT reloading the iframe,
// so the WS relay underneath survives every raise/dismiss.
figma.showUI(__html__, { visible: false, width: 340, height: 420 });

// Versions reported to the server over the frozen envelope on connect (server-initiated
// GET_VERSION handshake). These are the SOURCE OF TRUTH for the plugin's wire identity:
//   • PROTOCOL_VERSION — the frozen forward-compat envelope contract. The server GATES on
//     this; bump it ONLY on a breaking envelope change (and the server's MIN with it).
//   • PLUGIN_VERSION — the plugin release, shown to the human in a skew nudge. Informational.
const PROTOCOL_VERSION = 1;
const PLUGIN_VERSION = "0.1.0";

// Phase 2 consent gate. The sandbox is the SOLE ARBITER (Invariant): it holds the durable
// approval decision and refuses to run writes for a session the human hasn't approved. The
// server only introduces itself (SESSION_INFO) and formats the pending reply — it does not
// own the approval bit.
//
// Sticky approval is keyed on a TOKEN this sandbox mints on Allow — NOT on the server's
// identity (project path), which is a human-readable label and therefore forgeable: a squatter
// that grabbed the freed port could announce the same path and inherit a prior Allow. The token
// is the auth key (Invariant "Approval keys on a minted session token, not a forgeable
// identity"): minted here on Allow, handed to the approved server, and echoed back by that
// server in every SESSION_INFO. A same-path squatter never received an Allow handover, so it
// has no token and falls back to PENDING. `approvedTokens` is sticky WITHIN a Figma session —
// it survives WS reconnects because this module outlives any single socket, but it is plain
// in-memory, so closing/reopening the plugin clears it (the "approve once per work session"
// behavior; clientStorage would wrongly persist approval across reopens).
const approvedTokens = new Set<string>();

// One live session, as last presented over SESSION_INFO. The token gates writes; the identity is
// the label the human approves in the panel; the pairing code is the glance-and-compare check
// shown beside it. All null until this connection's SESSION_INFO arrives — a connection with no
// token yet is UNAPPROVED, so a write racing ahead of the handshake gets the pending path.
interface SessionConn {
  token: string | null;
  identity: string | null;
  pairingCode: string | null;
}

// Phase 3 multi-connection: ui.html holds N persistent sockets (one per block port) and tags every
// server→sandbox message with its source port (__connKey). This map replaces the single
// currentToken/currentIdentity/currentPairingCode with one SessionConn per live port, so each
// session is gated and approved independently. Keyed by the port: one server binds one port and
// ui.html owns the sockets, so the port is the natural stable key. approvedTokens (above) stays a
// flat module Set — sticky approval keys on the minted TOKEN, not the connection, so it must
// outlive any single port's connection entry (Slice 2.1b).
type ConnKey = number;
const connections = new Map<ConnKey, SessionConn>();

// The one active driver (Invariant: exactly one session writes at a time). Only this key's writes
// reach the executor; every other approved session is gated short of it (gateWrite). Set on
// Allow/switch — a human action in the panel — and null until the first Allow. Deliberately NOT
// cleared when the active port's socket drops: a same-port reconnect reclaims active status with no
// re-prompt, and because isApproved() is checked BEFORE this key at the gate, a token-less squatter
// that grabs the freed port can't inherit the active slot.
let activeKey: ConnKey | null = null;

function isApproved(key: ConnKey): boolean {
  const conn = connections.get(key);
  return conn != null && conn.token !== null && approvedTokens.has(conn.token);
}

/**
 * Mint a session token on Allow. Unlike the pairing code (a deliberately low-entropy
 * glance-and-compare check), this token is the sticky-approval key: it is handed to the approved
 * server and echoed back in SESSION_INFO to re-key approval on reconnect. What it buys: a squatter
 * that merely announces the same (forgeable) project-path identity no longer inherits approval —
 * it holds no token, so it re-prompts. That is the Slice 2.1b win.
 *
 * What it does NOT buy — and why Math.random is fine: the token is a localhost BEARER value, not a
 * cryptographic secret. The server re-discloses it in SESSION_INFO to whatever client currently
 * holds the slot, so an active local attacker that connects during a drop window can HARVEST the
 * token and later replay it from the freed port. Closing that needs cryptographic server auth,
 * which is explicitly out of scope for v1 (consent stays the real gate) — see the plan's "Left
 * open". Because an attacker who defeats this has already observed the value, generator strength
 * is moot; Math.random (no crypto in Figma's QuickJS sandbox) suffices to stop blind guessing.
 */
function mintToken(): string {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}

interface InboundMessage {
  id?: string;
  type?: string;
  [key: string]: unknown;
}

// Everything needed to reply to one inbound message, derived from it once at dispatch:
// the correlation `id`, the opaque routing metadata to echo back, and `connKey` — the local
// source-port tag ui.html attached, stamped back onto the reply so ui.html sends it on the right
// socket. Bundled so every handler threads a single value instead of three co-varying params.
interface ReplyTo {
  id: string | undefined;
  echo: Record<string, unknown>;
  connKey: ConnKey | undefined;
}

// The inbound keys this plugin version actually consumes. Everything else is opaque
// routing metadata a newer server may attach (e.g. a future `sessionId` a broker uses
// to fan out across sessions) — we echo those keys back untouched on the reply so the
// server can correlate without ANY plugin change. This is the forward-compat pre-invest
// that keeps the eventual multi-session upgrade server-only.
//
// `__connKey` is the local-only exception: ui.html adds it to tag a message's source socket, and
// it MUST be in this set so replyTarget keeps it OUT of the echoed metadata — otherwise the
// frozen-envelope echo would ride this routing key back onto the WS (ui.html strips it too, but
// registering it here is the first half of the belt-and-suspenders the Phase 3 warning demands).
const KNOWN_INBOUND_KEYS = new Set([
  "id",
  "type",
  "code",
  "nodeId",
  "payload",
  "message",
  "identity",
  "pairingCode",
  "sessionToken",
  "__connKey",
]);

/** The source-port tag ui.html attached, or undefined if absent — one parse site for the routing
 * key, so the "is it a number" check and its absent-sentinel are defined once. */
function connKeyOf(msg: InboundMessage): ConnKey | undefined {
  return typeof msg.__connKey === "number" ? msg.__connKey : undefined;
}

function replyTarget(msg: InboundMessage): ReplyTo {
  const echo: Record<string, unknown> = {};
  for (const key of Object.keys(msg)) {
    if (!KNOWN_INBOUND_KEYS.has(key)) echo[key] = msg[key];
  }
  return { id: msg.id, echo, connKey: connKeyOf(msg) };
}

/**
 * The single reply path. Spreads echoed routing metadata first, the reply body next, and stamps
 * the correlation `id` and `__connKey` last so neither can clobber them — every reply carries the
 * id back (frozen-envelope Invariant) and the source-port tag so ui.html routes it to the right
 * socket. `__connKey` is LOCAL: it never reaches a server because ui.html strips it before ws.send.
 */
function reply(to: ReplyTo, body: Record<string, unknown>): void {
  figma.ui.postMessage({ ...to.echo, ...body, id: to.id, __connKey: to.connKey });
}

// First-run orientation. The arbiter panel shows a one-time explainer (what the plugin does;
// "only approve sessions you started") the FIRST time it is ever raised, then never again. This
// is the ONE durable bit of plugin state — it persists across plugin reopens via clientStorage,
// deliberately distinct from the per-session approval Set (in-memory, clears on reopen). Read once
// at startup into a sync flag so panel-raise stays synchronous (no await in the hot path); the
// write-back is fire-and-forget. The startup read resolves long before any session connects (it's
// local; SESSION_INFO needs a WS round-trip), so the flag is settled by the first raise.
const ORIENTATION_STORAGE_KEY = "code-mode:has-seen-orientation";
let hasSeenOrientation = false;
void figma.clientStorage.getAsync(ORIENTATION_STORAGE_KEY).then((seen) => {
  hasSeenOrientation = seen === true;
});

/**
 * Whether to show first-run orientation THIS raise — true once ever, then never again. Consuming
 * it flips the in-memory flag and persists the durable "seen" bit (fire-and-forget). Split out of
 * showArbiterPanel so the durable, once-ever write isn't buried behind a per-raise "show" verb.
 */
function consumeFirstRunOrientation(): boolean {
  if (hasSeenOrientation) return false;
  hasSeenOrientation = true;
  void figma.clientStorage.setAsync(ORIENTATION_STORAGE_KEY, true);
  return true;
}

/**
 * One panel row per live session, derived from the connection map. Forwards {identity, pairingCode}
 * plus the per-row state the panel renders from — `approved` (token in approvedTokens) and `active`
 * (the one active driver) — and `key` so the row's Allow/Deny/switch routes back to the right
 * connection. NEVER the session token, a localhost bearer credential (Slice 2.1b) not for display.
 */
function panelSessions(): Array<{
  key: ConnKey;
  identity: string | null;
  pairingCode: string | null;
  approved: boolean;
  active: boolean;
}> {
  const sessions = [];
  for (const [key, conn] of connections) {
    sessions.push({
      key,
      identity: conn.identity,
      pairingCode: conn.pairingCode,
      approved: isApproved(key),
      active: key === activeKey,
    });
  }
  return sessions;
}

/**
 * Re-render the panel's row list WITHOUT touching iframe visibility. SHOW_PANEL only updates the
 * (possibly hidden) DOM; figma.ui.show()/hide() is what raises/lowers the iframe — so this keeps a
 * visible panel's rows current (a session joined/left/changed state) without raising a hidden one.
 * `showOrientation:false` — the once-ever banner is consumed only on an actual raise (below), never
 * on a silent refresh.
 */
function renderPanel(): void {
  figma.ui.postMessage({ type: "SHOW_PANEL", sessions: panelSessions(), showOrientation: false });
}

/**
 * Raise the arbiter panel (and refresh its rows). The panel RENDER is a session LIST (Slice 2.2
 * pre-invest); Phase 3 fills it with N rows. Consumes first-run orientation here, on the actual
 * raise. Idempotent: safe to call on each gated write, so a write blocked after a dismiss re-surfaces
 * the panel. Visibility is driven EXPLICITLY (raise on a pending decision, lower on resolution) — NOT
 * derived from approval state, which can't see a non-active approved session's pending switch request.
 */
function showArbiterPanel(): void {
  figma.ui.postMessage({
    type: "SHOW_PANEL",
    sessions: panelSessions(),
    showOrientation: consumeFirstRunOrientation(),
  });
  figma.ui.show();
}

/** Dismiss the arbiter panel (a decision was made, or the last session left). WS relay unaffected
 * — hiding doesn't reload the iframe (see the showUI note up top). A still-pending session re-raises
 * it on its agent's next gated write (gateWrite). */
function hideArbiterPanel(): void {
  figma.ui.postMessage({ type: "HIDE_PANEL" });
  figma.ui.hide();
}

/**
 * The single write-gate decision and the enforcement point for BOTH the consent and the
 * one-active-driver Invariants — owned in one place so EXECUTE_CODE and SCREENSHOT (and any future
 * write verb) can't drift. Returns true only when the write may run; otherwise it raises the panel
 * for the human and replies with the right gate, and returns false:
 *   • unapproved (or no source port — the fail-closed default) → PENDING_APPROVAL (approve via Allow)
 *   • approved but not the active driver → INACTIVE_SESSION (switch the active driver to it)
 * Raising the panel here is what surfaces a non-active approved session's switch request, so the
 * human can act on it.
 */
function gateWrite(to: ReplyTo): boolean {
  if (to.connKey === undefined || !isApproved(to.connKey)) {
    showArbiterPanel();
    reply(to, { type: "PENDING_APPROVAL" });
    return false;
  }
  if (to.connKey !== activeKey) {
    showArbiterPanel();
    reply(to, { type: "INACTIVE_SESSION" });
    return false;
  }
  return true;
}

/**
 * Apply the human's panel decision to a specific session (keyed by its port). Allow on an
 * unapproved row mints a session token, remembers it as approved, binds it to that connection, and
 * hands it to that row's server (routed by __connKey) so the server can echo it on reconnect —
 * approval keys on the minted token, never the forgeable identity (Invariant). Allow on an
 * already-approved row mints nothing; it's a SWITCH. Either Allow makes the row the active driver
 * (the one session whose writes reach the executor). Deny (approve !== true) changes no state.
 * Either way the panel is dismissed (soft): a still-pending session re-raises it on its agent's
 * next gated write (gateWrite), so Deny means "not now," not a permanent block.
 */
function applyDecision(key: ConnKey, approve: boolean): void {
  const conn = connections.get(key);
  if (conn && approve) {
    if (!isApproved(key)) {
      const token = mintToken();
      approvedTokens.add(token);
      conn.token = token;
      // Same field name (`sessionToken`) the server echoes back in SESSION_INFO — one vocabulary in
      // both directions. __connKey routes the unsolicited handover to THIS row's socket.
      figma.ui.postMessage({ type: "SESSION_TOKEN", sessionToken: token, __connKey: key });
    }
    activeKey = key;
  }
  hideArbiterPanel();
}

figma.ui.onmessage = (msg: InboundMessage) => {
  // Local CONTROL messages from ui.html and the arbiter panel are id-less: they never traverse
  // the WS, so they carry no server correlation id and get no reply. The server, by contrast,
  // stamps an id on every message (PluginBridge.request), so id-less ⟺ local control. Handle
  // those here and return; an id-CARRYING message of any type falls through to the normal
  // envelope path below (and its ERROR reply for unknown types), preserving the frozen-envelope
  // "every id-carrying message gets exactly one reply" invariant.
  if (msg.id === undefined) {
    // Local CONTROL from ui.html, all keyed by __connKey (the source port) so the right session is
    // addressed. WS_CONNECTED/WS_CLOSED are the persistent relay's discovery + disconnect signals —
    // ui.html fires them ONLY for a socket that actually opened (never for the dead block ports it
    // also dials), so they arrive only for real sessions. UI_DECISION carries the row the human clicked.
    // Every local control message is port-tagged; one with no key is malformed — drop it (fail closed).
    const key = connKeyOf(msg);
    if (key === undefined) return;
    if (msg.type === "WS_CONNECTED") {
      // A fresh socket opened on this port (the server restarted, or a DIFFERENT local server
      // grabbed the port after the prior one dropped). Reset this port's binding to unapproved so a
      // write racing ahead of the new SESSION_INFO can't ride a stale-but-approved token into the
      // executor. approvedTokens stays intact (sticky); a legit reconnect re-binds via the echoed
      // token in its SESSION_INFO. ui.html fires this on ws.onopen, before any server message on the
      // new socket. activeKey is left alone — see its declaration for why a reconnect keeps it.
      connections.set(key, { token: null, identity: null, pairingCode: null });
    } else if (msg.type === "WS_CLOSED") {
      // The socket dropped — remove the session's row (disconnect-detection reuses this persistent
      // relay). Keep activeKey even if it pointed here: a same-port reconnect reclaims active status,
      // and with no socket there are no writes meanwhile. ui.html auto-reconnects the port after this.
      // Refresh the row list; lower the panel only once the LAST session is gone (nothing left to act
      // on) — a departure mustn't tear down a panel another session raised for a pending decision.
      connections.delete(key);
      if (connections.size === 0) hideArbiterPanel();
      else renderPanel();
    } else if (msg.type === "UI_DECISION") {
      // The human clicked Allow / Switch / Deny on a specific row. The handover (on Allow) rides the
      // same sandbox→ui.html→WS relay as any reply (ui.html forwards it verbatim); it carries no id
      // — it's unsolicited, not a reply.
      applyDecision(key, msg.approve === true);
    }
    return;
  }
  const to = replyTarget(msg);
  if (msg.type === "PING") {
    // Smoke test: echo back, including a live `figma.*` read to prove the API is
    // reachable from inside the sandbox (not just that the bytes round-tripped).
    reply(to, { type: "PONG", echo: msg.payload, page: figma.currentPage.name });
  } else if (msg.type === "SESSION_INFO") {
    // The server introduces its session: the identity (project path) the human approves, the
    // per-connection pairing code shown in the panel, and — on a reconnect of an already-approved
    // server — the session token it was handed on the prior Allow. Bind all three for this port's
    // connection (the echoed token re-keys sticky approval) and ack immediately — we must NOT block
    // on the human here; approval arrives later via UI_DECISION. A squatter that never got an Allow
    // echoes no token, so the entry's token stays null and the gate re-prompts.
    if (to.connKey !== undefined) {
      connections.set(to.connKey, {
        token: typeof msg.sessionToken === "string" ? msg.sessionToken : null,
        identity: typeof msg.identity === "string" ? msg.identity : null,
        pairingCode: typeof msg.pairingCode === "string" ? msg.pairingCode : null,
      });
    }
    reply(to, { type: "SESSION_INFO_ACK" });
    // Raise the panel for an unapproved session so the human can Allow/Deny; for an already-approved
    // reconnect (its token echoed back here) just refresh the rows without raising, so it does NOT
    // re-prompt (Done-when #3) and doesn't disturb a panel another session may have raised.
    if (to.connKey !== undefined && !isApproved(to.connKey)) showArbiterPanel();
    else renderPanel();
  } else if (msg.type === "EXECUTE_CODE") {
    // Sandbox-side gate (the Invariants' enforcement point): gateWrite runs the write only for the
    // approved, active-driver session — otherwise it replies PENDING_APPROVAL or INACTIVE_SESSION and
    // the write never reaches the executor.
    if (gateWrite(to)) void executeCode(to, typeof msg.code === "string" ? msg.code : "");
  } else if (msg.type === "SCREENSHOT") {
    if (gateWrite(to)) void screenshot(to, typeof msg.nodeId === "string" ? msg.nodeId : undefined);
  } else if (msg.type === "GET_VERSION") {
    // Server-initiated version handshake. The constants live here in the sandbox (not in
    // ui.html, which owns the WS connect but doesn't know them), so the server asks and we
    // answer over the frozen envelope — no extra ui.html→code.ts connect plumbing.
    reply(to, { type: "VERSION", pluginVersion: PLUGIN_VERSION, protocolVersion: PROTOCOL_VERSION });
  } else if (msg.type === "NOTIFY") {
    // Human channel of the skew nudge: figma.notify is a figma.* call, so the toast MUST
    // originate here in the sandbox, not the server or iframe. A spike-era plugin predating
    // this handler falls through to the ERROR path below and the toast is silently dropped —
    // by design: that plugin still gets the agent channel, which suffices (see the plan).
    figma.notify(typeof msg.message === "string" ? msg.message : "", { timeout: 15_000 });
    reply(to, { type: "NOTIFY_RESULT" });
  } else if (typeof msg.id === "string") {
    // Frozen-envelope contract: every id-carrying inbound gets a reply. An unrecognized
    // type returns a loud, correlated error instead of the silent drop that used to hang
    // the server to its 15s timeout — this is the path a newer server hits against this
    // (older) plugin, so the message names the version skew as the likely cause.
    reply(to, {
      type: "ERROR",
      error: `Unsupported message type ${JSON.stringify(msg.type)} — the server may be newer than this plugin. Update the plugin.`,
    });
  }
};

/**
 * Runs the agent's raw code string against the live figma.* API and posts back
 * `{ id, result, console, errors }`. The agent's code is never bundled or
 * transformed — it arrives as a string and is eval'd here, in the sandbox.
 *
 * The async IIFE wrapper is mandatory: Figma's QuickJS sandbox blocks the
 * AsyncFunction constructor but permits `eval` + `await` inside an IIFE, so this
 * is what buys the agent `await` (e.g. `figma.loadFontAsync`) for free. A bare
 * `eval(code)` would break the moment the agent writes `await`.
 */
async function executeCode(to: ReplyTo, code: string): Promise<void> {
  const consoleLog: string[] = [];
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  // Capture the agent's console output so it round-trips back as feedback. Each
  // call is serialized through the same node-aware serializer as the result, so
  // logging a live node yields `{id,name,type}` instead of an opaque failure.
  const capture = (level: string) => (...args: unknown[]) => {
    consoleLog.push(`[${level}] ${args.map((a) => stringifyArg(a)).join(" ")}`);
  };
  console.log = capture("log");
  console.info = capture("info");
  console.warn = capture("warn");
  console.error = capture("error");

  let result: unknown;
  let errorMessage: string | null = null;
  // The two-pass image path: flcm.render() throws this sentinel (carrying the urls) BEFORE creating any
  // node when the server hasn't yet injected the image bytes. It's not an error — it's a request for the
  // server to fetch+validate those urls and re-run this same code with the bytes injected. Surfaced on the
  // normal result envelope so the frozen wire shape is untouched.
  let imagesNeeded: string[] | null = null;
  try {
    // The preamble bundle rides INSIDE the same async IIFE as the user's code, so its single
    // `flcm` global (flcm.frame/text/render/…) is simply in scope. The leading preamble also
    // preloads fonts (an `await`), which is why the IIFE must be async.
    const raw = await eval("(async function(){ " + SANDBOX_PREAMBLE + "\n;\n" + code + "\n })()");
    // Return-path node guard (R2): a returned live node would otherwise collapse to
    // { id } and silently drop everything else. Make that loud instead of lossy.
    guardReturnValue(raw);
    result = raw;
  } catch (err) {
    const needed = err && typeof err === "object" ? (err as { __flcmImagesNeeded?: unknown }).__flcmImagesNeeded : undefined;
    if (Array.isArray(needed)) imagesNeeded = needed.filter((u): u is string => typeof u === "string");
    else errorMessage = formatError(err);
  } finally {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }

  reply(to, imagesNeeded
    ? { type: "EXECUTE_CODE_RESULT", imagesNeeded, console: consoleLog, errors: null }
    : { type: "EXECUTE_CODE_RESULT", result: safeSerialize(result), console: consoleLog, errors: errorMessage });
}

/**
 * Exports a node as PNG and posts back exactly one of `{ id, image }` (a base64
 * string) or `{ id, errors }` — never both. With no nodeId, snapshots the whole
 * current page.
 *
 * The base64 encoding MUST happen here, not on the server: `exportAsync` returns a
 * Uint8Array, and ui.html JSON.stringifies every outbound message — which turns a
 * raw Uint8Array into a useless `{"0":..,"1":..}` blob (the same un-JSON-able trap
 * safeSerialize guards against for nodes). QuickJS has no Buffer, so we use the
 * sandbox's own `figma.base64Encode` to get a clean string across the wire.
 */
async function screenshot(to: ReplyTo, nodeId: string | undefined): Promise<void> {
  try {
    const node = nodeId ? figma.getNodeById(nodeId) : figma.currentPage;
    if (!node) throw new Error(`No node found with id ${nodeId}`);
    if (!("exportAsync" in node)) throw new Error(`Node ${node.type} (${node.id}) is not exportable`);
    const bytes = await node.exportAsync({ format: "PNG" });
    reply(to, { type: "SCREENSHOT_RESULT", image: figma.base64Encode(bytes) });
  } catch (err) {
    reply(to, { type: "SCREENSHOT_RESULT", errors: formatError(err) });
  }
}

/**
 * A live Figma node, for the return-path guard. The id+type pair alone is too loose
 * (an agent's own `{ id, type }` data object would trip it), so we also require
 * `removed` — present on every BaseNode, absent on plain JSON the agent builds.
 */
function looksLikeNode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.type === "string" && "removed" in o;
}

function findLiveNode(value: unknown, path: string, depth: number): { path: string; type: string } | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  // Stop at a node — never recurse into its (huge, circular) internals.
  if (looksLikeNode(value)) return { path, type: String((value as Record<string, unknown>).type) };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findLiveNode(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value as object)) {
    const hit = findLiveNode((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Reject a return value that is — or contains — a live node, loudly. The bridge
 * JSON-serializes everything, so a node would come back as a bare { id } with every
 * other property dropped and no signal that it happened. Better a clear error that
 * teaches the id pattern than silent loss the agent debugs blind.
 */
function guardReturnValue(value: unknown): void {
  const hit = findLiveNode(value, "", 0);
  if (!hit) return;
  const where = hit.path ? ` (at return value ${hit.path.startsWith("[") ? hit.path : `.${hit.path}`})` : "";
  throw new Error(
    `You returned a live Figma node${where}: a ${hit.type}. Live nodes can't cross the bridge — ` +
      `they collapse to { id } and you lose every other property. Return the id string instead: ` +
      "`return node.id` (or `return { id: node.id }`, or an array of ids).",
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ? `${err.name}: ${err.message}\n${err.stack}` : `${err.name}: ${err.message}`;
  }
  return String(err);
}

function stringifyArg(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = safeSerialize(value);
  return typeof serialized === "string" ? serialized : JSON.stringify(serialized);
}

/**
 * Converts an arbitrary eval result into something safe to send over
 * postMessage/WS. Live Figma node objects are NOT plain JSON — sending one
 * produces opaque failures — so any object that looks like a node collapses to
 * `{id,name,type}`. Everything else is recursed with a depth cap to defang
 * deep/circular structures.
 */
function safeSerialize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();

  if (depth >= 4) return "[…]";

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((v) => safeSerialize(v, depth + 1));
  }

  // A live Figma node: has a string `id` and `type`. Return a stable handle the
  // agent can thread into later execute_code calls via figma.getNodeById.
  const obj = value as Record<string, unknown>;
  if (typeof obj.id === "string" && typeof obj.type === "string") {
    const out: Record<string, unknown> = {
      id: obj.id,
      name: typeof obj.name === "string" ? obj.name : undefined,
      type: obj.type,
    };
    // flcm.render() returns Handles (plain POJOs that trip this same id+type heuristic) carrying the
    // author's `key` and a text node's resolved `text`. Carry both across the bridge so the agent can
    // read out.keyed[...].key / out.root.text agent-side. A live Figma node surfaces neither as a plain
    // prop (its identity lives in pluginData, its text in `characters`), so this only enriches handles.
    if (typeof obj.key === "string") out.key = obj.key;
    if (typeof obj.text === "string") out.text = obj.text;
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    try {
      out[key] = safeSerialize(obj[key], depth + 1);
    } catch {
      out[key] = "[unserializable]";
    }
  }
  return out;
}
