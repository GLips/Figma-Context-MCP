import { describe, expect, it } from "vitest";
import type { Node as FigmaNode, TypeStyle } from "@figma/rest-api-spec";
import { walkNodes } from "~/core/simplify.js";
import { createRefStyleTable } from "~/core/style-table.js";
import { restNodeToSnapshot } from "~/adapters/rest/node-to-snapshot.js";
import type { SimplifiedTextStyle, TextRun } from "~/core/transformers/text.js";

/**
 * Minimal Figma TEXT node factory. Tests only need the fields the text
 * extractor reads — the full Figma union is deeply discriminated, so we cast
 * through `unknown` to avoid inventing thousands of irrelevant fields.
 */
function makeText(opts: {
  id?: string;
  name?: string;
  characters: string;
  style?: Partial<TypeStyle>;
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<string, Partial<TypeStyle>>;
  lineTypes?: Array<"NONE" | "ORDERED" | "UNORDERED">;
  lineIndentations?: number[];
}): FigmaNode {
  return {
    id: opts.id ?? "text:1",
    name: opts.name ?? "Text",
    type: "TEXT",
    visible: true,
    characters: opts.characters,
    style: opts.style ?? { fontFamily: "Inter", fontWeight: 400, fontSize: 16 },
    characterStyleOverrides: opts.characterStyleOverrides ?? [],
    styleOverrideTable: opts.styleOverrideTable ?? {},
    lineTypes: opts.lineTypes ?? [],
    lineIndentations: opts.lineIndentations ?? [],
  } as unknown as FigmaNode;
}

async function extract(nodes: FigmaNode[]) {
  const sink = createRefStyleTable();
  const { nodes: extracted } = await walkNodes(
    nodes.map((node) => restNodeToSnapshot(node)),
    sink,
  );
  return { nodes: extracted, styles: sink.styles };
}

/** Assert a run is a `[text, ref]` tuple and return it destructurable. */
function asTuple(run: TextRun): [string, string] {
  expect(Array.isArray(run)).toBe(true);
  const [text, style] = run as [string, unknown];
  expect(typeof style).toBe("string");
  return [text, style as string];
}

describe("buildFormattedText — plain text passthrough", () => {
  it("emits raw text with no boldWeight when there are no overrides", async () => {
    const { nodes } = await extract([makeText({ characters: "Hello world" })]);
    // Plain text stays a bare string — the run array only appears for spans
    // whose style markdown cannot express.
    expect(nodes[0].text).toBe("Hello world");
    expect(nodes[0].boldWeight).toBeUndefined();
  });

  it("escapes markdown special chars in plain text", async () => {
    const { nodes } = await extract([
      makeText({ characters: "Use *stars* and _underscores_ and [brackets]" }),
    ]);
    expect(nodes[0].text).toBe("Use \\*stars\\* and \\_underscores\\_ and \\[brackets\\]");
  });
});

describe("buildFormattedText — markdown-expressible overrides", () => {
  it("bold override produces **text** and emits boldWeight", async () => {
    const { nodes } = await extract([
      makeText({
        // "bold" spans chars 4–8
        characters: "abc bold def",
        style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16 },
        characterStyleOverrides: [0, 0, 0, 0, 1, 1, 1, 1],
        styleOverrideTable: { "1": { fontWeight: 700 } },
      }),
    ]);
    expect(nodes[0].text).toBe("abc **bold** def");
    expect(nodes[0].boldWeight).toBe(700);
  });

  it("italic override produces *text*", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "a b c",
        characterStyleOverrides: [0, 0, 0, 0, 1],
        styleOverrideTable: { "1": { italic: true } },
      }),
    ]);
    expect(nodes[0].text).toBe("a b *c*");
  });

  it("strikethrough override produces ~~text~~", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "ab",
        characterStyleOverrides: [1, 1],
        styleOverrideTable: { "1": { textDecoration: "STRIKETHROUGH" } },
      }),
    ]);
    expect(nodes[0].text).toBe("~~ab~~");
  });

  it("URL hyperlink produces [text](url)", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "see link",
        characterStyleOverrides: [0, 0, 0, 0, 1, 1, 1, 1],
        styleOverrideTable: {
          "1": { hyperlink: { type: "URL", url: "https://example.com" } },
        },
      }),
    ]);
    expect(nodes[0].text).toBe("see [link](https://example.com)");
  });

  it("combines bold + italic + strike into ~~***text***~~", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "wow",
        characterStyleOverrides: [1, 1, 1],
        styleOverrideTable: {
          "1": { fontWeight: 700, italic: true, textDecoration: "STRIKETHROUGH" },
        },
      }),
    ]);
    expect(nodes[0].text).toBe("~~***wow***~~");
  });
});

