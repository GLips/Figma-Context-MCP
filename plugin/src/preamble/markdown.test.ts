// markdown parser (Phase 3b): the write-edge inverse of figma-mcp read's escapeMarkdown/renderRunMarkdown.
// These are pure-string unit tests of parseInlineMarkdown — the flag set each segment carries, the escape
// decode, nesting, whitespace-flanking, and the round-trip guarantee the shared spec pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInlineMarkdown } from "./markdown.js";

test("a plain string with no markers is one flagless segment", () => {
  assert.deepEqual(parseInlineMarkdown("hello world"), [{ text: "hello world" }]);
  assert.deepEqual(parseInlineMarkdown(""), []);
});

test("bold / italic / strike each set exactly their flag on the core", () => {
  assert.deepEqual(parseInlineMarkdown("a **b** c"), [
    { text: "a " },
    { text: "b", bold: true },
    { text: " c" },
  ]);
  assert.deepEqual(parseInlineMarkdown("*i*"), [{ text: "i", italic: true }]);
  assert.deepEqual(parseInlineMarkdown("~~s~~"), [{ text: "s", strike: true }]);
});

test("bold+italic (***) collapses to both flags regardless of wrapper order", () => {
  assert.deepEqual(parseInlineMarkdown("***x***"), [{ text: "x", bold: true, italic: true }]);
});

test("maximum stack [~~***x***~~](url) yields one segment with all four flags", () => {
  assert.deepEqual(parseInlineMarkdown("[~~***x***~~](https://a.co)"), [
    { text: "x", bold: true, italic: true, strike: true, hyperlink: "https://a.co" },
  ]);
});

test("a link wraps only its text; neighbours stay plain", () => {
  assert.deepEqual(parseInlineMarkdown("see [docs](https://a.co) now"), [
    { text: "see " },
    { text: "docs", hyperlink: "https://a.co" },
    { text: " now" },
  ]);
});

test("emphasis cannot flank whitespace — space-flanked markers stay literal", () => {
  // `** bold**` is not bold (CommonMark), and `2 * 3` is arithmetic, not italic.
  assert.deepEqual(parseInlineMarkdown("** bold**"), [{ text: "** bold**" }]);
  assert.deepEqual(parseInlineMarkdown("2 * 3 * 4"), [{ text: "2 * 3 * 4" }]);
});

test("trailing whitespace pulled outside the markers stays plain (read's splitEdgeWhitespace inverse)", () => {
  assert.deepEqual(parseInlineMarkdown("**bold** "), [{ text: "bold", bold: true }, { text: " " }]);
});

test("escaped markers decode to literal characters, never markers", () => {
  // Authoring a literal ** — read emits \*\*, and re-authoring reproduces the two asterisks, no bold.
  assert.deepEqual(parseInlineMarkdown("\\*\\*not bold\\*\\*"), [{ text: "**not bold**" }]);
  assert.deepEqual(parseInlineMarkdown("a \\[b\\] \\(c\\)"), [{ text: "a [b] (c)" }]);
});

test("newline escapes: two-char \\n is a line break, \\\\n is a literal backslash-n", () => {
  assert.deepEqual(parseInlineMarkdown("line1\\nline2"), [{ text: "line1\nline2" }]);
  assert.deepEqual(parseInlineMarkdown("a\\\\nb"), [{ text: "a\\nb" }]);
});

test("underscores are never emphasis markers (snake_case survives)", () => {
  assert.deepEqual(parseInlineMarkdown("my_var_name"), [{ text: "my_var_name" }]);
});

test("a link URL round-trips %28/%29 back to parens", () => {
  assert.deepEqual(parseInlineMarkdown("[x](https://a.co/f%28y%29)"), [
    { text: "x", hyperlink: "https://a.co/f(y)" },
  ]);
});

test("an empty-destination [x]() is literal text, not a link", () => {
  assert.deepEqual(parseInlineMarkdown("[x]()"), [{ text: "[x]()" }]);
});

test("a link URL is rebuilt from raw source, not text-escape-decoded", () => {
  // escapeLinkUrl (read) does NOT escape backslash, so a URL that legitimately contains a `\n` sequence
  // must survive verbatim — the text-escape decode (\n → newline) must not reach into the URL region.
  assert.deepEqual(parseInlineMarkdown("[x](https://a.co/p\\nq)"), [
    { text: "x", hyperlink: "https://a.co/p\\nq" },
  ]);
});

test("markdown image syntax fails loud (no text form)", () => {
  assert.throws(() => parseInlineMarkdown("![alt](https://a.co/i.png)"), /image syntax/);
});

test("adjacent bold runs parse independently", () => {
  assert.deepEqual(parseInlineMarkdown("**a** **b**"), [
    { text: "a", bold: true },
    { text: " " },
    { text: "b", bold: true },
  ]);
});
