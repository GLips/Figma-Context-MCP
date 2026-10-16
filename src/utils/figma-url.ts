import { tagError } from "~/utils/error-meta.js";

declare const FIGMA_FILE_KEY: unique symbol;
declare const FIGMA_NODE_ID: unique symbol;

/**
 * A Figma file key or node id that passed the input edge: checked against its grammar, and a node
 * id normalized to the colon form the API matches. Only the constructors below mint one, plus
 * `FigmaService` for values Figma itself returns — so a Figma call can't be handed an unchecked
 * string from an agent or the CLI.
 */
export type FigmaFileKey = string & { readonly [FIGMA_FILE_KEY]: true };
export type FigmaNodeId = string & { readonly [FIGMA_NODE_ID]: true };

export const FIGMA_FILE_KEY_PATTERN = /^[a-zA-Z0-9]+$/;
export const FIGMA_FILE_KEY_FORMAT_MESSAGE = "File key must be alphanumeric";

/**
 * A Figma node id as an agent may pass it: colon form from the API (`1234:5678`), dash form from
 * a URL's `node-id` (`1234-5678`), or an instance sublayer chain (`I5666:180910;1:10515`). An
 * input-edge grammar, so it lives with the message and normalizer it pairs with, not in core.
 */
export const FIGMA_NODE_ID_PATTERN = /^I?\d+[:-]\d+(?:;\d+[:-]\d+)*$/;
export const FIGMA_NODE_ID_FORMAT_MESSAGE =
  "Node ID must be like '1234:5678' or 'I5666:180910;1:10515;1:10336'";

export function figmaFileKey(raw: string): FigmaFileKey {
  const fileKey = parseFigmaFileKey(raw);
  if (fileKey === null)
    tagError(new Error(FIGMA_FILE_KEY_FORMAT_MESSAGE), { category: "invalid_input" });
  return fileKey;
}

/** The same check for an edge that answers bad input with its own reply: null when it isn't a key. */
export function parseFigmaFileKey(raw: string): FigmaFileKey | null {
  return FIGMA_FILE_KEY_PATTERN.test(raw) ? (raw as FigmaFileKey) : null;
}

/** A URL's `node-id` is dashed (`1-2`); the API matches only the colon form (`1:2`). */
export function figmaNodeId(raw: string): FigmaNodeId {
  if (!FIGMA_NODE_ID_PATTERN.test(raw))
    tagError(new Error(FIGMA_NODE_ID_FORMAT_MESSAGE), { category: "invalid_input" });
  return raw.replace(/-/g, ":") as FigmaNodeId;
}

export interface FigmaUrlParts {
  fileKey: FigmaFileKey;
  nodeId: FigmaNodeId | undefined;
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

  const fileKey = figmaFileKey(match[2]);

  const rawNodeId = url.searchParams.get("node-id");
  const nodeId = rawNodeId ? figmaNodeId(rawNodeId) : undefined;

  return { fileKey, nodeId };
}
