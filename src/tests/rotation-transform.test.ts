import { describe, test, expect } from "vitest";
import { buildSimplifiedLayout } from "~/transformers/layout.js";
import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";

// Values from a real production design (a marketing collage of tilted book
// covers), cross-checked against Figma plugin-API measurements of the same
// nodes. A 100x148.75 rectangle rotated -18.3° (Figma sign, CCW-positive)
// whose relativeTransform translation is (111.43, 40).
const CSS_PHI = (18.3 * Math.PI) / 180; // CSS clockwise angle for Figma -18.3
const COS = Math.cos(CSS_PHI);
const SIN = Math.sin(CSS_PHI);

function makeParent(overrides: Record<string, unknown> = {}) {
  return {
    id: "1:1",
    type: "FRAME",
    clipsContent: false,
    children: [],
    absoluteBoundingBox: { x: 100, y: 200, width: 1440, height: 750 },
    relativeTransform: [
      [1, 0, 100],
      [0, 1, 200],
    ],
    size: { x: 1440, y: 750 },
    ...overrides,
  } as unknown as FigmaDocumentNode;
}

function makeRotatedChild(overrides: Record<string, unknown> = {}) {
  return {
    id: "1:2",
    type: "RECTANGLE",
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
    relativeTransform: [
      [COS, -SIN, 111.43],
      [SIN, COS, 40],
    ],
    size: { x: 100, y: 148.75 },
    absoluteBoundingBox: {
      x: 100 + 111.43 - 148.75 * SIN,
      y: 200 + 40,
      width: 100 * COS + 148.75 * SIN,
      height: 100 * SIN + 148.75 * COS,
    },
    ...overrides,
  } as unknown as FigmaDocumentNode;
}

describe("rotated-node transforms (geometry=paths)", () => {
  test("rotated child emits rotation, true size, and pre-rotation top-left", () => {
    const layout = buildSimplifiedLayout(makeRotatedChild(), makeParent());
    expect(layout.rotation).toBeCloseTo(-18.3, 1);
    expect(layout.dimensions?.width).toBeCloseTo(100, 1);
    expect(layout.dimensions?.height).toBeCloseTo(148.75, 1);
    expect(layout.locationRelativeToParent?.x).toBeCloseTo(111.43, 1);
    expect(layout.locationRelativeToParent?.y).toBeCloseTo(40, 1);
  });

  test("unrotated child under an unrotated parent is unchanged (no rotation field, AABB location)", () => {
    const child = {
      id: "1:3",
      type: "RECTANGLE",
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
      relativeTransform: [
        [1, 0, 1270.99],
        [0, 1, 313],
      ],
      size: { x: 100, y: 150 },
      absoluteBoundingBox: { x: 100 + 1270.99, y: 200 + 313, width: 100, height: 150 },
    } as unknown as FigmaDocumentNode;
    const layout = buildSimplifiedLayout(child, makeParent());
    expect(layout.rotation).toBeUndefined();
    expect(layout.locationRelativeToParent?.x).toBeCloseTo(1270.99, 1);
    expect(layout.locationRelativeToParent?.y).toBeCloseTo(313, 1);
  });

  test("unrotated child of a ROTATED group still takes the transform path so nesting composes", () => {
    const rotatedGroup = makeParent({
      type: "GROUP",
      relativeTransform: [
        [COS, -SIN, 500],
        [SIN, COS, 300],
      ],
    });
    const child = {
      id: "1:4",
      type: "RECTANGLE",
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
      relativeTransform: [
        [1, 0, 30],
        [0, 1, 10],
      ],
      size: { x: 64, y: 64 },
      absoluteBoundingBox: { x: 0, y: 0, width: 90, height: 90 },
    } as unknown as FigmaDocumentNode;
    const layout = buildSimplifiedLayout(child, rotatedGroup);
    // Local rotation ~0 → no rotation field, but location/size must come from
    // the transform (the AABB delta would be in a different, mixed frame).
    expect(layout.rotation).toBeUndefined();
    expect(layout.dimensions?.width).toBeCloseTo(64, 1);
    expect(layout.locationRelativeToParent?.x).toBeCloseTo(30, 1);
    expect(layout.locationRelativeToParent?.y).toBeCloseTo(10, 1);
  });

  test("vector-class node with ink bounds away from its layout box emits parent-relative renderBounds", () => {
    const textPath = {
      id: "1:5",
      type: "TEXT_PATH",
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
      relativeTransform: [
        [1, 0, -149],
        [0, 1, 44],
      ],
      size: { x: 1481, y: 933 },
      absoluteBoundingBox: { x: 100 - 149, y: 200 + 44, width: 1481, height: 933 },
      absoluteRenderBounds: { x: 100, y: 200 + 300, width: 1380, height: 576 },
    } as unknown as FigmaDocumentNode;
    const layout = buildSimplifiedLayout(textPath, makeParent());
    expect(layout.renderBounds).toEqual({ x: 0, y: 300, width: 1380, height: 576 });
  });

  test("renderBounds is not emitted when ink matches the layout box", () => {
    const vector = {
      id: "1:6",
      type: "VECTOR",
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
      absoluteBoundingBox: { x: 150, y: 250, width: 40, height: 40 },
      absoluteRenderBounds: { x: 150.2, y: 250.2, width: 39.8, height: 39.8 },
    } as unknown as FigmaDocumentNode;
    const layout = buildSimplifiedLayout(vector, makeParent());
    expect(layout.renderBounds).toBeUndefined();
  });
});
