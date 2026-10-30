import { UsageError } from "~/config.js";
import { parseFigmaUrl } from "~/utils/figma-url.js";

/** How a command authenticates to the Figma REST API and routes its traffic. */
export const FIGMA_REST_CREDENTIAL_FLAGS = {
  figmaApiKey: {
    type: String,
    placeholder: "<token>",
    description: "Figma personal access token (env FIGMA_API_KEY)",
  },
  figmaOauthToken: {
    type: String,
    placeholder: "<token>",
    description:
      "Figma OAuth bearer token; used instead of the API key when set (env FIGMA_OAUTH_TOKEN)",
  },
  proxy: {
    type: String,
    placeholder: "<url>",
    description:
      "Proxy for Figma API calls, e.g. http://proxy:8080; 'none' ignores HTTP(S)_PROXY (env FIGMA_PROXY)",
  },
} as const;

/** Flags every REST-backed command takes: where the file is and how to authenticate. */
export const REST_COMMAND_FLAGS = {
  fileKey: {
    type: String,
    placeholder: "<key>",
    description: "Figma file key; overrides the URL's",
  },
  ...FIGMA_REST_CREDENTIAL_FLAGS,
} as const;

/**
 * The file and node a command targets: flags win over the URL's. Unbranded on purpose: each command
 * validates them with its tool's own parser (comments' node flag is a comma-separated list).
 */
export function resolveRestTarget(
  url: string | undefined,
  flags: { fileKey?: string; nodeId?: string },
): { fileKey: string; nodeId: string | undefined } {
  let { fileKey, nodeId } = flags;
  if (url) {
    try {
      const parsed = parseFigmaUrl(url);
      fileKey ??= parsed.fileKey;
      nodeId ??= parsed.nodeId;
    } catch (error) {
      if (!fileKey) throw error;
      // fileKey provided via flag — malformed URL is non-fatal
    }
  }
  if (!fileKey) throw new UsageError("Either a Figma URL or --file-key is required");
  return { fileKey, nodeId };
}
