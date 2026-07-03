import { z } from "zod";
import { Logger } from "~/utils/logger.js";
import { PluginBridge } from "./bridge.js";
import { WS_PORT_BLOCK } from "./ports.js";
import { SESSION_IDENTITY } from "./approval.js";
import { detectSkew } from "./version.js";

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

// The plugin answers GET_VERSION with this shape. Both fields are optional: a plugin
// predating the handshake never sends them — it ERRORs (request rejects → caught into {})
// and a malformed reply safeParses to {} — so the absence flows into detectSkew as the
// floor and nudges, never throws.
const VersionReply = z.object({
  pluginVersion: z.string().optional(),
  protocolVersion: z.number().optional(),
});

/**
 * Start the WS relay on the port block and wire the per-connection handshake. Called once per
 * process from server startup; every MCP server instance (one for stdio, one per stateless HTTP
 * request) shares the returned runtime.
 */
export function startPluginBridge(): PluginBridgeRuntime {
  const bridge = new PluginBridge();
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

    void handshakeVersion(bridge);
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

/**
 * Server-initiated version handshake (fires on every connect, alongside the PING). Asks
 * the sandbox for its versions over the frozen envelope, gates them against the supported
 * minimum, and — on skew — arms BOTH nudge channels: a figma.notify toast (human, routed
 * back through the sandbox) and the agent note appended to subsequent tool results.
 *
 * A plugin predating the handshake answers GET_VERSION with an envelope ERROR; we catch
 * that into an empty record so detectSkew treats it as the floor and nudges, never rejects.
 */
async function handshakeVersion(bridge: PluginBridge): Promise<void> {
  const epoch = bridge.currentEpoch();
  const reply = await bridge.request({ type: "GET_VERSION" }).catch(() => ({}));
  // If the slot was reclaimed/reconnected while we awaited, a DIFFERENT connection now owns it
  // and runs its own handshake. Bail so this stale connection's result — e.g. a displaced
  // squatter's GET_VERSION timing out to {} → nudge — can't clobber the current plugin's note.
  if (bridge.currentEpoch() !== epoch) return;
  const version = VersionReply.safeParse(reply).data ?? {};
  const note = detectSkew(version);
  bridge.setSkewNote(note);
  if (!note) return;
  Logger.log(`⚠️ Version skew — plugin reported ${JSON.stringify(version)}; nudging both channels`);
  // Fire-and-forget: a plugin predating the NOTIFY handler answers with an envelope ERROR
  // (rejecting this request) and the toast is silently dropped — expected, that plugin still
  // gets the agent channel. Don't chase a toast on a pre-v1 plugin.
  bridge.request({ type: "NOTIFY", message: note }).catch(() => {});
}
