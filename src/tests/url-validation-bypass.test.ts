import { describe, expect, it } from "vitest";
import { assertSafeImageUrl } from "~/utils/url-validation.js";

/**
 * Supplemental adversarial tests for assertSafeImageUrl covering common
 * SSRF bypass classes not exercised by the primary test file. These are
 * derived from the SSRF skill checklist (IP encodings, IPv6 loopback,
 * userinfo tricks, private ranges, additional cloud metadata endpoints).
 */
describe("assertSafeImageUrl - SSRF bypass classes", () => {
  const shouldBlock = [
    // Decimal / hex / octal encodings of 127.0.0.1 — WHATWG URL normalises
    // most of these to 127.0.0.1 (loopback) which then fails the allowlist.
    "https://2130706433/",
    "https://0x7f000001/",
    "https://017700000001/",

    // 127.x shorthand — normalises to 127.0.0.1 or otherwise fails allowlist
    "https://127.1/",
    "https://127.0.1/",

    // IPv6 loopback variants
    "https://[::1]/",
    "https://[0:0:0:0:0:0:0:1]/",

    // Private ranges — must fail the allowlist even if the loopback check
    // doesn't cover them explicitly
    "https://10.0.0.1/",
    "https://192.168.1.1/",
    "https://172.16.0.1/",

    // Link-local + additional cloud metadata endpoints
    "https://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254.nip.io/",
    "https://100.100.100.200/latest/meta-data/",
    "https://metadata.google.internal/computeMetadata/v1/",

    // Non-HTTPS schemes
    "gopher://127.0.0.1:6379/_",
    "dict://127.0.0.1:11211/stats",
    "ftp://s3-alpha-sig.figma.com/x",
    "javascript:alert(1)",
    "data:text/html,evil",

    // Userinfo trick — hostname is evil.com, not figma.com
    "https://s3-alpha-sig.figma.com@evil.com/",
    "https://evil.com#@s3-alpha-sig.figma.com/",

    // Look-alike / homograph attempts
    "https://figma.com.evil.com/",
    "https://evilfigma.com/",
    "https://figmausercontent.com.evil.tld/",
  ];

  for (const url of shouldBlock) {
    it(`blocks ${url}`, () => {
      expect(() => assertSafeImageUrl(url)).toThrow();
    });
  }

  it("still allows legitimate Figma CDN URLs", () => {
    expect(() =>
      assertSafeImageUrl("https://s3-alpha-sig.figma.com/img/abc/123/image.png"),
    ).not.toThrow();
    expect(() =>
      assertSafeImageUrl("https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc"),
    ).not.toThrow();
    expect(() => assertSafeImageUrl("https://cdn.figmausercontent.com/asset.png")).not.toThrow();
  });
});
