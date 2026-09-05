import { WebSocketServer, WebSocket } from "ws";
import { mintPairingCode, SESSION_IDENTITY } from "./approval.js";
import { ApprovalStore } from "./approval-store.js";
import { parsePeerVersion, refuseProtocolSkew, type ProtocolCompatibility } from "./version.js";
import { Logger } from "~/utils/logger.js";

/**
 * Every request the server can send the plugin, as a closed union rather than `{ type: string }` plus
 * an index signature.
 *
 * The open shape typechecked the one call this whole design exists to forbid: since ADR-0010 the flcm
 * std-lib rides on EXECUTE_CODE, so a `preamble`-less one is a request the plugin must refuse. Making
 * that a compile error is cheaper than discovering it as a runtime ERROR envelope.
 *
 * The plugin still validates what arrives, and should — JSON off a socket is untrusted however this
 * end is typed. This closes the SENDING side, which is the side a refactor can quietly break.
 *
 * `id` is deliberately absent: request() mints the correlation id and appends it last, so no payload
 * field can overwrite it.
 */
export type BridgeRequest =
  | { type: "PING"; payload: string }
  | { type: "GET_VERSION" }
  | { type: "NOTIFY"; message: string }
  // Both nullable on purpose, matching SessionConn on the plugin side: the pairing code is null with
  // no connection, and the session token is null until the human's first Allow mints one.
  | {
      type: "SESSION_INFO";
      identity: string;
      pairingCode: string | null;
      sessionToken: string | null;
    }
  | { type: "EXECUTE_CODE"; code: string; preamble: string }
  | { type: "SCREENSHOT"; nodeId?: string; key?: string; scale?: number };

/** Answers the plugin's mid-run IMAGES_REQUEST with url→base64 bytes (see image-requests.ts). */
export type ImagesRequestHandler = (urls: string[]) => Promise<Record<string, string>>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** The inactivity deadline (see DEFAULT_TIMEOUT_MS) — suspended and re-armed by run traffic. */
  timer: ReturnType<typeof setTimeout>;
  /** The absolute per-run ceiling (armed once, never reset by traffic — see DEFAULT_RUN_CEILING_MS). */
  ceilingTimer: ReturnType<typeof setTimeout>;
  /** The request's payload type: names what stalled in the timeout rejection, and gates which
   * pending ids the reverse direction will serve (only EXECUTE_CODE runs — see serveImagesRequest). */
  payloadType: string;
}

// The per-request INACTIVITY deadline, not a hard cap (protocol 2): run-scoped traffic — today,
// servicing the run's mid-run image request — suspends and re-arms it (serveImagesRequest), so a
// run only dies when neither side is doing its work. Injectable via the constructor so the
// contract harness can drive timeouts without waiting out 15 real seconds.
const DEFAULT_TIMEOUT_MS = 15_000;

// The message types the SERVER sends to establish a connection, before it knows what it is talking
// to. They are the ONLY ones exempt from the compatibility hold in `request()` — the handshake can't
// wait on its own answer. Everything else reaches the canvas (EXECUTE_CODE, SCREENSHOT, …) and must
// not be sent until the plugin's protocol is known to be supported.
//
// Deny-by-default on purpose: a canvas message type added later is gated the day it's added, without
// anyone having to remember to gate it. Adding a type HERE is the load-bearing decision — it means
// "this is safe to send to a plugin of unknown, possibly unsupported, vintage".
const HANDSHAKE_REQUEST_TYPES = new Set<BridgeRequest["type"]>([
  "PING",
  "GET_VERSION",
  "SESSION_INFO",
  "NOTIFY",
]);

// The absolute wall-clock ceiling on one request, cancellation included — the backstop the
// inactivity deadline deliberately isn't. Without it, a cold-cache many-image render (or an agent
// looping renders) could legitimately re-arm the inactivity deadline for minutes while the MCP
// client abandoned the call at its own ~60s default — the agent told "failed" about a canvas still
// being written, exactly the dishonesty this protocol exists to remove. Sized to fit the client's
// 60s budget in the common (already-approved) case; a run that genuinely needs longer should split
// its work. await-approval.ts reasons against this number — keep them in sync.
const DEFAULT_RUN_CEILING_MS = 45_000;

// How many IMAGES_REQUEST services one run may have in flight at once. The shipped preamble can
// only ever have ONE in flight — every mutating verb's image fetch runs inside its serialized
// queue slot (mutation-lock.ts) — so the allowance above 1 is headroom for skewed/older preambles,
// not a shape the current one produces. Beyond it is a runaway or hostile holder using the reverse
// channel to pin the run's inactivity clock in permanent suspension or flood the fetch path —
// refused, not queued.
const MAX_INFLIGHT_IMAGE_SERVICES_PER_RUN = 4;

// How often the server pings the holder to prove the socket is still alive. A half-open
// socket (Figma crash / laptop sleep sends no TCP FIN, so `close` never fires and the
// slot stays occupied) is reaped within ~2 ticks. Kept comfortably above ui.html's 1s
// reconnect cadence so the live plugin reclaims the freed slot on its very next retry.
const HEARTBEAT_INTERVAL_MS = 10_000;

