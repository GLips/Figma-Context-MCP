// Plugin sandbox entry. This is the only context where `figma.*` lives. It never
// touches the network — it talks to the headless ui.html bridge via postMessage.

import { safeSerialize, guardReturnValue } from "./serialize.js";
import { resolveScreenshotTarget, type ScreenshotTarget } from "./screenshot-target.js";

// The std-lib source string, generated from the typed preamble/ fragments and baked in at build time
// by build.mjs via esbuild `define` (it can't be generated in-sandbox — flattening runs esbuild).
declare const SANDBOX_PREAMBLE: string;

// The window is a fixed-width strip whose HEIGHT is whatever the iframe measures after each render
// (UI_HEIGHT) — so "collapsed" and "expanded" are CSS states over there, not two magic numbers here.
// The bounds exist only so a render bug can't produce a 0px or screen-filling window.
const UI_WIDTH = 320;
const UI_MIN_HEIGHT = 40;
const UI_MAX_HEIGHT = 560;

// Load the bridge iframe. It is BOTH the network transport (the only context with WS access — the
// sandbox has none) AND the plugin's only human surface: an always-visible status strip that
// expands into the session list.
//
// It starts VISIBLE and is never hidden. A running plugin's only summonable surface is its own
// iframe — a menu command re-RUNS the plugin, which would tear down this relay and every in-memory
// approval — so a hidden window leaves the human no way to check whether a session is connected or
// to reach Revoke. They could only act at moments WE chose to interrupt them. An always-on strip
// inverts that: state is ambient, and the human opens the list whenever they want.
// themeColors gives the iframe Figma's light/dark variables, which an always-on window needs.
figma.showUI(__html__, {
  visible: true,
  width: UI_WIDTH,
  height: UI_MIN_HEIGHT,
  themeColors: true,
  title: "Framelink",
});

// Versions reported to the server over the frozen envelope on connect (server-initiated
// GET_VERSION handshake). These are the SOURCE OF TRUTH for the plugin's wire identity:
//   • PROTOCOL_VERSION — the envelope contract. The server GATES on this; bump it ONLY on a
//     breaking envelope change (and the server's MIN with it). v2 = the mid-run image
//     protocol (plugin-issued IMAGES_REQUEST/IMAGES_REPLY + run-scoped CANCEL).
//   • PLUGIN_VERSION — the plugin release, shown to the human in a skew refusal. Informational.
const PROTOCOL_VERSION = 2;
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

// Who holds the driving baton — the approved session whose write ran most recently. It is a LABEL
// for the human ("● Driving this file"), not a gate: any approved session takes the baton simply by
// writing (takeBaton). Which of the human's own approved agents writes next is a lock, not a
// security decision, so it needs no human mediation; exclusion between them is enforced by
// serializing their writes (enqueueWrite), not by refusing them.
//
// Deliberately NOT cleared when the active port's socket drops: a same-port reconnect keeps showing
// as the driver rather than blinking, and it grants nothing on its own — every write still passes
// isApproved() first, so a token-less squatter grabbing the freed port inherits nothing.
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

/**
 * Everything a reply inherits from its request, derived once at dispatch: the correlation `id`, and
 * `connKey` — the local source-port tag ui.html attached, stamped back so the reply goes out on the
 * socket the request arrived on.
 *
 * Negative space: nothing else crosses over, and there is deliberately no pass-through namespace to
 * put it in. The server correlates by `id` alone, and each session already has its own socket, so a
 * reply being a function of the handler's body is what makes it structurally impossible for a field
 * the sandbox CONSUMES to ride back out as if a newer server had attached it. Don't reintroduce a
 * general echo without a consumer that demands one.
 */
interface ReplyTo {
  id: string;
  connKey: ConnKey | undefined;
}

/** The source-port tag ui.html attached, or undefined if absent — one parse site for the routing
 * key, so the "is it a number" check and its absent-sentinel are defined once. */
