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

  describe("gap suppression with SPACE_BETWEEN", () => {
    test("primary: itemSpacing suppressed when SPACE_BETWEEN", () => {
      const node = makeFrame({
        primaryAxisAlignItems: "SPACE_BETWEEN",
        itemSpacing: 10,
      });
      expect(buildSimplifiedLayout(node).gap).toBeUndefined();
    });

    test("primary: itemSpacing preserved for other alignment modes", () => {
      const node = makeFrame({
        primaryAxisAlignItems: "MIN",
        itemSpacing: 10,
      });
      expect(buildSimplifiedLayout(node).gap).toBe("10px");
    });

    test("counter: counterAxisSpacing suppressed when SPACE_BETWEEN", () => {
      const node = makeFrame({
        layoutWrap: "WRAP",
        counterAxisAlignContent: "SPACE_BETWEEN",
        counterAxisSpacing: 24,
        primaryAxisAlignItems: "SPACE_BETWEEN",
        itemSpacing: 10,
      });
      expect(buildSimplifiedLayout(node).gap).toBeUndefined();
    });

    test("counter: counterAxisSpacing preserved when AUTO", () => {
      const node = makeFrame({
        layoutWrap: "WRAP",
        counterAxisAlignContent: "AUTO",
        counterAxisSpacing: 24,
        itemSpacing: 10,
      });
      expect(buildSimplifiedLayout(node).gap).toBe("24px 10px");
    });

    test("wrapped row: both gaps emit CSS shorthand (row-gap column-gap)", () => {
      const node = makeFrame({
        layoutMode: "HORIZONTAL",
        layoutWrap: "WRAP",
        itemSpacing: 10,
        counterAxisSpacing: 24,
      });
      // row layout: counterAxisSpacing=row-gap, itemSpacing=column-gap
      expect(buildSimplifiedLayout(node).gap).toBe("24px 10px");
    });

    test("wrapped column: both gaps emit CSS shorthand (row-gap column-gap)", () => {
      const node = makeFrame({
        layoutMode: "VERTICAL",
        layoutWrap: "WRAP",
        itemSpacing: 10,
        counterAxisSpacing: 24,
      });
      // column layout: itemSpacing=row-gap, counterAxisSpacing=column-gap
      expect(buildSimplifiedLayout(node).gap).toBe("10px 24px");
    });

    test("wrapped: equal gaps collapse to single value", () => {
      const node = makeFrame({
        layoutWrap: "WRAP",
        itemSpacing: 16,
        counterAxisSpacing: 16,
      });
      expect(buildSimplifiedLayout(node).gap).toBe("16px");
    });

    test("counterAxisSpacing ignored for non-wrapped layouts", () => {
      const node = makeFrame({
        layoutWrap: "NO_WRAP",
        itemSpacing: 10,
        counterAxisSpacing: 24,
      });
      expect(buildSimplifiedLayout(node).gap).toBe("10px");
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
