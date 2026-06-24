import { describe, test, expect } from "vitest";
import { buildSimplifiedLayout, computeGridChildOrder } from "~/transformers/layout.js";
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

  describe("dimensions in parent auto layout", () => {
    test("keeps fixed height when a row child stretches across a column parent", () => {
      const parent = makeFrame({
        layoutMode: "VERTICAL",
        absoluteBoundingBox: { x: 0, y: 0, width: 536, height: 158 },
      });
      const child = makeFrame({
        layoutMode: "HORIZONTAL",
        absoluteBoundingBox: { x: 0, y: 80, width: 536, height: 78 },
        layoutAlign: "STRETCH",
        layoutGrow: 0,
        layoutSizingHorizontal: "FILL",
        layoutSizingVertical: "FIXED",
      });

      expect(buildSimplifiedLayout(child, parent).dimensions).toEqual({ height: 78 });
    });
  });

  // The requested root has no parent in the payload, so Figma reports it as
  // FIXED at its artboard size — an artifact of being top-level. Honoring that
  // as a hard width/height would pin the whole design and kill responsiveness,
  // so the root marks such axes "contextual" and keeps the size as a non-binding
  // designed* reference. Descendants (real parent) keep their fixed semantics.
  describe("root node contextual sizing", () => {
    test("rewrites FIXED axes as contextual + designed reference on a top-level node", () => {
      const root = makeFrame({
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
        absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
      });
      const layout = buildSimplifiedLayout(root);
      expect(layout.sizing).toEqual({ horizontal: "contextual", vertical: "contextual" });
      expect(layout.designedWidth).toBe("1440px");
      expect(layout.designedHeight).toBe("900px");
      // No binding dimensions on the root.
      expect(layout.dimensions).toBeUndefined();
    });

    test("keeps the same FIXED sizing and dimensions on a non-root child", () => {
      const parent = makeFrame({
        layoutMode: "NONE",
        absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
      });
      const child = makeFrame({
        layoutMode: "NONE",
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
      });
      const layout = buildSimplifiedLayout(child, parent);
      expect(layout.sizing).toEqual({ horizontal: "fixed", vertical: "fixed" });
      expect(layout.dimensions).toEqual({ width: 200, height: 100 });
      expect(layout.designedWidth).toBeUndefined();
    });

    test("only the FIXED axis becomes contextual; a real HUG axis is left alone", () => {
      const root = makeFrame({
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "HUG",
        absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
      });
      const layout = buildSimplifiedLayout(root);
      // Canonical desktop root: fluid width, content-sized height.
      expect(layout.sizing).toEqual({ horizontal: "contextual", vertical: "hug" });
      expect(layout.designedWidth).toBe("1440px");
      // HUG needs no anchor — height is determined by content.
      expect(layout.designedHeight).toBeUndefined();
    });
  });

  describe("locationRelativeToParent", () => {
    // SECTION holds children but has no frame properties (no clipsContent, no
    // layoutMode), so it can never auto-layout — children are always positioned
    // absolutely within it. Regression guard: a stricter `isFrame(parent)` gate
    // previously dropped positions for SECTION children entirely.
    test("emits position for children of a SECTION parent", () => {
      const section = {
        type: "SECTION",
        absoluteBoundingBox: { x: 100, y: 200, width: 708, height: 245 },
      } as unknown as FigmaDocumentNode;
      const child = makeFrame({
        layoutMode: "NONE",
        absoluteBoundingBox: { x: 120, y: 210, width: 50, height: 50 },
      });

      expect(buildSimplifiedLayout(child, section).locationRelativeToParent).toEqual({
        x: 20,
        y: 10,
      });
    });

    test("omits position for top-level nodes (no parent)", () => {
      const node = makeFrame({
        absoluteBoundingBox: { x: 100, y: 200, width: 50, height: 50 },
      });
      expect(buildSimplifiedLayout(node).locationRelativeToParent).toBeUndefined();
    });

    test("omits position for in-flow children of an auto-layout parent", () => {
      const parent = makeFrame({
        layoutMode: "HORIZONTAL",
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
      });
      const child = makeFrame({
        absoluteBoundingBox: { x: 10, y: 10, width: 50, height: 50 },
      });
      expect(buildSimplifiedLayout(child, parent).locationRelativeToParent).toBeUndefined();
    });

    test("emits position for ABSOLUTE children inside an auto-layout parent", () => {
      const parent = makeFrame({
        layoutMode: "HORIZONTAL",
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
      });
      const child = makeFrame({
        layoutPositioning: "ABSOLUTE",
        absoluteBoundingBox: { x: 30, y: 40, width: 50, height: 50 },
      });
      const result = buildSimplifiedLayout(child, parent);
      expect(result.position).toBe("absolute");
      expect(result.locationRelativeToParent).toEqual({ x: 30, y: 40 });
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

  describe("z-order vs grid-flow order", () => {
    test("children already in anchor order: no sort, no zIndex", () => {
      const c1 = makeGridChild({ gridColumnAnchorIndex: 0, gridRowAnchorIndex: 0 });
      const c2 = makeGridChild({ gridColumnAnchorIndex: 1, gridRowAnchorIndex: 0 });
      const c3 = makeGridChild({ gridColumnAnchorIndex: 2, gridRowAnchorIndex: 0 });
      const parent = makeGridParent({ children: [c1, c2, c3] });

      expect(computeGridChildOrder(parent)).toBeNull();
      expect(buildSimplifiedLayout(c1, parent).zIndex).toBeUndefined();
      expect(buildSimplifiedLayout(c2, parent).zIndex).toBeUndefined();
      expect(buildSimplifiedLayout(c3, parent).zIndex).toBeUndefined();
    });

    test("z-order differs from anchor order with overlap: sort, emit zIndex on moved children", () => {
      // Mirrors the "Dynamic - FR" case from the Figma file: 6 children in a 3x2
      // packed grid, where the 100x100 cell-spanning child is z-order-last but
      // belongs at row 2 col 0 in grid flow. Children are placed with overlapping
      // bboxes to verify zIndex is emitted when stacking matters.
      const overlapBox = { x: 0, y: 0, width: 100, height: 100 };
      const c0 = makeGridChild({
        gridColumnAnchorIndex: 0,
        gridRowAnchorIndex: 0,
        absoluteBoundingBox: overlapBox,
      });
      const c1 = makeGridChild({
        gridColumnAnchorIndex: 1,
        gridRowAnchorIndex: 0,
        absoluteBoundingBox: overlapBox,
      });
      const c2 = makeGridChild({
        gridColumnAnchorIndex: 2,
        gridRowAnchorIndex: 0,
        absoluteBoundingBox: overlapBox,
      });
      const c3 = makeGridChild({
        gridColumnAnchorIndex: 1,
        gridRowAnchorIndex: 1,
        absoluteBoundingBox: overlapBox,
      });
      const c4 = makeGridChild({
        gridColumnAnchorIndex: 2,
        gridRowAnchorIndex: 1,
        absoluteBoundingBox: overlapBox,
      });
      const cBig = makeGridChild({
        gridColumnAnchorIndex: 0,
        gridRowAnchorIndex: 1,
        absoluteBoundingBox: overlapBox,
      });
      const parent = makeGridParent({ children: [c0, c1, c2, c3, c4, cBig] });

      // Sorted order is [c0, c1, c2, cBig, c3, c4] → indices [0, 1, 2, 5, 3, 4]
      expect(computeGridChildOrder(parent)).toEqual([0, 1, 2, 5, 3, 4]);

      // Unmoved children: no zIndex
      expect(buildSimplifiedLayout(c0, parent).zIndex).toBeUndefined();
      expect(buildSimplifiedLayout(c1, parent).zIndex).toBeUndefined();
      expect(buildSimplifiedLayout(c2, parent).zIndex).toBeUndefined();

      // Moved children: zIndex = original index (Figma z-order)
      expect(buildSimplifiedLayout(c3, parent).zIndex).toBe(3);
      expect(buildSimplifiedLayout(c4, parent).zIndex).toBe(4);
      expect(buildSimplifiedLayout(cBig, parent).zIndex).toBe(5);

      // Packed grid → no explicit grid positions emitted; sort handles placement
      expect(buildSimplifiedLayout(cBig, parent).gridColumn).toBeUndefined();
      expect(buildSimplifiedLayout(cBig, parent).gridRow).toBeUndefined();
    });

    test("sort reorders, but no overlap: skip zIndex (stacking can't affect rendering)", () => {
      // Array order ≠ anchor order, so sort reorders, but children sit in
      // distinct screen positions with no overlap — stacking is invisible
      // and zIndex would be noise.
      const c0 = makeGridChild({
        gridColumnAnchorIndex: 0,
        gridRowAnchorIndex: 0,
        absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 50 },
      });
      // Second in z-order but anchored at (1, 0) — sorts last.
      const cBottom = makeGridChild({
        gridColumnAnchorIndex: 0,
        gridRowAnchorIndex: 1,
        absoluteBoundingBox: { x: 0, y: 60, width: 50, height: 50 },
      });
      // Third in z-order but anchored at (0, 1) — sorts second.
      const cRight = makeGridChild({
        gridColumnAnchorIndex: 1,
        gridRowAnchorIndex: 0,
        absoluteBoundingBox: { x: 60, y: 0, width: 50, height: 50 },
      });
      const parent = makeGridParent({ children: [c0, cBottom, cRight] });

      // Sort still reorders: c0 stays, cRight (idx 2) moves to slot 1, cBottom (idx 1) to slot 2.
      expect(computeGridChildOrder(parent)).toEqual([0, 2, 1]);

      // But no overlap → no zIndex on anyone, including the moved children.
      expect(buildSimplifiedLayout(c0, parent).zIndex).toBeUndefined();
      expect(buildSimplifiedLayout(cBottom, parent).zIndex).toBeUndefined();
      expect(buildSimplifiedLayout(cRight, parent).zIndex).toBeUndefined();
    });

    test("adjacent cells touching (gap = 0) are not overlap", () => {
      // c0 at x=0..50 and cRight at x=50..100 share an edge but don't overlap.
      // The reordered child still shouldn't get a zIndex.
      const c0 = makeGridChild({
        gridColumnAnchorIndex: 0,
        gridRowAnchorIndex: 0,
        absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 50 },
      });
      const cBottom = makeGridChild({
        gridColumnAnchorIndex: 0,
        gridRowAnchorIndex: 1,
        absoluteBoundingBox: { x: 0, y: 50, width: 50, height: 50 },
      });
      const cRight = makeGridChild({
        gridColumnAnchorIndex: 1,
        gridRowAnchorIndex: 0,
        absoluteBoundingBox: { x: 50, y: 0, width: 50, height: 50 },
      });
      const parent = makeGridParent({ children: [c0, cBottom, cRight] });

      expect(buildSimplifiedLayout(cBottom, parent).zIndex).toBeUndefined();
      expect(buildSimplifiedLayout(cRight, parent).zIndex).toBeUndefined();
    });

    test("ABSOLUTE children keep their slot; in-flow siblings still sort", () => {
      const c0 = makeGridChild({ gridColumnAnchorIndex: 0, gridRowAnchorIndex: 0 });
      const cAbs = makeGridChild({
        layoutPositioning: "ABSOLUTE",
        gridColumnAnchorIndex: 0,
        gridRowAnchorIndex: 0,
      });
      const c1 = makeGridChild({ gridColumnAnchorIndex: 0, gridRowAnchorIndex: 1 });
      const c2 = makeGridChild({ gridColumnAnchorIndex: 1, gridRowAnchorIndex: 0 });
      const parent = makeGridParent({ children: [c0, cAbs, c1, c2] });

      // In-flow indices [0, 2, 3] sort by anchor → [0, 3, 2]; absolute keeps slot 1.
      expect(computeGridChildOrder(parent)).toEqual([0, 1, 3, 2]);
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

describe("aspectRatio zero-height guard", () => {
  // A zero-height column child would divide width/0 and emit aspectRatio:Infinity
  // into the LLM-facing output. The guard drops the field rather than emit a
  // value no consumer can use.
  // A non-auto-layout parent so the child's own column mode drives the axis.
  const parent = makeFrame({
    layoutMode: "NONE",
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
  });
  const columnChild = (height: number) =>
    makeFrame({
      layoutMode: "VERTICAL",
      preserveRatio: true,
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height },
    });

  test("does not emit aspectRatio for a column child with zero height", () => {
    const result = buildSimplifiedLayout(columnChild(0), parent);

    expect(result.dimensions?.aspectRatio).toBeUndefined();
  });

  test("still emits aspectRatio for a column child with non-zero height", () => {
    const result = buildSimplifiedLayout(columnChild(50), parent);

    expect(result.dimensions?.aspectRatio).toBe(2);
  });
});
