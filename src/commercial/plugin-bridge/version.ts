/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { PROTOCOL_VERSION, type VersionReply } from "@framelink/plugin/protocol";

// The compatibility policy for the version handshake. On connect the plugin reports its versions
// (GET_VERSION → VERSION); the server gates them here and, when the plugin is too old, REFUSES to
// drive it and tells the human to re-import. The protocol and its changelog live in the plugin's
// protocol module, built into both sides from one file, so the server requires exactly the version it
// was built with. pluginVersion is the release string, shown to the human; gating is by protocol.

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

/**
 * The refusal text for a plugin this server won't drive, or null when the plugin is current. `null`
 * is a plugin that never answered GET_VERSION with a VERSION (one predating the handshake ERRORs,
 * a silent one times out, a malformed answer parses to nothing).
 *
 * Every missing version is the FLOOR (protocol 0) and refused like any other under-minimum plugin: a
 * runtime that can't name its wire contract is exactly the runtime agent code must not run against.
 * A nudge appended to a result the plugin already executed would tell the human to update AFTER the
 * wrong runtime touched their document.
 */
export function refuseProtocolSkew(version: VersionReply | null): string | null {
  const protocol = version?.protocolVersion ?? 0;
  if (protocol >= PROTOCOL_VERSION) return null;
  const reported = version?.pluginVersion
    ? `plugin v${version.pluginVersion} (protocol v${protocol})`
    : `the connected plugin (protocol v${protocol})`;
  return (
    `⚠️ Framelink won't drive this Figma plugin: the server speaks protocol v${PROTOCOL_VERSION} and ` +
    `${reported} is older, so nothing was run. Fix: in Figma desktop, re-import the latest Framelink ` +
    `plugin (Plugins → Development → Import plugin from manifest…), re-open it, then retry.`
  );
}
