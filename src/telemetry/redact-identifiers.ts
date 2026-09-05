/**
 * Strip Figma file keys and node IDs out of free-text strings before they
 * leave the process as telemetry.
 *
 * Why this exists: `error_message` carries whatever a producer wrote into
 * `error.message`, and our most useful messages name the endpoint that failed
 * (`/files/<fileKey>/nodes?ids=<nodeId>`) or the node that was missing
 * (`Node 1:2 was not found`). Those strings identify a customer's document.
 * The structured fields (`error_category`, `http_status`, `network_code`)
 * already carry the analytics signal, so the identifiers are pure leak.
 *
 * Why scrub at the telemetry boundary rather than at each throw site: the
 * user-facing message is *supposed* to name the endpoint and the node — that
 * detail is how someone debugs a 403 or a stale link. Scrubbing here keeps the
 * two audiences separate (humans get the identifiers, PostHog doesn't) and
 * means a new error string somewhere in the codebase is covered by default
 * instead of only when its author remembers this rule.
 *
 * Each pattern also accepts the percent-encoded separators (`%2F`, `%3D`,
 * `%3A`, `%3F`, `%26`). Corporate proxies echo the blocked URL into their HTML
 * block page, `buildForbiddenMessage` splices that body verbatim into the 403
 * message, and those pages routinely encode the URL they're quoting — which is
 * precisely the 403-behind-a-proxy case this module exists for.
 */

export const REDACTED_FILE_KEY = "[REDACTED_FILE_KEY]";
export const REDACTED_NODE_ID = "[REDACTED_NODE_ID]";

/**
 * A file key following one of our two REST collections. Matched when it is
 * *either* long enough to be a real key (they're 22 base62 chars; nothing
 * shorter than 12 has been observed) *or* sitting in an unmistakable endpoint
 * context — followed by `/nodes`, `/images`, a query string, the quote that
 * closes an interpolated endpoint, or end of string.
 *
 * The two-branch shape is what keeps ordinary filesystem paths intact.
 * `download_figma_images` reports rejected `localPath` values through the same
 * `error_message` field, and `files/` and `images/` are everyday directory
 * names — a blanket `/(files|images)/\w+/` would turn `public/images/hero.png`
 * into noise and cost us the validation analytics that message exists for.
 */
const FILE_KEY_REST_PATH =
  /((?:\/|%2F)(?:files|images)(?:\/|%2F))(?:[A-Za-z0-9]{12,}|[A-Za-z0-9]+(?=(?:(?:\/|%2F)(?:nodes|images)\b)|[?'"]|%3F|$))/gi;

/**
 * A file key in a figma.com URL, which a user may paste as a tool argument and
 * see echoed back in an error. Anchored to the host on purpose: `design`,
 * `board`, `deck`, `slides` and `file` are all common directory names, and
 * `rest.ts`'s missing-node help text names `/proto/`, `/figjam/` and `/branch/`
 * in prose. Requiring `figma.com` first means only a real URL is rewritten.
 */
const FILE_KEY_WEB_URL =
  /(figma\.com(?:\/|%2F)(?:design|file|proto|board|slides|deck|figjam|branch)(?:\/|%2F))[A-Za-z0-9]+/gi;

/**
 * Query params whose value is one or more node IDs. Requires a leading
 * separator so the words can't match mid-token, and consumes the value up to
 * the next separator, quote, or angle bracket (the last for URLs quoted inside
 * an HTML block page).
 */
const NODE_ID_QUERY_PARAM = /((?:^|[\s?&]|%26|%3F)(?:ids|node-id|node_id))(?:=|%3D)[^&\s'"<>]*/gi;

/**
 * A bare Figma node ID in prose: `1:2`, `123:456`, the `I`-prefixed form used
 * for nodes inside instances, and `;`-joined instance paths (`I1:2;3:4`).
 *
 * The lookarounds keep this off colon-separated runs that aren't node IDs —
 * `127.0.0.1:8080`, `fetch-json.ts:75:11`, `12:30:45`. The port one is not
 * cosmetic: network failures are exactly what `proxy_mode` exists to analyze,
 * and the port is what separates "proxy refused" from "direct connect refused".
 *
 * Only the colon form is matched. The dash form (`1-2`) appears in figma.com
 * URLs, where it is always the value of `node-id=` and so is already covered
 * above; matching bare `\d+-\d+` anywhere would eat dates and ranges for no gain.
 */
const NODE_ID_TOKEN = /(?<![\w.:%-])I?\d+(?::|%3A)\d+(?:;I?\d+(?::|%3A)\d+)*(?![\d.:])/gi;

export function redactFigmaIdentifiers(message: string): string {
  return message
    .replace(FILE_KEY_REST_PATH, `$1${REDACTED_FILE_KEY}`)
    .replace(FILE_KEY_WEB_URL, `$1${REDACTED_FILE_KEY}`)
    .replace(NODE_ID_QUERY_PARAM, `$1=${REDACTED_NODE_ID}`)
    .replace(NODE_ID_TOKEN, REDACTED_NODE_ID);
}