describe("buildFormattedText — run-tuple overrides", () => {
  it("color (fills) override emits a run tuple with a color delta", async () => {
    const { nodes, styles } = await extract([
      makeText({
        characters: "red",
        characterStyleOverrides: [1, 1, 1],
        styleOverrideTable: {
          "1": {
            fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } } as never],
          },
        },
      }),
    ]);
    const runs = nodes[0].text as TextRun[];
    expect(runs).toHaveLength(1);
    const [text, ref] = asTuple(runs[0]);
    expect(text).toBe("red");
    expect(styles[ref]).toEqual({ color: "#FF0000" });
  });

  it("fontSize override emits a run tuple with a fontSize delta", async () => {
    const { nodes, styles } = await extract([
      makeText({
        characters: "big",
        style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16 },
        characterStyleOverrides: [1, 1, 1],
        styleOverrideTable: { "1": { fontSize: 24 } },
      }),
    ]);
    const runs = nodes[0].text as TextRun[];
    expect(runs).toHaveLength(1);
    const [text, ref] = asTuple(runs[0]);
    expect(text).toBe("big");
    expect(styles[ref]).toEqual({ fontSize: 24 });
  });

  it("mixed bold + color renders markdown inside the tuple text", async () => {
    const { nodes, styles } = await extract([
      makeText({
        characters: "hot",
        characterStyleOverrides: [1, 1, 1],
        styleOverrideTable: {
          "1": {
            fontWeight: 700,
            fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } } as never],
          },
        },
      }),
    ]);
    const runs = nodes[0].text as TextRun[];
    const [text, ref] = asTuple(runs[0]);
    expect(text).toBe("**hot**");
    expect(nodes[0].boldWeight).toBe(700);
    // The delta carries only color — the bold lives in markdown, not the delta.
    expect(styles[ref]).toEqual({ color: "#FF0000" });
  });

  it("NODE-type hyperlink falls through to a run-tuple delta", async () => {
    const { nodes, styles } = await extract([
      makeText({
        characters: "ref",
        characterStyleOverrides: [1, 1, 1],
        styleOverrideTable: {
          "1": { hyperlink: { type: "NODE", nodeID: "42:1" } },
        },
      }),
    ]);
    const runs = nodes[0].text as TextRun[];
    const [text, ref] = asTuple(runs[0]);
    expect(text).toBe("ref");
    expect(styles[ref]).toEqual({
      hyperlink: { type: "NODE", nodeID: "42:1" },
    });
  });
});

