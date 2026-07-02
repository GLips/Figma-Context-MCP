import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sha1Hex } from "~/core/sha1.js";

// The pure-JS sha1 must be byte-identical to node:crypto — the content-addressed
// style/element ids in compressed output (and thus the goldens) depend on it.
// A silent divergence would re-key every ref in every consumer's output.
describe("sha1Hex matches node:crypto", () => {
  const cases = [
    "",
    "abc",
    // block-boundary lengths (55/56/64 bytes) exercise the padding edge cases
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(64),
    "a".repeat(1000),
    // multi-byte UTF-8: 2-byte, 3-byte, and astral (4-byte, surrogate pair)
    "café — ünïcode",
    "日本語テキスト",
    "emoji 🎨🚀 mixed with text",
    // realistic stableStringify payloads (what actually gets hashed)
    JSON.stringify({ fontFamily: "Inter", fontSize: 16, fontWeight: 600 }),
    JSON.stringify(["#FF0000", { type: "GRADIENT_LINEAR", stops: [0, 1] }]),
  ];

  it.each(cases.map((s) => [s.length > 40 ? `${s.slice(0, 37)}...` : s, s]))(
    "%s",
    (_label, input) => {
      expect(sha1Hex(input)).toBe(createHash("sha1").update(input).digest("hex"));
    },
  );

  it("handles lone surrogates like TextEncoder (U+FFFD replacement)", () => {
    const lone = "abc\ud800def";
    expect(sha1Hex(lone)).toBe(createHash("sha1").update(lone, "utf8").digest("hex"));
  });
});
