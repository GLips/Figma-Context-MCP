/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The server↔plugin wire contract, declared once: the protocol version and its changelog, every frame
// each side may send, the parsers that admit them, and the numbers both processes reason against.
// The server's relay (src/commercial/plugin-bridge), the plugin host (code.ts), its relay iframe
// (ui.ts) and every test peer import it, so a wire word is a compile error on both sides or neither.
//
// LEAF-ONLY, and that is load-bearing: code.ts value-imports this file, and anything it imported would
// ride into the installed host bundle. ADR-0010 keeps the std-lib out of that bundle, so this file
// imports nothing — no preamble module, no zod, no figma typings. The preamble imports it too, which
// costs nothing: the preamble ships from the server, built from this same file.
//
// Parsing stays hand-rolled. JSON off a socket is untrusted however each end is typed, so the
// receiving side admits a frame through these parsers and handles the typed result, never the raw
// object. A field a frame doesn't need is dropped here, not carried.

// ---- Version ----

/**
 * The wire contract version: the envelope below plus the FlcmHost interface the host hands the
 * preamble (preamble/host.ts). Bump it on any change an installed plugin can't absorb; the server
 * refuses a plugin that reports any version but the one it was built with (version.ts).
 */
export const PROTOCOL_VERSION = 10;

// The changelog. Nothing has ever shipped at any version, so there is deliberately no compat path:
// the fix for skew is always a re-import, and the refusal names it.
/*
 * v2: mid-run image requests in the reverse direction, and the run-scoped CANCEL.
 * v3: EXECUTE_CODE carries the flcm std-lib; the plugin holds none of its own (ADR-0010).
 * v4: APPROVAL_STATUS polling, Reject, and connection-owned run states.
 * v5: read registration projects egress; getSession keeps preamble-owned data for one plugin run.
 * v6: FlcmHost.isRunFinished and the verb-queue drain; every CANCEL is answered by CANCEL_RESULT.
 * v7: FlcmHost.callServer and the opaque CHANNEL_REQUEST/CHANNEL_RESPONSE.
 * v8: writes are metered — documentChanged and RUN_CHANGED, the Authorizing User on SESSION_TOKEN,
 *     SESSION_INFO's Framelink origin, WRITE_ACCESS / WRITE_ACCESS_SIGN_IN.
 * v9: RUN_STATE carries `at`, and FlcmHost.runStartedAt, so the inactivity deadline counts from one
 *     instant on both sides.
 * v10: this module owns the wire. Every reply is typed (PING → PONG, GET_VERSION → VERSION, …) and
 *     parsed once at each seam. Read egress leaves the host: FlcmHost.registerRead is gone and the
 *     preamble's factory exports projectForEgress. FlcmHost.runCancellation() names why a run was
 *     cancelled, and revoking a session cancels its runs. EXECUTE_CODE carries the late-change window,
 *     and a clean late watch ends in RUN_SETTLED. NOTIFY carries {serverProtocol}, not text,
 *     and the server refuses a newer plugin as it does an older one.
 */

// ---- Transport ----

const PORT_BLOCK_BASE = 9876;
const PORT_BLOCK_COUNT = 16;
/**
 * The localhost ports a server may bind (the first free one) and the plugin dials (all of them), so N
 * concurrent sessions land on N ports the panel lists. Clear of common dev ports (3000, 5173, 8080,
 * 9222, 9229). plugin/manifest.json's devAllowedDomains must list every one as `ws://localhost:<port>`
 * — Figma has no port wildcard and rejects IP literals — and the contract harness pins that mirror.
 */
export const WS_PORT_BLOCK: readonly number[] = Array.from(
  { length: PORT_BLOCK_COUNT },
  (_, i) => PORT_BLOCK_BASE + i,
);

// ---- Timing both processes reason against ----

/** The server's inactivity deadline for a run. The preamble mirrors it on the run's own clock
 * (preamble/server-deadline.ts) to refuse verbs while a CANCEL is still queued behind the thread. */
export const RUN_INACTIVITY_DEADLINE_MS = 15_000;

