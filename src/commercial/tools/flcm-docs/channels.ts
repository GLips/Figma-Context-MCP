/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The same flcm docs reach an agent two ways: as MCP tool text (figma_execute_code, get_screenshot,
// get_flcm_reference) and as CLI help (execute, reference). Every sentence that names how to run
// code, take a screenshot, read comments or fetch more docs is spelled by the reader's channel, so
// neither reader is told to call something it doesn't have.
import { CLI_NAME } from "../../../utils/cli-help.js";

export interface DocsChannel {
  /** The request for some reference sections. */
  referenceCall(sectionIds: string[]): string;
  /** How to look at a node after building it: the markdown body of the "check what you built" recipe's how-to. */
  screenshotHowTo: string;
  /** Completes "a read's `comments: n` counts the unresolved threads pinned on that node; …". */
  commentsHowTo: string;
  /** The quick-start's line on running a script from a file; null where every run already does. */
  savedScriptHowTo: string | null;
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
  commentsHowTo: "the `get_figma_comments` tool reads them, given the node's id in `scope`",
  savedScriptHowTo: `LONG SCRIPT? Pass scriptPath to a .js file in the asset root; resend after fixes. Elsewhere, send code or run \`npx ${CLI_NAME} execute <file>\`.`,
};

export const CLI_DOCS_CHANNEL: DocsChannel = {
  referenceCall: (ids) => `${CLI_NAME} reference ${ids.join(" ")}`,
  // Every execute runs its script before the screenshot, so a second look must not rerun the build.
  screenshotHowTo: `\`execute\` takes the screenshot after the script runs, even when the script failed. Give the root a \`key\` so the first run can target it before you know its id:

\`\`\`sh
# build and look in one run
${CLI_NAME} execute card.js --screenshot out/card.png --key card

# look again, closer: every run executes its script, so use one that changes nothing
echo 'return' > look.js
${CLI_NAME} execute look.js --screenshot out/card@3x.png --node-id 12:345 --scale 3
\`\`\``,
  commentsHowTo: `\`${CLI_NAME} comments --file-key <fileKey> --node-id <id>\` reads them`,
  savedScriptHowTo: null,
};
