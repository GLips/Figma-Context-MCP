import { describe, expect, it } from "vitest";
import { walkNodes } from "~/core/simplify.js";
import { simplifyRestResponse } from "~/adapters/rest/rest.js";
import { restNodeToSnapshot } from "~/adapters/rest/node-to-snapshot.js";
import { createRefStyleTable } from "~/core/style-table.js";
import type { TraversalOptions } from "~/core/types.js";
import type { GetFileResponse, Style } from "@figma/rest-api-spec";
import type { Node as FigmaNode } from "@figma/rest-api-spec";

// Minimal Figma node factory — only the fields the walker actually reads.
// The Figma types are deeply discriminated unions; we cast through unknown
// because tests only need the subset of fields the walker touches.
function makeNode(overrides: Record<string, unknown>): FigmaNode {
  return { visible: true, ...overrides } as unknown as FigmaNode;
}

// Decode raw fixtures through the REST adapter exactly as production does, so the
// walker receives snapshots with decoded fills/effects and recursed children.
// (The adapter is the only place raw REST paint shapes are unpacked.)
async function walk(
  nodes: FigmaNode[],
  options?: TraversalOptions,
  extraStyles?: Record<string, Style>,
) {
  const sink = createRefStyleTable();
  const extracted = await walkNodes(
    nodes.map((node) => restNodeToSnapshot(node, extraStyles)),
    sink,
    options,
  );
  return { nodes: extracted, styles: sink.styles };
}

// A small but representative node tree:
//   Page
//   ├── Frame "Header" (visible)
//   │   ├── Text "Title"
//   │   └── Rectangle "Bg" (invisible)
//   ├── Frame "Body"
//   │   └── Frame "Card"
//   │       └── Text "Label"
//   └── Vector "Icon" (becomes IMAGE-SVG)
const fixtureNodes: FigmaNode[] = [
  makeNode({
    id: "1:1",
    name: "Header",
    type: "FRAME",
    children: [
      makeNode({ id: "1:2", name: "Title", type: "TEXT", characters: "Hello" }),
      makeNode({ id: "1:3", name: "Bg", type: "RECTANGLE", visible: false }),
    ],
  }),
  makeNode({
    id: "2:1",
    name: "Body",
    type: "FRAME",
    children: [
      makeNode({
        id: "2:2",
        name: "Card",
        type: "FRAME",
        children: [makeNode({ id: "2:3", name: "Label", type: "TEXT", characters: "World" })],
      }),
    ],
  }),
  makeNode({ id: "3:1", name: "Icon", type: "VECTOR" }),
];

