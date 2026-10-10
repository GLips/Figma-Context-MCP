import { getErrorMeta } from "~/utils/error-meta.js";
import { HttpError } from "~/utils/fetch-json.js";
import { proxyMode, type ProxyMode } from "~/utils/proxy-env.js";

// Comments are a separate grant: a token that reads the file fine can still be refused its comments.
function missingScopeCause(endpoint: string): string {
  return endpoint.includes("/comments")
    ? "- The access token is missing the comments scope (File comments: Read, `file_comments:read`) — a token that can read the file may still lack it"
    : "- The access token is missing required scopes (File content: Read, Dev resources: Read)";
}

const FORBIDDEN_CAUSES = [
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
 * `isCredentialRejection` below is the one place that does match `err`.
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
    [causesHeader, missingScopeCause(endpoint), ...FORBIDDEN_CAUSES],
    [TROUBLESHOOTING_GUIDE],
    ...(body ? [[LLM_INSTRUCTIONS]] : []),
    ...(proxyHint ? [[proxyHint]] : []),
  ];

  return sections.map((section) => section.join("\n")).join("\n\n");
}

/**
 * Whether Figma refused the credential itself rather than access to a file: a 401, or a 403 whose
 * `err` names the token ("Invalid token", "Token expired"). The one deliberate match on Figma's
 * `err` wording, accepted because a miss is cheap in both directions: a false positive costs a
 * host one credential refetch; a false negative keeps a dead cached credential until its TTL.
 * `responseBody` is Figma's short JSON verbatim — whitespace-collapsed, far under the quote cap.
 */
export function isCredentialRejection(error: unknown): boolean {
  const status = getErrorMeta(error).http_status;
  if (status === 401) return true;
  if (status !== 403 || !(error instanceof HttpError) || !error.responseBody) return false;
  try {
    const { err } = JSON.parse(error.responseBody) as { err?: unknown };
    return typeof err === "string" && /\btoken\b/i.test(err);
  } catch {
    return false;
  }
}
