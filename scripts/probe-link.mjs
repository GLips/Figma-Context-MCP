/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The document a live probe drives, and the plugin link in it: paired at this terminal first if the
// plugin doesn't trust this state dir yet, proven over REST with FIGMA_API_KEY, and allowed in the
// plugin. FIGMA_FILE_KEY names the scratch file; without it, the plugin asks which file to use.

import { createInterface } from "node:readline/promises";
import { targetForPluginCall } from "../src/commercial/plugin-bridge/plugin-call-link.ts";
import { documentReaderFor } from "../src/commercial/plugin-bridge/link-documents.ts";
import { terminalPairingCodeAsker } from "../src/commercial/commands/terminal-pairing.ts";
import { FigmaService, staticCredentialSource } from "../src/services/figma.ts";
import { figmaFileKey } from "../src/utils/figma-url.ts";
import { mintSessionHandle } from "../src/commercial/plugin-bridge/session-handle.ts";
import { mintExecutionId } from "../src/commercial/execution-id.ts";

// A person may be finding the plugin window: long enough not to rush them.
const PROBE_GRANT_WAIT_MS = 10 * 60_000;

/** Pair if needed, prove the file and wait for Allow, or throw why there is no target. */
export async function targetForProbe(bridge, log) {
  const token = process.env.FIGMA_API_KEY;
  if (!token)
    throw new Error(
      "Set FIGMA_API_KEY: the probe proves which file the plugin is in by reading it over REST.",
    );
  const reader = documentReaderFor(
    new FigmaService(staticCredentialSource({ kind: "pat", token })),
  );
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  let targeted;
  try {
    targeted = await targetForPluginCall(bridge, {
      fileKey: process.env.FIGMA_FILE_KEY ? figmaFileKey(process.env.FIGMA_FILE_KEY) : null,
      session: null,
      pairing: { kind: "offer", ask: terminalPairingCodeAsker(lines) },
      signal: new AbortController().signal,
      surface: "cli",
      reader,
      waitMs: PROBE_GRANT_WAIT_MS,
      onWaiting: () => {
        log("waiting for Allow (or a file pick) in the Framelink plugin");
        return async () => {};
      },
    });
  } finally {
    lines.close();
  }
  if (targeted.kind === "blocked")
    throw new Error(
      targeted.block === "incompatible"
        ? `${targeted.text} Run \`pnpm build:plugin\` in THIS worktree and re-import plugin/manifest.json from here.`
        : targeted.text,
    );
  log(`granted on "${targeted.document.fileName}" (${targeted.document.fileKey})`);
  return { link: targeted.link, document: targeted.document };
}

/**
 * Run probe code in the target's document, in a fresh session. A plugin refusal throws; it means
 * nothing ran.
 */
export async function executeOnProbeTarget(bridge, { link, document }, fields) {
  const reply = await bridge.submitRun(
    link,
    {
      type: "EXECUTE_CODE",
      fileKey: document.fileKey,
      session: { handle: mintSessionHandle(), create: true },
      ...fields,
    },
    mintExecutionId(),
  );
  if (reply.type !== "EXECUTE_CODE_RESULT")
    throw new Error(
      `the plugin refused the run (${reply.type === "NOT_GRANTED" ? reply.reason : reply.type}); nothing executed.`,
    );
  return reply;
}
