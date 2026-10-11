import { loadEnvFile, requireGlobalCredentials, resolveAuth, UsageError } from "~/config.js";
import type { FigmaAuthOptions } from "~/services/figma.js";
import { parseFigmaUrl } from "~/utils/figma-url.js";

/** Flags every REST-backed command takes: where the file is and how to authenticate. */
export const REST_COMMAND_FLAGS = {
  fileKey: {
    type: String,
    placeholder: "<key>",
    description: "Figma file key; overrides the URL's",
  },
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
  env: {
    type: String,
    placeholder: "<file>",
    description: "Load environment variables from this file (default ./.env)",
  },
} as const;

/** The file and node a command targets: flags win over the URL's. */
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
  // A node id copied from a URL's node-id is dashed; a read matches the API's colon form exactly.
  return { fileKey, nodeId: nodeId?.replace(/-/g, ":") };
}

/**
 * A CLI command has no per-request credential channel (unlike HTTP mode), so it fails fast with an
 * actionable error instead of an HTTP-shaped one from `getAuthHeaders`.
 */
export function resolveRestAuth(flags: {
  env?: string;
  figmaApiKey?: string;
  figmaOauthToken?: string;
}): FigmaAuthOptions {
  loadEnvFile(flags.env);
  const auth = resolveAuth(flags);
  requireGlobalCredentials(auth);
  return auth;
}
