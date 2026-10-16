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
export const PROTOCOL_VERSION = 12;

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
 * v11: links are paired and authenticated. HELLO replaces GET_VERSION, NOTIFY and PING; AUTHENTICATE
 *     challenges for the installation credential and carries the owner; PAIRING_OFFER, PAIRING_CLOSED
 *     and PAIR_CONFIRMED provision it. SESSION_INFO loses its pairing code and reaches authenticated
 *     links only; SESSION_TOKEN loses its Authorizing User.
 * v12: documents and grants. INTRODUCE replaces SESSION_INFO and answers the plugin's document claim;
 *     PROVE_DOCUMENT and PROOF_SETTLED prove which file a link is in; GRANT_STATUS replaces
 *     APPROVAL_STATUS, and the plugin alone stores grants per installation, owner, project and
 *     document. EXECUTE_CODE and SCREENSHOT name their document and may be answered NOT_GRANTED.
 *     SESSION_TOKEN, SESSION_CLAIM and REVOKE_SESSION are gone; GRANT_CHANGED carries grant changes
 *     between plugin instances, and DOCUMENT_CLAIMED a file key for a server to prove: a link the
 *     human pasted, or the file another server just proved.
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

/** How often a call waiting on the human polls GRANT_STATUS. */
export const GRANT_POLL_MS = 750;
/** How long after its last poll a grant prompt still reads as waiting in the panel: four missed polls. */
export const GRANT_PROMPT_GRACE_MS = 4 * GRANT_POLL_MS;

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
 * The owner of a plugin link: the Figma user signed in to the plugin (`figma.currentUser`), reported
 * when the link authenticates. Writes through the link are charged to `figmaUserId`; `name` is
 * display-only.
 */
export interface PluginOwner {
  figmaUserId: string;
  name: string;
}

/** A link owner off untrusted JSON; anything without a Figma user id is none. */
export function parsePluginOwner(value: unknown): PluginOwner | null {
  if (!isRecord(value)) return null;
  const { figmaUserId, name } = value;
  if (typeof figmaUserId !== "string" || figmaUserId.length === 0) return null;
  return { figmaUserId, name: typeof name === "string" ? name : "" };
}

// ---- Link setup: hello, authentication, pairing ----

/**
 * What a link proof signs, beside the credential id and the server's nonce. Versioned so a proof
 * minted for one scheme can never verify under another.
 */
export const LINK_PROOF_CONTEXT = "framelink-plugin-link-v1";

/** The message a link proof is an HMAC-SHA256 of, keyed by the credential's secret. */
export function linkProofMessage(credentialId: string, nonce: string): string {
  return `${LINK_PROOF_CONTEXT}:${credentialId}:${nonce}`;
}

// Credential ids, secrets and nonces are server-minted base64url. Bounded here because the plugin
// stores the id as part of a clientStorage key and both sides hash the rest.
const LINK_TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const LINK_PROOF = /^[0-9a-f]{64}$/;

/**
 * A pairing code: 8 Crockford base32 characters split by a dash (`7QKM-X2D9`), so it can't be
 * mistaken for a session handle. It names one pairing attempt and is never a credential.
 */
export const PAIRING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

// ---- Documents and grants ----

/** Figma file keys are alphanumeric. Bounded here because the plugin puts one in storage keys. */
const WIRE_FILE_KEY = /^[A-Za-z0-9]{1,128}$/;

export function isWireFileKey(value: unknown): value is string {
  return typeof value === "string" && WIRE_FILE_KEY.test(value);
}

// The longest project path either side accepts. A project is a directory path, never free text.
const MAX_PROJECT_LENGTH = 4096;

/**
 * Where a document proof lives: the file root's shared plugin data, which the server reads back over
 * REST (`plugin_data=shared`). Each nonce is its own key (`DOCUMENT_PROOF_KEY_PREFIX` + nonce), so
 * two plugin instances in one file proving at once never overwrite each other's. `DOCUMENT_CLAIM_KEY`
 * holds the file key a proof established, offered again by later plugin runs. A duplicated file
 * carries the claim too, which is why a claim is only ever a claim.
 */
