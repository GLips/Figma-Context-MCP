// The localhost WS port block. Each server probe-binds the FIRST free port in this block
// (advancing on EADDRINUSE — see PluginBridge.start), so N concurrent sessions land on N
// distinct ports the plugin can scan and list (Phase 3). The server binds IPv4 loopback only.
//
// THIS IS THE SINGLE SOURCE OF TRUTH for the block. Two consumers MUST mirror it:
//   • plugin/manifest.json networkAccess.devAllowedDomains — one `ws://localhost:<port>` entry
//     per port. The entries use the `localhost` hostname, NOT the 127.0.0.1 literal: Figma's manifest
//     validator rejects raw IP addresses ("must be a valid URL"), and the allowlist host must match
//     the host ui.html dials. Figma has NO port wildcard/range and a host-only entry matches only
//     port 80, so every port is listed explicitly (the contract harness pins this mirror so it can't drift).
//   • plugin/ui.html — dials the base port today; Phase 3 Slice 3.2 generalizes it to scan the block.
//
// Base stays 9876 (the pre-range single port) so the unchanged ui.html keeps connecting; the block is
// kept clear of well-trodden dev ports (3000 / 5173 / 8080 / 9222 / 9229) so a foreign service rarely
// answers the scan. Widening the block is a one-line COUNT bump here + matching manifest entries.
//
// BASE/COUNT are the construction knobs and stay module-local: the block is the ONLY thing consumers
// get, so they can't fragment the SSOT by depending on the base or count directly.
const BASE = 9876;
const COUNT = 16;
export const WS_PORT_BLOCK: number[] = Array.from({ length: COUNT }, (_, i) => BASE + i);