function connKeyOf(msg: InboundMessage): ConnKey | undefined {
  return typeof msg.__connKey === "number" ? msg.__connKey : undefined;
}

/**
 * The single reply path: the handler's body, with the correlation `id` (the frozen-envelope
 * Invariant) and the source-port tag stamped last so a body field can't clobber either.
 * `__connKey` is LOCAL — ui.html strips it before ws.send, so it never reaches a server.
 */
function reply(to: ReplyTo, body: Record<string, unknown>): void {
  figma.ui.postMessage({ ...body, id: to.id, __connKey: to.connKey });
}

// ---- Mid-run image fetch: the plugin→server reverse-request direction (protocol 2). ----
// The sandbox's render() suspends on an await while the server fetches image bytes; these tables
// correlate the plugin-ISSUED requests with the server's typed replies. Deliberately a separate id
// namespace ("preq-") and a separate pending table from the server's own requests: each side owns
// its ids, and reverse replies are matched by TYPE (IMAGES_REPLY/IMAGES_ERROR) before the envelope
// dispatch, so neither end ever has to guess who minted an id.
let nextImagesRequestId = 0;
interface PendingImagesFetch {
  resolve: (images: Record<string, string>) => void;
  reject: (err: Error) => void;
  runId: string;
  connKey: ConnKey | undefined;
}
const pendingImagesFetches = new Map<string, PendingImagesFetch>();

/**
 * Ask the run's server for image bytes (url → base64) and await its typed reply. Tagged with the
 * run's correlation id so the server can (a) suspend the run's inactivity deadline while IT is the
 * side doing the work, and (b) refuse a request for a run it no longer tracks (cancelled/timed
 * out) — that refusal rejects this promise, which is what makes a zombie run die at its
 * suspension point instead of resuming into canvas writes.
 */
function requestServerImages(to: ReplyTo, urls: string[]): Promise<Record<string, string>> {
  // Fail closed at issue time: with no live socket for this run's port, ui.html would silently drop
  // the frame and this promise could never settle — wedging the write chain (the run never
  // resolves, so no later write ever dispatches) for the life of the plugin. WS_CLOSED /
  // WS_CONNECTED reject the fetches that were already pending; this covers the run that reaches
  // its fetch only AFTER the drop.
  if (to.connKey === undefined || !connections.has(to.connKey)) {
    return Promise.reject(
      new Error("flcm: the server for this run is not connected — the image fetch cannot be issued and the script stops here."),
    );
  }
  return new Promise((resolve, reject) => {
    const id = "preq-" + ++nextImagesRequestId;
    pendingImagesFetches.set(id, { resolve, reject, runId: to.id, connKey: to.connKey });
    figma.ui.postMessage({ type: "IMAGES_REQUEST", id, runId: to.id, urls, __connKey: to.connKey });
  });
}

/** Settle a plugin-issued image request from the server's typed reply. An unknown id is dropped —
 * that fetch was already rejected by a CANCEL or a disconnect. The reply must arrive on the SAME
 * port the request went out on: ui.html holds a socket per block port, so without this check any
 * other local server (approved or not — approval gates writes, not this direction) could inject
 * bytes into an approved session's in-flight render, bypassing the trusted fetch path. */
function settleImagesFetch(msg: InboundMessage): void {
  const pending = typeof msg.id === "string" ? pendingImagesFetches.get(msg.id) : undefined;
  if (!pending || typeof msg.id !== "string") return;
  if (pending.connKey !== connKeyOf(msg)) return;
  pendingImagesFetches.delete(msg.id);
  if (msg.type === "IMAGES_REPLY" && msg.images && typeof msg.images === "object") {
    pending.resolve(msg.images as Record<string, string>);
  } else {
    pending.reject(
      new Error(
        typeof msg.error === "string" ? msg.error : "flcm.image: the server's image reply was malformed.",
      ),
    );
  }
}