/** How often a waiting call polls APPROVAL_STATUS. */
export const APPROVAL_POLL_MS = 750;
/** How long after its last poll a request still reads as waiting in the panel: four missed polls. */
export const APPROVAL_WAITING_GRACE_MS = 4 * APPROVAL_POLL_MS;

// ---- Limits enforced on one side and documented or pre-checked on the other ----

/** The largest screenshot export scale. The server rejects input past it; the plugin re-checks. */
export const MAX_SCREENSHOT_SCALE = 4;

/**
 * The most query survivors `flcm.find`'s predicate is offered before the call fails loud. A
 * predicate-only find makes every rendered node a candidate, so without a ceiling it would silently
 * churn a whole design. Deliberately high: if materialization is slow at this scale, fix the algorithm.
 */
export const FIND_MATERIALIZE_CAP = 5000;

// ---- Shared vocabulary ----

/**
 * What the plugin knew about a run the instant a CANCEL for it landed:
 *   • never-executed — still queued; the dequeue will skip it, canvas untouched.
 *   • was-running — executing, so verbs before the cancel already landed.
 *   • unknown — not tracked: it settled before the CANCEL arrived, or was never a run. The server
 *     also reads a CANCEL_RESULT that never came as unknown.
 */
export const CANCEL_DISPOSITIONS = ["never-executed", "was-running", "unknown"] as const;
export type CancelDisposition = (typeof CANCEL_DISPOSITIONS)[number];

