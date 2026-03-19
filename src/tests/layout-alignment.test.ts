import { describe, test, expect } from "vitest";
import { buildSimplifiedLayout } from "~/transformers/layout.js";
import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";

function makeFrame(overrides: Record<string, unknown> = {}) {
  return {
    clipsContent: true,
    layoutMode: "HORIZONTAL",
    children: [],
    primaryAxisAlignItems: "MIN",
    counterAxisAlignItems: "MIN",
    ...overrides,
  } as unknown as FigmaDocumentNode;
}

function makeChild(overrides: Record<string, unknown> = {}) {
  return {
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
    ...overrides,
  };
}

describe("layout alignment", () => {
  describe("justifyContent (primary axis)", () => {
    const cases: [string, string | undefined][] = [
      ["MIN", undefined],
      ["MAX", "flex-end"],
      ["CENTER", "center"],
      ["SPACE_BETWEEN", "space-between"],
    ];

    test.each(cases)("row: %s → %s", (figmaValue, expected) => {
      const node = makeFrame({
        layoutMode: "HORIZONTAL",
        primaryAxisAlignItems: figmaValue,
      });
      expect(buildSimplifiedLayout(node).justifyContent).toBe(expected);
    });

    test.each(cases)("column: %s → %s", (figmaValue, expected) => {
      const node = makeFrame({
        layoutMode: "VERTICAL",
        primaryAxisAlignItems: figmaValue,
      });
      expect(buildSimplifiedLayout(node).justifyContent).toBe(expected);
    });
  });

  describe("alignItems (counter axis)", () => {
    const cases: [string, string | undefined][] = [
      ["MIN", undefined],
      ["MAX", "flex-end"],
      ["CENTER", "center"],
      ["BASELINE", "baseline"],
    ];

    test.each(cases)("row: %s → %s", (figmaValue, expected) => {
      const node = makeFrame({
        layoutMode: "HORIZONTAL",
        counterAxisAlignItems: figmaValue,
      });
      expect(buildSimplifiedLayout(node).alignItems).toBe(expected);
    });

    test.each(cases)("column: %s → %s", (figmaValue, expected) => {
      const node = makeFrame({
        layoutMode: "VERTICAL",
        counterAxisAlignItems: figmaValue,
      });
      expect(buildSimplifiedLayout(node).alignItems).toBe(expected);
    });
  });

  describe("alignItems stretch detection", () => {
    test("row: all children fill cross axis → stretch", () => {
      const node = makeFrame({
        layoutMode: "HORIZONTAL",
        children: [
          makeChild({ layoutSizingVertical: "FILL" }),
          makeChild({ layoutSizingVertical: "FILL" }),
        ],
      });
      expect(buildSimplifiedLayout(node).alignItems).toBe("stretch");
    });

    test("column: all children fill cross axis → stretch", () => {
      const node = makeFrame({
        layoutMode: "VERTICAL",
        children: [
          makeChild({ layoutSizingHorizontal: "FILL" }),
          makeChild({ layoutSizingHorizontal: "FILL" }),
        ],
      });
      expect(buildSimplifiedLayout(node).alignItems).toBe("stretch");
    });

    test("row: mixed children → falls back to enum value", () => {
      const node = makeFrame({
        layoutMode: "HORIZONTAL",
        counterAxisAlignItems: "CENTER",
        children: [
          makeChild({ layoutSizingVertical: "FILL" }),
          makeChild({ layoutSizingVertical: "FIXED" }),
        ],
      });
      expect(buildSimplifiedLayout(node).alignItems).toBe("center");
    });

    test("column: mixed children → falls back to enum value", () => {
      const node = makeFrame({
        layoutMode: "VERTICAL",
        counterAxisAlignItems: "MAX",
        children: [
          makeChild({ layoutSizingHorizontal: "FILL" }),
          makeChild({ layoutSizingHorizontal: "FIXED" }),
        ],
      });
      expect(buildSimplifiedLayout(node).alignItems).toBe("flex-end");
    });

    test("absolute children are excluded from stretch check", () => {
      const node = makeFrame({
        layoutMode: "HORIZONTAL",
        children: [
          makeChild({ layoutSizingVertical: "FILL" }),
          makeChild({ layoutPositioning: "ABSOLUTE", layoutSizingVertical: "FIXED" }),
        ],
      });
      expect(buildSimplifiedLayout(node).alignItems).toBe("stretch");
    });

    test("no children → no stretch, uses enum value", () => {
      const node = makeFrame({
        layoutMode: "HORIZONTAL",
        counterAxisAlignItems: "CENTER",
        children: [],
      });
      expect(buildSimplifiedLayout(node).alignItems).toBe("center");
    });

    // These two tests verify correct cross-axis detection — the bug PR #232 addressed.
    // With the old bug, row mode checked layoutSizingHorizontal (main axis) instead of
    // layoutSizingVertical (cross axis), so children filling main-only would false-positive.
    test("row: children fill main axis only → no stretch", () => {
      const node = makeFrame({
        layoutMode: "HORIZONTAL",
        counterAxisAlignItems: "CENTER",
        children: [
          makeChild({ layoutSizingHorizontal: "FILL", layoutSizingVertical: "FIXED" }),
          makeChild({ layoutSizingHorizontal: "FILL", layoutSizingVertical: "FIXED" }),
        ],
      });
      expect(buildSimplifiedLayout(node).alignItems).toBe("center");
    });

    test("column: children fill main axis only → no stretch", () => {
      const node = makeFrame({
        layoutMode: "VERTICAL",
        counterAxisAlignItems: "CENTER",
        children: [
          makeChild({ layoutSizingVertical: "FILL", layoutSizingHorizontal: "FIXED" }),
          makeChild({ layoutSizingVertical: "FILL", layoutSizingHorizontal: "FIXED" }),
        ],
      });
      expect(buildSimplifiedLayout(node).alignItems).toBe("center");
    });
  });
});
