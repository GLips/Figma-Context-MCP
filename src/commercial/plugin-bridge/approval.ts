/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Phase 2 consent gate — the server's half of session identity + pairing code.
//
// The plugin is the sole arbiter (Invariant): it owns the durable approval decision. The
// server only *introduces itself* so the human in Figma can recognize and approve the
// session, and mints the optional anti-squatter check.
//
//   • SESSION_IDENTITY — the project path the server runs in. This is a human-readable LABEL
//     the human recognizes in the arbiter panel ("only approve sessions you started") — NOT an
//     auth key. It is observable and forgeable (a squatter can announce the same path), so
//     sticky approval keys on the sandbox-minted session token, not on this. The token lives on
//     PluginBridge (handed over on Allow, echoed in SESSION_INFO); identity stays just the label.
//   • pairing code — minted FRESH per WS connection. Shown in both the panel and the pending
//     tool result so a careful human can compare them and catch a squatter; a human who
//     doesn't care can just Allow. Consent is the gate; the code is the optional check, so
//     it is deliberately low-entropy (a 4-digit glance-and-compare, not a secret).

export const SESSION_IDENTITY = process.cwd();

/**
 * The Authorizing User: the human who clicked Allow for this session in the plugin, as `figma.currentUser`
 * reported them at that moment. Every write the session makes is attributed to this `figmaUserId`
 * (licensing/LICENSE-Framelink-Commercial.md, "Limit of the grant") — the free allowance is counted against it and a seat
 * is looked up for it. `name` is display-only.
 */
export interface AuthorizingUser {
  figmaUserId: string;
  name: string;
}

/** Read an Authorizing User off untrusted plugin JSON; anything without a Figma user id is no Authorizing User. */
export function parseAuthorizingUser(value: unknown): AuthorizingUser | null {
  if (typeof value !== "object" || value === null) return null;
  const { figmaUserId, name } = value as { figmaUserId?: unknown; name?: unknown };
  if (typeof figmaUserId !== "string" || figmaUserId.length === 0) return null;
  return { figmaUserId, name: typeof name === "string" ? name : "" };
}

/** Mint a fresh 4-digit pairing code for one connection. */
export function mintPairingCode(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}
