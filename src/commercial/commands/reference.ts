/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { type Command, command } from "cleye";
import {
  buildReferenceMenu,
  buildReferenceSections,
  CLI_REFERENCE_CALL,
  SECTION_IDS,
} from "~/commercial/tools/flcm-docs/reference.js";
import { buildCommandHelp } from "~/utils/cli-help.js";

/** The CLI twin of get_flcm_reference: same sections, same menu on a bare call. */
export const referenceCommand: Command = command(
  {
    name: "reference",
    strictFlags: true,
    parameters: ["[sections...]"],
    help: buildCommandHelp({
      name: "reference",
      summary: "Print sections of the flcm authoring reference, for writing execute scripts",
      details: `Name one or more sections; start with ${SECTION_IDS[0]}. Several are printed together, in the order below.`,
      exampleArgs: [SECTION_IDS[0], "verbs props"],
      appendix: [{ title: "Sections:", body: buildReferenceMenu() }],
    }),
  },
  (argv) => {
    process.stdout.write(buildReferenceSections(argv._.sections, CLI_REFERENCE_CALL) + "\n");
  },
);
