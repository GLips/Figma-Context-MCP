import { join } from "node:path";
import { Logger } from "~/utils/logger.js";
import { PluginBridge } from "./bridge.js";
import { WS_PORT_BLOCK } from "./ports.js";
import { SESSION_IDENTITY } from "./approval.js";
import { resolveStateDir } from "./approval-store.js";

/**
 * The running WS relay plus the code-mode advertisement latch. The relay starts with the server in
 * BOTH transports (one loopback port from the block; negligible when unused), but the code-mode
 * tools are only advertised once a plugin proves the write path exists by connecting.
 *
 * The latch never resets: once a plugin has connected, the tools stay advertised for the process
 * lifetime. That is deliberately stronger than a disconnect grace period — the plugin's ui.html
 * reconnects on a ~1s cadence, and a latch cannot flap on blips at all. Do not "fix" this by
 * un-advertising on disconnect: list-caching MCP clients would strand the agent mid-task.
 */
export interface PluginBridgeRuntime {
  bridge: PluginBridge;
  /** True once a plugin has connected at least once in this process (latched — see above). */
  hasEverConnected(): boolean;
  /** Run cb on the first plugin connection; runs immediately if one already happened. */
  onFirstConnect(cb: () => void): void;
}

/**
 * Start the WS relay on the port block and wire the per-connection handshake. Called once per
 * process from server startup; every MCP server instance (one for stdio, one per stateless HTTP
 * request) shares the returned runtime.
 */
export function startPluginBridge(): PluginBridgeRuntime {
  const bridge = new PluginBridge();
  // Surface where the durable-approval token file lives — it is a security-adjacent 0600 credential, so
  // an operator should be able to see (and locate/inspect) it at startup. Override via FRAMELINK_STATE_DIR.
  Logger.log(`Session approvals persisted under ${join(resolveStateDir(), "approvals")}`);
  // Callbacks awaiting the first plugin connection; null once it has happened (the latch fired).
  // One variable, not a boolean + array pair, so "latched but callbacks still queued" can't exist.
  let pendingFirstConnect: (() => void)[] | null = [];

  bridge.start(WS_PORT_BLOCK, () => {
    // Connection smoke test: the instant a plugin connects, prove the full loop
    //   server → WS → ui.html → postMessage → code.js → figma.* → back
    // works end to end. If the WS won't round-trip, no tool call can — so surface it loudly here.
    bridge
      .request({ type: "PING", payload: "ping from server" })
      .then((reply) =>
        Logger.log(`✅ Bridge smoke test passed — sandbox replied: ${JSON.stringify(reply)}`),
      )
      .catch((err: Error) => Logger.log(`❌ Bridge smoke test failed: ${err.message}`));

    // The version handshake is NOT fired here — PluginBridge runs it itself on every connection,
    // because the compatibility hold it feeds is only safe if a verdict always lands (bridge.ts).
    sendSessionInfo(bridge);

    if (pendingFirstConnect) {
      const callbacks = pendingFirstConnect;
      pendingFirstConnect = null;
      for (const cb of callbacks) cb();
    }
  });

  return {
    bridge,
    hasEverConnected: () => pendingFirstConnect === null,
    onFirstConnect: (cb) => {
      if (pendingFirstConnect) pendingFirstConnect.push(cb);
      else cb();
    },
  };
}

/**
 * Introduce this session to the plugin so the human can recognize and approve it: the
 * server identity (project path), the connection's pairing code (both shown in the arbiter
 * panel), and — once approved — the session token the sandbox handed us on Allow, echoed on
 * every reconnect so the sandbox re-keys sticky approval to it (null before the first Allow).
 * Fire-and-forget — the plugin acks immediately and records the fields; it must NOT block on
 * the human here (approval arrives later, out of band, via the panel), or this request would
 * hang to its 15s timeout. The plugin owns the approval decision; this just hands it what to
 * display and the token that proves a prior approval.
 */
function sendSessionInfo(bridge: PluginBridge): void {
  const pairingCode = bridge.getPairingCode();
  const sessionToken = bridge.getSessionToken();
  bridge
    .request({ type: "SESSION_INFO", identity: SESSION_IDENTITY, pairingCode, sessionToken })
    .catch(() => {});
}
