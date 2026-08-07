// Version handshake + skew policy. On connect the plugin reports its versions over the
// frozen envelope (see code.ts); the server gates them against the supported minimum
// here and, when the plugin is too old, fires the dual-channel skew nudge.
//
// Two versions travel together with different jobs:
//   • protocolVersion — the wire-contract version (the frozen forward-compat envelope).
//     This is what the server GATES on: a value below the minimum means the server speaks
//     a contract the plugin can't. Integer, bumped only on a breaking envelope change.
//   • pluginVersion — the plugin release string, shown to the human in the nudge. Purely
//     informational; gating is by protocolVersion.

// Lowest protocol the server will drive without nudging. Bump in the same change that
// makes a server feature require a newer plugin envelope.
export const MIN_PROTOCOL_VERSION = 1;

export interface PeerVersion {
  pluginVersion?: string;
  protocolVersion?: number;
}

/**
 * Decide whether a connected plugin is too old to keep current; return the nudge text
 * (shared by both the human toast and the agent note) or null when the plugin is current.
 *
 * Missing fields are treated as the FLOOR (protocol 0), never as a reason to reject — a
 * plugin predating the handshake answers the version request with an envelope ERROR, which
 * the caller turns into an empty record here. Those are exactly the stale users the nudge
 * exists to rescue; rejecting them would brick the un-updatable plugin (see the plan's
 * Warning). So the gate only ever *nudges*, never refuses.
 */
export function detectSkew(version: PeerVersion): string | null {
  const protocol = version.protocolVersion ?? 0;
  if (protocol >= MIN_PROTOCOL_VERSION) return null;
  const reported = version.pluginVersion
    ? `plugin v${version.pluginVersion}`
    : "the connected plugin";
  return (
    `⚠️ Update the Framelink Figma plugin: this server needs protocol v${MIN_PROTOCOL_VERSION}, but ` +
    `${reported} predates it. Re-import the latest plugin from its manifest in Figma to stay current.`
  );
}