/** Reject matching pending image fetches. A rejected fetch kills its suspended run at the await —
 * the mechanism behind both CANCEL (deadline fired) and WS_CLOSED (server went away), and what
 * keeps the write queue from wedging on a fetch whose reply can never arrive. */
function rejectImagesFetches(match: (p: PendingImagesFetch) => boolean, reason: string): void {
  for (const [id, pending] of pendingImagesFetches) {
    if (!match(pending)) continue;
    pendingImagesFetches.delete(id);
    pending.reject(new Error(reason));
  }
}

// First-run orientation. The session list shows a one-time explainer (what the plugin does; "only
// approve sessions you started") the FIRST time it is ever expanded, then never again. This is the
// ONE durable bit of plugin state — it persists across plugin reopens via clientStorage,
// deliberately distinct from the per-session approval Set (in-memory, clears on reopen). Read once
// at startup into a sync flag so expanding stays synchronous (no await in the hot path); the
// write-back is fire-and-forget. The startup read resolves long before any session connects (it's
// local; SESSION_INFO needs a WS round-trip), so the flag is settled by the first expand.
const ORIENTATION_STORAGE_KEY = "code-mode:has-seen-orientation";
let hasSeenOrientation = false;
void figma.clientStorage.getAsync(ORIENTATION_STORAGE_KEY).then((seen) => {
  hasSeenOrientation = seen === true;
});

/**
 * Whether to show first-run orientation THIS expand — true once ever, then never again. Consuming
 * it flips the in-memory flag and persists the durable "seen" bit (fire-and-forget). Split out of
 * setExpanded so the durable, once-ever write isn't buried behind a per-render "expand" verb.
 */
function consumeFirstRunOrientation(): boolean {
  if (hasSeenOrientation) return false;
  hasSeenOrientation = true;
  void figma.clientStorage.setAsync(ORIENTATION_STORAGE_KEY, true);
  return true;
}

/**
 * The short, glanceable name for a session: the last segment of its identity (a project path). The
 * strip and the takeover toast have one line to work with; the expanded row still shows the FULL
 * identity, which is what the human actually approves.
 */
function sessionLabel(identity: string | null): string {
  if (identity === null) return "A session";
  const segments = identity.split("/").filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : identity;
}

/**
 * One row per live session, derived from the connection map. Forwards {identity, label, pairingCode}
 * plus the per-row state the UI renders from — `approved` (token in approvedTokens) and `active`
 * (holds the driving baton) — and `key` so the row's Allow/Deny/Revoke routes back to the right
 * connection. NEVER the session token, a localhost bearer credential (Slice 2.1b) not for display.
 */
function panelSessions(): Array<{
  key: ConnKey;
  identity: string | null;
  label: string;
  pairingCode: string | null;
  approved: boolean;
  active: boolean;
}> {
  const sessions = [];
  for (const [key, conn] of connections) {
    sessions.push({
      key,
      identity: conn.identity,
      label: sessionLabel(conn.identity),
      pairingCode: conn.pairingCode,
      approved: isApproved(key),
      active: key === activeKey,
    });
  }
  return sessions;
}

// Whether the strip is expanded into the session list. Collapsed is the resting state — one line of
// ambient status. It expands when the human asks (clicking the strip) or when a session needs a
// decision, which is now the ONLY moment the plugin interrupts anyone.
let expanded = false;

/**
 * Push the current state to the strip — the single render path (there is no separate "raise"; the
 * window is always visible). The iframe re-measures itself after painting and reports its height
 * back (UI_HEIGHT), which is what resizes the window, so render and resize are one flow.
 */
function renderUi(showOrientation = false): void {
  figma.ui.postMessage({ type: "RENDER", sessions: panelSessions(), expanded, showOrientation });
}

/**
 * Expand or collapse the strip. Consumes first-run orientation on the first expand ever — the one
 * durable "seen" bit, spent the first time the human is actually shown the list. Idempotent, so a
 * write blocked after a collapse re-opens the list.
 */
