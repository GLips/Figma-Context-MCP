import { describe, expect, it } from "vitest";
import { parsePaint, buildSimplifiedStrokes } from "~/transformers/style.js";
import type { Paint, Node as FigmaDocumentNode } from "@figma/rest-api-spec";

// Paint types outside the REST spec reach real files: Figma code-component
// CUSTOM paints (customEffectId + componentPropAssignments) were observed live
// on 2026-08-22. The spec's Paint union cannot express them, so the fixture
// casts through unknown exactly the way the API payload arrives at runtime.
const customPaint = {
  type: "CUSTOM",
  visible: true,
  blendMode: "NORMAL",
  customEffectId: "CodeComponentId:20e41e41-fixture",
  componentPropAssignments: [{ defId: "1:2", value: "fixture" }],
} as unknown as Paint;

const solidRed: Paint = {
  type: "SOLID",
  blendMode: "NORMAL",
  color: { r: 1, g: 0, b: 0, a: 1 },
};

describe("unknown paint types", () => {
  it("degrades to a marked passthrough instead of throwing", () => {
    const fill = parsePaint(customPaint);
    expect(fill).toEqual({ type: "CUSTOM", unknownPaint: true, raw: customPaint });
  });

  it("preserves the raw Figma fields for later consumers", () => {
    const fill = parsePaint(customPaint) as { raw: Record<string, unknown> };
    expect(fill.raw).toBe(customPaint);
    expect(fill.raw.customEffectId).toBe("CodeComponentId:20e41e41-fixture");
    expect(fill.raw.componentPropAssignments).toEqual([{ defId: "1:2", value: "fixture" }]);
  });

  it("leaves known paints untouched", () => {
    expect(parsePaint(solidRed)).toMatch(/^#ff0000$/i);
  });

  it("does not abort stroke parsing when one stroke paint is unknown", () => {
    const node = {
      id: "1:1",
      name: "mixed-strokes",
      type: "RECTANGLE",
      strokes: [solidRed, customPaint],
      strokeWeight: 2,
    } as unknown as FigmaDocumentNode;
    const strokes = buildSimplifiedStrokes(node);
    expect(strokes.colors).toHaveLength(2);
    // Reversed to CSS stacking order: the unknown top paint leads, marked.
    expect(strokes.colors[0]).toEqual({ type: "CUSTOM", unknownPaint: true, raw: customPaint });
    expect(strokes.colors[1]).toMatch(/^#ff0000$/i);
    expect(strokes.strokeWeight).toBe("2px");
  });
});
