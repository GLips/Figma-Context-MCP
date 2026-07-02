// Rich text (Phase 1): flcm.text accepts a styled-runs array alongside the plain-string form. Construction
// is inert (checked on the built WriteNode); the per-range apply is render-time (bridge) behavior, checked
// against the in-memory figma mock, which records each setRange* call so we can assert the runs landed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { text, render } from "./flcm.js";
import { resolveFontStrict } from "./fonts.js";

createFigmaMock();

test("a plain string still builds a plain text node (no runs)", () => {
  const wn = text("hello", { textStyle: { fontSize: 14 } });
  assert.equal(wn.text, "hello");
  assert.equal(wn.runs, undefined);
});

test("a runs array builds one node whose characters are the concatenation", async () => {
  const wn = text(
    [
      ["@ridgeline", { color: "#6366F1", fontWeight: "semibold" }],
      " body copy ",
      ["more", { color: "#8E8E93" }],
    ],
    { textStyle: { fontSize: 14 } },
  );
  assert.equal(wn.text, undefined);
  assert.equal(wn.runs!.length, 3);

  const out = await render(wn);
  const node = figma.getNodeById(out.root.id);
  assert.equal(node.characters, "@ridgeline body copy more");
  assert.equal(node.fontSize, 14); // base props apply as the node default
});

test("runs apply per-range weight and fills over the right slices; unstyled runs touch nothing", async () => {
  const out = await render(
    text(
      [
        ["@ridgeline", { color: "#6366F1", fontWeight: "semibold" }], // 0..10 — weight + fill
        " body copy ", //                                                10..21 — inherits base, no range
        ["more", { color: "#8E8E93" }], //                               21..25 — fill only
      ],
      { textStyle: { fontSize: 14 } },
    ),
  );
  const node = figma.getNodeById(out.root.id);

  // Only the weighted run sets a range font — and it resolves to the family's Semi Bold, not the base.
  assert.equal(node._rangeFonts.length, 1);
  assert.deepEqual(node._rangeFonts[0], { start: 0, end: 10, value: { family: "Inter", style: "Semi Bold" } });

  // Two runs carry a color → two fill ranges over their exact slices; the middle run adds none.
  assert.equal(node._rangeFills.length, 2);
  assert.deepEqual(node._rangeFills.map((r: any) => [r.start, r.end]), [[0, 10], [21, 25]]);
});

test("resolveFontStrict throws for an unloaded run font rather than falling back to base", () => {
  assert.throws(() => resolveFontStrict({}, "Inter", 700), /was not loaded/);
  // The FontMap key includes the italic flag now (family|weight|italic) — an upright run keys the empty
  // slant; asking for the same pair as italic misses and fails loud rather than snapping to the upright.
  const loaded = {
    "Inter|700|": { family: "Inter", style: "Bold" },
    "Inter|700|i": { family: "Inter", style: "Bold Italic" },
  };
  assert.deepEqual(resolveFontStrict(loaded, "Inter", 700), { family: "Inter", style: "Bold" });
  assert.deepEqual(resolveFontStrict(loaded, "Inter", 700, true), { family: "Inter", style: "Bold Italic" });
  assert.throws(() => resolveFontStrict({ "Inter|700|": { family: "Inter", style: "Bold" } }, "Inter", 700, true), /was not loaded/);
});

test("markdown in a plain string compiles to runs and renders per-range", async () => {
  const wn = text("Hi **bold** and *italic* and ~~struck~~ and [link](https://a.co)");
  // Splits into runs (no longer a single plain string).
  assert.equal(wn.text, undefined);
  assert.equal(wn.characters, undefined);

  const out = await render(wn);
  const node = figma.getNodeById(out.root.id);
  assert.equal(node.characters, "Hi bold and italic and struck and link");

  // Bold + italic each resolve a per-range font (weight snap / italic variant); strike does not.
  const bold = node._rangeFonts.find((r: any) => r.value.style === "Bold");
  assert.deepEqual([bold.start, bold.end], [3, 7]);
  const italic = node._rangeFonts.find((r: any) => r.value.style === "Italic");
  assert.deepEqual([italic.start, italic.end], [12, 18]);

  // Strike → a STRIKETHROUGH decoration range over exactly "struck".
  assert.equal(node._rangeDecorations.length, 1);
  assert.deepEqual(node._rangeDecorations[0], { start: 23, end: 29, value: "STRIKETHROUGH" });

  // Link → a URL hyperlink range over exactly "link".
  assert.equal(node._rangeHyperlinks.length, 1);
  assert.deepEqual(node._rangeHyperlinks[0], { start: 34, end: 38, value: { type: "URL", value: "https://a.co" } });
});

