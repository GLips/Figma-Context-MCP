/**
 * Validates that a URL is safe to fetch — defense-in-depth against SSRF
 * if the Figma API ever returns a crafted or unexpected URL.
 *
 * Allowed:
 *  - HTTPS scheme only
 *  - Hostnames matching known Figma CDN domains
 *
 * Blocked:
 *  - Private/internal IPs, localhost, link-local, metadata endpoints
 *  - Non-HTTPS schemes (http, file, ftp, etc.)
 *  - Unknown hostnames
 */

const ALLOWED_HOST_PATTERNS: RegExp[] = [
  // Figma's own domains (CDN, API, assets)
  /^(.+\.)?figma\.com$/,
  // Amazon S3 buckets used by Figma (e.g. s3-alpha-sig.figma.com is already
  // covered above, but Figma has historically used raw S3 URLs too)
  /^[\w.-]+\.amazonaws\.com$/,
  // Figma image CDN
  /^(.+\.)?figmausercontent\.com$/,
];

export function assertSafeImageUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid image URL: ${url}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing to fetch image over insecure protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block obvious internal targets even if they somehow match a pattern
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.startsWith("169.254.") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error(`Refusing to fetch image from internal address: ${hostname}`);
  }

  const allowed = ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  if (!allowed) {
    throw new Error(
      `Image URL hostname not in allowlist: ${hostname}. Expected a Figma CDN domain.`,
    );
  }
}