// How long a starting server keeps re-probing a busy port that THIS project already holds a persisted
// approval for, before giving up and advancing to the next port in the block.
//
// Why this exists: durable approval keys on (cwd, PORT), so a restart only reloads its token if it
// reclaims its own port — and a dev-watch save-restart is a photo finish. Measured on the real
// `pnpm dev` loop: the predecessor releases the port ~145ms after SIGTERM and the successor binds
// ~280ms later. Anything that slows the predecessor's exit past the rebuild+spawn (a telemetry flush
// on a slow network, a loaded machine, an in-flight request) inverts that margin, the successor
// probe-advances to the next port, finds an EMPTY approval slot there, echoes `sessionToken: null`,
// and the plugin — whose own gate is per-connection — correctly treats it as a brand-new session and
// re-prompts with a fresh pairing code. The human sees "why is it asking again?" after a save they
// didn't think was a restart.
//
// What the gate actually knows, stated exactly: "this project was approved on this port." That is the
// only evidence available at bind time, and it is weaker than "the holder is my own dying
// predecessor" — the persistence key has no process in it, so nothing here can tell a predecessor
// from a live sibling. The consequence, named rather than glossed: a SECOND server started from the
// same cwd while an approved one holds the base port pays the FULL window (~2s of extra startup)
// before advancing — the Cursor-plus-Claude-Code case in approval-store.ts. That cost is accepted
// deliberately; it is a one-time delay on a second session, weighed against re-prompting a human on
// every save of the first. A server whose cwd holds NO approval for the busy port (a different
// project, a first-ever run) advances instantly and never pays it.
//
// The budget is a single deadline for the whole probe (not per port), so worst-case added startup is
// bounded by the window once, however many held-and-approved ports the block contains.
const RECLAIM_WINDOW_MS = 2_000;
const RECLAIM_RETRY_MS = 100;

// How recently a persisted approval must have been USED for this server to treat a plugin as probably
// around — the window `hasRecentApproval` measures against. Sized to span the quiet gaps inside one
// working session (an agent writes, the human looks at Figma and thinks, then asks for a tweak) while
// expiring long before "closed Figma and moved on". Deliberately unrelated to the store's 24h TTL:
// that one answers "must the human re-approve?", this one answers "is a plugin plausibly there?".
const RECENT_APPROVAL_MS = 30 * 60 * 1000;

/**
 * Gate connections by `Origin`. A Figma plugin UI runs in a sandboxed iframe, so its
 * WebSocket handshake carries `Origin: null` (or no Origin header for non-browser
 * clients). We accept ONLY that and refuse everything else — any real `http(s)://…`
 * origin is a script running on an identifiable web page, which must not reach the
 * eval socket. A real `figma.com` origin is included in that refusal on purpose: it
 * comes from a non-sandboxed script on a figma.com *page* (web-app context, injected
 * script, figma-scoped extension), exactly the browser-page category we shut out — the
 * plugin itself never presents it.
 *
 * Deliberately WEAK, by design — this is defense-in-depth, NOT authorization:
 *  - A determined web page CAN still present `Origin: null` by nesting its WebSocket in
 *    its own `sandbox="allow-scripts"` iframe (opaque origin). So this only stops the
 *    naive same-origin page, not a crafted one.
 *  - A non-browser local process can send any Origin (or none) it likes.
 * Closing those is Phase 2's job: the in-Figma human-consent gate is the real trust
 * boundary. This check just removes the cheapest drive-by (a visited page's direct
 * `new WebSocket`) so consent isn't the only thing standing between a page and the socket.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  return !origin || origin === "null";
}

/**
 * Owns the single WebSocket connection to the Figma plugin and the request/response
 * correlation. `request()` is the only REQUEST path: it stamps every outbound request
 * with a fresh id and resolves when a reply carrying that same id arrives. Replies
 * without a matching pending id are dropped. This is where the plan's "every WS
 * request carries a correlation id" invariant is enforced — callers never deal with
 * ids themselves. Two server→plugin frames live OUTSIDE it by design: the id-less
 * one-way CANCEL on timeout, and IMAGES_REPLY/IMAGES_ERROR, which answer the PLUGIN's
 * ids (protocol 2's reverse direction, serveImagesRequest).
 *
 * It is also where the version gate lives: every connection runs its own GET_VERSION handshake, and
 * a request that isn't part of that handshake is held until the verdict lands, then sent or refused
 * (see HANDSHAKE_REQUEST_TYPES and `sendOnceCompatible`).
 */