describe("walkNodes", () => {
  it("produces correct node structure from a nested tree", async () => {
    const { nodes } = await walk(fixtureNodes);

    // Top-level: Header, Body, Icon (3 nodes — Bg is invisible, filtered out)
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.name)).toEqual(["Header", "Body", "Icon"]);

    // Header has 1 child (Title only — Bg is invisible)
    const header = nodes[0];
    expect(header.children).toHaveLength(1);
    expect(header.children![0].name).toBe("Title");
    expect(header.children![0].text).toBe("Hello");

    // Body > Card > Label
    const body = nodes[1];
    expect(body.children).toHaveLength(1);
    expect(body.children![0].name).toBe("Card");
    expect(body.children![0].children).toHaveLength(1);
    expect(body.children![0].children![0].name).toBe("Label");
    expect(body.children![0].children![0].text).toBe("World");

    // Vector becomes IMAGE-SVG
    const icon = nodes[2];
    expect(icon.type).toBe("IMAGE-SVG");
    expect(icon.children).toBeUndefined();
  });

  it("respects maxDepth option", async () => {
    const { nodes } = await walk(fixtureNodes, { maxDepth: 1 });

    // At depth 0 we get top-level nodes, depth 1 gets their direct children, no deeper
    const header = nodes.find((n) => n.name === "Header")!;
    expect(header.children).toHaveLength(1);
    expect(header.children![0].name).toBe("Title");

    // Body's child "Card" is at depth 1 — it should exist but have no children
    const body = nodes.find((n) => n.name === "Body")!;
    expect(body.children).toHaveLength(1);
    expect(body.children![0].name).toBe("Card");
    expect(body.children![0].children).toBeUndefined();
  });

  it("accumulates global style variables across nodes", async () => {
    const styledNode = makeNode({
      id: "4:1",
      name: "Styled",
      type: "FRAME",
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }],
    });

    const { styles } = await walk([styledNode]);

    // The fill should be extracted into a global variable
    expect(Object.keys(styles).length).toBeGreaterThan(0);
  });

  it("deduplicates identical styles across nodes into a single global variable", async () => {
    const sharedFill = [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }];

    const nodeA = makeNode({ id: "5:1", name: "A", type: "FRAME", fills: sharedFill });
    const nodeB = makeNode({ id: "5:2", name: "B", type: "FRAME", fills: sharedFill });

    const { nodes, styles } = await walk([nodeA, nodeB]);

    // Both nodes should reference the same fill variable
    expect(nodes[0].fills).toBeDefined();
    expect(nodes[0].fills).toBe(nodes[1].fills);

    // Only one fill entry should exist in the styles table
    const fillEntries = Object.entries(styles).filter(([key]) => key.startsWith("fill"));
    expect(fillEntries).toHaveLength(1);
  });

  it("deduplicates identical colors used as both fill and stroke", async () => {
    const sharedColor = [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }];

    // Stroke node first — if strokes used a different prefix, the var would
    // be named stroke_* and the fill would reuse it under the wrong prefix.
    const strokeNode = makeNode({
      id: "8:1",
      name: "A",
      type: "FRAME",
      strokes: sharedColor,
      strokeWeight: 1,
    });
    const fillNode = makeNode({ id: "8:2", name: "B", type: "FRAME", fills: sharedColor });

    const { nodes, styles } = await walk([strokeNode, fillNode]);

    expect(nodes[0].strokes).toBeDefined();
    expect(nodes[1].fills).toBeDefined();
    expect(nodes[0].strokes).toBe(nodes[1].fills);

    // The shared var should use the fill prefix since stroke colors are
    // structurally identical to fill colors in Figma (both are FILL-type styles).
    const colorEntries = Object.entries(styles).filter(
      ([, value]) => JSON.stringify(value) === JSON.stringify(["#FF0000"]),
    );
    expect(colorEntries).toHaveLength(1);
    expect(colorEntries[0][0]).toMatch(/^fill_/);
  });

  it("preserves non-default stroke alignment on the simplified node", async () => {
    const node = makeNode({
      id: "9:1",
      name: "Card",
      type: "FRAME",
      strokes: [{ type: "SOLID", color: { r: 0.89, g: 0.9, b: 0.9, a: 1 }, visible: true }],
      strokeWeight: 2,
      strokeAlign: "OUTSIDE",
    });

    const { nodes } = await walk([node]);

    expect(nodes[0].strokeAlign).toBe("outside");
    expect(nodes[0].strokeWidth).toBe("2px");
  });

  it("omits INSIDE stroke alignment, the CSS-border default consumers assume", async () => {
    const node = makeNode({
      id: "9:2",
      name: "Card",
      type: "FRAME",
      strokes: [{ type: "SOLID", color: { r: 0.89, g: 0.9, b: 0.9, a: 1 }, visible: true }],
      strokeWeight: 2,
      strokeAlign: "INSIDE",
    });

    const { nodes } = await walk([node]);

    expect(nodes[0].strokeAlign).toBeUndefined();
    expect(nodes[0].strokeWidth).toBe("2px");
  });

  it("disambiguates named styles when style names collide", async () => {
    const nodeA = makeNode({
      id: "7:1",
      name: "Text A",
      type: "TEXT",
      characters: "Hello",
      style: { fontFamily: "Inter", fontWeight: 400, fontSize: 12 },
      styles: { text: "13:77" },
    });

    const nodeB = makeNode({
      id: "7:2",
      name: "Text B",
      type: "TEXT",
      characters: "World",
      style: { fontFamily: "Inter", fontWeight: 600, fontSize: 14 },
      styles: { text: "161:300" },
    });

    const extraStyles: Record<string, Style> = {
      "13:77": { name: "Heading / Large" } as Style,
      "161:300": { name: "Heading / Large" } as Style,
    };

    const { nodes, styles: resultVars } = await walk([nodeA, nodeB], {}, extraStyles);

    expect(nodes[0].textStyle).toBe("Heading / Large");
    expect(nodes[1].textStyle).toBe("Heading / Large (161:300)");

    const styleKeys = Object.keys(resultVars).filter((key) => key.startsWith("Heading / Large"));
    expect(styleKeys).toHaveLength(2);
  });
});