describe("buildFormattedText — run merging and weight detection", () => {
  it("merges adjacent runs with identical deltas from different override IDs", async () => {
    // Two override entries with visually identical deltas should collapse.
    const { nodes, styles } = await extract([
      makeText({
        characters: "abcd",
        characterStyleOverrides: [1, 1, 2, 2],
        styleOverrideTable: {
          "1": { fontSize: 24 },
          "2": { fontSize: 24 },
        },
      }),
    ]);
    const runs = nodes[0].text as TextRun[];
    // The adapter merges the equal-delta runs — a single tuple, one ref.
    expect(runs).toHaveLength(1);
    const [text, ref] = asTuple(runs[0]);
    expect(text).toBe("abcd");
    expect(styles[ref]).toEqual({ fontSize: 24 });
  });

  it("trailing-zero omission in characterStyleOverrides is handled", async () => {
    // Override array shorter than text → trailing chars default to base (0).
    const { nodes } = await extract([
      makeText({
        characters: "bold then plain",
        characterStyleOverrides: [1, 1, 1, 1],
        styleOverrideTable: { "1": { fontWeight: 700 } },
      }),
    ]);
    expect(nodes[0].text).toBe("**bold** then plain");
  });

  it("picks the most-frequent heavier weight as boldWeight", async () => {
    // 6 chars at weight 800, 3 chars at weight 600 → boldWeight = 800.
    // The 600 run also gets `**` but carries an explicit fontWeight in its ref.
    const { nodes, styles } = await extract([
      makeText({
        characters: "AAAAAA BBB",
        characterStyleOverrides: [1, 1, 1, 1, 1, 1, 0, 2, 2, 2],
        styleOverrideTable: {
          "1": { fontWeight: 800 },
          "2": { fontWeight: 600 },
        },
      }),
    ]);
    expect(nodes[0].boldWeight).toBe(800);
    // "AAAAAA" renders as plain **; "BBB" is bold markdown plus an explicit
    // fontWeight delta since 600 isn't the canonical boldWeight.
    const runs = nodes[0].text as TextRun[];
    expect(runs[0]).toBe("**AAAAAA** ");
    const [text, ref] = asTuple(runs[1]);
    expect(text).toBe("**BBB**");
    expect(styles[ref]).toEqual({ fontWeight: 600 });
  });

  it("inverse override (lighter than base) becomes a run-tuple delta, not markdown", async () => {
    const { nodes, styles } = await extract([
      makeText({
        characters: "ab",
        style: { fontFamily: "Inter", fontWeight: 700, fontSize: 16 },
        characterStyleOverrides: [0, 1],
        styleOverrideTable: { "1": { fontWeight: 400 } },
      }),
    ]);
    const runs = nodes[0].text as TextRun[];
    expect(runs[0]).toBe("a");
    const [text, ref] = asTuple(runs[1]);
    expect(text).toBe("b");
    expect(nodes[0].boldWeight).toBeUndefined();
    expect(styles[ref]).toEqual({ fontWeight: 400 });
  });
});

describe("buildFormattedText — cross-node dedup and edge cases", () => {
  it("shares one ref across different text nodes with the same delta", async () => {
    const { nodes, styles } = await extract([
      makeText({
        id: "t1",
        name: "One",
        characters: "ab",
        characterStyleOverrides: [1, 1],
        styleOverrideTable: { "1": { fontSize: 24 } },
      }),
      makeText({
        id: "t2",
        name: "Two",
        characters: "cd",
        characterStyleOverrides: [1, 1],
        styleOverrideTable: { "1": { fontSize: 24 } },
      }),
    ]);
    const [textA, refA] = asTuple((nodes[0].text as TextRun[])[0]);
    const [textB, refB] = asTuple((nodes[1].text as TextRun[])[0]);
    expect(textA).toBe("ab");
    expect(textB).toBe("cd");
    // Content-addressed dedup: identical deltas share one styles entry.
    expect(refA).toBe(refB);
    expect(styles[refA]).toEqual({ fontSize: 24 });
  });

  it("drops no-op overrides that match the base style", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "x",
        style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16 },
        characterStyleOverrides: [1],
        // Override declares fontWeight: 400 — same as base, so it's a no-op.
        styleOverrideTable: { "1": { fontWeight: 400 } },
      }),
    ]);
    // The no-op delta produces no tuple — the text stays a bare string.
    expect(nodes[0].text).toBe("x");
    expect(nodes[0].boldWeight).toBeUndefined();
  });

  it("handles an empty text node", async () => {
    const { nodes } = await extract([makeText({ characters: "" })]);
    // Empty text: no `text` field is set on the result.
    expect(nodes[0].text).toBeUndefined();
    expect(nodes[0].boldWeight).toBeUndefined();
  });
});

