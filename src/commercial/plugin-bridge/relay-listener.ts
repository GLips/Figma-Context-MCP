/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { AddressInfo } from "node:net";
import type { WebSocket, WebSocketServer } from "ws";
import { Logger } from "~/utils/logger.js";
import { createLocalWebSocketServer, type LocalListenerPolicy } from "~/utils/local-listener.js";

// Match the WS inbound ceiling, including the envelope. Image-specific caps remain in its adapter.
export const MAX_CHANNEL_BYTES = 100 * 1024 * 1024;

// How often the server pings each link to prove its socket is still alive. A half-open socket
// (Figma crash / laptop sleep sends no TCP FIN) is reaped within ~2 ticks.
const HEARTBEAT_INTERVAL_MS = 10_000;

// How long a starting server keeps re-probing a busy port that THIS project holds a persisted approval
// for, before advancing. Durable approval keys on (cwd, PORT), so a restart reloads its token only if
// it reclaims its own port, and a dev-watch save-restart is a photo finish (the predecessor frees the
// port ~145ms after SIGTERM, the successor binds ~280ms later). Advancing past it lands on an empty
// approval slot, and the human is re-prompted after a save they didn't think was a restart.
//
// The gate knows only "this project was approved on this port", which can't tell a dying predecessor
// from a live sibling. So a SECOND same-cwd server pays the full window once before advancing:
// accepted, against re-prompting on every save. One deadline for the whole probe, not per port.
export const RECLAIM_WINDOW_MS = 2_000;
const RECLAIM_RETRY_MS = 100;

/**
 * A Figma plugin UI runs in a sandboxed iframe, so its handshake carries `Origin: null`; a non-browser
 * client sends none. Any real origin is a script on an identifiable web page, which must not reach the
 * eval socket — `figma.com` included, since the plugin itself never presents it. An opaque origin is
 * not proof of the plugin, though: link authentication, not this, is the trust boundary.
 */
export const RELAY_LISTENER_POLICY: LocalListenerPolicy = {
  browsers: "opaque-origin-only",
  checkHost: true,
};

export interface RelayListenerHooks {
  /** Whether a new upgrade may become a link, making room for it first if the bridge can. */
  admitsNewcomer(): boolean;
  /** Whether this project holds an unexpired approval for `port` — the evidence a reclaim wait needs. */
  holdsApprovalFor(port: number): boolean;
  /** The port is ours. Runs before any connection on it can be accepted. */
  bound(port: number): void;
  accept(socket: WebSocket): void;
  heartbeat(): void;
}

/**
 * The relay's network edge: probe-binds the first free port in the block, refuses web origins (through
 * the local-listener boundary) and hijack attempts at the upgrade, and drives the heartbeat. It holds
 * no connection state — the bridge owns the links, and is asked through `hooks`.
 */
export class RelayListener {
  // The winning WebSocketServer, retained only so `stop()` can close it (free the port).
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Wall-clock cutoff for waiting on a busy-but-ours port during the probe (see RECLAIM_WINDOW_MS).
  // One budget for the whole probe, stamped in `start()`; 0 means "never wait".
  private reclaimDeadline = 0;
  // The pending re-probe of a busy-but-ours port, held so `stop()` can cancel it: without the handle a
  // stopped listener would come back to life when the timer fired.
  private reclaimTimer: ReturnType<typeof setTimeout> | null = null;
  // The port this probe already announced a reclaim wait for, so the ~20 retries inside one window
  // say it once. Also what tells the giving-up branch that anyone was waiting.
  private reclaimWaitPort: number | null = null;
  // Whether `stop()` has run without a `start()` since. Every step of the probe checks it, because a
  // probe is spread across three turns of the event loop — the retry timer, the `tryBind` call it
  // makes, and the `listening` callback for a bind libuv has already accepted — and `stop()` can land
  // between any two of them. A `WebSocketServer` constructed but not yet listening would otherwise
  // still take the port and reload the persisted token onto a bridge the caller has discarded.
  private stopped = false;
  private boundPort: number | null = null;

  constructor(
    private readonly hooks: RelayListenerHooks,
    private readonly reclaimWindowMs = RECLAIM_WINDOW_MS,
  ) {}

  /** The port this listener won its probe-bind on, or null before `listening` (and after stop). */
  get port(): number | null {
    return this.boundPort;
  }

  /**
   * Probe-bind the first free port in the block, advancing on `EADDRINUSE`. The OS guarantees no
   * double-bind, so two concurrent servers sharing one block never collide — the second simply
   * advances to the next free port.
   */
  start(ports: readonly number[]): void {
    this.stopped = false;
    this.reclaimDeadline = Date.now() + this.reclaimWindowMs;
    this.reclaimWaitPort = null;
    this.tryBind(ports, 0);
  }