export const DOCUMENT_DATA_NAMESPACE = "framelink";
export const DOCUMENT_PROOF_KEY_PREFIX = "proof:";
export const DOCUMENT_CLAIM_KEY = "fileKey";

/** The proof nonces a file root's shared plugin data holds. Off a REST read, so untrusted. */
export function documentProofNonces(sharedPluginData: unknown): string[] {
  if (!isRecord(sharedPluginData)) return [];
  const ours = sharedPluginData[DOCUMENT_DATA_NAMESPACE];
  if (!isRecord(ours)) return [];
  return Object.keys(ours)
    .filter((key) => key.startsWith(DOCUMENT_PROOF_KEY_PREFIX) && ours[key])
    .map((key) => key.slice(DOCUMENT_PROOF_KEY_PREFIX.length))
    .filter(isLinkToken);
}

/** How a document proof ended, as the server tells the link it challenged. */
export type ProofOutcome =
  | { kind: "proven"; fileKey: string; fileName: string }
  // The link claimed `fileKey` (or its human pasted it), and the nonce never showed up there.
  | { kind: "refuted"; fileKey: string }
  // Nothing learned: the link wasn't in the file a call named, or the file couldn't be read.
  | { kind: "abandoned" };

/** What a GRANT_STATUS poll asks the panel to show while the answer isn't `granted`. */
export const GRANT_PROMPTS = ["none", "grant", "select"] as const;
export type GrantPrompt = (typeof GRANT_PROMPTS)[number];

/**
 * A plugin's answer to GRANT_STATUS:
 *   • granted — this project may edit the named document; for `select`, the human also picked it.
 *   • absent — no grant, and nothing was asked (`none`).
 *   • pending — the prompt is showing.
 *   • denied — the human said no to this server.
 *   • unproven — the link isn't proven to be in the named document, or none was named.
 */
export const GRANT_STATES = ["granted", "absent", "pending", "denied", "unproven"] as const;
export type GrantState = (typeof GRANT_STATES)[number];

/** Why a run was refused before anything executed: no grant, or not the document it names. */
export const NOT_GRANTED_REASONS = ["no-grant", "other-document"] as const;
export type NotGrantedReason = (typeof NOT_GRANTED_REASONS)[number];

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
  // FROZEN: every plugin build, past and future, must parse this frame and answer HELLO_RESULT, so a
  // mismatched build is still told to re-import. The plugin words that notice itself from the number.
  | { type: "HELLO"; serverProtocol: number }
  // Prove possession of the credential `credentialId` names, by signing `nonce` (linkProofMessage).
  | { type: "AUTHENTICATE"; credentialId: string; nonce: string }
  // Show this code in the panel until the attempt closes or expires. Acked, never acted on.
  | { type: "PAIRING_OFFER"; code: string; expiresInMs: number }
  | { type: "PAIRING_CLOSED"; code: string }
  // The human confirmed `code`: store this installation credential. Sent only to the link showing it.
  | { type: "PAIR_CONFIRMED"; code: string; credentialId: string; secret: string }
  // Who this server is: the project grants key on (its canonical working directory), and the origin
  // of FRAMELINK_API_URL, the only origin the plugin opens sign-in pages on. Answered with the claim.
  | { type: "INTRODUCE"; project: string; framelinkOrigin: string }
  // Write `nonce` into the file root's proofs, for the server to find over REST.
  | { type: "PROVE_DOCUMENT"; nonce: string }
  | { type: "PROOF_SETTLED"; nonce: string; outcome: ProofOutcome }
  // `fileKey` is the document the server proved this link to be in, or null when it proved none.
  | { type: "GRANT_STATUS"; fileKey: string | null; prompt: GrantPrompt }
  // The call this connection's prompt served is over: stop showing it.
  | { type: "GRANT_PROMPT_CLOSED" }
  // Another plugin instance changed this grant: re-read it. A hint; storage is the record.
  | { type: "GRANT_CHANGED_ELSEWHERE"; project: string; fileKey: string }
  | {
      type: "EXECUTE_CODE";
      code: string;
      preamble: string;
      // The document this run is for. The plugin runs it only there, and only under a grant.
      fileKey: string;
      // How long past a "no change" reply the plugin keeps watching for a change it would charge to
      // this run. The server owns the number (write-access.ts); the plugin only obeys it.
      lateChangeWindowMs: number;
    }
  // What the panel shows about write access. Acked, never acted on.
  | { type: "WRITE_ACCESS"; notice: WriteAccessNotice }
  | {
      type: "SCREENSHOT";
      fileKey: string;
      nodeId?: string;
      key?: string;
      scale?: number;
      context?: boolean;
      margin?: number;
    };

