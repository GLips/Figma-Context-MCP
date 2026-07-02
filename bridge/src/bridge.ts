import { WebSocketServer, WebSocket } from "ws";
import { mintPairingCode } from "./approval.js";
import { log } from "./logger.js";

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
 * correlation. `request()` is the ONLY send path: it stamps every outbound message
 * with a fresh id and resolves when a reply carrying that same id arrives. Replies
 * without a matching pending id are dropped. This is where the plan's "every WS
 * request carries a correlation id" invariant is enforced — callers never deal with
 * ids themselves.
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
  // echoed in every SESSION_INFO so the sandbox re-keys sticky approval to it, surviving until
  // the process exits. A same-path squatter is a different process whose token starts null, so
  // it echoes none and the sandbox re-prompts (Invariant: approval keys on the token, not the
  // forgeable identity). Mirror of the Phase 2 warning that sticky approval can't reuse the
  // connection-scoped pattern — same reasoning, server side.
  private sessionToken: string | null = null;

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
      log(`No free port in the WS block [${ports[0]}..${ports[ports.length - 1]}] — is the block full?`);
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
          log(`Refused WS connection from web origin ${origin}`);
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
          log("Refused second WS connection — an established plugin holds the channel");
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
      log(`Unexpected WS bind error on port ${port}: ${err.message}`);
      throw err;
    });
    wss.on("listening", () => {
      log(`WS bridge listening on ws://127.0.0.1:${port}`);
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
      const stale =
        this.socket && this.socket.readyState === WebSocket.OPEN ? this.socket : null;

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
      socket.on("message", (data) => this.handleMessage(data.toString()));
      socket.on("close", () => {
        // A socket displaced by slot-reclaim is no longer current — this.socket already
        // points at the newcomer, whose fresh handshake requests are queued synchronously
        // by onConnect. terminate()'s close fires a tick LATER, so failing pending here
        // unconditionally would reject the NEWCOMER's in-flight handshake. Bail when we're
        // not the current socket; the displaced socket's own stragglers (server-fired
        // handshakes to a squatter) fall to their 15s timeout — fire-and-forget, harmless.
        if (this.socket !== socket) {
          log("Displaced WS socket closed");
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
        log("Plugin disconnected from WS bridge");
      });

      if (stale) {
        // terminate() fires `stale`'s close handler, but this.socket already points at the
        // newcomer, so the `this.socket === socket` guard there leaves the new slot intact.
        log("Reclaiming WS slot from a non-handshaked holder for a new connection");
        stale.terminate();
      }
      log("Plugin connected to WS bridge");
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
      log("Heartbeat: holder missed a pong — terminating the half-open socket");
      socket.terminate();
      return;
    }
    this.socketAlive = false;
    socket.ping();
  }

  /** Set the current connection's version-skew nudge (null = plugin is current). */
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
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error("No Figma plugin connected. Open the Framelink plugin in Figma desktop and try again."),
      );
    }
    const id = `req-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge request ${id} (${payload.type}) timed out after ${DEFAULT_TIMEOUT_MS}ms`));
      }, DEFAULT_TIMEOUT_MS);
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
      log(`Ignoring non-JSON message from plugin: ${raw.slice(0, 120)}`);
      return;
    }
    // Token handover from the sandbox after Allow: unsolicited (no id — it's not a reply to any
    // server request), so it's handled here, before the id-match path that would drop it. Persist
    // it OUTSIDE the connection-scoped cluster (the field never clears on disconnect) so every
    // later SESSION_INFO echoes it and the sandbox re-keys sticky approval to the token.
    if (msg.type === "SESSION_TOKEN" && typeof msg.sessionToken === "string") {
      this.sessionToken = msg.sessionToken;
      log("Stored session token handed over by the sandbox after Allow");
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
