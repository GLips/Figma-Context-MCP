import { describe, expect, it } from "vitest";
import { assertSafeImageUrl } from "~/utils/url-validation.js";

describe("assertSafeImageUrl", () => {
  it("allows Figma CDN URLs", () => {
    expect(() =>
      assertSafeImageUrl("https://s3-alpha-sig.figma.com/img/abc/123/image.png"),
    ).not.toThrow();
    expect(() =>
      assertSafeImageUrl("https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc"),
    ).not.toThrow();
  });

  it("blocks localhost", () => {
    expect(() => assertSafeImageUrl("https://localhost/secret")).toThrow(/internal address/);
    expect(() => assertSafeImageUrl("https://127.0.0.1/secret")).toThrow(/internal address/);
  });

  it("blocks cloud metadata endpoints", () => {
    expect(() => assertSafeImageUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
      /insecure protocol/,
    );
    expect(() => assertSafeImageUrl("https://169.254.169.254/latest/meta-data/")).toThrow(
      /internal address/,
    );
    expect(() => assertSafeImageUrl("https://metadata.google.internal/")).toThrow(
      /internal address/,
    );
  });

  it("blocks non-HTTPS", () => {
    expect(() => assertSafeImageUrl("http://s3-alpha-sig.figma.com/img/abc.png")).toThrow(
      /insecure protocol/,
    );
    expect(() => assertSafeImageUrl("file:///etc/passwd")).toThrow(/insecure protocol/);
  });

  it("blocks unknown hostnames", () => {
    expect(() => assertSafeImageUrl("https://evil.com/image.png")).toThrow(/not in allowlist/);
    expect(() => assertSafeImageUrl("https://attacker.com/redirect")).toThrow(/not in allowlist/);
  });

  it("blocks invalid URLs", () => {
    expect(() => assertSafeImageUrl("not-a-url")).toThrow(/Invalid image URL/);
  });
});