function setExpanded(next: boolean): void {
  expanded = next;
  renderUi(next ? consumeFirstRunOrientation() : false);
}

/**
 * Resize the window, outside the current message-handler turn.
 *
 * Figma has no auto-sizing — `figma.ui.resize` is the only lever, so the height is relayed from the
 * iframe's own measurement of #root (UI_HEIGHT). The measurement is the load-bearing part: `document.
 * body` is stretched to the window by Figma's injected page styles and therefore can never report a
 * height SMALLER than the current window, so measuring it made the window grow but never shrink.
 *
 * The setTimeout is one turn of separation, not a workaround for anything measured: resizes issued
 * from this handler have been observed to apply either way. It is here because a resize called
 * synchronously from inside an in-flight `figma_execute_code` run coincided with that request losing
 * its reply. Cheap insurance; drop it if that's ever traced to something else.
 */
function resizeWindow(height: number): void {
  setTimeout(() => figma.ui.resize(UI_WIDTH, height), 0);
}

/**
 * The single write-gate decision and the enforcement point for the consent Invariant — owned in one
 * place so EXECUTE_CODE and SCREENSHOT (and any future write verb) can't drift. Consent is the ONLY
 * human decision: an unapproved session (or one with no source port — the fail-closed default) is
 * refused with PENDING_APPROVAL, and the strip expands so the human can Allow.
 *
 * An approved session that isn't the current driver simply TAKES the baton. Why NOT the old
 * INACTIVE_SESSION refusal: it made handoff reactive — the second session had to bump into a wall
 * before the human was even shown that it wanted to drive, and the human then had to click a switch
 * they never asked to arbitrate. Approval is the security boundary; ordering between the human's own
 * approved agents is a lock, and locks are the machine's job (see enqueueWrite).
 */
function gateWrite(to: ReplyTo): boolean {
  if (to.connKey === undefined || !isApproved(to.connKey)) {
    setExpanded(true);
    reply(to, { type: "PENDING_APPROVAL" });
    return false;
  }
  if (to.connKey !== activeKey) takeBaton(to.connKey);
  return true;
}

/**
 * Hand the driving baton to an approved session, on its own write. A takeover the human didn't ask
 * for is worth a toast — but ONLY when a different live session was driving; the first write of a
 * lone session, or one reclaiming the baton after the previous driver's row left, is not news.
 */
function takeBaton(key: ConnKey): void {
  const displaced = activeKey !== null ? connections.get(activeKey) : undefined;
  const taking = connections.get(key);
  activeKey = key;
  if (displaced !== undefined && taking !== undefined) {
    figma.notify(`${sessionLabel(taking.identity)} is now driving this file.`, { timeout: 4000 });
  }
  renderUi();
}

/**
 * One writer at a time (Invariant) — enforced by SERIALIZING writes rather than refusing the
 * non-driving session. Two approved agents can now both have work in flight, and without this chain
 * their executions would interleave at every `await` inside the document (loadFontAsync,
 * exportAsync), which is the interleaving the one-active-driver rule existed to prevent.
 *
 * The `catch` is not defensive noise: one rejection anywhere in the chain would poison it and
 * silently brick EVERY later write for the life of the plugin. Both handlers already reply on their
 * own error paths, so swallowing here loses nothing a caller could act on.
 */
let writeChain: Promise<void> = Promise.resolve();
function enqueueWrite(run: () => Promise<void>): void {
  writeChain = writeChain.then(run).catch(() => {});
}

/**
 * Apply the human's Allow/Deny to a specific session (keyed by its port). Allow mints a session
 * token, remembers it as approved, binds it to that connection, and hands it to that row's server
 * (routed by __connKey) so the server can echo it on reconnect — approval keys on the minted token,
 * never the forgeable identity (Invariant). Deny (approve !== true) changes no state: it means "not
 * now", so the session's next write re-opens the list.
 *
 * Approving does NOT make the row the driver. Driving follows WRITES (takeBaton), so there is
 * exactly one rule for who holds the baton and the human never arbitrates it. Either way the list
 * collapses — the decision is made, and the strip still reports anything left pending.
 */
