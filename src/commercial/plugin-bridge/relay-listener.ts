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
  // Whether `stop()` has run without a `start()` since. Every step of the probe checks it, because a
  // probe is spread across three turns of the event loop — the retry timer, the `tryBind` call it
  // makes, and the `listening` callback for a bind libuv has already accepted — and `stop()` can land
  // between any two of them. A `WebSocketServer` constructed but not yet listening would otherwise
  // still take the port for a bridge the caller has discarded.
  private stopped = false;
  private boundPort: number | null = null;

  constructor(private readonly hooks: RelayListenerHooks) {}

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
    this.tryBind(ports, 0);
  }

  /** Close the server (freeing its port). `stopped` is checked by `tryBind` and `listening`. */
  stop(): void {
    this.stopped = true;
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
    // EADDRINUSE means another session already holds this port — advance to the next, closing this
    // loser so its half-open listener doesn't linger. Any OTHER bind error (EACCES, EADDRNOTAVAIL …)
    // is genuinely exceptional, so crash loud rather than degrade quietly; log first so the reason
    // survives.
    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        wss.close();
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
      // Installed here, not in tryBind, so only the server that WON its bind gets one.
      this.heartbeatTimer = setInterval(() => this.hooks.heartbeat(), HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer.unref();
    });
    wss.on("connection", (socket) => this.hooks.accept(socket));
  }
}
