import { z } from "zod";

// Version handshake + compatibility policy. On connect the plugin reports its versions over the
// frozen envelope (see code.ts); the server gates them against the supported minimum here and, when
// the plugin is too old, REFUSES to drive it and tells the human to update.
//
// Two versions travel together with different jobs:
//   • protocolVersion — the wire-contract version (the frozen forward-compat envelope).
//     This is what the server GATES on: a value below the minimum means the server speaks
//     a contract the plugin can't. Integer, bumped only on a breaking envelope change.
//   • pluginVersion — the plugin release string, shown to the human in the refusal. Purely
//     informational; gating is by protocolVersion.

// Lowest protocol the server will drive. Bump in the same change that makes a server feature
// require a newer plugin envelope.
export const MIN_PROTOCOL_VERSION = 1;

/**
 * Where a connection stands with the version handshake.
 *
 * `checking` is the state that matters: GET_VERSION is asked the instant a plugin connects, but the
 * answer is a round-trip away, and a canvas request landing inside that window must HOLD rather than
 * be sent. Letting it through is how an under-minimum plugin ends up executing agent code against a
 * wire contract the server no longer speaks — the refusal below can only refuse what it is asked
 * about first.
 */
export type ProtocolCompatibility = "checking" | "compatible" | "incompatible";

export interface PeerVersion {
  pluginVersion?: string;
  protocolVersion?: number;
}

// The plugin answers GET_VERSION with this shape. Both fields are optional: a plugin predating the
// handshake never sends them — it ERRORs (the request rejects → caller catches into `{}`) and a
// malformed reply safeParses to `{}` — so the absence flows through as the protocol floor.
const VersionReply = z.object({
  pluginVersion: z.string().optional(),
  protocolVersion: z.number().optional(),
});

/** Read a GET_VERSION reply (or a caught failure) as a peer version; anything unparseable is the floor. */
export function parsePeerVersion(reply: unknown): PeerVersion {
  return VersionReply.safeParse(reply).data ?? {};
}

/**
 * The refusal text for a plugin this server won't drive, or null when the plugin is current. One
 * string feeds BOTH channels — the figma.notify toast the human reads and the error every canvas
 * request rejects with — so the two can't drift.
 *
 * Missing fields are treated as the FLOOR (protocol 0) and refused like any other under-minimum
 * plugin: a runtime that can't name its wire contract is exactly the runtime agent code must not run
 * against. That is a deliberate reversal of the nudge-only policy this gate shipped with — a nudge
 * appended to a result the plugin already executed tells the human to update AFTER the wrong runtime
 * has touched their document.
 */
export function refuseProtocolSkew(version: PeerVersion): string | null {
  const protocol = version.protocolVersion ?? 0;
  if (protocol >= MIN_PROTOCOL_VERSION) return null;
  const reported = version.pluginVersion
    ? `plugin v${version.pluginVersion} (protocol v${protocol})`
    : `the connected plugin (protocol v${protocol})`;
  return (
    `⚠️ Framelink won't drive this Figma plugin: the server speaks protocol v${MIN_PROTOCOL_VERSION} and ` +
    `${reported} is older, so nothing was run. Re-import the latest Framelink plugin from its manifest ` +
    `in Figma, then retry.`
  );
}
