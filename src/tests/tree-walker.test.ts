import { describe, expect, it } from "vitest";
import { extractFromDesign } from "~/extractors/node-walker.js";
import { allExtractors, collapseSvgContainers } from "~/extractors/built-in.js";
import { simplifyRawFigmaObject } from "~/extractors/design-extractor.js";
import type { GlobalVars } from "~/extractors/types.js";
import type { GetFileResponse } from "@figma/rest-api-spec";
import type { Node as FigmaNode } from "@figma/rest-api-spec";

// Minimal Figma node factory — only the fields the walker actually reads.
// The Figma types are deeply discriminated unions; we cast through unknown
// because tests only need the subset of fields the walker touches.
function makeNode(overrides: Record<string, unknown>): FigmaNode {
  return { visible: true, ...overrides } as unknown as FigmaNode;
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

describe("extractFromDesign", () => {
  it("produces correct node structure from a nested tree", async () => {
    const { nodes } = await extractFromDesign(fixtureNodes, allExtractors);

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
    const { nodes } = await extractFromDesign(fixtureNodes, allExtractors, { maxDepth: 1 });

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

    const { globalVars } = await extractFromDesign([styledNode], allExtractors);

    // The fill should be extracted into a global variable
    expect(Object.keys(globalVars.styles).length).toBeGreaterThan(0);
  });

  it("deduplicates identical styles across nodes into a single global variable", async () => {
    const sharedFill = [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }];

    const nodeA = makeNode({ id: "5:1", name: "A", type: "FRAME", fills: sharedFill });
    const nodeB = makeNode({ id: "5:2", name: "B", type: "FRAME", fills: sharedFill });

    const { nodes, globalVars } = await extractFromDesign([nodeA, nodeB], allExtractors);

    // Both nodes should reference the same fill variable
    expect(nodes[0].fills).toBeDefined();
    expect(nodes[0].fills).toBe(nodes[1].fills);

    // Only one fill entry should exist in globalVars
    const fillEntries = Object.entries(globalVars.styles).filter(([key]) => key.startsWith("fill"));
    expect(fillEntries).toHaveLength(1);
  });

  it("disambiguates named styles that share the same name", async () => {
    const styleName = "Heading / Large";
    const styleIdA = "S:1234567890";
    const styleIdB = "S:abcdef1234";

    const extraStyles = {
      [styleIdA]: { name: styleName },
      [styleIdB]: { name: styleName },
    };

    const baseStyle = {
      fontFamily: "Inter",
      fontWeight: 400,
      fontSize: 14,
      lineHeightPx: 20,
      textAlignHorizontal: "LEFT",
      textAlignVertical: "TOP",
    };

    const nodeA = makeNode({
      id: "6:1",
      name: "Title A",
      type: "TEXT",
      characters: "Hello",
      style: baseStyle,
      styles: { text: styleIdA },
    });

    const nodeB = makeNode({
      id: "6:2",
      name: "Title B",
      type: "TEXT",
      characters: "World",
      style: baseStyle,
      styles: { text: styleIdB },
    });

    const { nodes, globalVars } = await extractFromDesign([nodeA, nodeB], allExtractors, {}, {
      styles: {},
      extraStyles,
    } as GlobalVars & { extraStyles: typeof extraStyles });

    const styleKeys = Object.keys(globalVars.styles).filter((key) => key.startsWith(styleName));
    expect(styleKeys).toHaveLength(2);
    expect(nodes[0].textStyle).not.toBe(nodes[1].textStyle);
    expect(nodes[0].textStyle).toBe(`${styleName} (567890)`);
    expect(nodes[1].textStyle).toBe(`${styleName} (ef1234)`);
  });
});

describe("collapseSvgContainers", () => {
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

    const { nodes } = await extractFromDesign([booleanOpNode], allExtractors, {
      afterChildren: collapseSvgContainers,
    });

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

    const { nodes } = await extractFromDesign([frameWithBoolOp], allExtractors, {
      afterChildren: collapseSvgContainers,
    });

    // The BOOLEAN_OPERATION collapses to IMAGE-SVG first (bottom-up),
    // then the FRAME sees all children are SVG-eligible and collapses too.
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("IMAGE-SVG");
    expect(nodes[0].children).toBeUndefined();
  });
});

describe("simplifyRawFigmaObject", () => {
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

    const result = await simplifyRawFigmaObject(mockResponse, allExtractors, {
      afterChildren: collapseSvgContainers,
    });

    expect(result.name).toBe("Test File");
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.map((n) => n.name)).toEqual(["Header", "Body", "Icon"]);

    // Verify full depth traversal happened
    const label = result.nodes[1].children![0].children![0];
    expect(label.name).toBe("Label");
    expect(label.text).toBe("World");
  });
});
