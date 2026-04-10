import { describe, expect, it } from "vitest";
import { tagError, getErrorMeta } from "~/utils/error-meta.js";

describe("error-meta cause chain", () => {
  it("merges meta across nested causes, with outer winning on conflict", () => {
    // Innermost: HTTP error tagged with status + retryability (like fetchJSON does)
    const innerError = new Error("Fetch failed with status 429");
    try {
      tagError(innerError, { http_status: 429, is_retryable: true });
    } catch {
      // tagError throws — caught here so we can use the tagged error
    }

    // Middle wrapper: figma.ts wrapping the inner error with endpoint context
    const wrappedError = new Error(
      "Failed to make request to Figma API endpoint '/files/abc': Fetch failed with status 429",
      { cause: innerError },
    );

    // Outer: get-figma-data.ts tagging with phase
    try {
      tagError(wrappedError, { phase: "fetch" });
    } catch {
      // intentionally swallowed
    }

    const meta = getErrorMeta(wrappedError);

    // Outer phase tag survives
    expect(meta.phase).toBe("fetch");
    // Inner machine data walks up through `cause`
    expect(meta.http_status).toBe(429);
    expect(meta.is_retryable).toBe(true);
  });

  it("outer tag wins when both layers set the same field", () => {
    const inner = new Error("inner");
    try {
      tagError(inner, { phase: "fetch", http_status: 500 });
    } catch {
      // intentionally swallowed
    }

    const outer = new Error("outer", { cause: inner });
    try {
      tagError(outer, { phase: "simplify" });
    } catch {
      // intentionally swallowed
    }

    const meta = getErrorMeta(outer);
    expect(meta.phase).toBe("simplify"); // outer wins
    expect(meta.http_status).toBe(500); // not overridden
  });

  it("returns empty object for untagged errors", () => {
    const meta = getErrorMeta(new Error("plain"));
    expect(meta).toEqual({});
  });

  it("survives circular cause chains without infinite looping", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    try {
      tagError(a, { phase: "fetch" });
    } catch {
      // intentionally swallowed
    }
    expect(() => getErrorMeta(a)).not.toThrow();
    expect(getErrorMeta(a).phase).toBe("fetch");
  });
});
