/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { captureScreenshot, type CaptureOptions } from "./screenshot-capture.js";
// Plugin sandbox entry. This is the only context where `figma.*` lives. It never
// touches the network — it talks to the relay iframe (ui.ts) via postMessage.

import { createApprovalLifecycle, type ApprovalAnswer } from "./approval-lifecycle.js";
import { approvalRequestState, createAwayRequests } from "./approval-requests.js";
import { safeSerialize, guardReturnValue } from "./serialize.js";
import { resolveScreenshotTarget, type ScreenshotTarget } from "./screenshot-target.js";
import { createRunCancellationRegistry } from "./run-cancellation.js";
import { observeDocumentChanges, type DocumentChangeObserver } from "./document-changes.js";
import {
  APPROVAL_WAITING_GRACE_MS,
  PROTOCOL_VERSION,
  parseServerFrame,
  type AuthorizingUser,
  type CancelDisposition,
  type HostTraceStage,
  type NativeOperation,
  type PluginFrame,
  type PluginReply,
  type RunPhase,
  type ServerFrame,
  type WriteAccessNotice,
} from "./protocol.js";
import type { ConnKey, HostInbound, PanelControl, PanelRender, PanelSession } from "./panel.js";
// TYPE-ONLY on purpose: this is the one shared declaration binding the host half of the flcm
// interface to the preamble half, and it must stay erasable — a value import from preamble/ would
// drag the whole std-lib back into this bundle, which is exactly what ADR-0010 removed.
import type { FlcmHost, RunCancelCause } from "./preamble/host.js";
// Likewise type-only: the factory result types both agent bindings without bundling their implementation.
import type * as SandboxRuntime from "./preamble/sandbox.js";

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
// iframe — a menu command re-RUNS the plugin, which tears down this relay and every live
// connection — so a hidden window leaves the human no way to check whether a session is connected
// or to reach Revoke access / Revoke all approvals. They could only act at moments WE chose to
// interrupt them. An always-on strip inverts that: state is ambient, and the human opens the list
// whenever they want.
// themeColors gives the iframe Figma's light/dark variables, which an always-on window needs.
figma.showUI(__html__, {
  visible: true,
  width: UI_WIDTH,
  height: UI_MIN_HEIGHT,
  themeColors: true,
  title: "Framelink",
});

// The plugin release, answered beside PROTOCOL_VERSION to the server's GET_VERSION and shown to the
// human in a skew refusal. Informational: the server gates on the protocol alone (protocol.ts).
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

// The consent gate. The sandbox is the SOLE ARBITER: it holds the durable approval decision and
// refuses to run writes for a session the human hasn't approved. The server only introduces itself
// (SESSION_INFO) and formats the pending reply — it does not own the approval bit.
//
// Approval keys on a TOKEN this sandbox mints on Allow, never on the server's identity (a project
// path — a forgeable label). The token is handed to the approved server and echoed back in every
// SESSION_INFO; a same-path squatter never got the handover, so it has no token and is PENDING.
const APPROVED_TOKENS_STORAGE_KEY = "code-mode:approved-tokens";
let approvalStorageError: string | null = null;
const approvedTokens = createApprovalLifecycle({
  load: () => figma.clientStorage.getAsync(APPROVED_TOKENS_STORAGE_KEY),
  save: async (tokens) => {
    await figma.clientStorage.setAsync(APPROVED_TOKENS_STORAGE_KEY, tokens);
    approvalStorageError = null;
  },
}, (error) => {
  approvalStorageError = `Approval storage failed: ${String(error)}. Changes may not survive reopening.`;
  figma.notify(approvalStorageError, { error: true, timeout: 15000 });
});
void approvedTokens.ready.then(() => renderUi());

// One live session, as last presented over SESSION_INFO. The token gates writes; the identity is
// the label the human approves in the panel; the pairing code is the glance-and-compare check
// shown beside it. All null until this connection's SESSION_INFO arrives — a connection with no
// token yet is UNAPPROVED, so a write racing ahead of the handshake gets the pending path.
interface SessionConn {
  rejected?: boolean;
  decisionRevision?: number;
  token: string | null;
  identity: string | null;
  pairingCode: string | null;
  // When this connection last asked for approval (a pending status poll or a refused write), and the
  // session claim minted on its first ask. See approval-requests.ts.
  askedAt?: number;
  sessionClaim?: string;
  // In flight while this connection collects an Allow given while it was away; status polls wait on it.
  handover?: Promise<boolean>;
  // The server's latest word on write access (allowance spent, a sign-in code, its outcome), shown on
  // this session's row. Absent until the server has something to say.
  writeAccess?: WriteAccessNotice;
  // Set by the human's sign-in click and spent by the next sign-in code: the browser only ever opens
  // because the human asked, never because a server pushed a URL.
  signInRequested?: boolean;
  // The origin of the Framelink app this server is configured against (SESSION_INFO). The browser
  // opens a sign-in page only on this origin.
  framelinkOrigin: string | null;
}