  /**
   * Close the server (freeing its port). Shuts the probe down on all three of its paths: latch
   * `stopped` (checked by `tryBind` and `listening`), cancel a scheduled re-probe, burn the budget.
   */
  stop(): void {
    this.stopped = true;
    if (this.reclaimTimer) clearTimeout(this.reclaimTimer);
    this.reclaimTimer = null;
    this.reclaimDeadline = 0;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.wss?.close();
    this.wss = null;
    this.boundPort = null;
  }

  private tryBind(ports: readonly number[], index: number): void {
    if (this.stopped) return;
    if (index >= ports.length) {
      Logger.log(
        `No free port in the WS block [${ports[0]}..${ports[ports.length - 1]}] — is the block full?`,
      );
      return;
    }
    const port = ports[index];
    // Loopback only — the eval socket must never be reachable from the LAN. Bound to the IPv4 literal
    // even though the plugin dials `ws://localhost` (the manifest can't use an IP literal — Figma's
    // validator rejects it): `localhost` resolves to both ::1 and 127.0.0.1, and Chromium (Figma's
    // runtime) falls back to 127.0.0.1 instantly when the ::1 attempt is refused. Don't widen this to
    // a non-loopback host to "match" localhost — that would breach the boundary.
    //
    // Past the policy, the bridge decides: it caps links that haven't authenticated, and never
    // displaces one that has.
    const wss = createLocalWebSocketServer(
      RELAY_LISTENER_POLICY,
      { maxPayload: MAX_CHANNEL_BYTES, host: "127.0.0.1", port },
      () => {
        if (this.hooks.admitsNewcomer()) return true;
        Logger.log("Refused WS connection — every waiting plugin link is showing a pairing code");
        return false;
      },
    );
    // EADDRINUSE means another session already holds this port — advance to the next (closing this
    // loser so its half-open listener doesn't linger), EXCEPT while this port still looks like our own
    // former slot: see RECLAIM_WINDOW_MS. Any OTHER bind error (EACCES, EADDRNOTAVAIL …) is genuinely
    // exceptional, so crash loud rather than degrade quietly; log first so the reason survives.
    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        wss.close();
        if (this.shouldWaitToReclaim(port)) {
          // Re-probe the SAME index: the holder is very likely the dying predecessor of this very
          // server. REFERENCED, not unref'd: this listener holds no port while it waits, so an unref'd
          // timer would let a process whose sole job is the bridge (a probe script) exit silently.
          // Bounded by the reclaim budget and cancelled by stop().
          this.announceReclaimWait(port);
          this.reclaimTimer = setTimeout(() => {
            this.reclaimTimer = null;
            this.tryBind(ports, index);
          }, RECLAIM_RETRY_MS);
          return;
        }
        if (this.reclaimWaitPort === port)
          Logger.log(
            `Port ${port} is still held after the ${this.reclaimWindowMs}ms reclaim window — advancing to the next port in the block. The plugin scans the whole block, so it will still find this server; a prior approval keyed to port ${port} will not be reloaded.`,
          );
        this.tryBind(ports, index + 1);
        return;
      }
      Logger.log(`Unexpected WS bind error on port ${port}: ${err.message}`);
      throw err;
    });
    wss.on("listening", () => {
      // A bind libuv had already accepted when `stop()` ran: hand the port straight back.
      if (this.stopped) {
        wss.close();
        return;
      }
      // The address, not `port`: a bind on port 0 (tests) lands wherever the OS put it.
      const bound = (wss.address() as AddressInfo).port;
      Logger.log(`WS bridge listening on ws://127.0.0.1:${bound}`);
      this.boundPort = bound;
      this.wss = wss;
      this.hooks.bound(bound);
      // Installed here, not in tryBind, so only the server that WON its bind gets one.
      this.heartbeatTimer = setInterval(() => this.hooks.heartbeat(), HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer.unref();
    });
    wss.on("connection", (socket) => this.hooks.accept(socket));
  }

  /**
   * Whether a busy port is worth re-probing instead of advancing past: only while the probe's reclaim
   * budget is unspent AND this project holds an unexpired approval for that exact port. The approval
   * is the evidence that the holder is most likely our own not-yet-dead predecessor.
   */
  private shouldWaitToReclaim(port: number): boolean {
    return Date.now() < this.reclaimDeadline && this.hooks.holdsApprovalFor(port);
  }

  /**
   * Say, once per waited-on port, that startup is paused and what a human can do about it. The wait
   * is invisible otherwise, and the case it most often hits is a SECOND process from the same cwd (a
   * probe script started while the MCP server runs), where "nothing happened" looks like a bug.
   */
  private announceReclaimWait(port: number): void {
    if (this.reclaimWaitPort === port) return;
    this.reclaimWaitPort = port;
    Logger.log(
      `Port ${port} is busy and this project holds an approval for it — waiting up to ${this.reclaimWindowMs}ms ` +
        `to reclaim it (normally this server's own restarting predecessor). If another Framelink server ` +
        `or probe is holding the port, stop it, or give this process its own state with ` +
        `FRAMELINK_STATE_DIR=<an isolated dir> so it advances to a free port immediately.`,
    );
  }
}
