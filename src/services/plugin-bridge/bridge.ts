import { WebSocketServer, WebSocket } from "ws";
import { mintPairingCode, SESSION_IDENTITY } from "./approval.js";
import { ApprovalStore } from "./approval-store.js";
import { Logger } from "~/utils/logger.js";

export interface BridgeRequest {
  type: string;
  [key: string]: unknown;
}

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

// The absolute wall-clock ceiling on one request, cancellation included — the backstop the
// inactivity deadline deliberately isn't. Without it, a cold-cache many-image render (or an agent
// looping renders) could legitimately re-arm the inactivity deadline for minutes while the MCP
// client abandoned the call at its own ~60s default — the agent told "failed" about a canvas still
// being written, exactly the dishonesty this protocol exists to remove. Sized to fit the client's
// 60s budget in the common (already-approved) case; a run that genuinely needs longer should split
// its work. await-approval.ts reasons against this number — keep them in sync.
const DEFAULT_RUN_CEILING_MS = 45_000;

// How many IMAGES_REQUEST services one run may have in flight at once. A well-behaved preamble
// issues ONE batched, deduped request per render(); a small allowance covers a script that renders
// concurrently. Beyond that is a runaway or hostile holder using the reverse channel to pin the
// run's inactivity clock in permanent suspension or flood the fetch path — refused, not queued.
const MAX_INFLIGHT_IMAGE_SERVICES_PER_RUN = 4;

// How often the server pings the holder to prove the socket is still alive. A half-open
// socket (Figma crash / laptop sleep sends no TCP FIN, so `close` never fires and the
// slot stays occupied) is reaped within ~2 ticks. Kept comfortably above ui.html's 1s
// reconnect cadence so the live plugin reclaims the freed slot on its very next retry.
const HEARTBEAT_INTERVAL_MS = 10_000;

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
 */
export class PluginBridge {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 0;
  // The agent-facing version-skew nudge for the CURRENT connection, or null when the
  // plugin is current. Connection-scoped on purpose: set by the connect handshake, read
  // by tool handlers to append the note, and cleared on disconnect so a newer plugin
  // reconnecting onto the freed slot starts clean instead of inheriting a stale nudge.
  private skewNote: string | null = null;
  // The pairing code for the CURRENT connection — minted fresh on connect, read by the
  // SESSION_INFO handshake (shown in the panel) and by the tool handlers (shown in the
  // pending-approval result). Connection-scoped like the skew note: a fresh socket gets a
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
  // OR reclaim). A connection-scoped async side effect (index.ts's version handshake → skew
  // note) captures this before awaiting and re-checks it after, so a result that lands AFTER a
  // reclaim/reconnect can't clobber the newer connection's state. Without it, a displaced
  // squatter's GET_VERSION pending — orphaned by the close-guard below, since failing it would
  // hit the newcomer's pending too — times out 15s later and stamps a stale nudge on the real
  // plugin that took the slot.
  private epoch = 0;
  // The session token the sandbox minted on Allow and handed back over the WS. This is the
  // FIRST bridge field that must SURVIVE reconnects — it is deliberately NOT part of the
  // connection-scoped cluster above (socket/skewNote/pairingCode/handshaked/socketAlive/epoch),
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

  // How long a pending request may sit with no run traffic before it is cancelled (see
  // DEFAULT_TIMEOUT_MS). Set once at construction.
  private readonly requestTimeoutMs: number;
  // The absolute wall-clock cap on one request (see DEFAULT_RUN_CEILING_MS) — never suspended,
  // never re-armed. Set once at construction.
  private readonly runCeilingMs: number;
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

  // Injectable so the contract harness / tests isolate persistence to a temp dir instead of touching
  // the real ~/.framelink, and drive timeouts without real 15s waits. Production uses the defaults.
  constructor(
    private readonly store: ApprovalStore = new ApprovalStore(),
    {
      requestTimeoutMs = DEFAULT_TIMEOUT_MS,
      runCeilingMs = DEFAULT_RUN_CEILING_MS,
      imagesRequestHandler = null,
    }: {
      requestTimeoutMs?: number;
      runCeilingMs?: number;
      imagesRequestHandler?: ImagesRequestHandler | null;
    } = {},
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.runCeilingMs = runCeilingMs;
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
    // again (close this loser first so its half-open listener doesn't linger). Any OTHER bind
    // error (EACCES, EADDRNOTAVAIL …) is genuinely exceptional, NOT a "block full" condition, so
    // crash loud rather than degrade quietly: a deliberate asymmetry with the soft block-exhaustion
    // path above (which logs and survives serverless). Log first so the reason survives the crash.
    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        wss.close();
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
      // Start every connection with a clean skew note. The close handler also clears it,
      // but clearing only on close leaves a window: if a prior connection drops mid-handshake,
      // its awaited setSkewNote() can land AFTER close cleared the slot, stranding a stale
      // nudge that the next (current) plugin would then inherit. Clearing on connect closes
      // that window — a fresh connection nudges only once its OWN handshake proves skew.
      this.skewNote = null;
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
        this.skewNote = null;
        this.pairingCode = null;
        this.handshaked = false;
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
      onConnect?.();
    });
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

  /** Set the current connection's version-skew refusal (null = plugin is current). */
  setSkewNote(note: string | null): void {
    this.skewNote = note;
  }

  /** The current connection's skew nudge, or null. Read by tool handlers to append it. */
  getSkewNote(): string | null {
    return this.skewNote;
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