export type ServerRequestType = ServerRequest["type"];

/**
 * The only requests a link is sent before it authenticates (bridge.ts), and the only ones a
 * mismatched build is sent at all is the first. Deny-by-default: adding a type here asserts it is
 * safe to send to a page posing as the plugin, which is anyone who can open a socket with `Origin: null`.
 */
export const LINK_SETUP_REQUEST_TYPES = [
  "HELLO",
  "AUTHENTICATE",
  "PAIRING_OFFER",
  "PAIRING_CLOSED",
  "PAIR_CONFIRMED",
] as const satisfies readonly ServerRequestType[];

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
    case "HELLO":
      return typeof f.serverProtocol === "number" ? { type: "HELLO", id, serverProtocol: f.serverProtocol } : null;
    case "AUTHENTICATE":
      return isLinkToken(f.credentialId) && isLinkToken(f.nonce)
        ? { type: "AUTHENTICATE", id, credentialId: f.credentialId, nonce: f.nonce }
        : null;
    case "PAIRING_OFFER":
      return isPairingCode(f.code) && typeof f.expiresInMs === "number" && f.expiresInMs > 0
        ? { type: "PAIRING_OFFER", id, code: f.code, expiresInMs: f.expiresInMs }
        : null;
    case "PAIRING_CLOSED":
      return isPairingCode(f.code) ? { type: "PAIRING_CLOSED", id, code: f.code } : null;
    case "PAIR_CONFIRMED":
      return isPairingCode(f.code) && isLinkToken(f.credentialId) && isLinkToken(f.secret)
        ? { type: "PAIR_CONFIRMED", id, code: f.code, credentialId: f.credentialId, secret: f.secret }
        : null;
    case "INTRODUCE":
      return isProject(f.project) && typeof f.framelinkOrigin === "string"
        ? { type: "INTRODUCE", id, project: f.project, framelinkOrigin: f.framelinkOrigin }
        : null;
    case "PROVE_DOCUMENT":
      return isLinkToken(f.nonce) ? { type: "PROVE_DOCUMENT", id, nonce: f.nonce } : null;
    case "PROOF_SETTLED": {
      const outcome = parseProofOutcome(f.outcome);
      return isLinkToken(f.nonce) && outcome ? { type: "PROOF_SETTLED", id, nonce: f.nonce, outcome } : null;
    }
    case "GRANT_STATUS":
      return (f.fileKey === null || isWireFileKey(f.fileKey)) && isOneOf(GRANT_PROMPTS, f.prompt)
        ? { type: "GRANT_STATUS", id, fileKey: f.fileKey, prompt: f.prompt }
        : null;
    case "GRANT_PROMPT_CLOSED":
      return { type: f.type, id };
    case "GRANT_CHANGED_ELSEWHERE":
      return isProject(f.project) && isWireFileKey(f.fileKey)
        ? { type: "GRANT_CHANGED_ELSEWHERE", id, project: f.project, fileKey: f.fileKey }
        : null;
    case "EXECUTE_CODE":
      // No std-lib, window or document means a server that predates this plugin: refused, never
      // defaulted.
      if (typeof f.preamble !== "string" || !f.preamble) return null;
      if (typeof f.lateChangeWindowMs !== "number" || !(f.lateChangeWindowMs >= 0)) return null;
      if (!isWireFileKey(f.fileKey)) return null;
      return {
        type: "EXECUTE_CODE",
        id,
        code: typeof f.code === "string" ? f.code : "",
        preamble: f.preamble,
        fileKey: f.fileKey,
        lateChangeWindowMs: f.lateChangeWindowMs,
      };
    case "WRITE_ACCESS": {
      const notice = parseWriteAccessNotice(f.notice);
      return notice ? { type: "WRITE_ACCESS", id, notice } : null;
    }
    case "SCREENSHOT":
      if (!isWireFileKey(f.fileKey)) return null;
      return {
        type: "SCREENSHOT",
        id,
        fileKey: f.fileKey,
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

/** A run refused before anything executed. Nothing about the canvas changed. */
export type NotGrantedReply = { type: "NOT_GRANTED"; reason: NotGrantedReason };

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

/** FROZEN, like HELLO. Both optional: a plugin that can't name them reads as the protocol floor. */
export type HelloReply = { type: "HELLO_RESULT"; pluginVersion?: string; protocolVersion?: number };

/** The answer to AUTHENTICATE: a proof under the named credential, or that this plugin holds none. */
export type AuthenticateReply =
  | { type: "LINK_PROOF"; proof: string; owner: PluginOwner | null }
  | { type: "LINK_UNPAIRED" };

/** The one reply each request is owed, by request type. An ERROR may stand in for any of them. */
export interface ReplyByRequest {
  HELLO: HelloReply;
  AUTHENTICATE: AuthenticateReply;
  PAIRING_OFFER: { type: "PAIRING_OFFER_ACK" };
  PAIRING_CLOSED: { type: "PAIRING_CLOSED_ACK" };
  PAIR_CONFIRMED: { type: "CREDENTIAL_STORED" };
  // `claim` is the file key this file's root says a past proof established, or null.
  INTRODUCE: { type: "INTRODUCED"; claim: string | null };
  PROVE_DOCUMENT: { type: "PROOF_WRITTEN" };
  PROOF_SETTLED: { type: "PROOF_SETTLED_ACK" };
  GRANT_STATUS: { type: "GRANT"; state: GrantState };
  GRANT_PROMPT_CLOSED: { type: "GRANT_PROMPT_CLOSED_ACK" };
  GRANT_CHANGED_ELSEWHERE: { type: "GRANT_CHANGED_ELSEWHERE_ACK" };
  // Runs pass the grant check first, on arrival and again at dequeue.
  EXECUTE_CODE: ExecuteCodeResult | NotGrantedReply;
  WRITE_ACCESS: { type: "WRITE_ACCESS_ACK" };
  SCREENSHOT: ScreenshotResult | NotGrantedReply;
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
    case "HELLO":
      if (f.type !== "HELLO_RESULT") return null;
      return {
        type: "HELLO_RESULT",
        pluginVersion: typeof f.pluginVersion === "string" ? f.pluginVersion : undefined,
        protocolVersion: typeof f.protocolVersion === "number" ? f.protocolVersion : undefined,
      };
    case "AUTHENTICATE":
      if (f.type === "LINK_UNPAIRED") return { type: "LINK_UNPAIRED" };
      return f.type === "LINK_PROOF" && typeof f.proof === "string" && LINK_PROOF.test(f.proof)
        ? { type: "LINK_PROOF", proof: f.proof, owner: parsePluginOwner(f.owner) }
        : null;
    case "PAIRING_OFFER":
      return f.type === "PAIRING_OFFER_ACK" ? { type: "PAIRING_OFFER_ACK" } : null;
    case "PAIRING_CLOSED":
      return f.type === "PAIRING_CLOSED_ACK" ? { type: "PAIRING_CLOSED_ACK" } : null;
    case "PAIR_CONFIRMED":
      return f.type === "CREDENTIAL_STORED" ? { type: "CREDENTIAL_STORED" } : null;
    case "INTRODUCE":
      return f.type === "INTRODUCED" && (f.claim === null || isWireFileKey(f.claim))
        ? { type: "INTRODUCED", claim: f.claim }
        : null;
    case "PROVE_DOCUMENT":
      return f.type === "PROOF_WRITTEN" ? { type: "PROOF_WRITTEN" } : null;
    case "PROOF_SETTLED":
      return f.type === "PROOF_SETTLED_ACK" ? { type: "PROOF_SETTLED_ACK" } : null;
    case "GRANT_STATUS":
      return f.type === "GRANT" && isOneOf(GRANT_STATES, f.state) ? { type: "GRANT", state: f.state } : null;
    case "GRANT_PROMPT_CLOSED":
      return f.type === "GRANT_PROMPT_CLOSED_ACK" ? { type: "GRANT_PROMPT_CLOSED_ACK" } : null;
    case "GRANT_CHANGED_ELSEWHERE":
      return f.type === "GRANT_CHANGED_ELSEWHERE_ACK" ? { type: "GRANT_CHANGED_ELSEWHERE_ACK" } : null;
    case "WRITE_ACCESS":
      return f.type === "WRITE_ACCESS_ACK" ? { type: "WRITE_ACCESS_ACK" } : null;
    case "EXECUTE_CODE":
      return parseNotGranted(f) ?? parseExecuteCodeResult(f);
    case "SCREENSHOT":
      if (f.type === "NOT_GRANTED") return parseNotGranted(f);
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
  // This plugin instance granted or revoked `project` on `fileKey`. The server passes it on to its
  // other links, so instances of the plugin with that document open re-read the grant.
  | { type: "GRANT_CHANGED"; project: string; fileKey: string; granted: boolean }
  // A file this plugin may be in, for the server to prove — never proof itself: a link the human
  // pasted, or the file another server just proved.
  | { type: "DOCUMENT_CLAIMED"; fileKey: string }
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
    case "GRANT_CHANGED":
      return isProject(f.project) && isWireFileKey(f.fileKey) && typeof f.granted === "boolean"
        ? { type: "GRANT_CHANGED", project: f.project, fileKey: f.fileKey, granted: f.granted }
        : null;
    case "DOCUMENT_CLAIMED":
      return isWireFileKey(f.fileKey) ? { type: "DOCUMENT_CLAIMED", fileKey: f.fileKey } : null;
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

/** Everything the plugin sends: a reply, carrying its request's id, or an event. */
export type PluginFrame = (PluginReply & { id: string }) | PluginEvent;

// ---- Narrowing helpers ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(words: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (words as readonly string[]).includes(value);
}

function isLinkToken(value: unknown): value is string {
  return typeof value === "string" && LINK_TOKEN.test(value);
}

function isPairingCode(value: unknown): value is string {
  return typeof value === "string" && PAIRING_CODE_PATTERN.test(value);
}

function isProject(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PROJECT_LENGTH;
}

function parseProofOutcome(value: unknown): ProofOutcome | null {
  if (!isRecord(value)) return null;
  if (value.kind === "abandoned") return { kind: "abandoned" };
  if (!isWireFileKey(value.fileKey)) return null;
  if (value.kind === "refuted") return { kind: "refuted", fileKey: value.fileKey };
  return value.kind === "proven" && typeof value.fileName === "string"
    ? { kind: "proven", fileKey: value.fileKey, fileName: value.fileName }
    : null;
}

function parseNotGranted(f: Record<string, unknown>): NotGrantedReply | null {
  return f.type === "NOT_GRANTED" && isOneOf(NOT_GRANTED_REASONS, f.reason)
    ? { type: "NOT_GRANTED", reason: f.reason }
    : null;
}
