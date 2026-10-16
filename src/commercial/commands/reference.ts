/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { type Command, command } from "cleye";
import { WS_PORT_BLOCK } from "@framelink/plugin/protocol";
import { PluginBridge } from "~/commercial/plugin-bridge/bridge.js";
import { referenceDocumentsNote } from "~/commercial/plugin-bridge/reference-documents-note.js";
import {
  buildReferenceMenu,
  buildReferenceSections,
  SECTION_IDS,
} from "~/commercial/tools/flcm-docs/reference.js";
import { CLI_DOCS_CHANNEL } from "~/commercial/tools/flcm-docs/channels.js";
import { buildCommandHelp } from "~/utils/cli-help.js";
import { pluginWaitMs, waitForPluginConnection } from "./plugin-wait.js";

// A listing is a glance, not a run: it waits briefly for a plugin, not the execute default.
const FILES_WAIT_SECONDS = 20;
// Long enough for every connected plugin's introduction and grant answer.
const FILES_LOOKUP_MS = 5_000;

/**
 * The CLI twin of get_flcm_reference: same sections, same menu on a bare call, and with --files the
 * same open-file list the tool leads with. Only --files starts a relay; the docs need none.
 */
export const referenceCommand: Command = command(
  {
    name: "reference",
    strictFlags: true,
    parameters: ["[sections...]"],
    help: buildCommandHelp({
      name: "reference",
      summary: "Print sections of the flcm authoring reference, for writing execute scripts",
      details: `Name one or more sections; start with ${SECTION_IDS[0]}. Several are printed together, in the order below.
--files first lists the Figma files open with the Framelink plugin and their document ids, for
\`execute --document\`; it waits for the plugin to connect, and prints the list alone without sections.`,
      exampleArgs: [SECTION_IDS[0], "verbs props", "--files"],
      appendix: [{ title: "Sections:", body: buildReferenceMenu() }],
    }),
    flags: {
      files: {
        type: Boolean,
        description: "List the Figma files open with the Framelink plugin, with their document ids",
      },
      wait: {
        type: Number,
        placeholder: "<seconds>",
        description: `With --files, wait this long for the plugin to connect (default ${FILES_WAIT_SECONDS})`,
      },
    },
  },
  (argv) => {
    runReference(argv.flags, argv._.sections).then(
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

export async function runReference(
  { files, wait }: { files?: boolean; wait?: number },
  sections: string[],
  { bridge = new PluginBridge() }: { bridge?: PluginBridge } = {},
): Promise<number> {
  if (files) {
    const waitMs = pluginWaitMs(wait ?? FILES_WAIT_SECONDS);
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error("Interrupted"));
    process.once("SIGINT", interrupt);
    try {
      bridge.start(WS_PORT_BLOCK);
      await waitForPluginConnection(bridge, waitMs, controller.signal, "no files were listed");
      process.stdout.write((await referenceDocumentsNote(bridge, "cli", FILES_LOOKUP_MS)) + "\n");
    } finally {
      process.removeListener("SIGINT", interrupt);
      bridge.stop();
    }
    if (!sections.length) return 0;
    process.stdout.write("\n");
  }
  process.stdout.write(buildReferenceSections(sections, CLI_DOCS_CHANNEL) + "\n");
  return 0;
}
