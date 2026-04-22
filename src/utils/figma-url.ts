import { tagError } from "~/utils/error-meta.js";

export interface FigmaUrlParts {
  fileKey: string;
  nodeId: string | undefined;
}

const FIGMA_PATH_PATTERN = /^\/(file|design)\/([a-zA-Z0-9]+)/;

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

  // Figma URLs encode node IDs with dashes (1-2), but the API expects colons (1:2)
  const rawNodeId = url.searchParams.get("node-id");
  const nodeId = rawNodeId ? rawNodeId.replace(/-/g, ":") : undefined;

  return { fileKey, nodeId };
}
