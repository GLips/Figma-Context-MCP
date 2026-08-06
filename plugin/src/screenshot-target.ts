// screenshot-target — which node a get_screenshot call actually captures.
//
// Split out of code.ts's screenshot() so the resolution RULES (which fail loud) are separable from the
// export/reply plumbing (which needs a live sandbox). This is the sandbox side of the read-back surface:
// key→node resolution can only live here, since `pluginData('flcm/key')` is unreachable from the server.

import { readKey } from "./preamble/identity.js";

export interface ScreenshotTarget {
  nodeId?: string;
  key?: string;
  scale?: number;
}

/**
 * At most one target (the server rejects both at once), so: nodeId, else key, else the whole page.
 *
 * Scans the current page only: under `documentAccess: dynamic-page` that's the one page guaranteed
 * loaded, and a whole-document scan would have to load every page just to take a picture.
 *
 * A key that matches nothing, or more than one node, THROWS. It must never fall through to a whole-page
 * capture — that silent substitution is the shape of the original bug this surface exists to close. The
 * page default fires only when no target was passed at all.
 */
export async function resolveScreenshotTarget({ nodeId, key }: ScreenshotTarget): Promise<BaseNode> {
  if (nodeId !== undefined) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) throw new Error(`No node found with id ${nodeId}`);
    return node;
  }
  if (key === undefined) return figma.currentPage;
  const matches = figma.currentPage.findAll((n) => readKey(n) === key);
  if (!matches.length) {
    throw new Error(
      `No node on the current page carries the flcm key "${key}". Keys are stamped by render() from a ` +
        `node's \`key\` prop — check the spelling, or screenshot by nodeId instead.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} nodes on the current page carry the flcm key "${key}", so the target is ` +
        `ambiguous (duplicating a node copies its key). Screenshot by nodeId instead, or re-render with ` +
        `unique keys.`,
    );
  }
  return matches[0];
}