export const RUN_PHASES = ["queued", "running"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

/** The host stages RUN_TRACE may report. Diagnostic only; the server drops any other word. */
export const HOST_TRACE_STAGES = [
  "eval-start",
  "eval-end",
  "native-start",
  "native-end",
  "native-error",
] as const;
export type HostTraceStage = (typeof HOST_TRACE_STAGES)[number];

/** The native Figma operations whose waits the preamble traces. */
export const NATIVE_OPERATIONS = ["page-create", "page-switch", "font-load", "font-list"] as const;
export type NativeOperation = (typeof NATIVE_OPERATIONS)[number];

/**
 * The Authorizing User: the human who clicked Allow for a session, as `figma.currentUser` reported
 * them then. Every write the session makes is attributed to `figmaUserId`; `name` is display-only.
 */
export interface AuthorizingUser {
  figmaUserId: string;
  name: string;
}

/** An Authorizing User off untrusted JSON; anything without a Figma user id is none. */
export function parseAuthorizingUser(value: unknown): AuthorizingUser | null {
  if (!isRecord(value)) return null;
  const { figmaUserId, name } = value;
  if (typeof figmaUserId !== "string" || figmaUserId.length === 0) return null;
  return { figmaUserId, name: typeof name === "string" ? name : "" };
}

/** What the plugin panel shows about write access, pushed from the server. */
export type WriteAccessNotice =
  | { kind: "allowance-exhausted"; allowance: number; resetsAt: string; signedIn: boolean }
  | { kind: "sign-in-pending"; userCode: string; verificationUri: string }
  // `seat: null` — signed in, but the seat check that followed didn't get an answer yet.
  | { kind: "signed-in"; seat: boolean | null }
  | { kind: "sign-in-failed"; message: string };

function parseWriteAccessNotice(value: unknown): WriteAccessNotice | null {
  if (!isRecord(value)) return null;
  const n = value;
  if (n.kind === "allowance-exhausted" && typeof n.allowance === "number" && typeof n.resetsAt === "string")
    return { kind: n.kind, allowance: n.allowance, resetsAt: n.resetsAt, signedIn: n.signedIn === true };
  if (n.kind === "sign-in-pending" && typeof n.userCode === "string" && typeof n.verificationUri === "string")
    return { kind: n.kind, userCode: n.userCode, verificationUri: n.verificationUri };
  if (n.kind === "signed-in") return { kind: n.kind, seat: typeof n.seat === "boolean" ? n.seat : null };
  if (n.kind === "sign-in-failed" && typeof n.message === "string") return { kind: n.kind, message: n.message };
  return null;
}

// ---- Server → plugin ----

/**
 * Every request the server sends, each answered by exactly one reply carrying its `id` (ReplyFor).
 * Closed, so an EXECUTE_CODE without its std-lib is a compile error on the sending side. `id` is not
 * part of the payload: the bridge mints it and appends it last, so no field can overwrite it.
 */
export type ServerRequest =
  | { type: "PING"; payload: string }
  | { type: "GET_VERSION" }
  | { type: "APPROVAL_STATUS" }
  // Sent only to a plugin whose protocol isn't the server's. The plugin words the toast itself, so a peer
  // can never put its own text in front of the human.
  | { type: "NOTIFY"; serverProtocol: number }
  | {
      type: "SESSION_INFO";
      identity: string;
      // Null with no connection, and until the human's first Allow mints a token, respectively.
      pairingCode: string | null;
      sessionToken: string | null;
      // The claim the plugin gave this session's last approval request, so an Allow given while the
      // session was disconnected can be handed over now.
      sessionClaim: string | null;
      // The origin of FRAMELINK_API_URL: the plugin opens sign-in pages on this origin only.
      framelinkOrigin: string;
    }
  | {
      type: "EXECUTE_CODE";
      code: string;
      preamble: string;
      // How long past a "no change" reply the plugin keeps watching for a change it would charge to
      // this run. The server owns the number (write-access.ts); the plugin only obeys it.
      lateChangeWindowMs: number;
    }
  // What the panel shows about write access. Acked, never acted on.
  | { type: "WRITE_ACCESS"; notice: WriteAccessNotice }
  | { type: "SCREENSHOT"; nodeId?: string; key?: string; scale?: number; context?: boolean; margin?: number };

export type ServerRequestType = ServerRequest["type"];

/**
 * The requests a plugin of unknown vintage may be sent before its version is known — the handshake
 * can't wait on its own answer. Everything else holds for the verdict (bridge.ts). Deny-by-default:
 * adding a type here asserts it is safe to send to an unsupported plugin, so their shapes must not
 * change in a way an older plugin misreads.
 */
export const HANDSHAKE_REQUEST_TYPES = ["PING", "GET_VERSION", "SESSION_INFO", "NOTIFY"] as const satisfies readonly ServerRequestType[];

/** The requests the plugin tracks as runs: queued, then running, and answerable by CANCEL_RESULT. */
export const RUN_REQUEST_TYPES = ["EXECUTE_CODE", "SCREENSHOT"] as const satisfies readonly ServerRequestType[];

/** The server's one-way frames: neither is a request, and neither is answered by a reply. */
export type ServerOneWay =
  // The server gave up on a run: run-scoped and id-less. Answered by the CANCEL_RESULT event.
  | { type: "CANCEL"; runId: string }
  // The answer to a plugin-issued CHANNEL_REQUEST, in the PLUGIN's id namespace. Payload and error
  // cross opaquely: a capability can change its shapes with no plugin release.
  | { type: "CHANNEL_RESPONSE"; id: string; ok: true; payload: unknown }
  | { type: "CHANNEL_RESPONSE"; id: string; ok: false; error: unknown };

export type ServerFrame = (ServerRequest & { id: string }) | ServerOneWay;

/**
 * Admit one server frame, or null when it isn't one this plugin understands — an unknown type, or a
 * known one missing what it needs. An id-carrying null is still owed an ERROR reply (code.ts).
 */
export function parseServerFrame(value: unknown): ServerFrame | null {
  if (!isRecord(value)) return null;
  const f = value;
  if (f.type === "CANCEL") return typeof f.runId === "string" ? { type: "CANCEL", runId: f.runId } : null;
  if (typeof f.id !== "string") return null;
  const id = f.id;
  switch (f.type) {
    case "CHANNEL_RESPONSE":
      return f.ok === true
        ? { type: "CHANNEL_RESPONSE", id, ok: true, payload: f.payload }
        : { type: "CHANNEL_RESPONSE", id, ok: false, error: f.error };
    case "PING":
      return { type: "PING", id, payload: typeof f.payload === "string" ? f.payload : "" };
    case "GET_VERSION":
    case "APPROVAL_STATUS":
      return { type: f.type, id };
    case "NOTIFY":
      return typeof f.serverProtocol === "number"
        ? { type: "NOTIFY", id, serverProtocol: f.serverProtocol }
        : null;
    case "SESSION_INFO":
      if (typeof f.identity !== "string" || typeof f.framelinkOrigin !== "string") return null;
      return {
        type: "SESSION_INFO",
        id,
        identity: f.identity,
        pairingCode: stringOrNull(f.pairingCode),
        sessionToken: stringOrNull(f.sessionToken),
        sessionClaim: stringOrNull(f.sessionClaim),
        framelinkOrigin: f.framelinkOrigin,
      };
    case "EXECUTE_CODE":
      // No std-lib or no window means a server that predates this plugin: refused, never defaulted.
      if (typeof f.preamble !== "string" || !f.preamble) return null;
      if (typeof f.lateChangeWindowMs !== "number" || !(f.lateChangeWindowMs >= 0)) return null;
      return {
        type: "EXECUTE_CODE",
        id,
        code: typeof f.code === "string" ? f.code : "",
        preamble: f.preamble,
        lateChangeWindowMs: f.lateChangeWindowMs,
      };
    case "WRITE_ACCESS": {
      const notice = parseWriteAccessNotice(f.notice);
      return notice ? { type: "WRITE_ACCESS", id, notice } : null;
    }
    case "SCREENSHOT":
      return {
        type: "SCREENSHOT",
        id,
        nodeId: typeof f.nodeId === "string" ? f.nodeId : undefined,
        key: typeof f.key === "string" ? f.key : undefined,
        scale: typeof f.scale === "number" ? f.scale : undefined,
        context: f.context === true,
        margin: typeof f.margin === "number" ? f.margin : undefined,
      };
    default:
      return null;
  }
}

// ---- Plugin → server: replies ----

export type PendingApprovalReply = { type: "PENDING_APPROVAL" };
export type ApprovalStatusReply =
  | { type: "APPROVAL_GRANTED" }
  | PendingApprovalReply
  | { type: "APPROVAL_REJECTED" };

/**
 * What a run reported. `result` is absent when the code returned nothing or threw (undefined isn't
 * JSON). `documentChanged` is whether the document changed while the run executed, writes that landed
 * after the code returned included; false is provisional until RUN_SETTLED, since a change Figma
 * reports later arrives as RUN_CHANGED. It is the server's to meter, never the agent's to read.
 */
export type ExecuteCodeResult = {
  type: "EXECUTE_CODE_RESULT";
  result?: unknown;
  console: string[];
  errors: string | null;
  documentChanged: boolean;
};

/** Exactly one of a base64 PNG or the failure. */
export type ScreenshotResult = { type: "SCREENSHOT_RESULT"; image: string } | { type: "SCREENSHOT_RESULT"; errors: string };

/** A plugin's versions. Both optional: a plugin that can't name them reads as the protocol floor. */
export type VersionReply = { type: "VERSION"; pluginVersion?: string; protocolVersion?: number };

/** The one reply each request is owed, by request type. An ERROR may stand in for any of them. */
export interface ReplyByRequest {
  PING: { type: "PONG"; echo: string };
  GET_VERSION: VersionReply;
  APPROVAL_STATUS: ApprovalStatusReply;
  NOTIFY: { type: "NOTIFY_RESULT" };
  SESSION_INFO: { type: "SESSION_INFO_ACK" };
  // Write requests pass the consent gate first: an unapproved session is answered PENDING_APPROVAL.
  EXECUTE_CODE: ExecuteCodeResult | PendingApprovalReply;
  WRITE_ACCESS: { type: "WRITE_ACCESS_ACK" };
  SCREENSHOT: ScreenshotResult | PendingApprovalReply;
}
export type ReplyFor<T extends ServerRequestType> = ReplyByRequest[T];

/**
 * The reply to any request the plugin can't serve — an unknown type, or a malformed one — so a newer
 * server against an older plugin fails fast and readably instead of at its deadline.
 */
export type ErrorReply = { type: "ERROR"; error: string };

export type PluginReply = ReplyByRequest[ServerRequestType] | ErrorReply;

/**
 * Admit the reply to a request of `requestType`, or null when it isn't the shape that request is
 * owed. An ERROR is admitted for any request.
 */
export function parseReply<T extends ServerRequestType>(requestType: T, value: unknown): ReplyFor<T> | ErrorReply | null {
  const reply = parseAnyReply(requestType, value);
  return reply as ReplyFor<T> | ErrorReply | null;
}

function parseAnyReply(requestType: ServerRequestType, value: unknown): PluginReply | null {
  if (!isRecord(value)) return null;
  const f = value;
  if (f.type === "ERROR") return typeof f.error === "string" ? { type: "ERROR", error: f.error } : null;
  switch (requestType) {
    case "PING":
      return f.type === "PONG" ? { type: "PONG", echo: typeof f.echo === "string" ? f.echo : "" } : null;
    case "GET_VERSION":
      if (f.type !== "VERSION") return null;
      return {
        type: "VERSION",
        pluginVersion: typeof f.pluginVersion === "string" ? f.pluginVersion : undefined,
        protocolVersion: typeof f.protocolVersion === "number" ? f.protocolVersion : undefined,
      };
    case "APPROVAL_STATUS":
      return f.type === "APPROVAL_GRANTED" || f.type === "PENDING_APPROVAL" || f.type === "APPROVAL_REJECTED"
        ? { type: f.type }
        : null;
    case "NOTIFY":
      return f.type === "NOTIFY_RESULT" ? { type: "NOTIFY_RESULT" } : null;
    case "SESSION_INFO":
      return f.type === "SESSION_INFO_ACK" ? { type: "SESSION_INFO_ACK" } : null;
    case "WRITE_ACCESS":
      return f.type === "WRITE_ACCESS_ACK" ? { type: "WRITE_ACCESS_ACK" } : null;
    case "EXECUTE_CODE":
      if (f.type === "PENDING_APPROVAL") return { type: "PENDING_APPROVAL" };
      return parseExecuteCodeResult(f);
    case "SCREENSHOT":
      if (f.type === "PENDING_APPROVAL") return { type: "PENDING_APPROVAL" };
      if (f.type !== "SCREENSHOT_RESULT") return null;
      if (typeof f.image === "string" && f.errors === undefined) return { type: "SCREENSHOT_RESULT", image: f.image };
      if (typeof f.errors === "string" && f.image === undefined) return { type: "SCREENSHOT_RESULT", errors: f.errors };
      return null;
  }
}

/** An EXECUTE_CODE_RESULT, or null. Also read off a reply whose caller already gave up (bridge.ts). */
export function parseExecuteCodeResult(value: unknown): ExecuteCodeResult | null {
  if (!isRecord(value)) return null;
  const f = value;
  if (f.type !== "EXECUTE_CODE_RESULT") return null;
  if (!Array.isArray(f.console) || !f.console.every((line) => typeof line === "string")) return null;
  if (f.errors !== null && typeof f.errors !== "string") return null;
  if (typeof f.documentChanged !== "boolean") return null;
  const result: ExecuteCodeResult = {
    type: "EXECUTE_CODE_RESULT",
    console: f.console as string[],
    errors: f.errors,
    documentChanged: f.documentChanged,
  };
  if ("result" in f) result.result = f.result;
  return result;
}

// ---- Plugin → server: events ----

/** Frames the plugin sends unprompted. None is a reply; CHANNEL_REQUEST carries the plugin's own id. */
export type PluginEvent =
  // The Allow handover: the token this session's approval keys on, and who clicked Allow.
  | { type: "SESSION_TOKEN"; sessionToken: string; authorizingUser: AuthorizingUser | null }
  // The plugin's claim on this session's pending approval request, sent only to the socket that asked.
  | { type: "SESSION_CLAIM"; sessionClaim: string }
  // The human revoked this session in the panel: forget the token.
  | { type: "REVOKE_SESSION" }
  // The human clicked the panel's sign-in button.
  | { type: "WRITE_ACCESS_SIGN_IN" }
  // A mid-run call to a server capability, tagged with the run it serves.
  | { type: "CHANNEL_REQUEST"; id: string; runId: string; capability: string; payload: unknown }
  // A run entered a phase; `at` is the plugin's stamp for when (the frame leaves only once the
  // plugin thread goes idle, so arrival can be seconds late).
  | { type: "RUN_STATE"; runId: string; phase: RunPhase; at: number }
  | { type: "RUN_TRACE"; runId: string; stage: HostTraceStage; operation?: NativeOperation; elapsedMs: number }
  // The answer to a CANCEL.
  | { type: "CANCEL_RESULT"; runId: string; disposition: CancelDisposition }
  // The document changed after the run's reply said it hadn't. At most one per run.
  | { type: "RUN_CHANGED"; runId: string }
  // The run's late-change watch closed with no change: nothing more will be reported for it. Never
  // sent for a run whose reply said documentChanged, nor alongside a RUN_CHANGED.
  | { type: "RUN_SETTLED"; runId: string };

export type PluginEventType = PluginEvent["type"];

/** Admit an unsolicited plugin frame, or null. */
export function parsePluginEvent(value: unknown): PluginEvent | null {
  if (!isRecord(value)) return null;
  const f = value;
  switch (f.type) {
    case "SESSION_TOKEN":
      return isPluginMintedToken(f.sessionToken)
        ? { type: "SESSION_TOKEN", sessionToken: f.sessionToken, authorizingUser: parseAuthorizingUser(f.authorizingUser) }
        : null;
    case "SESSION_CLAIM":
      return isPluginMintedToken(f.sessionClaim) ? { type: "SESSION_CLAIM", sessionClaim: f.sessionClaim } : null;
    case "REVOKE_SESSION":
    case "WRITE_ACCESS_SIGN_IN":
      return { type: f.type };
    case "CHANNEL_REQUEST":
      return typeof f.id === "string" && typeof f.runId === "string" && typeof f.capability === "string"
        ? { type: "CHANNEL_REQUEST", id: f.id, runId: f.runId, capability: f.capability, payload: f.payload }
        : null;
    case "RUN_STATE":
      return typeof f.runId === "string" && isOneOf(RUN_PHASES, f.phase) && typeof f.at === "number" && Number.isFinite(f.at)
        ? { type: "RUN_STATE", runId: f.runId, phase: f.phase, at: f.at }
        : null;
    case "RUN_TRACE": {
      if (typeof f.runId !== "string" || !isOneOf(HOST_TRACE_STAGES, f.stage)) return null;
      if (typeof f.elapsedMs !== "number" || !(f.elapsedMs >= 0 && f.elapsedMs <= 3_600_000)) return null;
      const event: PluginEvent = { type: "RUN_TRACE", runId: f.runId, stage: f.stage, elapsedMs: f.elapsedMs };
      if (isOneOf(NATIVE_OPERATIONS, f.operation)) event.operation = f.operation;
      return event;
    }
    case "CANCEL_RESULT":
      // An unrecognized word reads as "the plugin cannot say", which is what `unknown` means.
      return typeof f.runId === "string"
        ? { type: "CANCEL_RESULT", runId: f.runId, disposition: isOneOf(CANCEL_DISPOSITIONS, f.disposition) ? f.disposition : "unknown" }
        : null;
    case "RUN_CHANGED":
    case "RUN_SETTLED":
      return typeof f.runId === "string" ? { type: f.type, runId: f.runId } : null;
    default:
      return null;
  }
}

/**
 * A plausible plugin-minted session token or claim (code.ts mintToken: base-36, ~30 characters).
 * They arrive off the socket and the server writes them to disk, so their shape is bounded here.
 */
function isPluginMintedToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-z]{16,64}$/.test(value);
}

/** Everything the plugin sends: a reply, carrying its request's id, or an event. */
export type PluginFrame = (PluginReply & { id: string }) | PluginEvent;

// ---- Narrowing helpers ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(words: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (words as readonly string[]).includes(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