// The scheme://host[:port] of an http(s) URL, lowercased, or null. Hand-rolled: the plugin sandbox
// has no URL class.
function httpOriginOf(url: string): string | null {
  const match = /^(https?:\/\/[^/?#\\@]+)(?:[/?#]|$)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Open the sign-in page for this row's pending code — approved sessions only, and only a page on the
 * Framelink origin the server announced: figma.openExternal hands the URL to the OS browser.
 */
function openSignIn(key: ConnKey): void {
  const conn = connections.get(key);
  const notice = conn?.writeAccess;
  if (!conn || !isApproved(key) || notice?.kind !== "sign-in-pending") return;
  const origin = httpOriginOf(notice.verificationUri);
  if (origin === null || origin !== conn.framelinkOrigin) return;
  figma.openExternal(notice.verificationUri);
}

// One per socket generation (panel.ts ConnKey). Approval tokens are independent and may survive
// replacement connections.
const connections = new Map<ConnKey, SessionConn>();

// Requests from sessions whose socket has closed, kept so a late Allow still reaches them. Keyed by
// the closed connection's key, which the relay never reuses, so a row's Allow can't land on a live one.
const awayRequests = createAwayRequests<AuthorizingUser | null>();

/** Post one frame to a server, on the socket generation it belongs to. */
function toServer(connKey: ConnKey, frame: PluginFrame): void {
  figma.ui.postMessage({ to: "server", connKey, frame });
}

/** The human who is clicking right now, as the Allow handover names them. */
function currentAuthorizingUser(): AuthorizingUser | null {
  const user = figma.currentUser;
  return user?.id ? { figmaUserId: user.id, name: user.name } : null;
}

/**
 * A connection asked for approval and was told PENDING. The first ask mints the session claim and
 * gives it to this socket's server alone; later asks just keep the request marked as waiting.
 */
function noteApprovalAsked(key: ConnKey): void {
  const conn = connections.get(key);
  if (!conn) return;
  conn.askedAt = Date.now();
  if (conn.sessionClaim === undefined) {
    conn.sessionClaim = mintToken();
    toServer(key, { type: "SESSION_CLAIM", sessionClaim: conn.sessionClaim });
  }
  scheduleExpiryRender();
}

// One timer, re-armed for the soonest waiting request to lapse, so its row turns to "expired" when
// the polls stop rather than at the next unrelated render.
let expiryRender: ReturnType<typeof setTimeout> | undefined;
function scheduleExpiryRender(): void {
  if (expiryRender !== undefined) clearTimeout(expiryRender);
  expiryRender = undefined;
  const now = Date.now();
  let soonest = Infinity;
  for (const conn of connections.values()) {
    if (conn.askedAt === undefined) continue;
    const lapsesAt = conn.askedAt + APPROVAL_WAITING_GRACE_MS;
    if (lapsesAt > now) soonest = Math.min(soonest, lapsesAt);
  }
  if (soonest === Infinity) return;
  expiryRender = setTimeout(() => {
    renderUi();
    scheduleExpiryRender();
  }, soonest - now);
}

// Who holds the driving baton — the approved session whose write ran most recently. It is a LABEL
// for the human ("● Driving this file"), not a gate: any approved session takes the baton simply by
// writing (takeBaton). Which of the human's own approved agents writes next is a lock, not a
// security decision, so it needs no human mediation; exclusion between them is enforced by
// serializing their writes (enqueueWrite), not by refusing them.
//
// Deliberately NOT cleared when the driver's socket drops: it grants nothing on its own — every write
// still passes isApproved() first, so a token-less squatter grabbing the freed port inherits nothing.
let activeKey: ConnKey | null = null;

/** A connection with no token is definitely unapproved; one with a token waits on the store. */
function approvalOf(key: ConnKey): ApprovalAnswer {
  const conn = connections.get(key);
  if (!conn || conn.token === null) return "unapproved";
  return approvedTokens.approval(conn.token);
}

type SettledApproval = Exclude<ApprovalAnswer, "unknown">;

/** The connection's approval once the store has a definite answer. */
async function settledApprovalOf(key: ConnKey): Promise<SettledApproval> {
  for (;;) {
    const answer = approvalOf(key);
    if (answer !== "unknown") return answer;
    await approvedTokens.settled;
  }
}

/** Act on a definite answer: synchronously when the store already has one, else once it settles. */
function whenApprovalKnown(key: ConnKey, then: (approval: SettledApproval) => void): void {
  const answer = approvalOf(key);
  if (answer !== "unknown") then(answer);
  else void settledApprovalOf(key).then(then);
}

function isApproved(key: ConnKey): boolean {
  return approvalOf(key) === "approved";
}

/**
 * Mint a session token on Allow, or a session claim. The token is the sticky-approval key; a squatter
 * that announces the same project path holds none, so it re-prompts.
 *
 * Why Math.random is fine (QuickJS has no crypto): the token is a localhost BEARER value. The server
 * re-discloses it in SESSION_INFO, so a local attacker connecting during a drop window can harvest
 * and replay it — closing that needs cryptographic server auth, out of scope; consent is the gate.
 * An attacker who beats this has already seen the value, so generator strength is moot. Claims reach
 * unapproved servers, so a local process can sample the generator — no worse than that residual.
 */
function mintToken(): string {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}

/**
 * Everything a reply inherits from its request, derived once at dispatch: the correlation `id`, and
 * `connKey` — the socket generation the request arrived on, which the reply goes out on.
 *
 * Negative space: nothing else crosses over, and there is deliberately no pass-through namespace to
 * put it in. The server correlates by `id` alone, and each session already has its own socket, so a
 * reply being a function of the handler's body is what makes it structurally impossible for a field
 * the sandbox CONSUMES to ride back out as if a newer server had attached it. Don't reintroduce a
 * general echo without a consumer that demands one.
 */
interface ReplyTo {
  id: string;
  connKey: ConnKey;
}

/** Announce a run's phase on its connection. Returns the stamp it carries. */
function runState(to: ReplyTo, phase: RunPhase): number {
  // `at` because the frame only leaves once this thread goes idle: a run that opens with seconds of
  // synchronous work delivers "running" seconds late, and the server would start its deadline then.
  const at = Date.now();
  toServer(to.connKey, { type: "RUN_STATE", runId: to.id, phase, at });
  return at;
}

/**
 * The answer to a server CANCEL: what this plugin knew about the run when the frame landed. Like
 * RUN_STATE it is run-scoped and id-less — CANCEL carries no correlation id, so this cannot ride the
 * reply path — and like RUN_STATE it goes out on the connection the run belongs to.
 */
function cancelResult(connKey: ConnKey, runId: string, disposition: CancelDisposition): void {
  toServer(connKey, { type: "CANCEL_RESULT", runId, disposition });
}

/**
 * The document changed after this run's reply said it hadn't (document-changes.ts watchLate). Like
 * CANCEL_RESULT it is run-scoped and id-less, and at most one is sent per run; the server records the
 * Write under the run's execution, so a duplicate is harmless.
 */
function runChanged(to: ReplyTo): void {
  toServer(to.connKey, { type: "RUN_CHANGED", runId: to.id });
}

/** The late watch closed with no change: the server may stop holding this run open for one. */
function runSettled(to: ReplyTo): void {
  toServer(to.connKey, { type: "RUN_SETTLED", runId: to.id });
}

/**
 * The single reply path: the handler's body, with the correlation `id` (the frozen-envelope
 * Invariant) stamped last so a body field can't clobber it.
 */
function reply(to: ReplyTo, body: PluginReply): void {
  toServer(to.connKey, { ...body, id: to.id });
}

// ---- Mid-run server calls: the plugin→server reverse-request direction. ----
// The preamble suspends on an await while the server works; these tables
// correlate the plugin-ISSUED requests with the server's responses. Deliberately a separate id
// namespace ("preq-") and a separate pending table from the server's own requests: each side owns
// its ids, and reverse replies are matched by TYPE (CHANNEL_RESPONSE) before the envelope
// dispatch, so neither end ever has to guess who minted an id.
let nextChannelRequestId = 0;
interface PendingServerCall {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  runId: string;
  connKey: ConnKey;
}
const pendingServerCalls = new Map<string, PendingServerCall>();

/**
 * Call a capability on the run's server and await its opaque response. Tagged with the
 * run's correlation id so the server can (a) suspend the run's inactivity deadline while IT is the
 * side doing the work, and (b) refuse a request for a run it no longer tracks (cancelled/timed
 * out) — that refusal rejects this promise, which is what makes a zombie run die at its
 * suspension point instead of resuming into canvas writes.
 *
 * ORDERING RULE a capability must hold to: the sandbox gathers its evidence, the server computes,
 * and any follow-up `figma.*` work happens AFTER the reply. A server handler must not turn around
 * and await a fresh plugin request, because that request queues behind the execution still
 * suspended on this call and the two wait on each other forever. The same non-reentrancy the
 * mutation lock documents for verbs (see preamble/mutation-lock.ts), one level out.
 */
function callServer(to: ReplyTo, capability: string, payload: unknown): Promise<unknown> {
  // Fail closed at issue time: with no live socket for this run's connection, the relay would
  // silently drop the frame and this promise could never settle — wedging the write chain for the
  // life of the plugin. WS_CLOSED rejects the calls that were already pending; this covers the run
  // that reaches its call only AFTER the drop.
  if (!connections.has(to.connKey)) {
    return Promise.reject(
      new Error("flcm: the server for this run is not connected — the server call cannot be issued and the script stops here."),
    );
  }
  return new Promise((resolve, reject) => {
    const id = "preq-" + ++nextChannelRequestId;
    pendingServerCalls.set(id, { resolve, reject, runId: to.id, connKey: to.connKey });
    toServer(to.connKey, { type: "CHANNEL_REQUEST", id, runId: to.id, capability, payload });
  });
}

/** Settle a plugin-issued server request from the server's response. An unknown id is dropped —
 * that call was already rejected by a CANCEL, a disconnect or a revoke. The reply must arrive on the
 * SAME connection the request went out on: the relay holds a socket per block port, so without this
 * check any other local server (approved or not — approval gates writes, not this direction) could
 * inject a result into another server's suspended call. */
function settleServerCall(msg: Extract<ServerFrame, { type: "CHANNEL_RESPONSE" }>, connKey: ConnKey): void {
  const pending = pendingServerCalls.get(msg.id);
  if (!pending) return;
  if (pending.connKey !== connKey) return;
  pendingServerCalls.delete(msg.id);
  if (msg.ok) {
    pending.resolve(msg.payload);
    return;
  }
  // A failure crosses opaquely, the same way a success does. The installed plugin is the ONE piece
  // that can't be updated in step with a new capability, so it must not flatten the server's error
  // to prose: a future capability ships a structured failure (code, details) and a preamble that
  // reads it off `.detail`, with no plugin release. `message` stays a string only because throwing
  // a non-Error in the sandbox loses the stack.
  const error = new Error(
    typeof msg.error === "string" ? msg.error :
      msg.error && typeof msg.error === "object" && "message" in msg.error && typeof msg.error.message === "string"
        ? msg.error.message : "flcm: the server capability failed.",
  );
  (error as Error & { detail?: unknown }).detail = msg.error;
  pending.reject(error);
}

// Run cancellation. The policy, the run phase it reads, and the key semantics live on the registry
// module — run-cancellation.ts — not here.
const cancelledRuns = createRunCancellationRegistry();

/**
 * Accept a run: track it from this moment — a run can be cancelled while it still sits in the queue —
 * and tell its server. Phase transitions are announced and recorded together, in these two functions
 * only: the server's copy of the phase drives its deadlines, ours answers its CANCELs, and a run
 * whose two copies disagree is exactly how a caller gets told the wrong thing.
 */
function acceptRun(to: ReplyTo): void {
  cancelledRuns.enqueue(to);
  runState(to, "queued");
}

/**
 * The run reached the front of the write chain and is about to touch the document. The previous
 * execution's late-change watch ends first, so nothing this run does is charged to that one.
 */
function beginRun(to: ReplyTo): number {
  lateChangeWatch?.stop();
  lateChangeWatch = null;
  cancelledRuns.markRunning(to);
  return runState(to, "running");
}

// The last execution whose reply said "no change", still watching for a change that lands after it
// (document-changes.ts watchLate). Bounded by the next run's start and by the window its EXECUTE_CODE
// carried — the server's number, since the server is what holds the run open for it.
let lateChangeWatch: DocumentChangeObserver | null = null;

/** Reject matching pending server calls. A rejected call kills its suspended run at the await —
 * the mechanism behind CANCEL (deadline fired), WS_CLOSED (server went away) and a revoke, and what
 * keeps the write queue from wedging on a call whose reply can never arrive. */
function rejectServerCalls(match: (p: PendingServerCall) => boolean, reason: string): void {
  for (const [id, pending] of pendingServerCalls) {
    if (!match(pending)) continue;
    pendingServerCalls.delete(id);
    pending.reject(new Error(reason));
  }
}

/**
 * The human revoked this connection's approval: its queued runs never start, its running one writes
 * nothing more, and a server call it is suspended on is abandoned. Cooperative — a raw figma.* write
 * already in flight can't be stopped, only every verb and await after it.
 */
function cancelRevokedRuns(key: ConnKey): void {
  cancelledRuns.cancelConnection(key, "revoked");
  rejectServerCalls(
    (p) => p.connKey === key,
    "flcm: the human revoked this session's approval in Figma — the server call was abandoned and the script stops here.",
  );
}

// First-run orientation. The session list shows a one-time explainer (what the plugin does; "only
// approve sessions you started") the FIRST time it is ever expanded, then never again. Durable via
// clientStorage, same as approvedTokens above. Read once at startup into a sync flag so expanding
// stays synchronous (no await in the hot path); the write-back is fire-and-forget. An expand that
// beats the startup read shows the orientation once more — harmless, so nothing waits for it.
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
 * connection. NEVER the session token, a localhost bearer credential not for display.
 */
function panelSessions(): PanelSession[] {
  const sessions: PanelSession[] = [];
  const now = Date.now();
  for (const [key, conn] of connections) {
    const approved = isApproved(key);
    sessions.push({
      key,
      identity: conn.identity,
      label: sessionLabel(conn.identity),
      pairingCode: conn.pairingCode,
      approved,
      active: key === activeKey,
      writeAccess: conn.writeAccess ?? null,
      connected: true,
      // A rejected session's call is being refused, not waiting; it isn't an open request either.
      request: approved || conn.rejected ? null : approvalRequestState(conn.askedAt, now),
      rejected: !approved && conn.rejected === true,
      allowedWhileAway: false,
    });
  }
  for (const [key, away] of awayRequests.entries(now)) {
    sessions.push({
      key,
      identity: away.identity,
      label: sessionLabel(away.identity),
      pairingCode: away.pairingCode,
      approved: false,
      active: false,
      writeAccess: null,
      connected: false,
      request: "expired",
      rejected: false,
      allowedWhileAway: away.allowed !== undefined,
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
 *
 * `hasApprovals` gates the "Revoke all approvals" footer — it reflects the WHOLE persisted Set, not
 * just rows in `sessions`, because a prior approval can outlive its connection (that's the point of
 * persisting it). Without this flag the footer would have no way to appear for approvals nobody is
 * currently connected to reconnect and show a row for.
 */
function renderUi(showOrientation = false): void {
  const render: PanelRender = {
    sessions: panelSessions(),
    expanded,
    showOrientation,
    hasApprovals: approvedTokens.size > 0 || awayRequests.allowedCount > 0,
    approvalStorageError,
  };
  figma.ui.postMessage({ to: "panel", render });
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
 * human decision: an unapproved session (or one whose connection is unknown — the fail-closed default) is
 * refused with PENDING_APPROVAL, and the strip expands so the human can Allow — unless the human
 * already rejected it, when the reply alone sends the agent to the REJECTED its status poll answers.
 *
 * "unknown" (stored approvals loading, or a change being written) is admitted into the queue but
 * never run: the dequeue gate asks again once the store settles. Prompting on it would ask an
 * approved session to be approved again.
 *
 * An approved session that isn't the current driver simply TAKES the baton: approval is the security
 * boundary, and ordering between the human's own approved agents is a lock (see enqueueWrite).
 */
function gateWrite(to: ReplyTo, approval: ApprovalAnswer): boolean {
  if (approval === "unapproved") {
    if (!connections.get(to.connKey)?.rejected) {
      noteApprovalAsked(to.connKey);
      setExpanded(true);
    }
    reply(to, { type: "PENDING_APPROVAL" });
    return false;
  }
  if (approval === "approved" && to.connKey !== activeKey) takeBaton(to.connKey);
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

// One store per plugin run, shared by approved callers across socket generations and pages.
let agentSession: Record<string, unknown> | undefined;

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

/** Allow becomes usable after durable storage succeeds. Reject ends pending waits. */
async function applyDecision(key: ConnKey, approve: boolean): Promise<void> {
  const conn = connections.get(key);
  if (!conn) {
    decideAwayRequest(key, approve);
    return;
  }
  const revision = (conn.decisionRevision ?? 0) + 1;
  conn.decisionRevision = revision;
  if (!approve) {
    conn.rejected = true;
    // The request is answered; left in place it would read as still waiting until its grace lapsed.
    conn.askedAt = undefined;
    setExpanded(anySessionAwaitingDecision());
    return;
  }
  const authorizingUser = currentAuthorizingUser();
  if (
    (await settledApprovalOf(key)) !== "approved" &&
    !(await grantSession(key, conn, revision, authorizingUser))
  ) return;
  setExpanded(anySessionAwaitingDecision());
}

/**
 * Whether a connected session still needs the human: neither approved nor rejected. A decision on
 * one row must not collapse a list another row opened.
 */
function anySessionAwaitingDecision(): boolean {
  for (const [key, conn] of connections) if (!conn.rejected && !isApproved(key)) return true;
  return false;
}

/**
 * Mint a token, make it durable, and hand it to this connection's server. False when storage failed
 * or another decision overtook this one, so the token never reached the session.
 *
 * Nothing runs here. A call that was waiting learns of the Allow from its next status poll and only
 * then submits its code; a call that already gave up has no code here to run.
 */
async function grantSession(
  key: ConnKey,
  conn: SessionConn,
  revision: number,
  authorizingUser: AuthorizingUser | null,
): Promise<boolean> {
  const token = mintToken();
  try { await approvedTokens.allow(token); }
  catch { renderUi(); return false; }
  if (connections.get(key) !== conn || conn.decisionRevision !== revision) {
    // Overtaken (Reject, Revoke, or the socket closed): the token is durable but reached no session,
    // so it would sit in storage approving nobody and keep "Revoke all approvals" on screen.
    void approvedTokens.revoke(token).catch(() => {});
    return false;
  }
  conn.rejected = false;
  conn.token = token;
  // The server spends its claim on this handover, so the request it named is over.
  conn.askedAt = undefined;
  conn.sessionClaim = undefined;
  // The Authorizing User rides the handover: every write this session makes is attributed to the human who
  // clicked Allow, so the server learns who that is here, once, with the token it persists.
  toServer(key, { type: "SESSION_TOKEN", sessionToken: token, authorizingUser });
  return true;
}

/**
 * Allow or dismiss a request whose session has disconnected. An Allow mints nothing yet: it records
 * who approved, and the token is minted and handed over only to the connection that presents this
 * request's session claim (SESSION_INFO). Reject just drops the row; the session asks again if it
 * returns.
 */
function decideAwayRequest(key: ConnKey, approve: boolean): void {
  if (!awayRequests.get(key)) return;
  if (approve) awayRequests.allow(key, currentAuthorizingUser());
  else awayRequests.dismiss(key);
  renderUi();
}

/**
 * The human clicked "Revoke access" on an approved row. Forget the token durably — that is what
 * closes the gate, including for a reconnect echoing it and after this plugin reopens — cancel the
 * runs it has outstanding, drop its baton, and tell the row's server to delete its persisted copy
 * (REVOKE_SESSION). A de-authorization, not a disconnect: the socket and row stay, and the agent can
 * ask again.
 */
async function revokeSession(key: ConnKey): Promise<void> {
  const conn = connections.get(key);
  if (conn) conn.decisionRevision = (conn.decisionRevision ?? 0) + 1;
  if (conn && conn.token) {
    const persistence = approvedTokens.revoke(conn.token);
    cancelRevokedRuns(key);
    toServer(key, { type: "REVOKE_SESSION" });
    conn.token = null;
    await persistence.catch(() => {});
  }
  if (activeKey === key) activeKey = null;
  renderUi();
}

/**
 * The human clicked "Revoke all approvals" — a global action distinct from per-row Revoke access:
 * it forgets EVERY token this plugin remembers, including ones for sessions that aren't currently
 * connected. Approval survives a plugin reopen, so this is the durable way to undo that survival;
 * persisting an empty Set survives the same reopen.
 *
 * Every connected row is also told to drop its server-side copy, like revokeSession, so an active
 * session's next write re-prompts at once rather than on its next reconnect.
 */
async function revokeAllApprovals(): Promise<void> {
  const persistence = approvedTokens.revokeAll();
  awayRequests.dismissAllowed();
  for (const [key, conn] of connections) {
    conn.decisionRevision = (conn.decisionRevision ?? 0) + 1;
    if (conn.token === null) continue;
    cancelRevokedRuns(key);
    toServer(key, { type: "REVOKE_SESSION" });
    conn.token = null;
  }
  activeKey = null;
  await persistence.catch(() => {});
  renderUi();
}

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
      // The iframe asks for its first paint once it has loaded; the sandbox can't render into a
      // document that doesn't exist yet.
      renderUi();
      return;
    case "UI_TOGGLE":
      setExpanded(!expanded);
      return;
    case "UI_REVOKE_ALL":
      revokeAllApprovals();
      return;
    case "UI_HEIGHT":
      // The iframe measured itself after painting. Clamped, so a render bug can't leave a 0px or
      // screen-filling window; the width never changes.
      resizeWindow(Math.max(UI_MIN_HEIGHT, Math.min(UI_MAX_HEIGHT, Math.round(msg.height))));
      return;
    case "WS_CONNECTED":
      // Each socket generation starts with an unapproved session. The previous generation receives
      // WS_CLOSED and keeps its own cancellation until settlement.
      connections.set(msg.connKey, { token: null, identity: null, pairingCode: null, framelinkOrigin: null });
      return;
    case "WS_CLOSED":
      closeConnection(msg.connKey);
      return;
    case "UI_DECISION":
      // The human clicked Allow / Deny on a specific row. The handover (on Allow) is unsolicited.
      applyDecision(msg.connKey, msg.approve);
      return;
    case "UI_SIGN_IN": {
      // The human asked to sign in from this row's write-access card. The server runs the device flow
      // and answers with a WRITE_ACCESS sign-in code, which is what opens the browser.
      const conn = connections.get(msg.connKey);
      if (!conn || !isApproved(msg.connKey)) return;
      conn.signInRequested = true;
      toServer(msg.connKey, { type: "WRITE_ACCESS_SIGN_IN" });
      return;
    }
    case "UI_OPEN_SIGN_IN":
      openSignIn(msg.connKey);
      return;
    case "UI_REVOKE":
      revokeSession(msg.connKey);
      return;
  }
}

/**
 * The socket dropped — remove the session's row. Keep activeKey even if it pointed here: with no
 * socket there are no writes meanwhile. Collapse only once the LAST session is gone — a departure
 * mustn't close a list another session opened for a pending decision.
 */
function closeConnection(key: ConnKey): void {
  // First, kill this session's suspended runs: a reply to their server calls can never arrive,
  // and an unrejected call would wedge the write queue for the life of the plugin.
  rejectServerCalls(
    (p) => p.connKey === key,
    "flcm: the server disconnected mid-run — the server call was abandoned and the script stops here.",
  );
  // The server rejects every in-flight caller when a socket dies, so its outstanding runs here
  // (queued or executing) were all reported failed — cancel them or they'd keep going.
  cancelledRuns.cancelConnection(key, "disconnected");
  // A session that asked and was neither approved nor rejected keeps its request as an away
  // request, so a late Allow can still reach it when it reconnects.
  const closing = connections.get(key);
  if (
    closing &&
    closing.sessionClaim !== undefined &&
    closing.askedAt !== undefined &&
    closing.identity !== null &&
    !closing.rejected &&
    !isApproved(key)
  ) {
    awayRequests.retain(key, {
      identity: closing.identity,
      pairingCode: closing.pairingCode,
      sessionClaim: closing.sessionClaim,
      askedAt: closing.askedAt,
    });
  }
  connections.delete(key);
  if (connections.size === 0) setExpanded(false);
  else renderUi();
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
    // The server gave up on this run. Record it; every refusal point reads the registry (the full
    // policy lives in run-cancellation.ts). Rejecting the pending server calls below additionally
    // kills a run suspended at its await right now.
    //
    // Answer FIRST, before the call rejections: the server is holding its caller for this one
    // frame, and a queued run's own refusal cannot speak for it — that refusal only fires once the
    // run ahead finishes, which may be long after the caller was told something.
    cancelResult(key, msg.runId, cancelledRuns.recordCancellation(key, msg.runId));
    rejectServerCalls(
      (p) => p.runId === msg.runId && p.connKey === key,
      "flcm: this run was cancelled by the server (its deadline passed) — the script stops here.",
    );
    return;
  }
  // Reverse-direction replies: answers to PLUGIN-issued requests, in the plugin's id namespace. They
  // are replies, so they never reach the request dispatch below.
  if (msg.type === "CHANNEL_RESPONSE") {
    settleServerCall(msg, key);
    return;
  }
  const to: ReplyTo = { id: msg.id, connKey: key };
  switch (msg.type) {
    case "PING":
      // Smoke test: echo back. Any local process can send it before consent, so it reads nothing
      // from the document — not even the page name.
      reply(to, { type: "PONG", echo: msg.payload });
      return;
    case "SESSION_INFO":
      introduceSession(to, msg);
      return;
    case "APPROVAL_STATUS": {
      const conn = connections.get(key);
      const answer = (approval: SettledApproval) => {
        const type = conn?.rejected ? "APPROVAL_REJECTED" :
          approval === "approved" ? "APPROVAL_GRANTED" : "PENDING_APPROVAL";
        if (type === "PENDING_APPROVAL") {
          noteApprovalAsked(key);
          setExpanded(true);
        }
        reply(to, { type });
      };
      const decide = () => whenApprovalKnown(key, answer);
      // The first poll can beat the handover of an Allow given while away; answering pending then would
      // pop the panel open and mint a fresh claim, a second prompt for a session already allowed.
      if (conn?.handover) void conn.handover.then(decide);
      else decide();
      return;
    }
    case "EXECUTE_CODE": {
      // Sandbox-side gate (the consent Invariant's enforcement point): an unapproved session is
      // answered PENDING_APPROVAL and its write never reaches the executor; executeCode gates again at
      // dequeue. Queued, not awaited here, so a second session's write can't interleave with this one.
      // A request missing its std-lib never got this far: the parser refused it, so no human is asked
      // to consent to something that could not run.
      const { code, preamble, lateChangeWindowMs } = msg;
      if (gateWrite(to, approvalOf(key))) {
        acceptRun(to);
        enqueueWrite(() => executeCode(to, code, preamble, lateChangeWindowMs));
      }
      return;
    }
    case "SCREENSHOT":
      if (gateWrite(to, approvalOf(key))) {
        acceptRun(to);
        const { nodeId, key: nodeKey, scale, context, margin } = msg;
        enqueueWrite(() => screenshot(to, { nodeId, key: nodeKey }, { scale, context, margin }));
      }
      return;
    case "WRITE_ACCESS": {
      const conn = connections.get(key);
      if (conn) {
        conn.writeAccess = msg.notice;
        if (msg.notice.kind === "sign-in-pending" && conn.signInRequested) {
          conn.signInRequested = false;
          openSignIn(key);
        }
        setExpanded(true);
      }
      reply(to, { type: "WRITE_ACCESS_ACK" });
      return;
    }
    case "GET_VERSION":
      // Server-initiated version handshake, answered over the frozen envelope.
      reply(to, { type: "VERSION", pluginVersion: PLUGIN_VERSION, protocolVersion: PROTOCOL_VERSION });
      return;
    case "NOTIFY":
      // Human channel of the server's version-skew refusal (it is the only sender). The skew is found
      // at connect, before any consent, so any local process can send this frame: it carries a number
      // and the plugin words the toast, so a peer can't put its own text in front of the human.
      figma.notify(skewNotice(msg.serverProtocol), { timeout: 15_000 });
      reply(to, { type: "NOTIFY_RESULT" });
      return;
  }
}

/**
 * The server introduces its session: the identity (project path) the human approves, the
 * per-connection pairing code shown in the panel, the Framelink origin its sign-in pages must be on,
 * and — from an already-approved server — the session token it was handed on a prior Allow (it
 * re-keys sticky approval; a squatter has none, so the gate re-prompts). Acked immediately: approval
 * arrives later via UI_DECISION, never by blocking here.
 */
function introduceSession(to: ReplyTo, msg: Extract<ServerFrame, { type: "SESSION_INFO" }>): void {
  const key = to.connKey;
  let handover: Promise<boolean> | undefined;
  const label = {
    token: msg.sessionToken,
    identity: msg.identity,
    pairingCode: msg.pairingCode,
    framelinkOrigin: msg.framelinkOrigin,
  };
  // Merged into the connection, never replacing it: a write that beat the handshake may already have
  // sent this socket a session claim, and an Allow in flight holds this object (grantSession).
  const existing = connections.get(key);
  const conn: SessionConn = existing ? Object.assign(existing, label) : label;
  connections.set(key, conn);
  // A session back from away presents the claim its last request was given. It takes over that
  // request: allowed while away, it gets its token now; otherwise the request stays expired on
  // this connection, under the same claim the server still holds. A session whose echoed token
  // is already approved just retires the request.
  const away = msg.sessionClaim !== null ? awayRequests.claim(msg.sessionClaim, conn.identity) : undefined;
  if (away && !isApproved(key)) {
    const { key: awayKey, request } = away;
    if (request.allowed) {
      const revision = (conn.decisionRevision ?? 0) + 1;
      conn.decisionRevision = revision;
      // A handover that fails (storage, or a newer decision) puts the request back, Allow and all,
      // rather than losing the human's click without a trace.
      handover = grantSession(key, conn, revision, request.allowed.authorizingUser)
        .then((granted) => {
          if (!granted) awayRequests.retain(awayKey, request);
          return granted;
        });
      conn.handover = handover;
    } else {
      conn.askedAt = request.askedAt;
      conn.sessionClaim = request.sessionClaim;
    }
  }
  reply(to, { type: "SESSION_INFO_ACK" });
  // Open the list for an unapproved session so the human can Allow/Deny. An already-approved
  // reconnect, or one collecting an Allow given while away, only refreshes: no re-prompt, and no
  // disturbing a list another session opened.
  if (handover) void handover.then(() => renderUi());
  else whenApprovalKnown(key, (approval) => {
    if (approval === "unapproved" && connections.get(key) === conn) setExpanded(true);
    else renderUi();
  });
}

// What a run cancelled before it started tells its (late) reply, by cause.
const CANCELLED_WHILE_QUEUED: Record<RunCancelCause, string> = {
  server: "this run was cancelled by the server while it was still queued",
  disconnected: "this run's server disconnected while the run was still queued",
  revoked: "the human revoked this session's approval while the run was still queued",
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
async function executeCode(
  to: ReplyTo,
  code: string,
  preamble: string,
  lateChangeWindowMs: number,
): Promise<void> {
  // First, so a CANCEL landing while the store settles is still honoured just below.
  const approval = await settledApprovalOf(to.connKey);
  // The dequeue refusal — the queued-zombie case (run-cancellation.ts): a run cancelled while it
  // sat queued behind writeChain must not execute now, mutating a canvas the agent was told is
  // unchanged. Nothing may wait for this reply — a CANCEL was answered the moment it landed — but
  // the frozen envelope promises one reply per request, and the server files it as a late reply.
  const cancelled = cancelledRuns.cancellation(to);
  if (cancelled) {
    cancelledRuns.settle(to);
    reply(to, {
      type: "EXECUTE_CODE_RESULT",
      result: null,
      console: [],
      errors: `flcm: ${CANCELLED_WHILE_QUEUED[cancelled]} — no code was executed.`,
      documentChanged: false,
    });
    return;
  }
  if (!gateWrite(to, approval)) { cancelledRuns.settle(to); return; }
  const runStartedAt = beginRun(to);
  const traceStarted = Date.now();
  const trace = (stage: HostTraceStage, operation?: NativeOperation) => {
    try {
      toServer(to.connKey, { type: "RUN_TRACE", runId: to.id, stage, operation, elapsedMs: Date.now() - traceStarted });
    } catch { /* A diagnostic must never change execution or cleanup. */ }
  };
  trace("eval-start");
  const consoleLog: string[] = [];
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  // Capture the agent's console output so it round-trips back as feedback. Each call takes the
  // result's egress (one projection for the whole line) and node-aware serializer, so logging a live
  // node yields `{id,name,type}` instead of an opaque failure.
  const capture = (level: string) => (...args: unknown[]) => {
    const line = runtime ? (runtime.projectForEgress(args, "console") as unknown[]) : args;
    consoleLog.push(`[${level}] ${line.map(stringifyArg).join(" ")}`);
  };
  console.log = capture("log");
  console.info = capture("info");
  console.warn = capture("warn");
  console.error = capture("error");

  let result: unknown;
  let errorMessage: string | null = null;
  // Flipped once this run has nothing left to do — after the queue drain below, so a verb that was
  // legitimately queued by this run's code is not refused as another run's leftover. Every host
  // method reads it, which is what contains a runtime the agent stored across calls.
  let settled = false;
  let runtime: typeof SandboxRuntime | undefined;
  let landedAfterReturn = 0;
  let documentChanged = false;
  let documentChanges: DocumentChangeObserver | undefined;
  try {
    // Watching starts before anything of the agent's can run, and ends after the drain below.
    documentChanges = observeDocumentChanges();
    // Two evals, and the split is the point. The server's std-lib is a FACTORY expression
    // (src/preamble/index.mjs): called with the host, it returns { flcm, session }, which the agent's
    // code receives as named parameters. How the preamble binds its host stays wholly in preamble/.
    // The agent's own wrapper also keeps its line numbers its own, not offsets into the std-lib.
    //
    // The host answers for THIS run (`to`), so each service refuses once the run has settled rather
    // than serve a runtime the agent kept past its reply. Tracing goes quiet instead: a diagnostic
    // that refused would change execution.
    const host: FlcmHost = {
      getSession: (initialize) => agentSession ??= initialize(),
      traceNative: (stage, operation) => { if (!settled) trace(stage, operation); },
      // A finished runtime is refused in the preamble, before it asks (refuseIfRunFinished).
      callServer: (capability: string, payload: unknown) => callServer(to, capability, payload),
      runCancellation: () => cancelledRuns.cancellation(to),
      isRunFinished: () => settled,
      runStartedAt,
    };
    const built = (eval(preamble) as (host: FlcmHost) => typeof SandboxRuntime)(host);
    // Checked HERE, not in the finally that drains: a std-lib that cannot be drained must fail as a
    // run error the agent sees, never as a throw out of the finally — that would cost the run its
    // reply, and the frozen envelope promises one for every request.
    if (
      typeof built.mutationQueueIdle !== "function" ||
      typeof built.committedVerbCount !== "function" ||
      typeof built.projectForEgress !== "function"
    ) {
      throw new Error(
        "the flcm std-lib the server sent doesn't match this plugin — it lacks the mutation queue " +
          "or the read egress this host drives. Update the server (`npx figma-developer-mcp@latest`) " +
          "and the plugin, then restart.",
      );
    }
    runtime = built;
    const { flcm, session } = built;
    // Indirect eval gives agent code global scope, never this function's host/transport locals.
    const raw = await (0, eval)("(async function(flcm, session){ " + code + "\n })")(flcm, session);
    // Return-path node guard: a returned live node would otherwise collapse to
    // { id } and silently drop everything else. Make that loud instead of lossy.
    guardReturnValue(raw);
    result = safeSerialize(runtime.projectForEgress(raw, "result"));
    // Session capture is optional; its narrower data contract must not reject a valid wire result.
    try { session.last = raw; } catch { session.last = undefined; }
  } catch (err) {
    errorMessage = formatError(err);
  } finally {
    // Drain before anything else in here, and the order of the three is load-bearing:
    //   • BEFORE the console restore, so a queued verb's warnings still reach the agent's reply;
    //   • BEFORE settle(), which drops this run's cancellation — a CANCEL landing mid-drain must
    //     still refuse the verbs behind it (mutation-lock refuseIfCancelled);
    //   • BEFORE `settled`, or the run's own queued verbs would be refused as a stale runtime's.
    // Nothing else can wait for these writes: the agent has returned, and the reply is what it
    // screenshots against. A preamble that never evaluated leaves no queue to drain.
    if (runtime) landedAfterReturn = await runtime.mutationQueueIdle();
    // After the drain, so writes that landed after the agent's code returned count too. A committed
    // flcm verb is a change by construction; it is OR'd in because it is known synchronously,
    // while change events arrive in asynchronous batches (document-changes.ts). A "no" is only
    // provisional: the observer keeps watching past the reply and reports a late change on its own.
    documentChanged =
      ((await documentChanges?.changedSoFar()) ?? false) || (runtime?.committedVerbCount() ?? 0) > 0;
    if (documentChanged) documentChanges?.stop();
    else if (documentChanges) {
      documentChanges.watchLate(
        { onChange: () => runChanged(to), onSettled: () => runSettled(to) },
        lateChangeWindowMs,
      );
      lateChangeWatch = documentChanges;
    }
    trace("eval-end");
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    settled = true;
    cancelledRuns.settle(to);
  }
  if (landedAfterReturn > 0) {
    runtime!.warnings.add({ id: null, message:
      `${landedAfterReturn} write(s) finished after your code returned — flcm reserves a ` +
        `verb's slot the moment it is called, so an unawaited verb (or a sibling of one that ` +
        `rejected in Promise.all) still lands. This reply waited for them; await every verb to keep ` +
        `your result and the canvas in step.`,
    });
  }
  if (runtime) consoleLog.push(...runtime.warnings.summary());

  reply(to, { type: "EXECUTE_CODE_RESULT", result, console: consoleLog, errors: errorMessage, documentChanged });
}

/**
 * Exports a node as PNG and posts back exactly one of `{ id, image }` (a base64
 * string) or `{ id, errors }` — never both. With no target, snapshots the whole
 * current page. `scale` (already range-checked server-side) multiplies the export
 * resolution so the agent can inspect detail it can't resolve at 1x.
 *
 * The base64 encoding MUST happen here, not on the server: `exportAsync` returns a
 * Uint8Array, and the relay (ui.ts) JSON.stringifies every outbound frame — which turns a
 * raw Uint8Array into a useless `{"0":..,"1":..}` blob (the same un-JSON-able trap
 * safeSerialize guards against for nodes). QuickJS has no Buffer, so we use the
 * sandbox's own `figma.base64Encode` to get a clean string across the wire.
 */
async function screenshot(
  to: ReplyTo,
  target: ScreenshotTarget,
  options: CaptureOptions,
): Promise<void> {
  const approval = await settledApprovalOf(to.connKey);
  // Same dequeue refusal as executeCode: exporting for a run the server already reported dead is
  // wasted work whose reply nothing correlates.
  const cancelled = cancelledRuns.cancellation(to);
  if (cancelled) {
    cancelledRuns.settle(to);
    reply(to, {
      type: "SCREENSHOT_RESULT",
      errors: `flcm: ${CANCELLED_WHILE_QUEUED[cancelled]} — no screenshot was taken.`,
    });
    return;
  }
  if (!gateWrite(to, approval)) { cancelledRuns.settle(to); return; }
  beginRun(to);
  try {
    const node = await resolveScreenshotTarget(target);
    const bytes = await captureScreenshot(node, options, () => cancelledRuns.cancellation(to) !== null);
    reply(to, { type: "SCREENSHOT_RESULT", image: figma.base64Encode(bytes) });
  } catch (err) {
    reply(to, { type: "SCREENSHOT_RESULT", errors: formatError(err) });
  } finally {
    cancelledRuns.settle(to);
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
