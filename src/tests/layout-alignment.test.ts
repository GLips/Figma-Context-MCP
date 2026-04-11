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

describe("grid layout", () => {
  function makeGridParent(overrides: Record<string, unknown> = {}) {
    return makeFrame({
      layoutMode: "GRID",
      gridColumnsSizing: "repeat(3,minmax(0,1fr))",
      gridRowsSizing: "auto",
      children: [],
      ...overrides,
    });
  }

  function makeGridChild(overrides: Record<string, unknown> = {}) {
    return {
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
      gridColumnAnchorIndex: 0,
      gridRowAnchorIndex: 0,
      gridColumnSpan: 1,
      gridRowSpan: 1,
      gridChildHorizontalAlign: "AUTO",
      gridChildVerticalAlign: "AUTO",
      ...overrides,
    } as unknown as FigmaDocumentNode;
  }

  describe("grid container", () => {
    test("basic grid container output", () => {
      const node = makeFrame({
        layoutMode: "GRID",
        absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
        gridColumnsSizing: "repeat(3,minmax(0,1fr))",
        gridRowsSizing: "auto",
        gridRowGap: 10,
        gridColumnGap: 10,
      });
      const result = buildSimplifiedLayout(node);
      expect(result.mode).toBe("grid");
      expect(result.gridTemplateColumns).toBe("repeat(3,minmax(0,1fr))");
      expect(result.gridTemplateRows).toBe("auto");
      expect(result.gap).toBe("10px");
      // Flex-specific props should NOT be present
      expect(result.justifyContent).toBeUndefined();
      expect(result.alignItems).toBeUndefined();
      expect(result.wrap).toBeUndefined();
    });

    test("trims whitespace from grid template strings", () => {
      const node = makeFrame({
        layoutMode: "GRID",
        absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
        gridColumnsSizing: "  100px 200px  ",
        gridRowsSizing: "  auto  ",
      });
      const result = buildSimplifiedLayout(node);
      expect(result.gridTemplateColumns).toBe("100px 200px");
      expect(result.gridTemplateRows).toBe("auto");
    });

    test("unequal row/column gaps produce CSS shorthand", () => {
      const node = makeFrame({
        layoutMode: "GRID",
        absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
        gridRowGap: 10,
        gridColumnGap: 20,
      });
      expect(buildSimplifiedLayout(node).gap).toBe("10px 20px");
    });

    test("grid container with padding", () => {
      const node = makeFrame({
        layoutMode: "GRID",
        absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
        paddingTop: 8,
        paddingRight: 16,
        paddingBottom: 8,
        paddingLeft: 16,
      });
      expect(buildSimplifiedLayout(node).padding).toBe("8px 16px");
    });
  });

  describe("grid child properties", () => {
    test("default grid child (span 1, AUTO align, packed) produces no grid props", () => {
      const child = makeGridChild();
      const parent = makeGridParent({ children: [child] });
      const result = buildSimplifiedLayout(child, parent);
      expect(result.gridColumn).toBeUndefined();
      expect(result.gridRow).toBeUndefined();
      expect(result.justifySelf).toBeUndefined();
      expect(result.alignSelf).toBeUndefined();
    });

    test("packed grid: column span > 1 emits span shorthand", () => {
      const child = makeGridChild({ gridColumnSpan: 2 });
      const parent = makeGridParent({ children: [child] });
      const result = buildSimplifiedLayout(child, parent);
      expect(result.gridColumn).toBe("span 2");
      expect(result.gridRow).toBeUndefined();
    });

    test("packed grid: row span > 1 emits span shorthand", () => {
      const child = makeGridChild({ gridRowSpan: 3 });
      const parent = makeGridParent({ children: [child] });
      const result = buildSimplifiedLayout(child, parent);
      expect(result.gridRow).toBe("span 3");
    });

    test("non-AUTO horizontal alignment emits justifySelf", () => {
      const child = makeGridChild({ gridChildHorizontalAlign: "CENTER" });
      const parent = makeGridParent({ children: [child] });
      expect(buildSimplifiedLayout(child, parent).justifySelf).toBe("center");
    });

    test("non-AUTO vertical alignment emits alignSelf", () => {
      const child = makeGridChild({ gridChildVerticalAlign: "MAX" });
      const parent = makeGridParent({ children: [child] });
      expect(buildSimplifiedLayout(child, parent).alignSelf).toBe("end");
    });

    test("MIN alignment maps to start", () => {
      const child = makeGridChild({
        gridChildHorizontalAlign: "MIN",
        gridChildVerticalAlign: "MIN",
      });
      const parent = makeGridParent({ children: [child] });
      const result = buildSimplifiedLayout(child, parent);
      expect(result.justifySelf).toBe("start");
      expect(result.alignSelf).toBe("start");
    });
  });

  describe("packed vs gapped grid positions", () => {
    test("packed grid: no explicit positions emitted", () => {
      // 3 children filling a 3-column grid sequentially
      const c1 = makeGridChild({ gridColumnAnchorIndex: 0, gridRowAnchorIndex: 0 });
      const c2 = makeGridChild({ gridColumnAnchorIndex: 1, gridRowAnchorIndex: 0 });
      const c3 = makeGridChild({ gridColumnAnchorIndex: 2, gridRowAnchorIndex: 0 });
      const parent = makeGridParent({ children: [c1, c2, c3] });

      expect(buildSimplifiedLayout(c1, parent).gridColumn).toBeUndefined();
      expect(buildSimplifiedLayout(c2, parent).gridColumn).toBeUndefined();
      expect(buildSimplifiedLayout(c3, parent).gridColumn).toBeUndefined();
    });

    test("gapped grid: explicit positions on all children", () => {
      // 2 children in a 3-column grid with a gap (cell at 0,1 is empty)
      const c1 = makeGridChild({ gridColumnAnchorIndex: 0, gridRowAnchorIndex: 0 });
      const c2 = makeGridChild({ gridColumnAnchorIndex: 2, gridRowAnchorIndex: 0 });
      const parent = makeGridParent({ children: [c1, c2] });

      // CSS is 1-based
      expect(buildSimplifiedLayout(c1, parent).gridColumn).toBe("1");
      expect(buildSimplifiedLayout(c1, parent).gridRow).toBe("1");
      expect(buildSimplifiedLayout(c2, parent).gridColumn).toBe("3");
      expect(buildSimplifiedLayout(c2, parent).gridRow).toBe("1");
    });

    test("gapped grid with spans: position includes span", () => {
      // Child spans 2 columns in a gapped grid
      const c1 = makeGridChild({
        gridColumnAnchorIndex: 0,
        gridRowAnchorIndex: 0,
        gridColumnSpan: 2,
      });
      const c2 = makeGridChild({ gridColumnAnchorIndex: 0, gridRowAnchorIndex: 1 });
      // c1 occupies (0,0) and (0,1), c2 occupies (1,0) — gapped because (1,1) is empty
      const parent = makeGridParent({ children: [c1, c2] });

      expect(buildSimplifiedLayout(c1, parent).gridColumn).toBe("1 / span 2");
      expect(buildSimplifiedLayout(c1, parent).gridRow).toBe("1");
    });
  });

  describe("gap shorthand zero handling", () => {
    test("zero row gap with non-zero column gap", () => {
      const node = makeFrame({
        layoutMode: "GRID",
        absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
        gridRowGap: 0,
        gridColumnGap: 16,
      });
      expect(buildSimplifiedLayout(node).gap).toBe("0px 16px");
    });

    test("both gaps zero is omitted (CSS default)", () => {
      const node = makeFrame({
        layoutMode: "GRID",
        absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
        gridRowGap: 0,
        gridColumnGap: 0,
      });
      expect(buildSimplifiedLayout(node).gap).toBeUndefined();
    });
  });

  describe("cross-layout nesting", () => {
    test("grid container inside flex parent retains alignSelf", () => {
      const gridContainer = makeFrame({
        layoutMode: "GRID",
        layoutAlign: "CENTER",
        gridColumnsSizing: "1fr 1fr",
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
      });
      const flexParent = makeFrame({
        layoutMode: "HORIZONTAL",
        children: [gridContainer],
      });
      const result = buildSimplifiedLayout(gridContainer, flexParent);
      // Container should be grid mode
      expect(result.mode).toBe("grid");
      expect(result.gridTemplateColumns).toBe("1fr 1fr");
      // But should NOT have flex alignment from parent
      expect(result.justifyContent).toBeUndefined();
      // alignSelf comes from the container's own layoutAlign
      expect(result.alignSelf).toBe("center");
    });

    test("flex container inside grid parent gets grid child props", () => {
      // A child that is itself a flex row, but sits inside a grid
      const flexChild = makeFrame({
        layoutMode: "HORIZONTAL",
        children: [],
        gridColumnSpan: 2,
        gridChildHorizontalAlign: "CENTER",
        gridColumnAnchorIndex: 0,
        gridRowAnchorIndex: 0,
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
      });
      const gridParent = makeFrame({
        layoutMode: "GRID",
        gridColumnsSizing: "1fr 1fr 1fr",
        children: [flexChild],
      });
      const result = buildSimplifiedLayout(flexChild, gridParent);
      // Own layout mode drives the mode
      expect(result.mode).toBe("row");
      // Grid child props come from grid parent relationship
      expect(result.gridColumn).toBe("span 2");
      expect(result.justifySelf).toBe("center");
    });
  });
});
