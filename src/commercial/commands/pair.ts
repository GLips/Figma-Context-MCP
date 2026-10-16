/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { type Command, command } from "cleye";
import { createInterface } from "node:readline/promises";
import { WS_PORT_BLOCK } from "@framelink/plugin/protocol";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { pairPluginLink } from "~/commercial/plugin-bridge/plugin-call-link.js";
import { buildCommandHelp } from "~/utils/cli-help.js";
import {
  DEFAULT_PLUGIN_WAIT_SECONDS,
  pluginWaitMs,
  waitForPluginConnection,
} from "./plugin-wait.js";
import { terminalPairingCodeAsker } from "./terminal-pairing.js";

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
        description: `Wait this long for the plugin to connect (default ${DEFAULT_PLUGIN_WAIT_SECONDS})`,
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
  const waitMs = pluginWaitMs(wait);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", interrupt);
  const lines = createInterface({ input, output: process.stderr, terminal: false });
  try {
    console.error(`Waiting up to ${waitMs / 1000}s for the Framelink plugin in Figma.`);
    bridge.start(WS_PORT_BLOCK);
    await waitForPluginConnection(bridge, waitMs, controller.signal, "nothing was paired");
    const pairing = await pairPluginLink(
      bridge,
      terminalPairingCodeAsker(lines),
      controller.signal,
      "cli",
    );
    if (pairing.kind === "blocked") {
      console.error(`Not paired. ${pairing.text}`);
      return 1;
    }
    if (pairing.kind === "already-paired") {
      console.error("Already paired: the Framelink plugin trusts this machine. Nothing to do.");
      return 0;
    }
    console.error(
      "Paired. Framelink servers and execute runs on this machine can now reach the plugin.",
    );
    return 0;
  } finally {
    process.removeListener("SIGINT", interrupt);
    lines.close();
    bridge.stop();
  }
}
