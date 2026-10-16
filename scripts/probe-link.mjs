/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The link a live probe drives: the one authenticated plugin, paired at this terminal first if the
// plugin doesn't trust this state dir yet. Refuses rather than guesses when two files are open.

import { createInterface } from "node:readline/promises";
import { DEFAULT_FRAMELINK_API_URL } from "../src/config.ts";
import { linkForPluginCall } from "../src/commercial/plugin-bridge/plugin-call-link.ts";
import { terminalPairingCodeAsker } from "../src/commercial/commands/terminal-pairing.ts";

/** Resolve (pairing if needed) and introduce the plugin link, or throw why there is none. */
export async function linkForProbe(bridge, log) {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  let linked;
  try {
    linked = await linkForPluginCall(
      bridge,
      terminalPairingCodeAsker(lines),
      new AbortController().signal,
      "cli",
    );
  } finally {
    lines.close();
  }
  if (linked.kind === "blocked")
    throw new Error(
      linked.block === "incompatible"
        ? `${linked.text} Run \`pnpm build:plugin\` in THIS worktree and re-import plugin/manifest.json from here.`
        : linked.text,
    );
  log("plugin authenticated — introducing the session");
  await bridge.request(linked.link, bridge.sessionInfo(DEFAULT_FRAMELINK_API_URL));
  return linked.link;
}