describe("buildFormattedText — reviewer regression coverage", () => {
  it("clears inherited underline when a run switches to strikethrough", async () => {
    const { nodes, styles } = await extract([
      makeText({
        characters: "ab",
        style: {
          fontFamily: "Inter",
          fontWeight: 400,
          fontSize: 16,
          textDecoration: "UNDERLINE",
        },
        characterStyleOverrides: [0, 1],
        styleOverrideTable: { "1": { textDecoration: "STRIKETHROUGH" } },
      }),
    ]);
    const runs = nodes[0].text as TextRun[];
    expect(runs[0]).toBe("a");
    const [text, ref] = asTuple(runs[1]);
    expect(text).toBe("~~b~~");
    // The explicit line-through suppresses the inherited base underline.
    expect(styles[ref]).toEqual({ textDecoration: "line-through" });
  });

  it("emits an inverse-decoration delta when a run clears the base decoration", async () => {
    const { nodes, styles } = await extract([
      makeText({
        characters: "ab",
        style: {
          fontFamily: "Inter",
          fontWeight: 400,
          fontSize: 16,
          textDecoration: "UNDERLINE",
        },
        characterStyleOverrides: [0, 1],
        styleOverrideTable: { "1": { textDecoration: "NONE" } },
      }),
    ]);
    const runs = nodes[0].text as TextRun[];
    expect(runs[0]).toBe("a");
    const [text, ref] = asTuple(runs[1]);
    expect(text).toBe("b");
    expect(styles[ref]).toEqual({ textDecoration: "none" });
  });

  it("pulls whitespace outside markdown emphasis markers", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "a bold ",
        characterStyleOverrides: [0, 0, 1, 1, 1, 1, 1],
        styleOverrideTable: { "1": { fontWeight: 700 } },
      }),
    ]);
    // The trailing space lives OUTSIDE the `**` so markdown renders correctly.
    expect(nodes[0].text).toBe("a **bold** ");
  });

  it("escapes URL destinations that contain parens or whitespace", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "link",
        characterStyleOverrides: [1, 1, 1, 1],
        styleOverrideTable: {
          "1": { hyperlink: { type: "URL", url: "https://a.com/(x)" } },
        },
      }),
    ]);
    // `(` and `)` are percent-encoded so they don't close the destination.
    expect(nodes[0].text).toBe("[link](https://a.com/%28x%29)");
  });

  it("merges runs whose deltas differ only in key order", async () => {
    // Base uses Roboto/16 so both fontFamily AND fontSize overrides survive
    // computeDelta's no-op filter and actually end up in the two runs'
    // delta objects in different property orders.
    const { nodes, styles } = await extract([
      makeText({
        characters: "ab",
        style: { fontFamily: "Roboto", fontWeight: 400, fontSize: 16 },
        characterStyleOverrides: [1, 2],
        styleOverrideTable: {
          "1": { fontSize: 24, fontFamily: "Inter" },
          "2": { fontFamily: "Inter", fontSize: 24 },
        },
      }),
    ]);
    const runs = nodes[0].text as TextRun[];
    // Key order doesn't split the runs — one merged tuple, one ref.
    expect(runs).toHaveLength(1);
    const [text, ref] = asTuple(runs[0]);
    expect(text).toBe("ab");
    expect(styles[ref]).toEqual({ fontFamily: "Inter", fontSize: 24 });
  });

  it("shares one styles entry between a base textStyle and an identical run delta", async () => {
    // Node A's base textStyle is exactly { fontSize: 24 } — the same shape node
    // B's run delta produces. With {tsN} retired, run deltas register in the
    // same content-addressed namespace as base styles, so the identical value
    // dedupes to ONE entry rather than paying for two.
    const { nodes, styles } = await extract([
      makeText({
        id: "t1",
        name: "base only",
        characters: "x",
        style: { fontSize: 24 },
      }),
      makeText({
        id: "t2",
        name: "with inline",
        characters: "ab",
        style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16 },
        characterStyleOverrides: [1, 1],
        styleOverrideTable: { "1": { fontSize: 24 } },
      }),
    ]);
    const baseRef = nodes[0].textStyle as string;
    const [, runRef] = asTuple((nodes[1].text as TextRun[])[0]);
    expect(baseRef).toBe(runRef);
    expect(styles[baseRef]).toEqual({ fontSize: 24 });
  });
});

