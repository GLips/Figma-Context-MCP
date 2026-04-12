import { describe, expect, it } from "vitest";
import type { Node as FigmaNode, TypeStyle } from "@figma/rest-api-spec";
import { extractFromDesign } from "~/extractors/node-walker.js";
import { allExtractors } from "~/extractors/built-in.js";
import type { SimplifiedTextStyle } from "~/transformers/text.js";

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
  } as unknown as FigmaNode;
}

async function extract(nodes: FigmaNode[]) {
  return extractFromDesign(nodes, allExtractors);
}

describe("buildFormattedText — plain text passthrough", () => {
  it("emits raw text with no boldWeight when there are no overrides", async () => {
    const { nodes, globalVars } = await extract([makeText({ characters: "Hello world" })]);
    expect(nodes[0].text).toBe("Hello world");
    expect(nodes[0].boldWeight).toBeUndefined();
    // No ts refs should appear in globalVars when there are no overrides.
    expect(Object.keys(globalVars.styles).some((k) => k.startsWith("ts"))).toBe(false);
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

describe("buildFormattedText — style-ref overrides", () => {
  it("color (fills) override emits a ts ref with a fills delta", async () => {
    const { nodes, globalVars } = await extract([
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
    expect(nodes[0].text).toMatch(/^\{ts1\}red\{\/ts1\}$/);
    const delta = globalVars.styles["ts1"] as SimplifiedTextStyle;
    expect(delta.fills).toEqual(["#FF0000"]);
  });

  it("fontSize override emits a ts ref with fontSize delta", async () => {
    const { nodes, globalVars } = await extract([
      makeText({
        characters: "big",
        style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16 },
        characterStyleOverrides: [1, 1, 1],
        styleOverrideTable: { "1": { fontSize: 24 } },
      }),
    ]);
    expect(nodes[0].text).toBe("{ts1}big{/ts1}");
    expect(globalVars.styles["ts1"]).toEqual({ fontSize: 24 });
  });

  it("mixed bold + color nests style ref outside markdown", async () => {
    const { nodes, globalVars } = await extract([
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
    expect(nodes[0].text).toBe("{ts1}**hot**{/ts1}");
    expect(nodes[0].boldWeight).toBe(700);
    // The ts ref carries only fills — the bold lives in markdown, not the ref.
    expect(globalVars.styles["ts1"]).toEqual({ fills: ["#FF0000"] });
  });

  it("NODE-type hyperlink falls through to a style ref", async () => {
    const { nodes, globalVars } = await extract([
      makeText({
        characters: "ref",
        characterStyleOverrides: [1, 1, 1],
        styleOverrideTable: {
          "1": { hyperlink: { type: "NODE", nodeID: "42:1" } },
        },
      }),
    ]);
    expect(nodes[0].text).toBe("{ts1}ref{/ts1}");
    expect(globalVars.styles["ts1"]).toEqual({
      hyperlink: { type: "NODE", nodeID: "42:1" },
    });
  });
});

describe("buildFormattedText — run merging and weight detection", () => {
  it("merges adjacent runs with identical deltas from different override IDs", async () => {
    // Two override entries with visually identical deltas should collapse.
    const { nodes, globalVars } = await extract([
      makeText({
        characters: "abcd",
        characterStyleOverrides: [1, 1, 2, 2],
        styleOverrideTable: {
          "1": { fontSize: 24 },
          "2": { fontSize: 24 },
        },
      }),
    ]);
    expect(nodes[0].text).toBe("{ts1}abcd{/ts1}");
    // Only one ref registered in globalVars — no ts2.
    expect(globalVars.styles["ts1"]).toEqual({ fontSize: 24 });
    expect(globalVars.styles["ts2"]).toBeUndefined();
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
    const { nodes, globalVars } = await extract([
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
    // "AAAAAA" renders as plain **, "BBB" renders as {ts1}**BBB**{/ts1}.
    expect(nodes[0].text).toBe("**AAAAAA** {ts1}**BBB**{/ts1}");
    expect(globalVars.styles["ts1"]).toEqual({ fontWeight: 600 });
  });

  it("inverse override (lighter than base) becomes a style ref, not markdown", async () => {
    const { nodes, globalVars } = await extract([
      makeText({
        characters: "ab",
        style: { fontFamily: "Inter", fontWeight: 700, fontSize: 16 },
        characterStyleOverrides: [0, 1],
        styleOverrideTable: { "1": { fontWeight: 400 } },
      }),
    ]);
    expect(nodes[0].text).toBe("a{ts1}b{/ts1}");
    expect(nodes[0].boldWeight).toBeUndefined();
    expect(globalVars.styles["ts1"]).toEqual({ fontWeight: 400 });
  });
});

describe("buildFormattedText — cross-node dedup and edge cases", () => {
  it("shares a ts ref across different text nodes with the same delta", async () => {
    const { nodes, globalVars } = await extract([
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
    expect(nodes[0].text).toBe("{ts1}ab{/ts1}");
    expect(nodes[1].text).toBe("{ts1}cd{/ts1}");
    // Only one ts entry registered — deduped via the globalVars style cache.
    const tsKeys = Object.keys(globalVars.styles).filter((k) => k.startsWith("ts"));
    expect(tsKeys).toEqual(["ts1"]);
  });

  it("drops no-op overrides that match the base style", async () => {
    const { nodes, globalVars } = await extract([
      makeText({
        characters: "x",
        style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16 },
        characterStyleOverrides: [1],
        // Override declares fontWeight: 400 — same as base, so it's a no-op.
        styleOverrideTable: { "1": { fontWeight: 400 } },
      }),
    ]);
    expect(nodes[0].text).toBe("x");
    expect(nodes[0].boldWeight).toBeUndefined();
    expect(Object.keys(globalVars.styles).some((k) => k.startsWith("ts"))).toBe(false);
  });

  it("handles an empty text node", async () => {
    const { nodes } = await extract([makeText({ characters: "" })]);
    // Empty text: no `text` field is set on the result.
    expect(nodes[0].text).toBeUndefined();
    expect(nodes[0].boldWeight).toBeUndefined();
  });
});

describe("extractTextStyle — broadened base style capture", () => {
  it("includes italic / textDecoration / hyperlink on a fully-styled text node", async () => {
    const { nodes, globalVars } = await extract([
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
    const styleRef = nodes[0].textStyle!;
    const style = globalVars.styles[styleRef] as SimplifiedTextStyle;
    expect(style.italic).toBe(true);
    expect(style.textDecoration).toBe("UNDERLINE");
    expect(style.hyperlink).toEqual({ type: "URL", url: "https://framelink.ai" });
  });
});
