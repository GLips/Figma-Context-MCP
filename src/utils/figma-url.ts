export interface FigmaUrlParts {
  fileKey: string;
  nodeId: string | undefined;
}

const FIGMA_PATH_PATTERN = /^\/(file|design)\/([a-zA-Z0-9]+)/;

export function parseFigmaUrl(input: string): FigmaUrlParts {
  const url = new URL(input);

  if (!url.hostname.endsWith("figma.com")) {
    throw new Error(`Not a Figma URL: ${input}`);
  }

  const match = url.pathname.match(FIGMA_PATH_PATTERN);
  if (!match) {
    throw new Error(`Could not extract file key from Figma URL: ${input}`);
  }

  const fileKey = match[2];

  // Figma URLs encode node IDs with dashes (1-2), but the API expects colons (1:2)
  const rawNodeId = url.searchParams.get("node-id");
  const nodeId = rawNodeId ? rawNodeId.replace(/-/g, ":") : undefined;

  return { fileKey, nodeId };
}
