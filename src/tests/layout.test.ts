import { describe, expect, it } from "vitest";
import * as __testedFile from "../transformers/layout.js";

const parentNode = {
  type: "FRAME",
  layoutMode: "NONE",
  absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 500 },
};

const nodeNonFrame = {
  type: "RECTANGLE",
  absoluteBoundingBox: { x: 100, y: 100, width: 50, height: 50 },
  layoutSizingHorizontal: "FIXED",
  layoutSizingVertical: "FIXED",
};

const nodeStretch = {
  type: "FRAME",
  layoutMode: "HORIZONTAL",
  primaryAxisAlignItems: "CENTER",
  children: [
    { type: "RECTANGLE", layoutSizingHorizontal: "FILL" },
    { type: "FRAME", layoutSizingHorizontal: "FILL" },
    { type: "VECTOR", layoutPositioning: "ABSOLUTE" },
  ],
};

const nodeAbsolutePositioning = {
  type: "RECTANGLE",
  layoutPositioning: "ABSOLUTE",
  absoluteBoundingBox: { x: 50, y: 50, width: 100, height: 100 },
  layoutSizingHorizontal: "FIXED",
  layoutSizingVertical: "FIXED",
};

const nodeAbsolutePositioningResult = {
  dimensions: {
    height: 100,
    width: 100,
  },
  mode: "none" as const,
  sizing: {
    horizontal: "fixed" as const,
    vertical: "fixed" as const,
  },
};

const nodeOverflow = {
  type: "FRAME",
  layoutMode: "VERTICAL",
  overflowDirection: ["HORIZONTAL", "VERTICAL"],
  paddingTop: 10,
  paddingBottom: 10,
  paddingLeft: 20,
  paddingRight: 20,
  itemSpacing: 8,
};

const nodeAspectRatio = {
  type: "FRAME",
  layoutMode: "VERTICAL",
  layoutSizingHorizontal: "HUG",
  layoutSizingVertical: "FILL",
  layoutAlign: "STRETCH",
  preserveRatio: true,
  absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
};

describe("src/transformers/layout.ts", () => {
  describe("buildSimplifiedLayout", () => {
    const { buildSimplifiedLayout } = __testedFile;
    // n: FigmaDocumentNode
    // parent: undefined | FigmaDocumentNode

    it("Absolute Positioning with parent", () => {
      const n: Parameters<typeof buildSimplifiedLayout>[0] = nodeAbsolutePositioning as any;
      const parent: Parameters<typeof buildSimplifiedLayout>[1] = parentNode as any;
      const __expectedResult: ReturnType<typeof buildSimplifiedLayout> =
        nodeAbsolutePositioningResult;
      expect(buildSimplifiedLayout(n, parent)).toEqual(__expectedResult);
    });

    it("Aspect Ratio with parent", () => {
      const n: Parameters<typeof buildSimplifiedLayout>[0] = nodeAspectRatio as any;
      const parent: Parameters<typeof buildSimplifiedLayout>[1] = parentNode as any;
      const __expectedResult: ReturnType<typeof buildSimplifiedLayout> = {
        sizing: { horizontal: "hug", vertical: "fill" },
        mode: "none",
      };
      expect(buildSimplifiedLayout(n, parent)).toEqual(__expectedResult);
    });

    it("Non-Frame with parent", () => {
      const n: Parameters<typeof buildSimplifiedLayout>[0] = nodeNonFrame as any;
      const parent: Parameters<typeof buildSimplifiedLayout>[1] = parentNode as any;
      const __expectedResult: ReturnType<typeof buildSimplifiedLayout> = {
        mode: "none",
        dimensions: { width: 50, height: 50 },
        sizing: { horizontal: "fixed", vertical: "fixed" },
      };
      expect(buildSimplifiedLayout(n, parent)).toEqual(__expectedResult);
    });

    it("Overflow with parent", () => {
      const n: Parameters<typeof buildSimplifiedLayout>[0] = nodeOverflow as any;
      const parent: Parameters<typeof buildSimplifiedLayout>[1] = parentNode as any;
      const __expectedResult: ReturnType<typeof buildSimplifiedLayout> = { mode: "none" };
      expect(buildSimplifiedLayout(n, parent)).toEqual(__expectedResult);
    });

    it("Stretch with parent", () => {
      const n: Parameters<typeof buildSimplifiedLayout>[0] = nodeStretch as any;
      const parent: Parameters<typeof buildSimplifiedLayout>[1] = parentNode as any;
      const __expectedResult: ReturnType<typeof buildSimplifiedLayout> = { mode: "none" };
      expect(buildSimplifiedLayout(n, parent)).toEqual(__expectedResult);
    });

    it("Absolute Positioning without parent", () => {
      const n: Parameters<typeof buildSimplifiedLayout>[0] = nodeAbsolutePositioning as any;
      const parent: Parameters<typeof buildSimplifiedLayout>[1] = undefined;
      const __expectedResult: ReturnType<typeof buildSimplifiedLayout> =
        nodeAbsolutePositioningResult;
      expect(buildSimplifiedLayout(n, parent)).toEqual(__expectedResult);
    });

    it("Aspect Ratio without parent", () => {
      const n: Parameters<typeof buildSimplifiedLayout>[0] = nodeAspectRatio as any;
      const parent: Parameters<typeof buildSimplifiedLayout>[1] = undefined;
      const __expectedResult: ReturnType<typeof buildSimplifiedLayout> = {
        sizing: { horizontal: "hug", vertical: "fill" },
        mode: "none",
      };
      expect(buildSimplifiedLayout(n, parent)).toEqual(__expectedResult);
    });

    it("Non-Frame without parent", () => {
      const n: Parameters<typeof buildSimplifiedLayout>[0] = nodeNonFrame as any;
      const parent: Parameters<typeof buildSimplifiedLayout>[1] = undefined;
      const __expectedResult: ReturnType<typeof buildSimplifiedLayout> = {
        mode: "none",
        dimensions: { width: 50, height: 50 },
        sizing: { horizontal: "fixed", vertical: "fixed" },
      };
      expect(buildSimplifiedLayout(n, parent)).toEqual(__expectedResult);
    });

    it("Overflow without parent", () => {
      const n: Parameters<typeof buildSimplifiedLayout>[0] = nodeOverflow as any;
      const parent: Parameters<typeof buildSimplifiedLayout>[1] = undefined;
      const __expectedResult: ReturnType<typeof buildSimplifiedLayout> = { mode: "none" };
      expect(buildSimplifiedLayout(n, parent)).toEqual(__expectedResult);
    });

    it("Stretch without parent", () => {
      const n: Parameters<typeof buildSimplifiedLayout>[0] = nodeStretch as any;
      const parent: Parameters<typeof buildSimplifiedLayout>[1] = undefined;
      const __expectedResult: ReturnType<typeof buildSimplifiedLayout> = { mode: "none" };
      expect(buildSimplifiedLayout(n, parent)).toEqual(__expectedResult);
    });
  });
});

// 3TG (https://3tg.dev) created 10 tests in 2784 ms (278.400 ms per generated test) @ 2026-04-02T17:19:54.352Z
