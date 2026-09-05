// The text words that closed the read↔write seam (Phase 5.1): casing, vertical alignment, paragraph
// metrics and whole-node links were readable but not authorable, so a `get` result could not be spread
// back into an edit or rebuilt into a spec. Two concerns pinned here — that each word actually LANDS
// (through the one applier create and edit share), and that the read shape's non-authorable leaves get
// their stated disposition (derived → dropped, unwritable → loud) instead of an "unknown prop".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { text, render } from "./flcm.js";
import { edit } from "./edit.js";

createFigmaMock();

test("the base text words land on the node — casing, vertical align, paragraph metrics, whole-node link", async () => {
  const out = await render(
    text("terms and conditions", {
      textStyle: {
        textTransform: "uppercase",
        textAlignVertical: "center",
        paragraphSpacing: 12,
        paragraphIndent: "8px",
        listSpacing: 4,
        hyperlink: "https://example.com/terms",
      },
    }),
  );
  const node = await figma.getNodeByIdAsync(out.node.id);
  assert.equal(node.textCase, "UPPER");
  assert.equal(node.textAlignVertical, "CENTER");
  assert.equal(node.paragraphSpacing, 12);
  assert.equal(node.paragraphIndent, 8); // "8px" rides the same length() parse every metric does
  assert.equal(node.listSpacing, 4);
  // A whole-node link is a RANGE write over every character, not a node property.
  assert.deepEqual(node._rangeHyperlinks[0], {
    start: 0,
    end: "terms and conditions".length,
    value: { type: "URL", value: "https://example.com/terms" },
  });
});

test("textTransform and fontVariant are two CSS words for ONE Figma slot", async () => {
  // Both spellings reach textCase, so the pair can't both be honored — refuse rather than let the
  // later key silently win.
  assert.throws(
    () => text("x", { textStyle: { textTransform: "uppercase", fontVariant: "small-caps" } }),
    /textTransform and fontVariant are two CSS words for Figma's ONE textCase slot/,
  );
  const smallCaps = await render(text("x", { textStyle: { fontVariant: "all-small-caps" } }));
  assert.equal((await figma.getNodeByIdAsync(smallCaps.node.id)).textCase, "SMALL_CAPS_FORCED");
  // "none" is the shared clearing word — it restores ORIGINAL casing, small-caps included.
  const cleared = await render(text("x", { textStyle: { textTransform: "none" } }));
  assert.equal((await figma.getNodeByIdAsync(cleared.node.id)).textCase, "ORIGINAL");
});

test("a run delta carries casing and paragraph metrics over its own slice", async () => {
  const out = await render(text(["plain ", ["SHOUT", { textTransform: "uppercase", paragraphSpacing: 20 }]]));
  const node = await figma.getNodeByIdAsync(out.node.id);
  assert.deepEqual(node._rangeCases[0], { start: 6, end: 11, value: "UPPER" });
  assert.deepEqual(node._rangeParagraphSpacings[0], { start: 6, end: 11, value: 20 });
});

test("edit rides the same compile — a live node takes the new words too", async () => {
  const out = await render(text("hi", { key: "label" }));
  await edit("label", { textStyle: { textTransform: "capitalize", paragraphIndent: 6 } });
  const node = await figma.getNodeByIdAsync(out.node.id);
  assert.equal(node.textCase, "TITLE");
  assert.equal(node.paragraphIndent, 6);
});

test("a spread read textStyle compiles: derived leaves drop, unwritable ones fail loud by name", () => {
  // The Goal case: `{ ...spec.textStyle, fontSize: 18 }`. fontVariantName ("Bold Italic") IS
  // fontWeight + fontStyle restated in Figma's own label, so it drops rather than blocking the spread.
  const wn = text("x", {
    textStyle: { fontVariantName: "Bold Italic", fontWeight: 700, fontStyle: "italic", fontSize: 18 } as never,
  });
  assert.deepEqual(wn.textStyle, { fontSize: 18, fontWeight: 700, fontStyle: "italic" });
  // opentypeFlags is real state with no setter anywhere in the plugin API — named, with the reason.
  assert.throws(
    () => text("x", { textStyle: { opentypeFlags: { LNUM: 1 } } as never }),
    /`opentypeFlags` is a read-only field — OpenType features are read-only to a plugin/,
  );
  // A genuinely unknown key still fails loud: tolerating the read leaves didn't open the closed set.
  assert.throws(() => text("x", { textStyle: { fontVariantname: "Bold" } as never }), /unknown prop "fontVariantname"/);
});

test("a hyperlink takes the author string or the read form; a NODE link has no authored form", async () => {
  const out = await render(text("docs", { textStyle: { hyperlink: { type: "URL", url: "https://x.co" } } }));
  const node = await figma.getNodeByIdAsync(out.node.id);
  assert.deepEqual(node._rangeHyperlinks[0].value, { type: "URL", value: "https://x.co" });
  assert.throws(
    () => text("x", { textStyle: { hyperlink: { type: "NODE", nodeID: "1:2" } } as never }),
    /NODE hyperlink .* Figma has no way for a plugin to author one/s,
  );
});
