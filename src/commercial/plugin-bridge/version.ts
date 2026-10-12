/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { PROTOCOL_VERSION, type VersionReply } from "@framelink/plugin/protocol";

// The compatibility policy for the version handshake. On connect the plugin reports its versions
// (GET_VERSION → VERSION); the server gates them here and, on any mismatch, REFUSES to drive it and
// tells the human which side to update. The protocol and its changelog live in the plugin's protocol
// module, built into both sides from one file, so the server requires exactly the version it was
// built with — a newer plugin's FlcmHost is as foreign to this server's preamble as an older one's.
// pluginVersion is the release string, shown to the human; gating is by protocol.

/**
 * Where a connection stands with the version handshake.
 *
 * `checking` is the state that matters: GET_VERSION is asked the instant a plugin connects, but the
 * answer is a round-trip away, and a canvas request landing inside that window must HOLD rather than
 * be sent. Letting it through is how a mismatched plugin ends up executing agent code against a
 * wire contract the server no longer speaks — the refusal below can only refuse what it is asked
 * about first.
 */
export type ProtocolCompatibility = "checking" | "compatible" | "incompatible";

/**
 * The refusal text for a plugin this server won't drive, or null when it speaks this server's exact
 * protocol. `null`
 * is a plugin that never answered GET_VERSION with a VERSION (one predating the handshake ERRORs,
 * a silent one times out, a malformed answer parses to nothing).
 *
 * Every missing version is the FLOOR (protocol 0) and refused like any other older plugin: a
 * runtime that can't name its wire contract is exactly the runtime agent code must not run against.
 * A nudge appended to a result the plugin already executed would tell the human to update AFTER the
 * wrong runtime touched their document.
 */
export function refuseProtocolSkew(version: VersionReply | null): string | null {
  const protocol = version?.protocolVersion ?? 0;
  if (protocol === PROTOCOL_VERSION) return null;
  const reported = version?.pluginVersion
    ? `plugin v${version.pluginVersion} (protocol v${protocol})`
    : `the connected plugin (protocol v${protocol})`;
  const fix =
    protocol < PROTOCOL_VERSION
      ? `is older, so nothing was run. Fix: in Figma desktop, re-import the latest Framelink plugin ` +
        `(Plugins → Development → Import plugin from manifest…), re-open it, then retry.`
      : `is newer, so nothing was run. Fix: update this Framelink MCP server to the latest ` +
        `figma-developer-mcp, restart it, then retry.`;
  return (
    `⚠️ Framelink won't drive this Figma plugin: the server speaks protocol v${PROTOCOL_VERSION} and ` +
    `${reported} ${fix}`
  );
}
