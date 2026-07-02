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

/** Mint a fresh 4-digit pairing code for one connection. */
export function mintPairingCode(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}