describe("buildFormattedText — newline escaping", () => {
  it("escapes real newlines as literal backslash-n in plain text", async () => {
    const { nodes } = await extract([makeText({ characters: "line one\nline two" })]);
    // Literal `\n` (two chars) — prevents YAML block-scalar emission.
    expect(nodes[0].text).toBe("line one\\nline two");
  });

  it("escapes paragraph separator U+2029 the same way", async () => {
    const { nodes } = await extract([makeText({ characters: "a\u2029b" })]);
    expect(nodes[0].text).toBe("a\\nb");
  });

  it("escapes newlines in styled runs too", async () => {
    const { nodes } = await extract([
      makeText({
        // "bold" chars 0–3, newline char 4, "tail" chars 5–8.
        characters: "bold\ntail",
        characterStyleOverrides: [1, 1, 1, 1],
        styleOverrideTable: { "1": { fontWeight: 700 } },
      }),
    ]);
    expect(nodes[0].text).toBe("**bold**\\ntail");
  });
});

describe("buildFormattedText — list formatting", () => {
  it("produces 1. / 2. / 3. prefixes for ordered lists", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "one\ntwo\nthree",
        lineTypes: ["ORDERED", "ORDERED", "ORDERED"],
        lineIndentations: [0, 0, 0],
      }),
    ]);
    expect(nodes[0].text).toBe("1. one\\n2. two\\n3. three");
  });

  it("produces - prefixes for unordered lists", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "a\nb",
        lineTypes: ["UNORDERED", "UNORDERED"],
        lineIndentations: [0, 0],
      }),
    ]);
    expect(nodes[0].text).toBe("- a\\n- b");
  });

  it("nests list levels with 2-space CommonMark indentation", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "outer\ninner\nback",
        lineTypes: ["ORDERED", "ORDERED", "ORDERED"],
        lineIndentations: [0, 1, 0],
      }),
    ]);
    // Outer ordered list continues across the nested level.
    expect(nodes[0].text).toBe("1. outer\\n  1. inner\\n2. back");
  });

  it("resets nested counters when the outer list advances", async () => {
    // Verifies that moving back up and then down again restarts the deeper
    // counter rather than resuming where it left off.
    const { nodes } = await extract([
      makeText({
        characters: "a\nx\ny\nb\nz",
        lineTypes: ["ORDERED", "ORDERED", "ORDERED", "ORDERED", "ORDERED"],
        lineIndentations: [0, 1, 1, 0, 1],
      }),
    ]);
    expect(nodes[0].text).toBe("1. a\\n  1. x\\n  2. y\\n2. b\\n  1. z");
  });

  it("preserves inline markdown inside list items", async () => {
    const { nodes } = await extract([
      makeText({
        // Chars: "a" "\n" "b" "o" "l" "d" — overrides length 6 (with newline).
        characters: "a\nbold",
        characterStyleOverrides: [0, 0, 1, 1, 1, 1],
        styleOverrideTable: { "1": { fontWeight: 700 } },
        lineTypes: ["UNORDERED", "UNORDERED"],
        lineIndentations: [0, 0],
      }),
    ]);
    expect(nodes[0].text).toBe("- a\\n- **bold**");
    expect(nodes[0].boldWeight).toBe(700);
  });

  it("handles mixed ordered and unordered list types", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "one\ntwo\nbullet",
        lineTypes: ["ORDERED", "ORDERED", "UNORDERED"],
        lineIndentations: [0, 0, 0],
      }),
    ]);
    expect(nodes[0].text).toBe("1. one\\n2. two\\n- bullet");
  });

  it("renders NONE lines between list items as plain paragraphs and resets ordering", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "item one\nbreak\nitem two",
        lineTypes: ["ORDERED", "NONE", "ORDERED"],
        lineIndentations: [0, 0, 0],
      }),
    ]);
    // A non-ORDERED line at the same depth breaks the list — the next
    // ORDERED item restarts at 1.
    expect(nodes[0].text).toBe("1. item one\\nbreak\\n1. item two");
  });

  it("preserves empty lines", async () => {
    const { nodes } = await extract([
      makeText({
        characters: "a\n\nb",
        lineTypes: ["NONE", "NONE", "NONE"],
        lineIndentations: [0, 0, 0],
      }),
    ]);
    expect(nodes[0].text).toBe("a\\n\\nb");
  });

  it("detects boldWeight across all lines of a list", async () => {
    const { nodes } = await extract([
      makeText({
        // "a" "\n" "big" — "big" is bold 800.
        characters: "a\nbig",
        characterStyleOverrides: [0, 0, 1, 1, 1],
        styleOverrideTable: { "1": { fontWeight: 800 } },
        lineTypes: ["UNORDERED", "UNORDERED"],
        lineIndentations: [0, 0],
      }),
    ]);
    // The bold run matches the canonical boldWeight, so markdown covers it —
    // no run tuple, the whole text stays one string.
    expect(nodes[0].text).toBe("- a\\n- **big**");
    expect(nodes[0].boldWeight).toBe(800);
  });
});

