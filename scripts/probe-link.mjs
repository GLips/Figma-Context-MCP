/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The document a live probe drives, and the plugin link in it: paired at this terminal first if the
// plugin doesn't trust this state dir yet, then allowed in the plugin. FIGMA_DOCUMENT names the
// scratch file by the document id the plugin stamped (a refusal lists them); FIGMA_FILE_KEY by its
// key, where the plugin build reports one. With neither, the one granted open file is used.

import { createInterface } from "node:readline/promises";
import { targetForPluginCall } from "../src/commercial/plugin-bridge/plugin-call-link.ts";
import { parseDocumentId } from "../src/commercial/plugin-bridge/document-id.ts";
import { terminalPairingCodeAsker } from "../src/commercial/commands/terminal-pairing.ts";
import { figmaFileKey } from "../src/utils/figma-url.ts";
import { mintSessionHandle } from "../src/commercial/plugin-bridge/session-handle.ts";
import { mintExecutionId } from "../src/commercial/execution-id.ts";

// A person may be finding the plugin window: long enough not to rush them.
const PROBE_GRANT_WAIT_MS = 10 * 60_000;

// What every probe run says it is for, in the plugin panel.
const PROBE_INTENT = "Live probe of the plugin link";

/** Pair if needed and wait for Allow, or throw why there is no target. */
export async function targetForProbe(bridge, log) {
  const { FIGMA_DOCUMENT, FIGMA_FILE_KEY } = process.env;
  const document = FIGMA_DOCUMENT ? parseDocumentId(FIGMA_DOCUMENT) : null;
  if (FIGMA_DOCUMENT && !document)
    throw new Error("FIGMA_DOCUMENT must be a document id exactly as Framelink listed it.");
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  let targeted;
  try {
    targeted = await targetForPluginCall(bridge, {
      intent: PROBE_INTENT,
      document,
      fileKey: FIGMA_FILE_KEY ? figmaFileKey(FIGMA_FILE_KEY) : null,
      session: null,
      pairing: { kind: "offer", ask: terminalPairingCodeAsker(lines) },
      signal: new AbortController().signal,
      surface: "cli",
      waitMs: PROBE_GRANT_WAIT_MS,
      onWaiting: () => {
        log("waiting for Allow (or a pick) in the Framelink plugin");
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
  log(`granted on "${targeted.document.fileName}" (document ${targeted.document.documentId})`);
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
      intent: PROBE_INTENT,
      documentId: document.documentId,
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