export class PluginBridge {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 0;
  // Where the CURRENT connection stands with the version handshake, and the refusal text when it came
  // back under the minimum. Connection-scoped on purpose: reset to `checking` the moment a socket is
  // installed, so a newer plugin reconnecting onto the freed slot starts clean instead of inheriting
  // its predecessor's verdict.
  //
  // `checking` HOLDS canvas requests rather than letting them through — that hold is the whole point.
  // GET_VERSION is asked on connect but answered a round-trip later, and a tool call can land inside
  // that window; sending it there is how a plugin below MIN_PROTOCOL_VERSION receives agent code and
  // runs it instead of being refused.
  private compatibility: ProtocolCompatibility = "checking";
  private skewRefusal: string | null = null;
  // Resolves when the current connection's verdict lands, or when that connection is abandoned with
  // the verdict still unknown. Re-created per connection, and the INVARIANT that makes the hold safe
  // is that every path which abandons a connection settles this first: disconnect (`close`), reclaim
  // (settled before the swap in the connection handler), and `stop()`. A holder is suspended on one
  // specific promise object, so dropping a resolver without calling it strands that holder for good —
  // no timeout covers it, because the request was never sent.
  private verdictSettled: Promise<void> = Promise.resolve();
  private settleVerdict: () => void = () => {};
  // The pairing code for the CURRENT connection — minted fresh on connect, read by the
  // SESSION_INFO handshake (shown in the panel) and by the tool handlers (shown in the
  // pending-approval result). Connection-scoped like the compatibility verdict: a fresh socket gets a
  // fresh code, and disconnect clears it so the next connection can't surface a stale one.
  private pairingCode: string | null = null;
  // Whether the current holder has answered the server over the frozen envelope (any reply
  // matching a pending request). True ⟺ it's a real plugin speaking the protocol — a current
  // one, or a stale one that envelope-ERRORs — NOT a dead/silent squatter. This gates
  // slot-reclaim: an established (handshaked) holder is never displaced by a second
  // connection (the 1.1 anti-hijack rule); a non-handshaked one is reclaimable.
  private handshaked = false;
  // Heartbeat liveness for the current socket. Each ping sets it false; the holder's pong
  // sets it true. A holder that misses a ping is half-open (dead but no FIN) and gets reaped.
  private socketAlive = false;
  // The session token the sandbox minted on Allow and handed back over the WS. This is the
  // FIRST bridge field that must SURVIVE reconnects — it is deliberately NOT part of the
  // connection-scoped cluster above (socket/compatibility/pairingCode/handshaked/socketAlive),
  // all of which reset on connect/disconnect. It is this server's proof of a prior approval:
  // echoed in every SESSION_INFO so the sandbox re-keys sticky approval to it. A same-path squatter
  // is a different process whose token starts null, so it echoes none and the sandbox re-prompts
  // (Invariant: approval keys on the token, not the forgeable identity). Mirror of the Phase 2
  // warning that sticky approval can't reuse the connection-scoped pattern — same reasoning, server
  // side.
  //
  // Held in memory here AND persisted through `store`, so it survives a server-process RESTART (not
  // just a WS reconnect). A restart is exactly what used to drop this back to null and re-prompt with
  // a fresh pairing code; reloading it once the port binds closes that gap (see approval-store.ts).
  private sessionToken: string | null = null;
  // The port this server won its probe-bind on, or null before `listening`. Persistence keys on it —
  // (cwd, port) — so concurrent same-cwd servers never share an approval file (see approval-store.ts).
  private boundPort: number | null = null;
  // `lastUsedAt` of the approval this server found when it bound its port, or null if it found none.
  // Fixed at `listening` and never refreshed: it answers "when was code mode last used HERE, before
  // this process existed", and once a plugin connects the connection latch answers everything better
  // (see hasRecentApproval).
  private reloadedApprovalLastUsedAt: number | null = null;
  // The winning WebSocketServer, retained only so `stop()` can close it (free the port). The relay is
  // otherwise process-lifetime; stop() exists for tests that model a restart by freeing then rebinding.
  private wss: WebSocketServer | null = null;
  // Wall-clock cutoff for waiting on a busy-but-ours port during the initial probe (see
  // RECLAIM_WINDOW_MS). One budget for the whole probe, stamped in `start()`; 0 means "never wait",
  // which is what a bridge that was never started reads as.
  private reclaimDeadline = 0;
  // The pending re-probe of a busy-but-ours port, held so `stop()` can cancel it. Without the handle a
  // stopped bridge would come back to life when the timer fired — binding the port it was just told to
  // release and reloading the persisted token onto an object the caller believes is dead.
  private reclaimTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether `stop()` has run without a `start()` since. Every step of the probe checks it, because a
  // probe is spread across three turns of the event loop — the retry timer, the `tryBind` call it
  // makes, and the `listening` callback for a bind libuv has already accepted — and `stop()` can land
  // between any two of them. Cancelling only the timer leaves the other two: a `WebSocketServer`
  // constructed but not yet listening will still take the port, overwrite the `wss` handle `stop()`
  // just nulled (so nothing can ever close it), and reload the persisted token onto a bridge the
  // caller has discarded.
  private stopped = false;

  // How long a pending request may sit with no run traffic before it is cancelled (see
  // DEFAULT_TIMEOUT_MS). Set once at construction.
  private readonly requestTimeoutMs: number;
  // The absolute wall-clock cap on one request (see DEFAULT_RUN_CEILING_MS) — never suspended,
  // never re-armed. Set once at construction.
  private readonly runCeilingMs: number;
  // The probe's budget for waiting on a busy-but-ours port (see RECLAIM_WINDOW_MS). Set once at
  // construction.
  private readonly reclaimWindowMs: number;
  // Answers the plugin's mid-run IMAGES_REQUEST frames (protocol 2's reverse direction). Fixed at
  // construction (index.ts wires the guarded fetch path + the session image cache); bridges built
  // without one — the contract harness's non-image sections — refuse the frames with IMAGES_ERROR.
  private readonly imagesRequestHandler: ImagesRequestHandler | null;
  // How many image services each run has in flight right now. The run's inactivity deadline stays
  // suspended while ANY service is running and re-arms only when the count returns to zero —
  // a lone clearTimeout/re-arm pair breaks under concurrent services (the first reply would
  // restart the clock while the second fetch is still ours to finish). Entries are cleared when
  // the run settles (reply, timeout, failPending), so a straggler fetch finds no count and no-ops.
  private readonly inFlightImageServices = new Map<string, number>();

  // Everything injectable for the contract harness, which drives real sockets: `store` isolates
  // persistence to a temp dir instead of touching the real ~/.framelink; `requestTimeoutMs` lets it pin
  // behaviour that only shows up when a request times out — a silent plugin's version handshake, and
  // a displaced squatter's orphaned one resolving late — without waiting out the real 15s;
  // `reclaimWindowMs` lets it pin both ends of the reclaim wait (advance immediately, and give up at
  // the deadline) against an explicit budget rather than racing a constant. Production takes the
  // defaults, and index.ts wires only the images handler.
  constructor(
    private readonly store: ApprovalStore = new ApprovalStore(),
    {
      requestTimeoutMs = DEFAULT_TIMEOUT_MS,
      runCeilingMs = DEFAULT_RUN_CEILING_MS,
      reclaimWindowMs = RECLAIM_WINDOW_MS,
      imagesRequestHandler = null,
    }: {
      requestTimeoutMs?: number;
      runCeilingMs?: number;
      reclaimWindowMs?: number;
      imagesRequestHandler?: ImagesRequestHandler | null;
    } = {},
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.runCeilingMs = runCeilingMs;
    this.reclaimWindowMs = reclaimWindowMs;
    this.imagesRequestHandler = imagesRequestHandler;
  }

  /**
   * Probe-bind the first free port in the block, advancing on `EADDRINUSE`. The OS guarantees no
   * double-bind, so two concurrent servers sharing one block never collide — the second simply
   * advances to the next free port. This is what lets N sessions coexist on N distinct ports
   * (Phase 3). The per-connection handlers (verifyClient, connection/close) are attached to every
   * probe's server, but a probe that loses the race to EADDRINUSE is closed before it accepts, so
   * only the winner's ever fire; the heartbeat is installed in `listening`, so it is winner-only.
   */
  start(ports: number[], onConnect?: () => void): void {
    this.stopped = false;
    this.reclaimDeadline = Date.now() + this.reclaimWindowMs;
    this.tryBind(ports, 0, onConnect);
  }

