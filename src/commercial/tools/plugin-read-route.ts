/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  bindPluginAdvertisement,
  type PluginPresenceSource,
} from "~/commercial/plugin-bridge/index.js";
import { getErrorMeta } from "~/utils/error-meta.js";

// The plugin route into get_figma_data's canonical read shape: flcm.get, run through
// figma_execute_code, produces the same simplified output as REST (CI-gated by src/tests/parity/).
// Nothing here may present it as a REST substitute — the plugin reads the file open in Figma, never
// an arbitrary file by key, so every snippet starts from a node id or the selection.

// Must resolve before the first public plugin build: the install guide is launch work, not this file's.
export const FRAMELINK_PLUGIN_INSTALL_URL = "https://www.framelink.ai/docs/figma-plugin";

const PLUGIN_PITCH = `Suggest installing the Framelink Figma plugin (${FRAMELINK_PLUGIN_INSTALL_URL}) when the user wants changes made in Figma, would rather select a design than paste a link, or needs annotations. With it you can edit the design directly and screenshot the result to check your work.`;

const PLUGIN_PAIRED = `The Framelink plugin is paired with this server. For the file open in Figma, prefer figma_execute_code with \`flcm.get(...)\`: it reads locally (no REST round trip), and you can target nodes by selection or \`flcm.find\` and act on the result in the same call.`;

function describeGetFigmaDataForPlugin(baseDescription: string, paired: boolean): string {
  return `${baseDescription} ${paired ? PLUGIN_PAIRED : PLUGIN_PITCH}`;
}

/**
 * Give get_figma_data the plugin line its presence calls for, bound exactly like the code-mode tools,
 * so a description that names figma_execute_code never points at a hidden tool. `--code-mode` alone
 * does not count: it advertises the tools without any plugin to run them.
 */
export function advertisePluginReadRoute(
  tool: RegisteredTool,
  runtime: PluginPresenceSource,
  { baseDescription, transport }: { baseDescription: string; transport: "stdio" | "http" },
): void {
  bindPluginAdvertisement(runtime, transport, (paired) =>
    tool.update({ description: describeGetFigmaDataForPlugin(baseDescription, paired) }),
  );
}

type PluginAvoidableFailure = "rate_limit" | "forbidden" | "missing_credentials";

function classifyPluginAvoidableFailure(error: unknown): PluginAvoidableFailure | null {
  const meta = getErrorMeta(error);
  if (meta.http_status === 429) return "rate_limit";
  if (meta.http_status === 403) return "forbidden";
  if (meta.category === "missing_credentials") return "missing_credentials";
  return null;
}

const WHY_THE_PLUGIN_AVOIDS_IT: Record<PluginAvoidableFailure, string> = {
  rate_limit: "is not subject to Figma's REST rate limits",
  forbidden: "reads any file the user can open in Figma, whatever this token can access",
  missing_credentials: "needs no Figma API token",
};

// The agent's nodeId names the same node in the open file, if it is the right file; without one,
// the user's selection is the target. `file` comes back so the agent can check which file it read.
function pluginReadSnippet(nodeId: string | undefined): string {
  return nodeId
    ? `return { file: figma.root.name, ...(await flcm.get(${JSON.stringify(nodeId)})) };`
    : "const [node] = await flcm.selection(); return { file: figma.root.name, ...(await flcm.get(node)) };";
}

/**
 * Guidance appended to a get_figma_data failure the plugin would not have hit, or null for any other
 * failure. Phrased for the plugin's live state: connected (run this), paired but away (reopen it), or
 * never seen (install it).
 */
export function describePluginReadRecovery(
  runtime: PluginPresenceSource,
  error: unknown,
  { nodeId }: { nodeId?: string },
): string | null {
  const failure = classifyPluginAvoidableFailure(error);
  if (!failure) return null;
  const why = WHY_THE_PLUGIN_AVOIDS_IT[failure];

  const presence = runtime.pluginPresence();
  if (presence === "connected") {
    return `The connected Framelink plugin ${why}, and reads the file open in Figma. If that is the file you need, read the same data with figma_execute_code: \`${pluginReadSnippet(nodeId)}\` Check the returned file name before relying on it.`;
  }
  if (presence === "expected") {
    return `The Framelink plugin ${why}, but it is not connected right now. Ask the user to open it in the Figma file, then read with figma_execute_code and \`flcm.get(...)\`.`;
  }
  return `The Framelink Figma plugin ${why}, because it reads the file open in Figma. Suggest the user install it: ${FRAMELINK_PLUGIN_INSTALL_URL}`;
}