describe("fill flattening", () => {
  // Resolve a node's registered fills var back to its concrete value.
  type Extracted = Awaited<ReturnType<typeof walk>>;
  function fillsValue(nodes: Extracted["nodes"], styles: Extracted["styles"]) {
    return styles[nodes[0].fills as string];
  }

  // Figma orders the fills array bottom-first, so index 0 is the backdrop and
  // the last entry is the topmost layer.
  it("composites an all-solid stack into a single resolved color", async () => {
    const node = makeNode({
      id: "f:1",
      name: "Swatch",
      type: "FRAME",
      fills: [
        { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, visible: true }, // white backdrop
        { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.2, visible: true }, // black @ 20%
      ],
    });

    const { nodes, styles } = await walk([node]);

    expect(fillsValue(nodes, styles)).toEqual(["#CCCCCC"]);
  });

  it("culls layers fully occluded by an opaque paint above them", async () => {
    const node = makeNode({
      id: "f:2",
      name: "Swatch",
      type: "FRAME",
      fills: [
        { type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 }, visible: true }, // blue backdrop
        { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }, // opaque red on top
      ],
    });

    const { nodes, styles } = await walk([node]);

    // Only the opaque top color survives; the blue beneath contributes nothing.
    expect(fillsValue(nodes, styles)).toEqual(["#FF0000"]);
  });

  it("folds both color.a and paint.opacity into the effective alpha", async () => {
    const node = makeNode({
      id: "f:6",
      name: "Swatch",
      type: "FRAME",
      fills: [
        { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, visible: true }, // white backdrop
        // black at color.a 0.5 × opacity 0.5 = 0.25 effective → 0.75 of white shows through
        { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 0.5 }, opacity: 0.5, visible: true },
      ],
    });

    const { nodes, styles } = await walk([node]);

    expect(fillsValue(nodes, styles)).toEqual(["#BFBFBF"]);
  });

  it("culls everything below a fully-opaque mid-stack paint, compositing only what's above", async () => {
    const node = makeNode({
      id: "f:7",
      name: "Swatch",
      type: "FRAME",
      fills: [
        { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }, // red (culled)
        { type: "SOLID", color: { r: 0, g: 1, b: 0, a: 1 }, visible: true }, // opaque green
        { type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 0.5, visible: true }, // blue @ 50% on top
      ],
    });

    const { nodes, styles } = await walk([node]);

    // Red contributes nothing (opaque green above it); blue@50% blends over green → teal.
    expect(fillsValue(nodes, styles)).toEqual(["#008080"]);
  });

  it("treats PASS_THROUGH blend as flattenable", async () => {
    const node = makeNode({
      id: "f:8",
      name: "Swatch",
      type: "FRAME",
      fills: [
        {
          type: "SOLID",
          color: { r: 1, g: 1, b: 1, a: 1 },
          blendMode: "PASS_THROUGH",
          visible: true,
        },
        {
          type: "SOLID",
          color: { r: 0, g: 0, b: 0, a: 1 },
          opacity: 0.2,
          blendMode: "PASS_THROUGH",
          visible: true,
        },
      ],
    });

    const { nodes, styles } = await walk([node]);

    expect(fillsValue(nodes, styles)).toEqual(["#CCCCCC"]);
  });

  it("emits rgba() when the composited stack is still translucent", async () => {
    const node = makeNode({
      id: "f:3",
      name: "Swatch",
      type: "FRAME",
      fills: [
        { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 0.5 }, visible: true },
        { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 0.5 }, visible: true },
      ],
    });

    const { nodes, styles } = await walk([node]);

    expect(fillsValue(nodes, styles)).toEqual(["rgba(85, 85, 85, 0.75)"]);
  });

  it("leaves a stack untouched when it contains a gradient", async () => {
    const node = makeNode({
      id: "f:4",
      name: "Swatch",
      type: "FRAME",
      fills: [
        {
          type: "GRADIENT_LINEAR",
          visible: true,
          gradientHandlePositions: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
        { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.2, visible: true },
      ],
    });

    const { nodes, styles } = await walk([node]);

    // Both layers survive, reversed into CSS top-first order: solid first, gradient last.
    const value = fillsValue(nodes, styles) as unknown[];
    expect(value).toHaveLength(2);
    expect(value[0]).toBe("rgba(0, 0, 0, 0.2)");
    expect((value[1] as { type: string }).type).toBe("GRADIENT_LINEAR");
  });

  it("leaves a stack untouched when any solid uses a non-normal blend mode", async () => {
    const node = makeNode({
      id: "f:5",
      name: "Swatch",
      type: "FRAME",
      fills: [
        { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, visible: true },
        {
          type: "SOLID",
          color: { r: 0, g: 0, b: 0, a: 0.2 },
          blendMode: "MULTIPLY",
          visible: true,
        },
      ],
    });

    const { nodes, styles } = await walk([node]);

    expect(fillsValue(nodes, styles)).toHaveLength(2);
  });
});