function applyDecision(key: ConnKey, approve: boolean): void {
  const conn = connections.get(key);
  if (conn !== undefined && approve && !isApproved(key)) {
    const token = mintToken();
    approvedTokens.add(token);
    conn.token = token;
    // Same field name (`sessionToken`) the server echoes back in SESSION_INFO — one vocabulary in
    // both directions. __connKey routes the unsolicited handover to THIS row's socket.
    figma.ui.postMessage({ type: "SESSION_TOKEN", sessionToken: token, __connKey: key });
  }
  setExpanded(false);
}

/**
 * The human clicked "Revoke access" on an approved row. Forget the token so this session (and any
 * later reconnect echoing it) is no longer approved, drop its baton, and tell that row's server to
 * delete its PERSISTED copy (REVOKE_SESSION over the same relay as the Allow handover) — otherwise a
 * durable on-disk token would silently re-approve on the next connect. Deleting the token from
 * approvedTokens is what actually closes the gate: a reconnect re-binds the token, but isApproved is
 * false once the Set no longer holds it. The row stays in the list, now unapproved (Allow/Deny
 * again) — this is a de-authorization, not a disconnect, which is why the button doesn't say
 * "Disconnect": the socket is untouched and the agent can ask again.
 */
function revokeSession(key: ConnKey): void {
  const conn = connections.get(key);
  if (conn && conn.token) {
    approvedTokens.delete(conn.token);
    figma.ui.postMessage({ type: "REVOKE_SESSION", __connKey: key });
    conn.token = null;
  }
  if (activeKey === key) activeKey = null;
  renderUi();
}

