import { WebSocketServer, WebSocket } from "ws";
import { mintPairingCode, SESSION_IDENTITY } from "./approval.js";
import { ApprovalStore } from "./approval-store.js";
import { parsePeerVersion, refuseProtocolSkew, type ProtocolCompatibility } from "./version.js";
import { Logger } from "~/utils/logger.js";

export interface BridgeRequest {
  type: string;
  [key: string]: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

// The message types the SERVER sends to establish a connection, before it knows what it is talking
// to. They are the ONLY ones exempt from the compatibility hold in `request()` — the handshake can't
// wait on its own answer. Everything else reaches the canvas (EXECUTE_CODE, SCREENSHOT, …) and must
// not be sent until the plugin's protocol is known to be supported.
//
// Deny-by-default on purpose: a canvas message type added later is gated the day it's added, without
// anyone having to remember to gate it. Adding a type HERE is the load-bearing decision — it means
// "this is safe to send to a plugin of unknown, possibly unsupported, vintage".
const HANDSHAKE_REQUEST_TYPES = new Set(["PING", "GET_VERSION", "SESSION_INFO", "NOTIFY"]);

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
// Waiting is gated on a PERSISTED APPROVAL for that exact port, which is the only evidence a server
// has that the port is plausibly its own former slot — so a genuinely-concurrent second session (no
// approval on the holder's port) still advances instantly and never pays this. The budget is a single
// deadline for the whole probe (not per port), so worst-case added startup is bounded by the window
// once, however many held-and-approved ports the block contains.
const RECLAIM_WINDOW_MS = 2_000;
const RECLAIM_RETRY_MS = 100;

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
 * correlation. `request()` is the ONLY send path: it stamps every outbound message
 * with a fresh id and resolves when a reply carrying that same id arrives. Replies
 * without a matching pending id are dropped. This is where the plan's "every WS
 * request carries a correlation id" invariant is enforced — callers never deal with
 * ids themselves.
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
  // Resolves when the current connection's verdict lands, or when its socket dies with the verdict
  // still unknown. Re-created per connection; the hold re-reads this field on every pass so a
  // reconnect mid-hold waits on the NEW connection's promise instead of one nobody will ever settle.
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
  // Monotonic id for the current connection, bumped each time a socket is installed (connect
  // OR reclaim). A connection-scoped async side effect (the version handshake → compatibility
  // verdict) captures this before awaiting and re-checks it after, so a result that lands AFTER a
  // reclaim/reconnect can't clobber the newer connection's state. Without it, a displaced
  // squatter's GET_VERSION pending — orphaned by the close-guard below, since failing it would
  // hit the newcomer's pending too — times out 15s later and condemns the real plugin that took
  // the slot as incompatible.
  private epoch = 0;
  // The session token the sandbox minted on Allow and handed back over the WS. This is the
  // FIRST bridge field that must SURVIVE reconnects — it is deliberately NOT part of the
  // connection-scoped cluster above (socket/compatibility/pairingCode/handshaked/socketAlive/epoch),
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
  // The winning WebSocketServer, retained only so `stop()` can close it (free the port). The relay is
  // otherwise process-lifetime; stop() exists for tests that model a restart by freeing then rebinding.
  private wss: WebSocketServer | null = null;
  // Wall-clock cutoff for waiting on a busy-but-ours port during the initial probe (see
  // RECLAIM_WINDOW_MS). One budget for the whole probe, stamped in `start()`; 0 means "never wait",
  // which is what a bridge that was never started reads as.
  private reclaimDeadline = 0;

