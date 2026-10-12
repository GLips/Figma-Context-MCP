import {
  loadEnvFile,
  requireGlobalCredential,
  resolveCredential,
  resolveProxy,
  UsageError,
} from "~/config.js";
import type { FigmaCredential } from "~/services/figma.js";
import { parseFigmaUrl } from "~/utils/figma-url.js";
import { installFigmaProxyDispatcher } from "~/utils/figma-proxy-dispatcher.js";

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
  env: {
    type: String,
    placeholder: "<file>",
    description: "Load environment variables from this file (default ./.env)",
  },
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

/**
 * The outbound-network bootstrap the server does at startup, for a REST command: load the env file,
 * route Figma traffic through the configured proxy, and resolve credentials. A CLI command has no
 * per-request credential channel (unlike HTTP mode), so it fails fast with an actionable error instead
 * of an HTTP-shaped one from `getAuthHeaders`.
 */
export function prepareRestCommand(flags: {
  env?: string;
  figmaApiKey?: string;
  figmaOauthToken?: string;
  proxy?: string;
}): FigmaCredential {
  loadEnvFile(flags.env);
  const credential = requireGlobalCredential(resolveCredential(flags));
  installFigmaProxyDispatcher(resolveProxy(flags).value);
  return credential;
}