describe("SVG container collapse", () => {
  it("collapses BOOLEAN_OPERATION nodes to IMAGE-SVG", async () => {
    const booleanOpNode = makeNode({
      id: "5:1",
      name: "Combined Shape",
      type: "BOOLEAN_OPERATION",
      booleanOperation: "UNION",
      children: [
        makeNode({ id: "5:2", name: "Circle", type: "ELLIPSE" }),
        makeNode({ id: "5:3", name: "Square", type: "RECTANGLE" }),
      ],
    });

    const { nodes } = await walk([booleanOpNode]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("IMAGE-SVG");
    expect(nodes[0].children).toBeUndefined();
  });

  it("collapses a frame containing a BOOLEAN_OPERATION to IMAGE-SVG", async () => {
    const frameWithBoolOp = makeNode({
      id: "6:1",
      name: "Icon Frame",
      type: "FRAME",
      children: [
        makeNode({
          id: "6:2",
          name: "Union",
          type: "BOOLEAN_OPERATION",
          booleanOperation: "UNION",
          children: [
            makeNode({ id: "6:3", name: "A", type: "RECTANGLE" }),
            makeNode({ id: "6:4", name: "B", type: "ELLIPSE" }),
          ],
        }),
      ],
    });

    const { nodes } = await walk([frameWithBoolOp]);

    // The BOOLEAN_OPERATION collapses to IMAGE-SVG first (bottom-up),
    // then the FRAME sees all children are SVG-eligible and collapses too.
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("IMAGE-SVG");
    expect(nodes[0].children).toBeUndefined();
  });

  // Auto-layout signals authored structure — the spacing between children is
  // intentional, so we should preserve the container even when its children
  // are all SVG-eligible (e.g., bar charts, button rows, layout test frames).
  it("does not collapse an auto-layout frame whose children are all SVG-eligible", async () => {
    const autoLayoutRow = makeNode({
      id: "7:1",
      name: "Bar Chart",
      type: "FRAME",
      clipsContent: false,
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      children: [
        makeNode({ id: "7:2", name: "Bar 1", type: "RECTANGLE" }),
        makeNode({ id: "7:3", name: "Bar 2", type: "RECTANGLE" }),
        makeNode({ id: "7:4", name: "Bar 3", type: "RECTANGLE" }),
      ],
    });

    const { nodes } = await walk([autoLayoutRow]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("FRAME");
    expect(nodes[0].children).toHaveLength(3);
  });

  // Escape hatch for decorative patterns: enough leaf primitives that the
  // payload cost outweighs the structural value (e.g., dotted backgrounds
  // built from grids of ellipses).
  it("collapses an auto-layout frame with many SVG-eligible children", async () => {
    const dotRow = makeNode({
      id: "8:1",
      name: "Dot Row",
      type: "FRAME",
      clipsContent: false,
      layoutMode: "HORIZONTAL",
      itemSpacing: 4,
      children: Array.from({ length: 20 }, (_, i) =>
        makeNode({ id: `8:${i + 2}`, name: `Dot ${i}`, type: "ELLIPSE" }),
      ),
    });

    const { nodes } = await walk([dotRow]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("IMAGE-SVG");
    expect(nodes[0].children).toBeUndefined();
  });

  // Non-auto-layout container with shape children is the original target case:
  // hand-drawn icons made of vector primitives. Must keep collapsing.
  it("still collapses a non-auto-layout frame whose children are all SVG-eligible", async () => {
    const iconFrame = makeNode({
      id: "9:1",
      name: "Icon",
      type: "FRAME",
      clipsContent: false,
      children: [
        makeNode({ id: "9:2", name: "Circle", type: "ELLIPSE" }),
        makeNode({ id: "9:3", name: "Rect", type: "RECTANGLE" }),
      ],
    });

    const { nodes } = await walk([iconFrame]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("IMAGE-SVG");
    expect(nodes[0].children).toBeUndefined();
  });
});

describe("component property support", () => {
  it("rescues hidden nodes with componentPropertyReferences.visible inside components", async () => {
    const componentNode = makeNode({
      id: "10:1",
      name: "Card",
      type: "COMPONENT",
      children: [
        makeNode({ id: "10:2", name: "Title", type: "TEXT", characters: "Card Title" }),
        makeNode({
          id: "10:3",
          name: "Badge",
          type: "FRAME",
          visible: false,
          componentPropertyReferences: { visible: "Show Badge#341:0" },
          children: [makeNode({ id: "10:4", name: "Badge Text", type: "TEXT", characters: "NEW" })],
        }),
      ],
    });

    const { nodes } = await walk([componentNode]);

    const card = nodes[0];
    expect(card.children).toHaveLength(2);

    const badge = card.children!.find((c) => c.name === "Badge")!;
    expect(badge).toBeDefined();
    expect(badge.componentPropertyReferences).toEqual({ visible: "Show Badge" });
  });

  it("strips hidden nodes normally inside instances", async () => {
    const instanceNode = makeNode({
      id: "11:1",
      name: "Card Instance",
      type: "INSTANCE",
      componentId: "10:1",
      componentProperties: {
        "Show Badge": { type: "BOOLEAN", value: false },
      },
      children: [
        makeNode({ id: "11:2", name: "Title", type: "TEXT", characters: "My Card" }),
        makeNode({ id: "11:3", name: "Badge", type: "FRAME", visible: false }),
      ],
    });

    const { nodes } = await walk([instanceNode]);

    const instance = nodes[0];
    expect(instance.children).toHaveLength(1);
    expect(instance.children![0].name).toBe("Title");
  });

  it("emits every property definition type on the defining node", async () => {
    const componentNode = makeNode({
      id: "12:1",
      name: "Product Card",
      type: "COMPONENT",
      componentPropertyDefinitions: {
        "On Sale#341:0": { type: "BOOLEAN", defaultValue: true },
        "Title#341:1": { type: "TEXT", defaultValue: "Product Name" },
        "Icon#341:2": { type: "INSTANCE_SWAP", defaultValue: "999:1" },
        // A SLOT default is a { guid } object on the wire — kept as a type, default dropped.
        "Content#341:3": { type: "SLOT", defaultValue: { guid: { sessionID: -1, localID: -1 } } },
      },
      children: [makeNode({ id: "12:2", name: "Title", type: "TEXT", characters: "Product Name" })],
    });

    const { nodes } = await walk([componentNode]);

    expect(nodes[0].propertyDefinitions).toEqual({
      "On Sale": { type: "boolean", defaultValue: true },
      Title: { type: "text", defaultValue: "Product Name" },
      Icon: { type: "instance_swap", defaultValue: "999:1" },
      Content: { type: "slot" },
    });
  });

  it("emits a set's variant axes with their options, and none on the variant children", async () => {
    const setNode = makeNode({
      id: "16:1",
      name: "Button",
      type: "COMPONENT_SET",
      componentPropertyDefinitions: {
        Variant: {
          type: "VARIANT",
          defaultValue: "Secondary",
          variantOptions: ["Secondary", "Primary"],
        },
      },
      children: [
        makeNode({ id: "16:2", name: "Variant=Secondary", type: "COMPONENT" }),
        makeNode({ id: "16:3", name: "Variant=Primary", type: "COMPONENT" }),
      ],
    });

    const { nodes } = await walk([setNode]);

    expect(nodes[0].propertyDefinitions).toEqual({
      Variant: {
        type: "variant",
        defaultValue: "Secondary",
        variantOptions: ["Secondary", "Primary"],
      },
    });
    expect(nodes[0].children![0].propertyDefinitions).toBeUndefined();
  });

  it("renames mainComponent and slotContentId references onto the fields they drive", async () => {
    const componentNode = makeNode({
      id: "17:1",
      name: "Card",
      type: "COMPONENT",
      children: [
        makeNode({
          id: "17:2",
          name: "Icon",
          type: "INSTANCE",
          componentId: "999:1",
          componentPropertyReferences: { mainComponent: "Icon#341:2" },
        }),
        makeNode({
          id: "17:3",
          name: "Content",
          type: "SLOT",
          componentPropertyReferences: { slotContentId: "Content#341:3" },
        }),
      ],
    });

    const { nodes } = await walk([componentNode]);

    const [icon, slot] = nodes[0].children!;
    expect(icon.componentPropertyReferences).toEqual({ componentId: "Icon" });
    expect(slot.type).toBe("SLOT");
    expect(slot.componentPropertyReferences).toEqual({ slot: "Content" });
  });

  it("marks each overridden sublayer with the output fields the designer changed", async () => {
    const instanceNode = makeNode({
      id: "18:1",
      name: "Card Instance",
      type: "INSTANCE",
      componentId: "17:1",
      overrides: [
        { id: "18:1", overriddenFields: ["width", "height"] },
        // REST spells a text edit as four tables; they fold to one output field.
        {
          id: "I18:1;17:5",
          overriddenFields: [
            "characters",
            "characterStyleOverrides",
            "styleOverrideTable",
            "fills",
          ],
        },
        // A wire field with no output field (bound variables) contributes nothing.
        { id: "I18:1;17:6", overriddenFields: ["boundVariables"] },
      ],
      children: [
        makeNode({ id: "I18:1;17:5", name: "Label", type: "TEXT", characters: "Hi" }),
        makeNode({ id: "I18:1;17:6", name: "Bg", type: "RECTANGLE" }),
      ],
    });

    const { nodes } = await walk([instanceNode]);

    expect(nodes[0].overrides).toEqual(["width", "height"]);
    expect(nodes[0].children![0].overrides).toEqual(["text", "fills"]);
    expect(nodes[0].children![1].overrides).toBeUndefined();
  });

  it("carries a nested instance's override whichever instance level reports it", async () => {
    const outer = makeNode({
      id: "19:1",
      name: "Card",
      type: "INSTANCE",
      componentId: "17:1",
      // The outer level reports the nested icon's sizing change and a fill on one of
      // the icon's own sublayers; the nested level reports only its opacity.
      overrides: [
        { id: "I19:1;16:2", overriddenFields: ["layoutSizingHorizontal"] },
        { id: "I19:1;16:2;16:3", overriddenFields: ["fills"] },
      ],
      children: [
        makeNode({
          id: "I19:1;16:2",
          name: "Icon",
          type: "INSTANCE",
          componentId: "16:1",
          overrides: [{ id: "I19:1;16:2", overriddenFields: ["opacity"] }],
          // TEXT, not a vector: an all-vector INSTANCE collapses to an SVG image.
          children: [
            makeNode({ id: "I19:1;16:2;16:3", name: "Glyph", type: "TEXT", characters: "★" }),
          ],
        }),
      ],
    });

    const { nodes } = await walk([outer]);

    const icon = nodes[0].children![0];
    expect(icon.overrides).toEqual(["width", "opacity"]);
    expect(icon.children![0].overrides).toEqual(["fills"]);
  });

  it("annotates componentPropertyReferences with characters→text rename", async () => {
    const componentNode = makeNode({
      id: "13:1",
      name: "Button",
      type: "COMPONENT",
      children: [
        makeNode({
          id: "13:2",
          name: "Label",
          type: "TEXT",
          characters: "Click me",
          componentPropertyReferences: { characters: "Button Label#100:0" },
        }),
      ],
    });

    const { nodes } = await walk([componentNode]);

    const label = nodes[0].children![0];
    expect(label.componentPropertyReferences).toEqual({ text: "Button Label" });
  });

  it("flattens instance componentProperties, keeping swaps and dropping variant + slot values", async () => {
    const instanceNode = makeNode({
      id: "14:1",
      name: "Card Instance",
      type: "INSTANCE",
      componentId: "10:1",
      componentProperties: {
        "On Sale": { type: "BOOLEAN", value: true },
        Title: { type: "TEXT", value: "My Product" },
        "Icon#341:2": { type: "INSTANCE_SWAP", value: "999:2" },
        // The variant is one join away (componentId → table name), so it isn't repeated here.
        Size: { type: "VARIANT", value: "Large" },
        // A SLOT value is a { guid } naming the slot node already in the subtree.
        "Content#341:3": { type: "SLOT", value: { guid: { sessionID: 14, localID: 9 } } },
      },
      children: [makeNode({ id: "14:2", name: "Content", type: "FRAME" })],
    });

    const { nodes } = await walk([instanceNode]);

    expect(nodes[0].componentProperties).toEqual({
      "On Sale": true,
      Title: "My Product",
      Icon: "999:2",
    });
  });

  it("strips hidden children inside nested instances within components", async () => {
    const componentNode = makeNode({
      id: "15:1",
      name: "Wrapper",
      type: "COMPONENT",
      children: [
        makeNode({
          id: "15:2",
          name: "Nested Instance",
          type: "INSTANCE",
          componentId: "99:1",
          children: [
            makeNode({ id: "15:3", name: "Visible Child", type: "FRAME" }),
            makeNode({ id: "15:4", name: "Hidden Child", type: "FRAME", visible: false }),
          ],
        }),
      ],
    });

    const { nodes } = await walk([componentNode]);

    const nestedInstance = nodes[0].children![0];
    expect(nestedInstance).toBeDefined();
    expect(nestedInstance.name).toBe("Nested Instance");
    expect(nestedInstance.children).toHaveLength(1);
    expect(nestedInstance.children![0].name).toBe("Visible Child");
  });
});

describe("simplifyRestResponse", () => {
  it("produces a complete SimplifiedDesign from a mock API response", async () => {
    const mockResponse = {
      name: "Test File",
      document: {
        id: "0:0",
        name: "Document",
        type: "DOCUMENT",
        children: fixtureNodes,
        visible: true,
      },
      components: {},
      componentSets: {},
      styles: {},
      schemaVersion: 0,
      version: "1",
      role: "owner",
      lastModified: "2024-01-01",
      thumbnailUrl: "",
      editorType: "figma",
    } as unknown as GetFileResponse;

    const result = await simplifyRestResponse(mockResponse);

    expect(result.name).toBe("Test File");
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.map((n) => n.name)).toEqual(["Header", "Body", "Icon"]);

    // Verify full depth traversal happened
    const label = result.nodes[1].children![0].children![0];
    expect(label.name).toBe("Label");
    expect(label.text).toBe("World");
  });

  it("keeps the components table to envelope provenance — definitions sit on the node", async () => {
    const componentNode = makeNode({
      id: "20:1",
      name: "Product Card",
      type: "COMPONENT",
      componentPropertyDefinitions: {
        "On Sale#341:0": { type: "BOOLEAN", defaultValue: true },
        "Title#341:1": { type: "TEXT", defaultValue: "Product Name" },
      },
      children: [makeNode({ id: "20:2", name: "Content", type: "FRAME" })],
    });

    const mockResponse = {
      name: "Test File",
      document: {
        id: "0:0",
        name: "Document",
        type: "DOCUMENT",
        children: [componentNode],
        visible: true,
      },
      components: {
        "20:1": { key: "abc123", name: "Product Card", componentSetId: undefined },
      },
      componentSets: {},
      styles: {},
      schemaVersion: 0,
      version: "1",
      role: "owner",
      lastModified: "2024-01-01",
      thumbnailUrl: "",
      editorType: "figma",
    } as unknown as GetFileResponse;

    const result = await simplifyRestResponse(mockResponse);

    expect(result.components["20:1"]).toEqual({
      id: "20:1",
      key: "abc123",
      name: "Product Card",
      componentSetId: undefined,
    });
    expect(result.nodes[0].propertyDefinitions).toEqual({
      "On Sale": { type: "boolean", defaultValue: true },
      Title: { type: "text", defaultValue: "Product Name" },
    });
  });
});