describe("extractTextStyle — line height", () => {
  it("omits lineHeight when the node uses Figma's auto (INTRINSIC_%) mode", async () => {
    // Real Figma shape: auto line height still reports a `lineHeightPx` (the
    // computed intrinsic value for the current font). Before the fix this
    // leaked out as an em string like "1.2102272851126534em".
    const { nodes, styles } = await extract([
      makeText({
        characters: "auto",
        style: {
          fontFamily: "Inter",
          fontWeight: 400,
          fontSize: 14,
          lineHeightPx: 16.94318199157715,
          lineHeightPercent: 100,
          lineHeightUnit: "INTRINSIC_%",
        } as never,
      }),
    ]);
    const styleRef = nodes[0].textStyle as string;
    const style = styles[styleRef] as SimplifiedTextStyle;
    expect(style.lineHeight).toBeUndefined();
  });

  it("emits explicit pixel line heights as px, rounded", async () => {
    const { nodes, styles } = await extract([
      makeText({
        characters: "explicit",
        style: {
          fontFamily: "Inter",
          fontWeight: 400,
          fontSize: 14,
          lineHeightPx: 16.94318199157715,
          lineHeightUnit: "PIXELS",
        } as never,
      }),
    ]);
    const styleRef = nodes[0].textStyle as string;
    const style = styles[styleRef] as SimplifiedTextStyle;
    expect(style.lineHeight).toBe("16.94px");
  });

  it("emits font-size-relative line heights as em (one canonical relative form)", async () => {
    const { nodes, styles } = await extract([
      makeText({
        characters: "pct",
        style: {
          fontFamily: "Inter",
          fontWeight: 400,
          fontSize: 14,
          lineHeightPx: 21,
          lineHeightPercentFontSize: 150,
          lineHeightUnit: "FONT_SIZE_%",
        } as never,
      }),
    ]);
    const styleRef = nodes[0].textStyle as string;
    const style = styles[styleRef] as SimplifiedTextStyle;
    expect(style.lineHeight).toBe("1.5em");
  });

  it("emits letterSpacing as em so it pastes straight into CSS", async () => {
    const { nodes, styles } = await extract([
      makeText({
        characters: "tracking",
        style: {
          fontFamily: "Inter",
          fontWeight: 400,
          fontSize: 16,
          letterSpacing: -0.32, // -0.32px / 16px = -0.02em
        } as never,
      }),
    ]);
    const styleRef = nodes[0].textStyle as string;
    const style = styles[styleRef] as SimplifiedTextStyle;
    expect(style.letterSpacing).toBe("-0.02em");
  });
});

describe("extractTextStyle — broadened base style capture", () => {
  it("includes fontStyle / textDecoration / hyperlink on a fully-styled text node", async () => {
    const { nodes, styles } = await extract([
      makeText({
        characters: "fully styled",
        style: {
          fontFamily: "Inter",
          fontWeight: 400,
          fontSize: 16,
          italic: true,
          textDecoration: "UNDERLINE",
          hyperlink: { type: "URL", url: "https://framelink.ai" },
        },
      }),
    ]);
    const styleRef = nodes[0].textStyle as string;
    const style = styles[styleRef] as SimplifiedTextStyle;
    expect(style.fontStyle).toBe("italic");
    expect(style.textDecoration).toBe("underline");
    expect(style.hyperlink).toEqual({ type: "URL", url: "https://framelink.ai" });
  });
});
