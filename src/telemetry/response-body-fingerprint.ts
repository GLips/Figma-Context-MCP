/**
 * Reduce an HTTP response body to a fingerprint before it reaches telemetry.
 *
 * Why: error messages splice `HttpError.responseBody` in verbatim (the 403
 * message, the generic fetch-failure wrap), which is right for the user — a
 * proxy block page names its reason. But block pages also print the
 * authenticated user, client IP and internal hostnames, and the identifier
 * scrub can't know about those. What analytics needs is *who* answered:
 * Figma, which proxy vendor, or something else.
 */

const MAX_FIELD_LENGTH = 100;

// Case-insensitive markers that identify a corporate proxy/firewall/CDN block
// page. First match wins, so more specific names sit before generic ones.
const PROXY_VENDORS: ReadonlyArray<readonly [vendor: string, marker: RegExp]> = [
  ["zscaler", /zscaler/i],
  ["netskope", /netskope/i],
  ["palo_alto", /palo\s?alto|pan-?os|globalprotect/i],
  ["fortinet", /forti(?:gate|guard|net)/i],
  ["cisco_umbrella", /umbrella|opendns/i],
  ["forcepoint", /forcepoint|websense/i],
  ["symantec", /bluecoat|blue coat|symantec/i],
  ["skyhigh", /skyhigh|mcafee/i],
  ["sophos", /sophos/i],
  ["checkpoint", /check\s?point/i],
  ["barracuda", /barracuda/i],
  ["squid", /squid/i],
  ["cloudflare", /cloudflare/i],
  ["akamai", /akamai/i],
];

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_FIELD_LENGTH ? `${flat.slice(0, MAX_FIELD_LENGTH)}…` : flat;
}

// Figma's own error bodies are `{"status":403,"err":"..."}` with a fixed
// vocabulary ("Invalid token", "File not exportable"), and `err` is the signal
// that tells one 403 cause from another — so it survives the fingerprint.
function figmaErr(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "err" in parsed) {
      const err = (parsed as { err: unknown }).err;
      if (typeof err === "string") return err;
    }
  } catch {
    // Not JSON — the HTML/text branches below describe it.
  }
  return undefined;
}

export function fingerprintResponseBody(body: string): string {
  const parts = [`${body.length} chars`];

  const err = figmaErr(body);
  if (err !== undefined) {
    parts.unshift("json");
    parts.push(`err="${clip(err)}"`);
    return `[response body: ${parts.join(", ")}]`;
  }

  const isHtml = /<html|<!doctype html/i.test(body);
  parts.unshift(isHtml ? "html" : "text");
  const vendor = PROXY_VENDORS.find(([, marker]) => marker.test(body))?.[0];
  if (vendor) parts.push(`vendor=${vendor}`);
  const title = isHtml ? /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] : undefined;
  if (title?.trim()) parts.push(`title="${clip(title)}"`);
  return `[response body: ${parts.join(", ")}]`;
}
