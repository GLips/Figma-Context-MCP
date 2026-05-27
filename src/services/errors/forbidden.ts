import { HttpError } from "~/utils/fetch-json.js";
import { proxyMode, type ProxyMode } from "~/utils/proxy-env.js";

const FORBIDDEN_CAUSES = [
  "- The access token is missing required scopes (File content: Read, Dev resources: Read)",
  "- The access token has been revoked, mistyped, or (for OAuth) expired — PATs don't expire, OAuth tokens do",
  "- The access token doesn't have permission to this specific file — it must be owned by or shared with the token's account, and for team/org files the account must belong to that team",
  "- The file's share settings don't allow viewers to copy/share/export",
  "- An HTTP intermediary (corporate proxy, firewall, VPN) rejected the request before it reached Figma",
];

const FORBIDDEN_CAUSES_HEADER_WITH_BODY =
  "Depending on the specific error message above, the issue may be one of the following:";
const FORBIDDEN_CAUSES_HEADER_WITHOUT_BODY = "The issue is typically one of the following:";

const TROUBLESHOOTING_GUIDE =
  "Troubleshooting guide: https://www.framelink.ai/docs/troubleshooting#cannot-access-file";

const LLM_INSTRUCTIONS =
  "Instructions: explain the specific reason from the response body above to the user in plain language and walk them through resolving it.";

const PROXY_HINTS: Record<ProxyMode, string | undefined> = {
  none: undefined,
  explicit:
    "Note: this server is configured to route requests through an explicit proxy (--proxy/FIGMA_PROXY). If the proxy may be the source of the 403, unset it, change it to --proxy=none, or bypass it for this host.",
  env: "Note: this server picked up a proxy from HTTP_PROXY/HTTPS_PROXY in your environment. If the proxy may be the source of the 403, set NO_PROXY=api.figma.com, pass --proxy=none, or unset HTTP_PROXY/HTTPS_PROXY.",
};

/**
 * Build a user-facing 403 message. Figma returns distinct `err` strings for
 * distinct causes (missing PAT scopes, expired OAuth token, un-exportable
 * file, etc.) and each has a different fix. We surface the response body
 * verbatim when we have it and list the common causes it could map to —
 * rather than string-matching here (fragile as Figma's wording drifts) or
 * dumping only a canned list (which is often generic for the specific case).
 * Full per-error resolution steps live in the docs so they can be updated
 * without a release.
 */
export function buildForbiddenMessage(endpoint: string, error: unknown): string {
  const body = error instanceof HttpError ? error.responseBody : undefined;
  const proxyHint = PROXY_HINTS[proxyMode()];
  const causesHeader = body
    ? FORBIDDEN_CAUSES_HEADER_WITH_BODY
    : FORBIDDEN_CAUSES_HEADER_WITHOUT_BODY;

  const sections: string[][] = [
    [
      `Request to Figma API endpoint '${endpoint}' returned 403 Forbidden.`,
      ...(body ? [`Response body: ${body}`] : []),
    ],
    [causesHeader, ...FORBIDDEN_CAUSES],
    [TROUBLESHOOTING_GUIDE],
    ...(body ? [[LLM_INSTRUCTIONS]] : []),
    ...(proxyHint ? [[proxyHint]] : []),
  ];

  return sections.map((section) => section.join("\n")).join("\n\n");
}