  // Both injectable for the contract harness, which drives real sockets: `store` isolates persistence
  // to a temp dir instead of touching the real ~/.framelink, and `requestTimeoutMs` lets it pin
  // behaviour that only shows up when a request times out — a silent plugin's version handshake, and
  // a displaced squatter's orphaned one resolving late — without waiting out the real 15s. Production
  // takes both defaults.
  constructor(
    private readonly store: ApprovalStore = new ApprovalStore(),
    private readonly requestTimeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * Probe-bind the first free port in the block, advancing on `EADDRINUSE`. The OS guarantees no
   * double-bind, so two concurrent servers sharing one block never collide — the second simply
   * advances to the next free port. This is what lets N sessions coexist on N distinct ports
   * (Phase 3). The per-connection handlers (verifyClient, connection/close) are attached to every
   * probe's server, but a probe that loses the race to EADDRINUSE is closed before it accepts, so
   * only the winner's ever fire; the heartbeat is installed in `listening`, so it is winner-only.
   */
  start(ports: number[], onConnect?: () => void): void {
    this.reclaimDeadline = Date.now() + RECLAIM_WINDOW_MS;
    this.tryBind(ports, 0, onConnect);
  }

  private tryBind(ports: number[], index: number, onConnect?: () => void): void {
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
          // fresh Allow. unref'd so a server whose port never frees can't hold the process open.
          setTimeout(() => this.tryBind(ports, index, onConnect), RECLAIM_RETRY_MS).unref();
          return;
        }
        this.tryBind(ports, index + 1, onConnect);
        return;
      }
      Logger.log(`Unexpected WS bind error on port ${port}: ${err.message}`);
      throw err;
    });
    wss.on("listening", () => {
      Logger.log(`WS bridge listening on ws://127.0.0.1:${port}`);
      // Record the winning port + server so persistence keys on (cwd, port) and stop() can free it.
      this.boundPort = port;
      this.wss = wss;
      // Reload a prior approval the instant the port is bound — before any connection can be accepted
      // (and thus before the first SESSION_INFO), so a plugin reconnecting onto this port immediately
      // gets the persisted token echoed and is not re-prompted. Keyed by THIS port: a concurrent
      // sibling on another port, or a restart that landed elsewhere, reloads nothing (fail-closed).
      this.sessionToken = this.store.load(port, Date.now());
      if (this.sessionToken)
        Logger.log("Reloaded a persisted session approval — a prior Allow still holds");
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

      this.socket = socket;
      this.epoch++;
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
      socket.on("message", (data) => this.handleMessage(data.toString()));
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
      void this.handshakeProtocolVersion();
      onConnect?.();
    });
  }

  /**
   * Whether a busy port is worth re-probing instead of advancing past: only while the probe's reclaim
   * budget is unspent AND this project holds an unexpired approval for that exact port. The approval
   * is the evidence — it means a human already Allowed a server of ours on this port, so the holder is
   * most likely our own not-yet-dead predecessor, and landing elsewhere would cost a fresh Allow.
   *
   * `store.load` is the right probe rather than a bespoke peek: it applies the same TTL and prunes the
   * same expired file the eventual `listening` handler would, so a stale slot can't hold up startup.
   */
  private shouldWaitToReclaim(port: number): boolean {
    return Date.now() < this.reclaimDeadline && this.store.load(port, Date.now()) !== null;
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
   * handler.
   *
   * A plugin predating the handshake answers GET_VERSION with an envelope ERROR (the request rejects)
   * and a silent one times out — both catch into an empty record, which reads as the protocol floor
   * and is refused. So every path settles: a held request is never held forever.
   */
  private async handshakeProtocolVersion(): Promise<void> {
    const epoch = this.epoch;
    const reply = await this.request({ type: "GET_VERSION" }).catch(() => ({}));
    // The slot was reclaimed or reconnected while we awaited: a DIFFERENT connection owns it and is
    // running its own handshake. Bail rather than stamping this connection's verdict on the newcomer
    // — a displaced squatter's orphaned GET_VERSION resolves 15s late and would otherwise condemn the
    // real plugin that took the slot.
    if (this.epoch !== epoch) return;
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

  /** The current connection's pairing code, or null when no plugin is connected. */
  getPairingCode(): string | null {
    return this.pairingCode;
  }

  /** The session token handed over on Allow, or null until one arrives; survives reconnects so SESSION_INFO can echo it. */
  getSessionToken(): string | null {
    return this.sessionToken;
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
    this.socket?.terminate();
    this.socket = null;
    this.wss?.close();
    this.wss = null;
  }

  /**
   * Monotonic id of the current connection; changes on every connect/reclaim. Capture it
   * before a connection-scoped await and re-check after, so a late result can't clobber a
   * newer connection's state (see the `epoch` field).
   */
  currentEpoch(): number {
    return this.epoch;
  }

  /** Reject and clear every pending request — used when the socket they were sent on dies. */
  private failPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }
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
   * The hold re-reads `verdictSettled` on every pass because a reconnect mid-hold swaps in a new
   * promise; awaiting the captured one would wait on a connection nobody will ever settle. A socket
   * that dies while we hold drops out of the loop and falls through to `sendCorrelated`'s own "no
   * plugin connected" rejection.
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Bridge request ${id} (${payload.type}) timed out after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // `id` last: the generated correlation id is authoritative and a payload field
      // must never overwrite it, or the reply could never be matched to this pending.
      socket.send(JSON.stringify({ ...payload, id }));
    });
  }

  private handleMessage(raw: string): void {
    let msg: { id?: unknown; type?: unknown; error?: unknown; sessionToken?: unknown };
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
    if (typeof msg.id !== "string") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    // A reply matching a pending request proves the holder speaks the frozen envelope — it's
    // a real plugin (current, or a stale one that envelope-ERRORs), not a dead/silent squatter.
    // This is what makes the holder "established" and thus protected from slot-reclaim.
    this.handshaked = true;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
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
}
