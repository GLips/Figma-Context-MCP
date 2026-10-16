/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { type Command, command } from "cleye";
import { createInterface, type Interface } from "node:readline/promises";
import { WS_PORT_BLOCK } from "@framelink/plugin/protocol";
import { UsageError } from "~/config.js";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import {
  approvalGuidance,
  pairingRateLimitedText,
  pluginDisconnectedAction,
} from "~/commercial/plugin-bridge/blocked-call-guidance.js";
import { unlinkedGuidanceState } from "~/commercial/plugin-bridge/session-guidance.js";
import { buildCommandHelp } from "~/utils/cli-help.js";

const DEFAULT_WAIT_SECONDS = 600;

/** The CLI twin of pair_figma_plugin: one whole pairing attempt, confirmed at this terminal. */
export const pairCommand: Command = command(
  {
    name: "pair",
    strictFlags: true,
    help: buildCommandHelp({
      name: "pair",
      summary:
        "Pair the Framelink plugin in Figma with this machine, so servers and execute can drive it",
      details: `Open the Framelink plugin in Figma first. The plugin panel shows a pairing code, and so does
this command; answer y only if they match. Pairing is remembered for every server and execute run
that shares this machine's Framelink state directory (FRAMELINK_STATE_DIR), so it is needed once.

Exits 0 when the plugin is paired (or already was), 1 otherwise.`,
      exampleArgs: ["", "--wait 60"],
    }),
    flags: {
      wait: {
        type: Number,
        placeholder: "<seconds>",
        description: `Wait this long for the plugin to connect (default ${DEFAULT_WAIT_SECONDS})`,
      },
    },
  },
  (argv) => {
    runPair(argv.flags).then(
      (code) => {
        process.exitCode = code;
      },
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    );
  },
);

/**
 * Pair from a terminal. Its own relay runs the whole attempt, so the code it prints is the code its
 * own link shows — never one a server process minted. Every answer but `y` is No.
 */
export async function runPair(
  { wait }: { wait?: number },
  {
    input = process.stdin,
    bridge = new PluginBridge(),
  }: { input?: NodeJS.ReadableStream; bridge?: PluginBridge } = {},
): Promise<number> {
  const waitMs = (wait ?? DEFAULT_WAIT_SECONDS) * 1000;
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 2_147_483_647)
    throw new UsageError(
      "--wait must be a finite, nonnegative number of seconds within the timer range.",
    );
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", interrupt);
  const lines = createInterface({ input, output: process.stderr, terminal: false });
  try {
    console.error(`Waiting up to ${waitMs / 1000}s for the Framelink plugin in Figma.`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Blocked: no Figma plugin connected before --wait expired. ${pluginDisconnectedAction()}`,
            ),
          ),
        waitMs,
      );
      bridge.start(WS_PORT_BLOCK, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const resolution = await bridge.resolveLink(controller.signal);
    if (resolution.kind === "linked" || resolution.kind === "several") {
      console.error("Already paired: the Framelink plugin trusts this machine. Nothing to do.");
      return 0;
    }
    if (resolution.kind !== "unpaired")
      throw new Error(approvalGuidance(unlinkedGuidanceState(resolution), "cli"));
    const offer = await bridge.offerPairing();
    if (offer.kind === "rate-limited") throw new Error(pairingRateLimitedText(offer.retryAfterMs));
    if (offer.kind === "none") {
      const settled = await bridge.resolveLink(controller.signal);
      if (settled.kind !== "linked")
        throw new Error("The Framelink plugin disconnected before pairing.");
      console.error("Already paired: the Framelink plugin trusts this machine. Nothing to do.");
      return 0;
    }
    for (const { code, expiresAt } of offer.attempts) {
      const shown = await confirmCodeShown(lines, code, expiresAt - Date.now(), controller.signal);
      if (!shown) {
        bridge.declinePairing(code);
        continue;
      }
      const confirmed = await bridge.confirmPairing(code);
      if (confirmed.kind === "paired") {
        console.error(
          "Paired. Framelink servers and execute runs on this machine can now reach the plugin.",
        );
        return 0;
      }
      throw new Error(
        confirmed.kind === "failed"
          ? confirmed.reason
          : `The pairing code ${code} expired before it was confirmed. Run pair again.`,
      );
    }
    console.error(
      "Not paired: no code was confirmed. If the panel showed a different code, something other than the plugin may be connected.",
    );
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    lines.close();
    bridge.stop();
  }
}

/** Ask whether the panel shows `code`. Only `y`/`yes` is a Yes; EOF, expiry and anything else are No. */
async function confirmCodeShown(
  lines: Interface,
  code: string,
  expiresInMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const expired = AbortSignal.timeout(Math.max(0, expiresInMs));
  const closed = new Promise<string>((resolve) => lines.once("close", () => resolve("")));
  const answer = await Promise.race([
    lines.question(
      `Does the Framelink plugin panel in Figma show the pairing code ${code}? [y/N] `,
      {
        signal: AbortSignal.any([signal, expired]),
      },
    ),
    closed,
  ]).catch(() => {
    if (signal.aborted) throw signal.reason;
    return "";
  });
  return /^\s*y(es)?\s*$/i.test(answer);
}
