import { describe, it, expect } from "vitest";
import type { SceneNodeLike, SceneTextSegment } from "@framelink/plugin/node-to-snapshot";
import { sceneNodeToSnapshot } from "@framelink/plugin/node-to-snapshot";

/**
 * Plugin text decode — the behaviors the committed parity fixtures don't
 * exercise: relative-unit conversions (the plugin spells them natively where
 * REST pre-resolves them, so a wrong mapping silently skews every relatively-
 * sized text read) and the line-split/merge edges of the run algorithm.
 */

function textNode(segments: SceneTextSegment[]): SceneNodeLike {
  return {
    id: "1:1",
    name: "T",
    type: "TEXT",
    characters: segments.map((s) => s.characters).join(""),
    getStyledTextSegments: () => segments,
  };
}

const resolveNothing = async () => null;

describe("scene text decode", () => {
  it("maps PERCENT line-height and letter-spacing onto REST's absolute spellings", async () => {
    const snapshot = await sceneNodeToSnapshot(
      textNode([
        {
          characters: "Hi",
          fontSize: 14,
          lineHeight: { unit: "PERCENT", value: 150 },
          letterSpacing: { unit: "PERCENT", value: 10 },
        },
      ]),
      resolveNothing,
    );

    expect(snapshot.text?.style).toMatchObject({
      lineHeightUnit: "FONT_SIZE_%",
      lineHeightPercentFontSize: 150,
      // 10% of the segment's 14px font size.
      letterSpacing: 1.4,
    });
    expect(snapshot.text?.style.lineHeightPx).toBeUndefined();
  });

  it("derives the variant name and italic flag from fontName/fontStyle", async () => {
    const snapshot = await sceneNodeToSnapshot(
      textNode([
        {
          characters: "Hi",
          fontName: { family: "Inter", style: "Bold Italic" },
          fontStyle: "ITALIC",
          fontWeight: 700,
        },
      ]),
      resolveNothing,
    );

    expect(snapshot.text?.style).toMatchObject({
      fontFamily: "Inter",
      fontStyle: "Bold Italic",
      italic: true,
      fontWeight: 700,
    });
  });

  it("emits italic: false so a regular run inside an italic base deltas out", async () => {
    // REST carries `italic: false` in the override table; the core turns it
    // into the inverse fontStyle: "normal" override. Dropping the false would
    // leave the run silently italic.
    const snapshot = await sceneNodeToSnapshot(
      textNode([
        { characters: "italic ", fontStyle: "ITALIC", fontSize: 12 },
        { characters: "regular", fontStyle: "REGULAR", fontSize: 12 },
      ]),
      resolveNothing,
    );

    expect(snapshot.text?.style.italic).toBe(true);
    expect(snapshot.text?.lines).toEqual([
      [
        { text: "italic ", delta: {} },
        { text: "regular", delta: { italic: false } },
      ],
    ]);
  });

  it("keeps AUTO line-height out of the base (REST's INTRINSIC_%)", async () => {
    const snapshot = await sceneNodeToSnapshot(
      textNode([{ characters: "Hi", lineHeight: { unit: "AUTO" }, fontSize: 12 }]),
      resolveNothing,
    );

    expect(snapshot.text?.style.lineHeightUnit).toBe("INTRINSIC_%");
    expect(snapshot.text?.style.lineHeightPx).toBeUndefined();
    expect(snapshot.text?.style.lineHeightPercentFontSize).toBeUndefined();
  });

  it("splits a single segment spanning newlines and keeps trailing/empty lines", async () => {
    // Matches REST's splitLines: an interior blank paragraph and a trailing
    // newline both produce their own (empty) line entries.
    const snapshot = await sceneNodeToSnapshot(
      textNode([{ characters: "a\n\nb\n", fontSize: 12 }]),
      resolveNothing,
    );

    expect(snapshot.text?.lines).toEqual([
      [{ text: "a", delta: {} }],
      [],
      [{ text: "b", delta: {} }],
      [],
    ]);
    expect(snapshot.text?.lineTypes).toHaveLength(4);
  });

  it("gives an empty list line its covering segment's list membership", async () => {
    // An empty ordered item between two others: its terminating newline lives
    // in the ORDERED segment, so the line keeps the bullet — REST reads the
    // same off the wire's lineTypes. (A trailing empty final paragraph has no
    // characters at all and stays NONE.)
    const snapshot = await sceneNodeToSnapshot(
      textNode([
        { characters: "One", fontSize: 12, listOptions: { type: "ORDERED" }, indentation: 1 },
        { characters: "\n\nTwo", fontSize: 12, listOptions: { type: "ORDERED" }, indentation: 1 },
      ]),
      resolveNothing,
    );

    expect(snapshot.text?.lineTypes).toEqual(["ORDERED", "ORDERED", "ORDERED"]);
    expect(snapshot.text?.lineIndentations).toEqual([1, 1, 1]);
    expect(snapshot.text?.lines).toEqual([
      [{ text: "One", delta: {} }],
      [],
      [{ text: "Two", delta: {} }],
    ]);
  });

  it("merges adjacent equal-delta runs within a line", async () => {
    // Segments split on a field the delta doesn't carry (e.g. a fill style id
    // boundary) must fuse back into one run, like REST's adjacent-run merge.
    const snapshot = await sceneNodeToSnapshot(
      textNode([
        { characters: "same", fontSize: 12, fontWeight: 400 },
        { characters: " style", fontSize: 12, fontWeight: 400 },
      ]),
      resolveNothing,
    );

    expect(snapshot.text?.lines).toEqual([[{ text: "same style", delta: {} }]]);
  });
});
