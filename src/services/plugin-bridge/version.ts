// Version handshake + skew policy. On connect the plugin reports its versions over the
// envelope (see code.ts); the server gates them against the supported minimum here and,
// when the plugin is too old, REFUSES code-mode tool calls until it is re-imported.
//
// Two versions travel together with different jobs:
//   • protocolVersion — the wire-contract version. This is what the server GATES on: a value
//     below the minimum means the server speaks a contract the plugin can't. Integer, bumped
//     only on a breaking envelope change.
//   • pluginVersion — the plugin release string, shown to the human in the refusal. Purely
//     informational; gating is by protocolVersion.

// Lowest protocol the server will drive. Bump in the same change that makes a server feature
// require a newer plugin envelope.
//
// v2: the mid-run image protocol — plugin-issued IMAGES_REQUEST/IMAGES_REPLY reverse direction
// and the run-scoped CANCEL frame, replacing the two-pass re-run. The DSL runtime lives in the
// PLUGIN bundle, so a v1 plugin genuinely cannot speak this: its render() still throws the
// retired imagesNeeded sentinel and it drops CANCEL frames. Nothing shipped before v2, so
// there is deliberately NO compat path — the fix is a re-import, and the refusal names it.
export const MIN_PROTOCOL_VERSION = 2;

export interface PeerVersion {
  pluginVersion?: string;
  protocolVersion?: number;
}

/**
 * Decide whether a connected plugin is too old for this server; return the refusal text (shown
 * to the human as a toast on connect, and returned by code-mode write tools instead of running)
 * or null when the plugin is current.
 *
 * Missing fields are treated as the FLOOR (protocol 0): a plugin predating the handshake
 * answers the version request with an envelope ERROR, which the caller turns into an empty
 * record here — exactly the stale plugin the refusal exists to name.
 */
export function detectSkew(version: PeerVersion): string | null {
  const protocol = version.protocolVersion ?? 0;
  if (protocol >= MIN_PROTOCOL_VERSION) return null;
  const reported = version.pluginVersion
    ? `plugin v${version.pluginVersion}`
    : "the connected plugin";
  return (
    `⚠️ The Framelink Figma plugin is out of date: this server speaks protocol v${MIN_PROTOCOL_VERSION}, but ` +
    `${reported} predates it, so code-mode calls are refused until it is updated. Fix: in Figma desktop, ` +
    `re-import the latest plugin (Plugins → Development → Import plugin from manifest…) and re-open it.`
  );
}