figma.ui.onmessage = (msg: InboundMessage) => {
  // Local CONTROL messages from ui.html and the arbiter panel are id-less: they never traverse
  // the WS, so they carry no server correlation id and get no reply. Server REQUESTS all carry ids
  // (PluginBridge.request); since protocol 2 the server also emits ONE id-less one-way frame,
  // CANCEL, handled in this branch beside the session-scoped controls because it is likewise
  // reply-less and __connKey-routed. An id-CARRYING message falls through to the reverse-reply
  // intercept and then the envelope path below (ERROR reply for unknown types), preserving the
  // "every id-carrying server request gets exactly one reply" invariant.
  if (msg.id === undefined) {
    // Surface control first — these address the WINDOW, not a session, so they carry no __connKey.
    if (msg.type === "UI_READY") {
      // The iframe asks for its first paint once it has loaded; the sandbox can't render into a
      // document that doesn't exist yet.
      renderUi();
      return;
    }
    if (msg.type === "UI_TOGGLE") {
      setExpanded(!expanded);
      return;
    }
    if (msg.type === "UI_HEIGHT") {
      // The iframe measured itself after painting. Clamped, so a render bug can't leave a 0px or
      // screen-filling window; the width never changes.
      const measured = typeof msg.height === "number" ? Math.round(msg.height) : UI_MIN_HEIGHT;
      resizeWindow(Math.max(UI_MIN_HEIGHT, Math.min(UI_MAX_HEIGHT, measured)));
      return;
    }
    // The rest is local CONTROL keyed by __connKey (the source port) so the right session is
    // addressed. WS_CONNECTED/WS_CLOSED are the persistent relay's discovery + disconnect signals —
    // ui.html fires them ONLY for a socket that actually opened (never for the dead block ports it
    // also dials), so they arrive only for real sessions. UI_DECISION carries the row the human clicked.
    // A session-scoped control with no key is malformed — drop it (fail closed).
    const key = connKeyOf(msg);
    if (key === undefined) return;
    if (msg.type === "WS_CONNECTED") {
      // A fresh socket opened on this port (the server restarted, or a DIFFERENT local server
      // grabbed the port after the prior one dropped). Reset this port's binding to unapproved so a
      // write racing ahead of the new SESSION_INFO can't ride a stale-but-approved token into the
      // executor. approvedTokens stays intact (sticky); a legit reconnect re-binds via the echoed
      // token in its SESSION_INFO. ui.html fires this on ws.onopen, before any server message on the
      // new socket. activeKey is left alone — see its declaration for why a reconnect keeps it.
      // Any image fetch still pending against this port belonged to the PREVIOUS socket's server —
      // the new one doesn't know its preq ids, so a reply can never arrive: reject now or the
      // suspended run (and the write chain behind it) waits forever.
      rejectImagesFetches(
        (p) => p.connKey === key,
        "flcm: the server connection for this run was replaced mid-run — the image fetch was abandoned and the script stops here.",
      );
      connections.set(key, { token: null, identity: null, pairingCode: null });
    } else if (msg.type === "WS_CLOSED") {
      // The socket dropped — remove the session's row (disconnect-detection reuses this persistent
      // relay). Keep activeKey even if it pointed here: a same-port reconnect reclaims active status,
      // and with no socket there are no writes meanwhile. ui.html auto-reconnects the port after this.
      // Refresh the list; collapse only once the LAST session is gone (nothing left to act on) — a
      // departure mustn't close a list another session opened for a pending decision.
      // First, kill this session's suspended runs: a reply to their image fetches can never arrive,
      // and an unrejected fetch would wedge the write queue for the life of the plugin.
      rejectImagesFetches(
        (p) => p.connKey === key,
        "flcm: the server disconnected mid-run — the image fetch was abandoned and the script stops here.",
      );
      connections.delete(key);
      if (connections.size === 0) setExpanded(false);
      else renderUi();
    } else if (msg.type === "UI_DECISION") {
      // The human clicked Allow / Deny on a specific row. The handover (on Allow) rides the same
      // sandbox→ui.html→WS relay as any reply (ui.html forwards it verbatim); it carries no id — it's
      // unsolicited, not a reply.
      applyDecision(key, msg.approve === true);
    } else if (msg.type === "UI_REVOKE") {
      // The human clicked "Revoke access" on an approved row — de-authorize it and clear the server's
      // persisted token.
      revokeSession(key);
    } else if (msg.type === "CANCEL") {
      // The server's deadline fired for this run (id-less, run-scoped, one-way — the server-side
      // mirror of SESSION_TOKEN's direction). What this actually guarantees: the run's pending
      // image fetches reject, so a run suspended at its await dies there. What it does NOT
      // guarantee: a run past its await (or one whose script catches the rejection, or one with no
      // image fills at all) can still write — CANCEL is advisory today. Authoritative refusal is
      // Phase 2's mutation lock ("a cancelled run is refused at the lock", invariant 4); don't
      // build a second enforcement path here, it would be deleted then. The server's own
      // zombie-run defense (image requests for a dead run are refused) covers the other half.
      // Scoped to BOTH the run id and this source port: correlation ids are per-server counters,
      // so two connected servers can mint colliding run ids.
      const runId = typeof msg.runId === "string" ? msg.runId : null;
      if (runId) {
        rejectImagesFetches(
          (p) => p.runId === runId && p.connKey === key,
          "flcm: this run was cancelled by the server (its deadline passed) — the script stops here.",
        );
      }
    }
    return;
  }
  // Reverse-direction replies (protocol 2): typed answers to PLUGIN-issued requests, matched by
  // type + plugin id and consumed here. They are replies, so they must not fall through to the
  // envelope dispatch below — its contract is "every id-carrying SERVER request gets one reply",
  // and its ids are a different namespace.
  if (msg.type === "IMAGES_REPLY" || msg.type === "IMAGES_ERROR") {
    settleImagesFetch(msg);
    return;
  }
  const to: ReplyTo = { id: msg.id, connKey: connKeyOf(msg) };
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
    // Open the list for an unapproved session so the human can Allow/Deny; for an already-approved
    // reconnect (its token echoed back here) just refresh, so it does NOT re-prompt (Done-when #3)
    // and doesn't disturb a list another session opened.
    if (to.connKey !== undefined && !isApproved(to.connKey)) setExpanded(true);
    else renderUi();
  } else if (msg.type === "EXECUTE_CODE") {
    // Sandbox-side gate (the consent Invariant's enforcement point): gateWrite runs the write only
    // for an approved session — otherwise it replies PENDING_APPROVAL and the write never reaches the
    // executor. Queued, not awaited here, so a second session's write can't interleave with this one.
    if (gateWrite(to)) enqueueWrite(() => executeCode(to, typeof msg.code === "string" ? msg.code : ""));
  } else if (msg.type === "SCREENSHOT") {
    if (gateWrite(to))
      enqueueWrite(() =>
        screenshot(
          to,
          {
            nodeId: typeof msg.nodeId === "string" ? msg.nodeId : undefined,
            key: typeof msg.key === "string" ? msg.key : undefined,
          },
          typeof msg.scale === "number" ? msg.scale : undefined,
        ),
      );
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
  try {
    // The preamble bundle rides INSIDE the same async wrapper as the user's code, so its single
    // `flcm` global (flcm.frame/text/render/…) is simply in scope. The leading preamble also
    // preloads fonts (an `await`), which is why the wrapper must be async.
    //
    // The mid-run image channel rides in as a PARAMETER of the wrapper: the preamble references
    // the free identifier `__flcmRequestImages`, which resolves to this argument. A parameter
    // inside the eval'd STRING, not a scope-chain local, so no bundler pass can ever rename the
    // binding away from the preamble's reference (build.mjs pins the string survives verbatim).
    // Bound to `to` so every request carries the run's correlation id and source port.
    const raw = await eval(
      "(async function(__flcmRequestImages){ " + SANDBOX_PREAMBLE + "\n;\n" + code + "\n })",
    )((urls: string[]) => requestServerImages(to, urls));
    // Return-path node guard (R2): a returned live node would otherwise collapse to
    // { id } and silently drop everything else. Make that loud instead of lossy.
    guardReturnValue(raw);
    result = raw;
  } catch (err) {
    errorMessage = formatError(err);
  } finally {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }

  reply(to, { type: "EXECUTE_CODE_RESULT", result: safeSerialize(result), console: consoleLog, errors: errorMessage });
}

