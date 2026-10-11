import { expect, test } from "vitest";
import { simplify, project } from "../src/index.js";
import type { NodeSnapshot, SnapshotSolidPaint } from "../src/snapshot.js";

const brand = { id: "VariableID:1:1", name: "color/brand" };
const space = { id: "VariableID:2:1", name: "space/md" };
const box = { x: 0, y: 0, width: 100, height: 40 };

const solid = (r: number, extra: Partial<SnapshotSolidPaint> = {}): SnapshotSolidPaint => ({
  type: "SOLID",
  color: { r, g: 0, b: 0, a: 1 },
  ...extra,
});

async function wireNode(snapshot: NodeSnapshot) {
  return project(await simplify([snapshot])).nodes[0];
}

test("a paint style wins over the paint variables under it; bound solids never fold", async () => {
  const styled = await wireNode({
    id: "1",
    name: "Styled",
    type: "RECTANGLE",
    fills: [solid(1, { colorVariable: brand })],
    styles: { fill: { id: "S:fill", name: "Brand" } },
  });
  expect(styled.fill).toEqual({ style: { id: "S:fill", name: "Brand" } });

  // Two literal solids would composite to one color; a bound layer keeps the stack apart.
  const stacked = await wireNode({
    id: "2",
    name: "Stacked",
    type: "RECTANGLE",
    fills: [solid(0), solid(1, { colorVariable: { id: brand.id }, opacity: 0.5 })],
  });
  expect(stacked.fill).toEqual([
    { type: "SOLID", color: { variable: { id: brand.id } }, opacity: 0.5 },
    "#000000",
  ]);
});

test("four-part words collapse to one reference only when every part shares it", async () => {
  const node = await wireNode({
    id: "1",
    name: "Row",
    type: "FRAME",
    absoluteBoundingBox: box,
    clipsContent: false,
    layoutMode: "HORIZONTAL",
    paddingTop: 8,
    paddingRight: 8,
    paddingBottom: 8,
    paddingLeft: 8,
    itemSpacing: 0,
    cornerRadius: 4,
    boundVariables: {
      paddingTop: space,
      paddingRight: space,
      paddingBottom: space,
      paddingLeft: { id: "VariableID:3:1" },
      itemSpacing: space,
      topLeftRadius: space,
      topRightRadius: space,
      bottomRightRadius: space,
      bottomLeftRadius: space,
    },
  });
  const ref = { variable: space };
  expect(node.layout).toMatchObject({
    padding: { top: ref, right: ref, bottom: ref, left: { variable: { id: "VariableID:3:1" } } },
    // A bound gap is emitted even where a literal 0 would be omitted.
    gap: ref,
  });
  expect(node.borderRadius).toEqual(ref);
});

test("a text style keeps only the words it can't cover; runs differ from the base by binding", async () => {
  const size = { id: "VariableID:4:1", name: "type/size/lg" };
  const text = (styles?: NodeSnapshot["styles"]): NodeSnapshot => ({
    id: "t",
    name: "Title",
    type: "TEXT",
    styles,
    text: {
      characters: "Hello world",
      style: {
        fontFamily: "Inter",
        fontSize: 16,
        textAlignHorizontal: "CENTER",
        boundVariables: { fontSize: { id: "VariableID:4:0" } },
      },
      lines: [
        [
          { text: "Hello ", delta: {} },
          { text: "world", delta: { fontSize: 20, boundVariables: { fontSize: size } } },
        ],
      ],
      lineTypes: ["NONE"],
      lineIndentations: [0],
    },
  });

  const styled = await wireNode(text({ text: { id: "S:text", name: "Heading" } }));
  expect(styled.textStyle).toEqual({
    style: { id: "S:text", name: "Heading" },
    textAlign: "center",
  });

  const bound = await wireNode(text());
  expect(bound.textStyle).toMatchObject({ fontSize: { variable: { id: "VariableID:4:0" } } });
  expect(bound.text).toEqual(["Hello ", ["world", { fontSize: { variable: size } }]]);
});

test("a root's bound fixed axis reads as its variable, not as the contextual word", async () => {
  const root = await wireNode({
    id: "1",
    name: "Card",
    type: "FRAME",
    absoluteBoundingBox: box,
    layoutMode: "VERTICAL",
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
    boundVariables: { width: space },
  });
  expect(root.width).toEqual({ variable: space });
  expect(root.height).toBe("contextual");
});
