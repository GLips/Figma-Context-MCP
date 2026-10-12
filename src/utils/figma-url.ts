import { tagError } from "~/utils/error-meta.js";

/**
 * A Figma node id as an agent may pass it: colon form from the API (`1234:5678`), dash form from
 * a URL's `node-id` (`1234-5678`), or a `;`-joined instance-override chain (`I5666:180910;1:10515`).
 * Shared by every tool schema; tools on zod v3 and v4 both build their schema from this pattern.
 */
export const FIGMA_NODE_ID_PATTERN = /^I?\d+[:-]\d+(?:;\d+[:-]\d+)*$/;
export const FIGMA_NODE_ID_FORMAT_MESSAGE =
  "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'";

/** A URL's `node-id` is dashed (`1-2`); the API matches only the colon form (`1:2`). */
export function normalizeFigmaNodeId(nodeId: string): string {
  return nodeId.replace(/-/g, ":");
}

export interface FigmaUrlParts {
  fileKey: string;
  nodeId: string | undefined;
}

// `/proto/` is the prototype presentation of an ordinary design file — same file key,
// same `/v1/files/{key}` response — so a pasted prototype link is worth accepting.
// `/board/` (FigJam) is deliberately absent: that endpoint answers, but with FigJam's
// own node vocabulary (STICKY, CONNECTOR, SHAPE_WITH_TEXT), which this server does not
// model. Refusing the URL beats emitting a design-shaped tree that says nothing.
const FIGMA_PATH_PATTERN = /^\/(file|design|proto)\/([a-zA-Z0-9]+)/;

export function parseFigmaUrl(input: string): FigmaUrlParts {
  const url = new URL(input);

  if (url.hostname !== "figma.com" && !url.hostname.endsWith(".figma.com")) {
    tagError(new Error(`Not a Figma URL: ${input}`), { category: "invalid_input" });
  }

  const match = url.pathname.match(FIGMA_PATH_PATTERN);
  if (!match) {
    tagError(new Error(`Could not extract file key from Figma URL: ${input}`), {
      category: "invalid_input",
    });
  }

  const fileKey = match[2];

  const rawNodeId = url.searchParams.get("node-id");
  const nodeId = rawNodeId ? normalizeFigmaNodeId(rawNodeId) : undefined;

  return { fileKey, nodeId };
}