/**
 * Exports a node as PNG and posts back exactly one of `{ id, image }` (a base64
 * string) or `{ id, errors }` — never both. With no target, snapshots the whole
 * current page. `scale` (already range-checked server-side) multiplies the export
 * resolution so the agent can inspect detail it can't resolve at 1x.
 *
 * The base64 encoding MUST happen here, not on the server: `exportAsync` returns a
 * Uint8Array, and ui.html JSON.stringifies every outbound message — which turns a
 * raw Uint8Array into a useless `{"0":..,"1":..}` blob (the same un-JSON-able trap
 * safeSerialize guards against for nodes). QuickJS has no Buffer, so we use the
 * sandbox's own `figma.base64Encode` to get a clean string across the wire.
 */
async function screenshot(
  to: ReplyTo,
  target: ScreenshotTarget,
  scale: number | undefined,
): Promise<void> {
  try {
    const node = await resolveScreenshotTarget(target);
    if (!("exportAsync" in node)) throw new Error(`Node ${node.type} (${node.id}) is not exportable`);
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale ?? 1 },
    });
    reply(to, { type: "SCREENSHOT_RESULT", image: figma.base64Encode(bytes) });
  } catch (err) {
    reply(to, { type: "SCREENSHOT_RESULT", errors: formatError(err) });
  }
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
