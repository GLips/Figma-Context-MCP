/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The same flcm docs reach an agent two ways: as MCP tool text (figma_execute_code, get_screenshot,
// get_flcm_reference) and as CLI help (execute, reference). Every sentence that names how to run
// code, take a screenshot or fetch more docs is spelled by the reader's channel, so neither reader
// is told to call something it doesn't have.
import { CLI_NAME } from "../../../utils/cli-help.js";

export interface DocsChannel {
  /** The request for some reference sections. */
  referenceCall(sectionIds: string[]): string;
  /** How to look at a node after building it: the markdown body of the "check what you built" recipe's how-to. */
  screenshotHowTo: string;
}

export const MCP_DOCS_CHANNEL: DocsChannel = {
  referenceCall: (ids) => `get_flcm_reference([${ids.map((id) => JSON.stringify(id)).join(", ")}])`,
  screenshotHowTo: `\`get_screenshot\` is a separate tool, not an \`flcm\` verb. Return the id from the build call, then pass it:

\`\`\`js
// figma_execute_code
session.card = await flcm.render(card);
return session.card.id;
\`\`\`

\`\`\`
// get_screenshot
{ "nodeId": "12:345" }             // the id you just returned
{ "key": "card" }                  // or a key you authored, resolved on the current page
{ "nodeId": "12:345", "scale": 3 } // 3× resolution, for fine detail
\`\`\``,
};

export const CLI_DOCS_CHANNEL: DocsChannel = {
  referenceCall: (ids) => `${CLI_NAME} reference ${ids.join(" ")}`,
  screenshotHowTo: `\`execute\` takes the screenshot after the script runs, even when the script failed. Give the root a \`key\` so you can target it without knowing its id:

\`\`\`sh
${CLI_NAME} execute card.js --screenshot out/card.png --key card
${CLI_NAME} execute card.js --screenshot out/card.png --node-id 12:345 --scale 3
\`\`\``,
};
