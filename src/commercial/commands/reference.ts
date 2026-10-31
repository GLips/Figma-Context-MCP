/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { command } from "cleye";
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
import { defineCliCommand } from "~/commands/cli-command.js";
import { printCliFailure, type CliCommandContext } from "~/commands/cli-context.js";
import { captureObservedCall, type ToolEventProperties } from "~/telemetry/index.js";
import type { OperationCall } from "~/utils/observed-operation.js";
import { pluginWaitDeadline, waitForPluginConnection } from "./plugin-wait.js";

// A listing is a glance, not a run: it waits briefly for a plugin, not the execute default.
const FILES_WAIT_SECONDS = 20;
// Long enough for every connected plugin's introduction and grant answer.
const FILES_LOOKUP_MS = 5_000;

/**
 * The CLI twin of get_flcm_reference: same sections, same menu on a bare call, and with --files the
 * same open-file list the tool leads with. Only --files starts a relay; the docs need none.
 */
export const referenceCommand = defineCliCommand(
  command({
    name: "reference",
    strictFlags: true,
    parameters: ["[sections...]"],
    help: buildCommandHelp({
      name: "reference",
      summary: "Print sections of the flcm authoring reference, for writing execute scripts",
      details: `Name one or more sections; start with ${SECTION_IDS[0]}. Several are printed together, in the order below.
--files first lists the Figma files open with the Framelink plugin and their document ids, for
\`execute --document\`; it waits for the plugin to connect, and until about 17s after starting so every
other open plugin can reconnect. Without sections it prints the list alone; it exits 1 if no list was printed.`,
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
  }),
  (argv, context) => runReference(argv.flags, argv._.sections, context),
);

export async function runReference(
  { files, wait }: { files?: boolean; wait?: number },
  sections: string[],
  { signal, observe }: Pick<CliCommandContext, "signal" | "observe">,
  { bridge = new PluginBridge() }: { bridge?: PluginBridge } = {},
): Promise<number> {
  const deadline = files ? pluginWaitDeadline(wait ?? FILES_WAIT_SECONDS) : 0;
  return observe(
    "get_flcm_reference",
    captureObservedCall,
    async (call: OperationCall<ToolEventProperties>) => {
      call.record({ section_count: sections.length });
      let listed = true;
      if (files) {
        try {
          bridge.start(WS_PORT_BLOCK);
          const unconnected = await waitForPluginConnection(
            bridge,
            deadline,
            signal,
            "no files were listed",
          );
          if (unconnected !== null) return printCliFailure(unconnected);
          const note = await referenceDocumentsNote(bridge, "cli", FILES_LOOKUP_MS);
          listed = note.listed;
          process.stdout.write(note.text + "\n");
        } finally {
          bridge.stop();
        }
        if (!sections.length) return listed ? 0 : 1;
        process.stdout.write("\n");
      }
      process.stdout.write(buildReferenceSections(sections, CLI_DOCS_CHANNEL) + "\n");
      return listed ? 0 : 1;
    },
  );
}