  private tryBind(ports: number[], index: number, onConnect?: () => void): void {
    if (this.stopped) return;
    if (index >= ports.length) {
      Logger.log(
        `No free port in the WS block [${ports[0]}..${ports[ports.length - 1]}] — is the block full?`,
      );
      return;
    }
    const port = ports[index];
    const wss = new WebSocketServer({
      // Loopback only — the eval socket must never be reachable from the LAN. Bound to the IPv4
      // literal even though the plugin dials `ws://localhost` (the manifest can't use an IP literal —
      // Figma's validator rejects it): `localhost` resolves to both ::1 and 127.0.0.1, and Chromium
      // (Figma's runtime) falls back to 127.0.0.1 instantly when the ::1 attempt is refused. Don't
      // widen this to a non-loopback host to "match" localhost — that would breach the boundary.
      host: "127.0.0.1",
      port,
      // Refuse the upgrade before a socket exists when the Origin is a web page, or
      // when an ESTABLISHED plugin holds the channel (anti-hijack — see below).
      verifyClient: ({ origin }: { origin?: string }) => {
        if (!isAllowedOrigin(origin)) {
          Logger.log(`Refused WS connection from web origin ${origin}`);
          return false;
        }
        // Anti-hijack (Slice 1.1), now liveness-aware (Slice 1.3). An ESTABLISHED holder —
        // one that has answered the server over the frozen envelope (handshaked) — is never
        // displaced, so a web page or local process can't steal a live plugin's channel by
        // connecting after it. But a holder that has NOT handshaked must not trap the real
        // plugin: it's either a pre-consent squatter monopolizing the single slot, or a
        // half-open socket whose plugin died. Admit the newcomer and let the connection handler
        // reclaim the slot — reclaim is triggered by ANY admitted (allowed-origin) connection,
        // gated on the HOLDER being non-established, not on the newcomer proving itself first;
        // the newcomer then completes its own handshake to drive. (Replacing one non-established
        // holder with another is harmless — consent, Phase 2, is the real write gate.) A
        // half-open holder that DID handshake looks established here and is reaped separately by
        // the heartbeat, freeing the slot.
        if (this.socket && this.socket.readyState === WebSocket.OPEN && this.handshaked) {
          Logger.log("Refused second WS connection — an established plugin holds the channel");
          return false;
        }
        return true;
      },
    });
    // EADDRINUSE means another session already holds this port — advance to the next and try
    // again (close this loser first so its half-open listener doesn't linger), EXCEPT while this
    // port still looks like our own former slot: see RECLAIM_WINDOW_MS. Any OTHER bind
    // error (EACCES, EADDRNOTAVAIL …) is genuinely exceptional, NOT a "block full" condition, so
    // crash loud rather than degrade quietly: a deliberate asymmetry with the soft block-exhaustion
    // path above (which logs and survives serverless). Log first so the reason survives the crash.
    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        wss.close();
        if (this.shouldWaitToReclaim(port)) {
          // Re-probe the SAME index rather than advancing: the holder is very likely the dying
          // predecessor of this very server, and landing elsewhere would silently cost the human a
          // fresh Allow. unref'd so a server whose port never frees can't hold the process open, and
          // retained so `stop()` can cancel it rather than leaving a discarded bridge to rebind on a
          // later tick (`stopped` covers the rest of that hazard).
          this.reclaimTimer = setTimeout(() => {
            this.reclaimTimer = null;
            this.tryBind(ports, index, onConnect);
          }, RECLAIM_RETRY_MS);
          this.reclaimTimer.unref();
          return;
        }
        this.tryBind(ports, index + 1, onConnect);
        return;
      }
      Logger.log(`Unexpected WS bind error on port ${port}: ${err.message}`);
      throw err;
    });
    wss.on("listening", () => {
      // A bind libuv had already accepted when `stop()` ran: hand the port straight back rather than
      // installing it. Nothing below this line may run on a stopped bridge — it would claim the port,
      // replace the `wss` handle stop() nulled, and reload the approval onto a discarded object.
      if (this.stopped) {
        wss.close();
        return;
      }
      Logger.log(`WS bridge listening on ws://127.0.0.1:${port}`);
      // Record the winning port + server so persistence keys on (cwd, port) and stop() can free it.
      this.boundPort = port;
      this.wss = wss;
      // Reload a prior approval the instant the port is bound — before any connection can be accepted
      // (and thus before the first SESSION_INFO), so a plugin reconnecting onto this port immediately
      // gets the persisted token echoed and is not re-prompted. Keyed by THIS port: a concurrent
      // sibling on another port, or a restart that landed elsewhere, reloads nothing (fail-closed).
      const reloaded = this.store.loadRecord(port, Date.now());
      this.sessionToken = reloaded?.token ?? null;
      this.reloadedApprovalLastUsedAt = reloaded?.lastUsedAt ?? null;
      if (this.sessionToken)
        Logger.log(
          "Reloaded a persisted session token — it will be offered on the next SESSION_INFO; the plugin decides whether the prior Allow still holds",
        );
      // Install the heartbeat here in `listening` (not eagerly in tryBind) so only the server that
      // WON its bind gets one — a probe that lost to EADDRINUSE never reaches here. unref'd and never
      // cleared: it lives for the whole process, like the bridge itself. (What it reaps: see HEARTBEAT_INTERVAL_MS.)
      const heartbeat = setInterval(() => this.heartbeatTick(), HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();
    });
    wss.on("connection", (socket) => {
      // verifyClient admitted this connection, so any current holder is non-handshaked (a
      // pre-consent squatter or a half-open dead socket). Reclaim the slot for the newcomer,
      // which will complete its own handshake. An established holder never reaches here — it's
      // refused at verifyClient — so this can't displace a live, responsive plugin.
      const stale = this.socket && this.socket.readyState === WebSocket.OPEN ? this.socket : null;

      // Settle the OUTGOING connection's gate before swapping in this one's. A canvas request holding
      // for the displaced connection is suspended on that promise, and we are about to drop the only
      // resolver for it — without this it waits forever, because the displaced socket's `close` bails
      // below and its handshake bails on the identity guard, so neither settles. Waking it here lets
      // it re-read the field and hold for the NEWCOMER's verdict instead, which is what it wanted all
      // along. (This is also why the displaced-socket branch of `close` must NOT settle: by then the
      // field points at the newcomer's gate, and settling it would release holders early.)
      this.settleVerdict();
      this.socket = socket;
      // Start every connection back at `checking`, with a fresh promise for canvas requests to hold
      // on. The close handler also resets this, but resetting only on close leaves a window: if a
      // prior connection drops mid-handshake, its awaited verdict can land AFTER close cleared the
      // slot, stranding a stale one the next plugin would inherit. Resetting on connect closes that
      // window — a fresh connection is driven only once its OWN handshake vouches for it.
      this.compatibility = "checking";
      this.skewRefusal = null;
      this.verdictSettled = new Promise((resolve) => {
        this.settleVerdict = resolve;
      });
      // A fresh socket is unproven (no reply yet) and presumed alive (so the first heartbeat
      // tick pings rather than reaps it). It earns `handshaked` on its first matched reply.
      this.handshaked = false;
      this.socketAlive = true;
      // Mint this connection's pairing code up front so the SESSION_INFO handshake (fired
      // from onConnect) and any pending-approval result share one source — guaranteeing the
      // code in the panel matches the one in the tool result.
      this.pairingCode = mintPairingCode();
      socket.on("pong", () => {
        if (this.socket === socket) this.socketAlive = true;
      });
      socket.on("message", (data) => this.handleMessage(socket, data.toString()));
      socket.on("close", () => {
        // A socket displaced by slot-reclaim is no longer current — this.socket already
        // points at the newcomer, whose fresh handshake requests are queued synchronously
        // by onConnect. terminate()'s close fires a tick LATER, so failing pending here
        // unconditionally would reject the NEWCOMER's in-flight handshake. Bail when we're
        // not the current socket; the displaced socket's own stragglers (server-fired
        // handshakes to a squatter) fall to their 15s timeout — fire-and-forget, harmless.
        if (this.socket !== socket) {
          Logger.log("Displaced WS socket closed");
          return;
        }
        this.socket = null;
        this.pairingCode = null;
        this.handshaked = false;
        // Wake anything holding for a verdict that will now never arrive. The hold re-checks the
        // socket, finds it gone, and falls through to the "No Figma plugin connected" rejection —
        // which the approval wait rides out across the plugin's ~1s redial, exactly as it does for
        // any other mid-wait drop.
        this.compatibility = "checking";
        this.skewRefusal = null;
        this.settleVerdict();
        // Every in-flight request was sent on THIS (current, now-closed) socket, so reject
        // them now instead of letting each hang to its 15s timeout — same "never a silent
        // hang" contract as the frozen envelope.
        this.failPending("Figma plugin disconnected before replying.");
        Logger.log("Plugin disconnected from WS bridge");
      });

      if (stale) {
        // terminate() fires `stale`'s close handler, but this.socket already points at the
        // newcomer, so the `this.socket === socket` guard there leaves the new slot intact.
        Logger.log("Reclaiming WS slot from a non-handshaked holder for a new connection");
        stale.terminate();
      }
      Logger.log("Plugin connected to WS bridge");
      // Ask what we're talking to FIRST. Fired from here rather than left to the caller that started
      // the bridge: holding canvas requests until a verdict lands is only safe if a verdict ALWAYS
      // lands, and the only way to guarantee that is for the connection itself to run the handshake.
      // Anything onConnect fires is a handshake message, which rides past the hold anyway.
      void this.handshakeProtocolVersion(socket);
      onConnect?.();
    });
  }

  /**
   * Whether a busy port is worth re-probing instead of advancing past: only while the probe's reclaim
   * budget is unspent AND this project holds an unexpired approval for that exact port. The approval
   * is the evidence — it means a human already Allowed a server of ours on this port, so the holder is
   * most likely our own not-yet-dead predecessor, and landing elsewhere would cost a fresh Allow.
   *
   * READ-ONLY on purpose (`hasUnexpiredApproval`, never `load`): the port being probed is one some
   * OTHER live process may hold, and `load` prunes an expired record. Pruning here would delete a
   * running peer's approval file behind its back, and its `touch` — a compare-and-set that only
   * rewrites a file still holding its token — would never put it back, so the peer would silently lose
   * durable approval and re-prompt on its next restart. A stale record can only ever cost this probe
   * its own bounded window.
   */
  private shouldWaitToReclaim(port: number): boolean {
    const now = Date.now();
    return now < this.reclaimDeadline && this.store.hasUnexpiredApproval(port, now);
  }

  /**
   * One heartbeat cycle: terminate the holder if it missed the previous ping's pong (it's
   * half-open — dead but no FIN), otherwise ping it and await the pong. Terminating fires
   * `close`, which frees the slot for the live plugin's reconnect. Public so the contract
   * harness can drive liveness deterministically instead of waiting out the real interval.
   */
  heartbeatTick(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (!this.socketAlive) {
      Logger.log("Heartbeat: holder missed a pong — terminating the half-open socket");
      socket.terminate();
      return;
    }
    this.socketAlive = false;
    socket.ping();
  }

  /**
   * Ask the fresh connection for its versions and settle this connection's compatibility verdict,
   * releasing any canvas request holding for it. Runs once per connection, fired from the connection
   * handler with that connection's own socket.
   *
   * A plugin predating the handshake answers GET_VERSION with an envelope ERROR (the request rejects)
   * and a silent one times out — both catch into an empty record, which reads as the protocol floor
   * and is refused. So every path settles: a held request is never held forever.
   */
  private async handshakeProtocolVersion(socket: WebSocket): Promise<void> {
    const reply = await this.request({ type: "GET_VERSION" }).catch(() => ({}));
    // We are no longer the current connection, so this answer is about a socket nobody is driving.
    // Two ways to get here, and BOTH must bail:
    //   • Reclaimed/reconnected — a displaced squatter's orphaned GET_VERSION resolves on its timeout,
    //     long after a real plugin took the slot, and would otherwise condemn it as incompatible.
    //   • Disconnected — `close` fails the pending GET_VERSION, so this resolves a microtask later
    //     with an empty record. Reading that as the floor would leave a bridge with NO plugin sitting
    //     in `incompatible`, telling the agent to reinstall the plugin when the truth is that nothing
    //     is connected.
    // Socket identity catches both; the connection epoch only catches the first (it doesn't move on a
    // disconnect), which is why the guard is on the socket.
    if (this.socket !== socket) return;
    const version = parsePeerVersion(reply);
    this.skewRefusal = refuseProtocolSkew(version);
    this.compatibility = this.skewRefusal ? "incompatible" : "compatible";
    this.settleVerdict();
    if (!this.skewRefusal) return;
    Logger.log(
      `⚠️ Version skew — plugin reported ${JSON.stringify(version)}; refusing canvas requests`,
    );
    // Human channel: a figma.notify toast. Fire-and-forget — a plugin predating the NOTIFY handler
    // envelope-ERRORs and the toast is silently dropped, which is fine; the agent still gets this
    // same text as the rejection on every canvas call it tries.
    this.request({ type: "NOTIFY", message: this.skewRefusal }).catch(() => {});
  }

  /**
   * Where the current connection stands with the version handshake — `checking` until its GET_VERSION
   * resolves, then `compatible` or `incompatible`. Canvas requests hold on the first and are refused
   * on the last; read directly only for diagnostics and by the bridge contract harness.
   */
  protocolCompatibility(): ProtocolCompatibility {
    return this.compatibility;
  }

  /**
   * The refusal text for the current connection when its verdict is `incompatible`, else null. Canvas
   * requests already reject with this same text; the one reader that ISN'T a canvas request is the
   * docs tool, which still serves on a stale plugin and leads with the refusal so the agent learns the
   * re-import fix before its first refused write.
   */
  protocolRefusal(): string | null {
    return this.compatibility === "incompatible" ? this.skewRefusal : null;
  }

  /** The current connection's pairing code, or null when no plugin is connected. */
  getPairingCode(): string | null {
    return this.pairingCode;
  }

  /** The session token handed over on Allow, or null until one arrives; survives reconnects so SESSION_INFO can echo it. */
  getSessionToken(): string | null {
    return this.sessionToken;
  }

  /** Is a plugin on the wire right now? The plain liveness question, with no approval in it. */
  isPluginConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Was code mode used on this (cwd, port) within the last few minutes, according to the approval this
   * server found when it bound? The ONLY cross-process evidence the relay has that a plugin is around:
   * every other signal — the connection latch, the socket, the pairing code — is per-process state that
   * a restart clears to "no plugin has ever been here", which is indistinguishable from a genuine cold
   * start and means the opposite.
   *
   * WHY RECENCY AND NOT MERE PRESENCE, which is what this first shipped as: the store's own expiry is a
   * 24h sliding TTL, sized for "don't re-prompt an active human", and reading it as "a plugin is around"
   * quietly turned approval storage into feature-enable storage — someone who approved code mode once
   * yesterday, then closed Figma, kept getting write tools advertised on every later server process all
   * day. A much shorter window answers the question actually being asked.
   *
   * It is still a PROXY, and deliberately a cheap one. The asymmetry that makes it safe: too generous
   * only shows a few extra tools to someone who used code mode minutes ago, while too strict reports a
   * live capability as absent — so the window leans long, and either way it stops mattering the instant
   * a plugin connects and the latch takes over. Not refreshed on use: once a plugin has connected, no
   * caller consults this.
   */
  hasRecentApproval(): boolean {
    if (this.reloadedApprovalLastUsedAt === null) return false;
    return Date.now() - this.reloadedApprovalLastUsedAt <= RECENT_APPROVAL_MS;
  }

  /**
   * Slide the persisted approval's TTL forward after a successful write, so an actively-used session is
   * never pruned mid-work. No-op when nothing is persisted (unapproved, or approval-less runs). Called
   * from the tool handler on the success path, not from `request()` — only a real write should count as
   * use. Passes the live token so the store's compare-and-set refuses to roll back a peer's newer file.
   */
  touchApproval(): void {
    if (this.boundPort !== null && this.sessionToken)
      this.store.touch(this.boundPort, this.sessionToken, Date.now());
  }

  /**
   * Close the WS server (freeing its port) and drop the current socket. NOT part of the normal server
   * lifecycle — the relay is meant to live for the whole process. It exists so tests can model a server
   * RESTART honestly: free the port, then rebind it with a fresh bridge that reloads the persisted token.
   * Under (cwd, port) keying, a faithful restart test must reclaim the same port, which requires this.
   */
  stop(): void {
    // Shut the probe down FIRST, on all three of its paths: latch `stopped` (checked by `tryBind` and
    // by `listening`), cancel a scheduled re-probe, and burn the budget. Closing `wss` alone is not
    // enough — it only disposes the bind that already WON, leaving anything still in flight free to
    // take the port and reload the persisted token onto a bridge the caller has discarded.
    this.stopped = true;
    if (this.reclaimTimer) clearTimeout(this.reclaimTimer);
    this.reclaimTimer = null;
    this.reclaimDeadline = 0;
    this.socket?.terminate();
    this.socket = null;
    // Nulling the socket makes the terminate()-driven `close` bail as "displaced", so it never runs
    // the disconnect reset — do it here, or a canvas request holding for a verdict is stranded on a
    // promise this stop just orphaned. Waking it drops it through to "No Figma plugin connected".
    this.compatibility = "checking";
    this.skewRefusal = null;
    this.settleVerdict();
    this.wss?.close();
    this.wss = null;
  }

  /** Reject and clear every pending request — used when the socket they were sent on dies. */
  private failPending(reason: string): void {
    for (const id of this.pending.keys()) {
      this.takePending(id)?.reject(new Error(reason));
    }
  }

  /** Remove a pending request and stop its clocks — every settle path (reply, deadline, socket
   * death) funnels through here, so none can leak a timer or an in-flight image-service count
   * (a straggler fetch then finds no count and no-ops). */
  private takePending(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    clearTimeout(pending.ceilingTimer);
    this.pending.delete(id);
    this.inFlightImageServices.delete(id);
    return pending;
  }

  request(payload: BridgeRequest): Promise<unknown> {
    // Handshake messages send SYNCHRONOUSLY (no await before the socket.send): the connection
    // contract depends on the newcomer's handshake being in flight before a displaced socket's close
    // fires a tick later. Everything else goes through the compatibility hold.
    if (HANDSHAKE_REQUEST_TYPES.has(payload.type)) return this.sendCorrelated(payload);
    return this.sendOnceCompatible(payload);
  }

  /**
   * Send a canvas request, but only once this connection's protocol is known to be supported: hold
   * while the verdict is still `checking`, refuse outright when it came back under the minimum.
   *
   * A LOOP, not a single await: each abandonment settles the gate (see `verdictSettled`), which wakes
   * us to re-read the field. A reclaim mid-hold puts us back to `checking` on the newcomer, so we hold
   * again and ultimately run against whoever ends up driving; a socket that dies drops out of the loop
   * and falls through to `sendCorrelated`'s own "no plugin connected" rejection.
   */
  private async sendOnceCompatible(payload: BridgeRequest): Promise<unknown> {
    while (this.compatibility === "checking" && this.socket?.readyState === WebSocket.OPEN) {
      await this.verdictSettled;
    }
    // Refuse rather than send. A stale plugin executing agent code against a wire contract the server
    // no longer speaks is the failure the minimum exists to prevent, and a refusal the agent relays
    // beats a nudge stapled to a result the wrong runtime already produced.
    const refusal = this.compatibility === "incompatible" ? this.skewRefusal : null;
    if (refusal) throw new Error(refusal);
    return this.sendCorrelated(payload);
  }

  /** Stamp a correlation id on the payload, send it, and resolve when the reply carrying that id lands. */
  private sendCorrelated(payload: BridgeRequest): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(
          "No Figma plugin connected. Open the Framelink plugin in Figma desktop and try again.",
        ),
      );
    }
    const id = `req-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => this.timeoutPending(id, "inactivity"), this.requestTimeoutMs),
        ceilingTimer: setTimeout(() => this.timeoutPending(id, "ceiling"), this.runCeilingMs),
        payloadType: payload.type,
      });
      // `id` last: the generated correlation id is authoritative and a payload field
      // must never overwrite it, or the reply could never be matched to this pending.
      socket.send(JSON.stringify({ ...payload, id }));
    });
  }

  /**
   * A deadline fired — the inactivity timeout or the absolute run ceiling: tell the plugin to
   * cancel the run, then reject the caller — cancel, never silently abandon. Plugin-side the
   * CANCEL is enforced (Phase 2): the run is recorded as cancelled, a still-queued run is refused
   * at dequeue, an executing run is refused before its next mutating verb (the preamble mutation
   * lock, plan invariant 4), and a run suspended at its image await has that await rejected. The
   * zombie-refusal in serveImagesRequest stays the server's own half (image requests naming a
   * dead run are refused). Don't add a second enforcement path here; the lock owns it. The frame
   * is a run-scoped, id-less one-way notification — the reverse mirror of the plugin's
   * SESSION_TOKEN/REVOKE_SESSION — and deliberately not a request: a CANCEL that awaited a reply
   * could itself time out and cancel, recursively.
   */
  private timeoutPending(id: string, cause: "inactivity" | "ceiling"): void {
    const pending = this.takePending(id);
    if (!pending) return;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "CANCEL", runId: id }));
    }
    const why =
      cause === "inactivity"
        ? `saw no traffic for ${this.requestTimeoutMs}ms`
        : `exceeded the absolute ${this.runCeilingMs}ms run ceiling`;
    pending.reject(
      new Error(
        `Bridge request ${id} (${pending.payloadType}) ${why} — ` +
          `the run was cancelled. The canvas holds whatever completed before that.`,
      ),
    );
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    let msg: {
      id?: unknown;
      type?: unknown;
      error?: unknown;
      sessionToken?: unknown;
      runId?: unknown;
      urls?: unknown;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      Logger.log(`Ignoring non-JSON message from plugin: ${raw.slice(0, 120)}`);
      return;
    }
    // Token handover from the sandbox after Allow: unsolicited (no id — it's not a reply to any
    // server request), so it's handled here, before the id-match path that would drop it. Persist
    // it OUTSIDE the connection-scoped cluster (the field never clears on disconnect) so every
    // later SESSION_INFO echoes it and the sandbox re-keys sticky approval to the token.
    if (msg.type === "SESSION_TOKEN" && typeof msg.sessionToken === "string") {
      this.sessionToken = msg.sessionToken;
      // Persist so the approval survives a server restart, not just this connection (approval-store.ts).
      // boundPort is set by `listening`, which precedes any connection, so it is non-null here.
      if (this.boundPort !== null)
        this.store.save(this.boundPort, msg.sessionToken, SESSION_IDENTITY, Date.now());
      Logger.log("Stored session token handed over by the sandbox after Allow (persisted)");
      return;
    }
    // The human revoked in the arbiter panel. Also unsolicited (id-less) — forget the token both in
    // memory and on disk so no future SESSION_INFO can re-approve; the plugin already cleared its own
    // approvedTokens entry, so the next write re-prompts.
    if (msg.type === "REVOKE_SESSION") {
      this.sessionToken = null;
      if (this.boundPort !== null) this.store.clear(this.boundPort);
      Logger.log("Session approval revoked by the human — cleared the persisted token");
      return;
    }
    // Protocol 2 reverse direction: the plugin asks US for image bytes mid-run. Its ids live in the
    // plugin's own namespace, so this must dispatch by TYPE before the pending-reply match below —
    // which only knows server-issued ids and would silently drop these frames.
    if (msg.type === "IMAGES_REQUEST") {
      this.serveImagesRequest(socket, msg);
      return;
    }
    if (typeof msg.id !== "string") return;
    const pending = this.takePending(msg.id);
    if (!pending) return;
    // A reply matching a pending request proves the holder speaks the frozen envelope — it's
    // a real plugin (current, or a stale one that envelope-ERRORs), not a dead/silent squatter.
    // This is what makes the holder "established" and thus protected from slot-reclaim.
    this.handshaked = true;
    // Frozen-envelope error path: a plugin replies `{ type:"ERROR", error }` to any
    // message type it doesn't recognize — the case a newer server hits against an
    // older, un-updatable plugin. Surface it as an immediate rejection so the caller
    // gets a readable error instead of waiting out the 15s timeout.
    if (msg.type === "ERROR" && typeof msg.error === "string") {
      pending.reject(new Error(msg.error));
      return;
    }
    pending.resolve(msg);
  }

  /**
   * Service a plugin-issued IMAGES_REQUEST (protocol 2). Traffic-as-heartbeat: the run's
   * inactivity deadline is SUSPENDED while WE are the side doing the work (our fetch is bounded by
   * images.ts's own timeouts and caps, and the run ceiling never suspends) and re-armed when the
   * run's last in-flight service settles — the deadline only ever counts plugin-side silence.
   * A request naming a run this bridge no longer tracks (timed
   * out, cancelled, already resolved) is refused instead of served: the refusal rejects the run's
   * suspended await plugin-side, so a zombie run can never resume into canvas writes after the
   * agent was told nothing happened. That refusal is the server's own half of the policy; the
   * plugin's run-cancellation registry enforces the rest (see timeoutPending).
   */
  private serveImagesRequest(
    socket: WebSocket,
    msg: { id?: unknown; runId?: unknown; urls?: unknown },
  ): void {
    // Only the current holder may draw on the reverse channel. A displaced or dead socket knows
    // live run ids (it carried them), so without this a stale holder could suspend or answer the
    // current connection's runs from the grave.
    if (this.socket !== socket) return;
    if (typeof msg.id !== "string") return; // unanswerable — nothing to correlate a reply to
    const id = msg.id;
    // A reverse request proves the holder speaks the envelope, exactly like a matched reply.
    this.handshaked = true;
    const runId = typeof msg.runId === "string" ? msg.runId : null;
    const urls = Array.isArray(msg.urls)
      ? msg.urls.filter((u): u is string => typeof u === "string")
      : [];
    // Reply on the socket the request arrived on, and only while it is still the current one — a
    // displaced or dead socket's fetch result must not leak onto a newer connection.
    const send = (body: Record<string, unknown>): void => {
      if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ ...body, id }));
      }
    };
    const run = runId ? this.pending.get(runId) : undefined;
    if (!runId || !run) {
      send({
        type: "IMAGES_ERROR",
        error: `flcm.image: run ${runId ?? "(unknown)"} is no longer active on this server (cancelled, timed out, or already finished) — the image request was refused.`,
      });
      return;
    }
    // Only a code run may pull bytes. Server-issued handshake requests (SESSION_INFO, GET_VERSION)
    // share the req-N id namespace, so without this gate a holder could burn network fetches — and
    // hold a suspension — against a pending it was never granted a run for.
    if (run.payloadType !== "EXECUTE_CODE") {
      send({
        type: "IMAGES_ERROR",
        error: `flcm.image: run ${runId} is not a code run — only EXECUTE_CODE runs may request images.`,
      });
      return;
    }
    if (!this.imagesRequestHandler) {
      send({
        type: "IMAGES_ERROR",
        error:
          "flcm.image: this server has no image handler wired — image bytes cannot be fetched.",
      });
      return;
    }
    const inFlight = this.inFlightImageServices.get(runId) ?? 0;
    if (inFlight >= MAX_INFLIGHT_IMAGE_SERVICES_PER_RUN) {
      send({
        type: "IMAGES_ERROR",
        error: `flcm.image: run ${runId} already has ${inFlight} image requests in flight — this one was refused.`,
      });
      return;
    }
    this.inFlightImageServices.set(runId, inFlight + 1);
    clearTimeout(run.timer); // suspend: the server is the side working now
    // Re-arm only when the LAST in-flight service settles — with concurrent services, the first
    // reply must not restart the run's clock while a second fetch is still the server's work.
    const settleService = (): void => {
      const count = this.inFlightImageServices.get(runId);
      if (count === undefined) return; // the run settled meanwhile and cleared its count
      if (count > 1) {
        this.inFlightImageServices.set(runId, count - 1);
        return;
      }
      this.inFlightImageServices.delete(runId);
      // A live count implies the run is still pending (counts only exist for pending runs, and
      // ids are never reused), so re-arming the captured `run` directly is safe.
      run.timer = setTimeout(() => this.timeoutPending(runId, "inactivity"), this.requestTimeoutMs);
    };
    void this.imagesRequestHandler(urls)
      .then((images) => {
        if (!this.pending.has(runId)) {
          // The run died while we fetched — withhold the bytes rather than resume a zombie.
          send({
            type: "IMAGES_ERROR",
            error: `flcm.image: run ${runId} is no longer active on this server — the image reply was withheld.`,
          });
          return;
        }
        send({ type: "IMAGES_REPLY", images });
      })
      .catch((err: unknown) => {
        send({ type: "IMAGES_ERROR", error: err instanceof Error ? err.message : String(err) });
      })
      .finally(settleService);
  }
}
