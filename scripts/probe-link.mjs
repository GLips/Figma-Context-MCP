/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The link a live probe drives: the one authenticated plugin, paired at this terminal first if the
// plugin doesn't trust this state dir yet. Refuses rather than guesses when two files are open.

import { createInterface } from "node:readline/promises";
import { DEFAULT_FRAMELINK_API_URL } from "../src/config.ts";

/** Resolve (pairing if needed) and introduce the plugin link, or throw why there is none. */
export async function linkForProbe(bridge, log) {
  let resolution = await bridge.resolveLink();
  if (resolution.kind === "unpaired") resolution = await pairAtTerminal(bridge, log);
  if (resolution.kind === "several")
    throw new Error(
      `${resolution.count} Figma files have the plugin open — close all but the scratch file.`,
    );
  if (resolution.kind === "incompatible")
    throw new Error(
      `${resolution.refusal} Run \`pnpm build:plugin\` in THIS worktree and re-import plugin/manifest.json from here.`,
    );
  if (resolution.kind !== "linked") throw new Error(`no usable plugin link (${resolution.kind}).`);
  const link = resolution.link;
  log("plugin authenticated — introducing the session");
  await bridge.request(link, bridge.sessionInfo(DEFAULT_FRAMELINK_API_URL));
  return link;
}

async function pairAtTerminal(bridge, log) {
  const offer = await bridge.offerPairing();
  if (offer.kind !== "offered") return bridge.resolveLink();
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const { code } of offer.attempts) {
      const answer = await lines.question(
        `Does the Framelink panel show the pairing code ${code}? [y/N] `,
      );
      if (!/^\s*y(es)?\s*$/i.test(answer)) {
        bridge.declinePairing(code);
        continue;
      }
      const confirmed = await bridge.confirmPairing(code);
      if (confirmed.kind !== "paired") throw new Error(`pairing failed (${confirmed.kind}).`);
      log("paired");
      return { kind: "linked", link: confirmed.link };
    }
    throw new Error("no pairing code was confirmed.");
  } finally {
    lines.close();
  }
}
