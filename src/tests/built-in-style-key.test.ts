import { describe, expect, it } from "vitest";
import type { Node as FigmaNode, Style, TypeStyle } from "@figma/rest-api-spec";
import { extractFromDesign } from "~/extractors/node-walker.js";
import { allExtractors } from "~/extractors/built-in.js";
import type { GlobalVars } from "~/extractors/types.js";

// resolveStyleKey decides whether a node's named Figma style collapses onto an
// existing same-name entry or gets a disambiguating ` (id)` suffix. The decision
// is a deep-equality check, so it must be order-insensitive: Figma can hand back
// semantically identical style objects with their keys in different orders, and a
// key-order-sensitive compare would spuriously split one style into two keys
// (wasted tokens + misleading distinct keys). These tests pin that behavior
// through the public extraction pipeline.

const STYLE_ID = "S:abc123";

// Minimal TEXT node carrying a named text-style reference. We cast through
// `unknown` because the full Figma node union is deeply discriminated and the
// extractor only reads these few fields.
function namedTextNode(style: Partial<TypeStyle>): FigmaNode {
  return {
    id: "text:1",
    name: "Heading",
    type: "TEXT",
    visible: true,
    characters: "Hello",
    style,
    styles: { text: STYLE_ID },
    characterStyleOverrides: [],
    styleOverrideTable: {},
    lineTypes: [],
    lineIndentations: [],
  } as unknown as FigmaNode;
}

const extraStyles: Record<string, Style> = {
  [STYLE_ID]: {
    key: "k",
    name: "Heading / Large",
    description: "",
    remote: false,
    styleType: "TEXT",
  } as Style,
};

async function extractWithSeed(seed: Record<string, unknown>) {
  const globalVars: GlobalVars = { styles: { "Heading / Large": seed } };
  return extractFromDesign(
    [namedTextNode({ fontFamily: "Inter", fontWeight: 700, fontSize: 24 })],
    allExtractors,
    {},
    globalVars,
    extraStyles,
  );
}

describe("resolveStyleKey — canonical (order-insensitive) comparison", () => {
  it("collapses a same-name style whose existing entry differs only in key order", async () => {
    // The node's extracted text style serializes to fontFamily/fontWeight/fontSize
    // (insertion order). The pre-existing entry holds the same values with keys in
    // a different order — a key-order-sensitive compare would split these.
    const { globalVars } = await extractWithSeed({
      fontFamily: "Inter",
      fontSize: 24,
      fontWeight: 700,
    });

    expect(Object.keys(globalVars.styles)).toEqual(["Heading / Large"]);
  });

  it("disambiguates a same-name style with genuinely different values", async () => {
    const { globalVars } = await extractWithSeed({
      fontFamily: "Inter",
      fontSize: 99,
      fontWeight: 700,
    });

    const keys = Object.keys(globalVars.styles);
    expect(keys).toContain("Heading / Large");
    expect(keys).toContain(`Heading / Large (${STYLE_ID})`);
    expect(keys).toHaveLength(2);
  });
});