test("a whole-node italic base resolves the italic font and needs no per-range font", async () => {
  const out = await render(text("all slanted", { textStyle: { fontStyle: "italic", fontWeight: 700 } }));
  const node = figma.getNodeById(out.root.id);
  assert.deepEqual(node.fontName, { family: "Inter", style: "Bold Italic" });
  assert.equal(node._rangeFonts, undefined); // plain string, no runs
});

test("an italic run over an italic base with a weight override keeps the slant", async () => {
  // The run changes only weight; effective slant inherits the italic base, so the run's font is italic.
  const out = await render(
    text([["heavy", { fontWeight: 900 }], " rest"], { textStyle: { fontStyle: "italic" } }),
  );
  const node = figma.getNodeById(out.root.id);
  const run = node._rangeFonts.find((r: any) => r.start === 0);
  assert.deepEqual(run.value, { family: "Inter", style: "Black Italic" });
});

test("a tuple StyleDelta can carry fontStyle/textDecoration/hyperlink directly", async () => {
  const out = await render(
    text([["x", { fontStyle: "italic", textDecoration: "underline", hyperlink: "https://b.co" }]]),
  );
  const node = figma.getNodeById(out.root.id);
  assert.equal(node._rangeFonts[0].value.style, "Italic");
  assert.deepEqual(node._rangeDecorations[0], { start: 0, end: 1, value: "UNDERLINE" });
  assert.deepEqual(node._rangeHyperlinks[0].value, { type: "URL", value: "https://b.co" });
});

test("an explicit run fontWeight overrides the markdown bold weight", async () => {
  // `**` implies default bold; the tuple's explicit 900 wins (a non-canonical heavy weight isn't lost).
  const out = await render(text([["**heavy**", { fontWeight: 900 }]]));
  const node = figma.getNodeById(out.root.id);
  assert.equal(node.characters, "heavy");
  assert.equal(node._rangeFonts[0].value.style, "Black");
});

test("a literal ** authored with escapes renders literally, no runs, and never re-tokenizes", () => {
  const wn = text("price \\*\\* each");
  assert.equal(wn.text, "price ** each");
  assert.equal(wn.runs, undefined);
});

test("unrealizable fontStyle / textDecoration values fail loud naming the set", () => {
  assert.throws(() => text("x", { textStyle: { fontStyle: "oblique" as never } }), /fontStyle must be one of/);
  assert.throws(() => text("x", { textStyle: { textDecoration: "overline" as never } }), /textDecoration must be one of/);
});

test("read-artifact and malformed run inputs fail loud", () => {
  // figma-mcp style-ref tokens are rejected on both the plain-string and the run-text forms.
  assert.throws(() => text("a {ts1}bold{/ts1} b"), /style-ref tokens/);
  assert.throws(() => text(["{ts1}bold{/ts1}"]), /style-ref tokens/);
  // A structured object that isn't a runs array is still the read artifact with no write path.
  assert.throws(() => text({ characters: "hi" } as never), /structured value/);
  // Malformed runs.
  assert.throws(() => text([]), /non-empty/);
  // The old { text, ... } object run form is no longer a valid run — a run is a bare string or a tuple.
  assert.throws(() => text([{ text: "hi" } as never]), /plain string or a \[text, style\] tuple/);
  assert.throws(() => text([[5, {}] as never]), /plain string or a \[text, style\] tuple/);
});
