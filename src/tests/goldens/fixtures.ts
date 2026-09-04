import type {
  GetFileResponse,
  GetFileNodesResponse,
  Node as FigmaNode,
} from "@figma/rest-api-spec";

/**
 * Baseline golden fixtures for the simplify core (Invariant 1).
 *
 * These are synthetic `GetFileResponse` / `GetFileNodesResponse` inputs that
 * deliberately exercise each REST-coupling spot the carve relocates into
 * `restNodeToSnapshot` — top-level component/style tables, `node.styles` name
 * lookups, text `characterStyleOverrides`/`styleOverrideTable` decoding, image
 * `imageRef`/`gifRef`, and gradient `gradientHandlePositions` — plus the
 * comparator cases (plain/autolayout frame, component + instance, named-style
 * disambiguation, deep-nested dedup).
 *
 * The golden test runs each through the PUBLIC entry (`simplifyRestResponse`)
 * so it survives the carve gutting the internals: the committed golden output
 * is whatever the current transform produces, and the carve must reproduce it
 * byte-for-byte. Fixtures are synthetic (the walk.test.ts pattern) — they
 * only need to hit the code paths, not be faithful Figma exports.
 */

// Only the fields the transform reads are populated; the Figma node type is a
// deeply discriminated union, so we cast through unknown as the existing tests do.
function node(overrides: Record<string, unknown>): FigmaNode {
  return { visible: true, ...overrides } as unknown as FigmaNode;
}

function fileResponse(
  name: string,
  children: FigmaNode[],
  extra: Partial<GetFileResponse> = {},
): GetFileResponse {
  return {
    name,
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children,
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
    ...extra,
  } as unknown as GetFileResponse;
}

// ---------------------------------------------------------------------------
// 1. Plain frame — solid-fill flattening, strokes, corner radius, opacity,
//    drop shadow, root contextual sizing, nested text + invisible child.
// ---------------------------------------------------------------------------
const plainFrame = fileResponse("Plain Frame", [
  node({
    id: "1:1",
    name: "Card",
    type: "FRAME",
    clipsContent: true,
    absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 120 },
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
    cornerRadius: 8,
    opacity: 0.9,
    fills: [
      { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, visible: true },
      { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.1, visible: true },
    ],
    strokes: [{ type: "SOLID", color: { r: 0.8, g: 0.8, b: 0.8, a: 1 }, visible: true }],
    strokeWeight: 1,
    strokeAlign: "OUTSIDE",
    effects: [
      {
        type: "DROP_SHADOW",
        visible: true,
        color: { r: 0, g: 0, b: 0, a: 0.25 },
        offset: { x: 0, y: 2 },
        radius: 4,
        spread: 0,
      },
    ],
    children: [
      node({
        id: "1:2",
        name: "Bg",
        type: "RECTANGLE",
        visible: false,
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 120 },
      }),
      node({
        id: "1:3",
        name: "Title",
        type: "TEXT",
        characters: "Hello",
        absoluteBoundingBox: { x: 16, y: 16, width: 120, height: 24 },
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
        style: {
          fontFamily: "Inter",
          fontWeight: 600,
          fontSize: 16,
          lineHeightPx: 24,
          lineHeightUnit: "PIXELS",
          textAlignHorizontal: "LEFT",
          textAlignVertical: "TOP",
        },
        fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1, a: 1 }, visible: true }],
      }),
    ],
  }),
]);

// ---------------------------------------------------------------------------
// 2. Auto-layout frame — layoutMode, padding, gap, primary/counter align,
//    child fixed sizing, and an absolutely-positioned child.
// ---------------------------------------------------------------------------
const autoLayoutFrame = fileResponse("Auto Layout", [
  node({
    id: "2:1",
    name: "Row",
    type: "FRAME",
    clipsContent: true,
    layoutMode: "HORIZONTAL",
    itemSpacing: 8,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 16,
    paddingRight: 16,
    primaryAxisAlignItems: "CENTER",
    counterAxisAlignItems: "MIN",
    absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 60 },
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
    children: [
      node({
        id: "2:2",
        name: "Primary Button",
        type: "FRAME",
        clipsContent: true,
        absoluteBoundingBox: { x: 16, y: 12, width: 120, height: 36 },
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
        cornerRadius: 6,
        fills: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1, a: 1 }, visible: true }],
      }),
      node({
        id: "2:3",
        name: "Badge",
        type: "FRAME",
        clipsContent: true,
        layoutPositioning: "ABSOLUTE",
        absoluteBoundingBox: { x: 260, y: 4, width: 24, height: 24 },
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
        cornerRadius: 12,
        fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }],
      }),
    ],
  }),
]);

// ---------------------------------------------------------------------------
// 3. Mixed-run text — characterStyleOverrides + styleOverrideTable (bold,
//    italic, strike, URL link, color), plus ordered/unordered list lines.
// ---------------------------------------------------------------------------
const baseTextStyle = {
  fontFamily: "Inter",
  fontWeight: 400,
  fontSize: 14,
  lineHeightPx: 20,
  lineHeightUnit: "PIXELS",
  textAlignHorizontal: "LEFT",
  textAlignVertical: "TOP",
};
// "Hi bold link\nOne\nTwo" — overrides mark "bold" (id 1) and "link" (id 2).
const mixedRunText = fileResponse("Mixed Run Text", [
  node({
    id: "3:1",
    name: "Body",
    type: "TEXT",
    absoluteBoundingBox: { x: 0, y: 0, width: 240, height: 80 },
    characters: "Hi bold link\nOne\nTwo",
    // indices:      0123456789...
    characterStyleOverrides: [0, 0, 0, 1, 1, 1, 1, 0, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0],
    styleOverrideTable: {
      "1": { fontWeight: 700 },
      "2": {
        textDecoration: "UNDERLINE",
        hyperlink: { type: "URL", url: "https://example.com" },
        fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 }, visible: true }],
      },
    },
    lineTypes: ["NONE", "ORDERED", "UNORDERED"],
    lineIndentations: [0, 0, 0],
    style: baseTextStyle,
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, visible: true }],
  }),
]);

// ---------------------------------------------------------------------------
// 4. Gradient fills — linear (with handles) and radial.
// ---------------------------------------------------------------------------
const gradientFill = fileResponse("Gradient Fill", [
  node({
    id: "4:1",
    name: "Linear",
    type: "RECTANGLE",
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
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
    ],
  }),
  node({
    id: "4:2",
    name: "Radial",
    type: "RECTANGLE",
    absoluteBoundingBox: { x: 0, y: 120, width: 100, height: 100 },
    fills: [
      {
        type: "GRADIENT_RADIAL",
        visible: true,
        opacity: 0.8,
        gradientHandlePositions: [
          { x: 0.5, y: 0.5 },
          { x: 1, y: 0.5 },
          { x: 0.5, y: 1 },
        ],
        gradientStops: [
          { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
        ],
      },
    ],
  }),
]);

// ---------------------------------------------------------------------------
// 5. Image fills — <img> path (FILL, no children), background path (TILE,
//    scalingFactor), and a cropped image (imageTransform) + gifRef.
// ---------------------------------------------------------------------------
const imageFill = fileResponse("Image Fill", [
  node({
    id: "5:1",
    name: "Photo",
    type: "RECTANGLE",
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    fills: [{ type: "IMAGE", imageRef: "abc123def456", scaleMode: "FILL", visible: true }],
  }),
  node({
    id: "5:2",
    name: "Tiled",
    type: "FRAME",
    clipsContent: true,
    absoluteBoundingBox: { x: 0, y: 120, width: 100, height: 100 },
    fills: [
      {
        type: "IMAGE",
        imageRef: "tile999",
        scaleMode: "TILE",
        scalingFactor: 0.5,
        visible: true,
      },
    ],
    children: [
      node({
        id: "5:3",
        name: "Cropped",
        type: "RECTANGLE",
        absoluteBoundingBox: { x: 0, y: 120, width: 50, height: 50 },
        fills: [
          {
            type: "IMAGE",
            imageRef: "crop555",
            gifRef: "gif777",
            scaleMode: "FILL",
            imageTransform: [
              [1, 0, 0.1],
              [0, 1, 0.2],
            ],
            visible: true,
          },
        ],
      }),
    ],
  }),
]);

// ---------------------------------------------------------------------------
// 6. Component + instance — top-level components table (GetFileNodesResponse
//    branch), COMPONENT propertyDefinitions, INSTANCE componentProperties,
//    componentPropertyReferences, hidden-node rescue via `visible` reference.
// ---------------------------------------------------------------------------
const componentInstance: GetFileNodesResponse = {
  name: "Components",
  role: "owner",
  lastModified: "2024-01-01",
  thumbnailUrl: "",
  version: "1",
  editorType: "figma",
  linkAccess: "view",
  nodes: {
    "6:1": {
      document: node({
        id: "6:1",
        name: "Group",
        type: "FRAME",
        clipsContent: true,
        absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
        children: [
          node({
            id: "6:2",
            name: "Product Card",
            type: "COMPONENT",
            clipsContent: true,
            absoluteBoundingBox: { x: 0, y: 0, width: 150, height: 200 },
            componentPropertyDefinitions: {
              "On Sale#341:0": { type: "BOOLEAN", defaultValue: true },
              "Title#341:1": { type: "TEXT", defaultValue: "Product Name" },
              "Icon#341:2": { type: "INSTANCE_SWAP", defaultValue: "999:1" },
            },
            children: [
              node({
                id: "6:3",
                name: "Label",
                type: "TEXT",
                characters: "Product Name",
                absoluteBoundingBox: { x: 8, y: 8, width: 134, height: 20 },
                componentPropertyReferences: { characters: "Title#341:1" },
                style: baseTextStyle,
                fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, visible: true }],
              }),
              node({
                id: "6:4",
                name: "Sale Ribbon",
                type: "FRAME",
                clipsContent: true,
                visible: false,
                componentPropertyReferences: { visible: "On Sale#341:0" },
                absoluteBoundingBox: { x: 0, y: 0, width: 60, height: 20 },
                fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }],
              }),
            ],
          }),
          node({
            id: "6:5",
            name: "Card Instance",
            type: "INSTANCE",
            componentId: "6:2",
            clipsContent: true,
            absoluteBoundingBox: { x: 150, y: 0, width: 150, height: 200 },
            componentProperties: {
              "On Sale": { type: "BOOLEAN", value: false },
              Title: { type: "TEXT", value: "My Product" },
            },
            children: [
              node({
                id: "6:6",
                name: "Label",
                type: "TEXT",
                characters: "My Product",
                absoluteBoundingBox: { x: 158, y: 8, width: 134, height: 20 },
                style: baseTextStyle,
                fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, visible: true }],
              }),
            ],
          }),
        ],
      }),
      components: {
        "6:2": { key: "compkey123", name: "Product Card", componentSetId: undefined },
      },
      componentSets: {},
      styles: {},
    },
  },
} as unknown as GetFileNodesResponse;

// ---------------------------------------------------------------------------
// 7. Named styles — node.styles referencing the top-level styles table, with a
//    same-name collision that must disambiguate by id, plus a named fill style.
// ---------------------------------------------------------------------------
const namedStyles = fileResponse(
  "Named Styles",
  [
    node({
      id: "7:1",
      name: "Heading A",
      type: "TEXT",
      characters: "Alpha",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 24 },
      style: { fontFamily: "Inter", fontWeight: 400, fontSize: 12 },
      styles: { text: "13:77" },
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, visible: true }],
    }),
    node({
      id: "7:2",
      name: "Heading B",
      type: "TEXT",
      characters: "Beta",
      absoluteBoundingBox: { x: 0, y: 30, width: 100, height: 24 },
      style: { fontFamily: "Inter", fontWeight: 600, fontSize: 14 },
      styles: { text: "161:300" },
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, visible: true }],
    }),
    node({
      id: "7:3",
      name: "Swatch",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 0, y: 60, width: 40, height: 40 },
      fills: [{ type: "SOLID", color: { r: 1, g: 0.5, b: 0, a: 1 }, visible: true }],
      styles: { fill: "20:1" },
    }),
  ],
  {
    styles: {
      "13:77": {
        key: "k1",
        name: "Heading / Large",
        styleType: "TEXT",
        description: "",
        remote: false,
      },
      "161:300": {
        key: "k2",
        name: "Heading / Large",
        styleType: "TEXT",
        description: "",
        remote: false,
      },
      "20:1": {
        key: "k3",
        name: "Brand / Orange",
        styleType: "FILL",
        description: "",
        remote: false,
      },
    },
  },
);

// ---------------------------------------------------------------------------
// 8. Deep-nested + dedup — three structurally identical "Chip" subtrees so the
//    compression pass hoists a shared style and emits element templates.
// ---------------------------------------------------------------------------
function chip(id: string, x: number): FigmaNode {
  return node({
    id,
    name: "Chip",
    type: "FRAME",
    clipsContent: true,
    absoluteBoundingBox: { x, y: 0, width: 60, height: 28 },
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
    cornerRadius: 14,
    fills: [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9, a: 1 }, visible: true }],
    children: [
      node({
        id: `${id}:t`,
        name: "Tag",
        type: "TEXT",
        characters: "Tag",
        absoluteBoundingBox: { x: x + 8, y: 6, width: 44, height: 16 },
        style: { fontFamily: "Inter", fontWeight: 500, fontSize: 12 },
        fills: [{ type: "SOLID", color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, visible: true }],
      }),
    ],
  });
}
const deepNested = fileResponse("Deep Nested", [
  node({
    id: "8:1",
    name: "Chip Row",
    type: "FRAME",
    clipsContent: true,
    layoutMode: "HORIZONTAL",
    itemSpacing: 8,
    absoluteBoundingBox: { x: 0, y: 0, width: 220, height: 28 },
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
    children: [chip("8:2", 0), chip("8:3", 68), chip("8:4", 136)],
  }),
]);

// ---------------------------------------------------------------------------
// 9. Rotated nodes — the own-size inversion (fig-8). Every `absoluteBoundingBox`
//    below is the page-space AABB Figma would report for the geometry named in
//    the comment beside it, so the REST producer has to invert its way back to
//    the authored numbers. Covers a plain angle, the degenerate 45° band (where
//    the inversion is unsolvable and the AABB stands in), a node UNDER a
//    degenerate one (size solvable, origin not), and a rotation nested inside a
//    rotation (page rotation 10° + 20°, which is what the AABB is aligned to).
// ---------------------------------------------------------------------------
const rotatedNodes = fileResponse("Rotated Nodes", [
  node({
    id: "9:1",
    name: "Rotation Board",
    type: "FRAME",
    clipsContent: true,
    absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 300 },
    layoutSizingHorizontal: "FIXED",
    layoutSizingVertical: "FIXED",
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, visible: true }],
    children: [
      node({
        id: "9:2",
        name: "Tilted Card",
        type: "FRAME",
        // 40x24 at (100, 60), rotated 15deg
        absoluteBoundingBox: { x: 100, y: 49.6472, width: 44.8487, height: 33.535 },
        rotation: 15,
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
        fills: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 0.9, a: 1 }, visible: true }],
      }),
      node({
        id: "9:3",
        name: "Diagonal Chip",
        type: "FRAME",
        // 60x20 at (220, 80), rotated 45deg — the degenerate band, where the
        // inversion has no answer and the AABB stands in.
        absoluteBoundingBox: { x: 220, y: 37.5736, width: 56.5685, height: 56.5685 },
        rotation: 45,
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
        fills: [{ type: "SOLID", color: { r: 0.9, g: 0.4, b: 0.2, a: 1 }, visible: true }],
        children: [
          node({
            id: "9:6",
            name: "Chip Label",
            type: "FRAME",
            // 20x8 at (6, 6) inside the chip, rotated -45deg — back to square with
            // the page, so its SIZE inverts cleanly even though its origin can't.
            absoluteBoundingBox: { x: 228.4853, y: 80, width: 20, height: 8 },
            rotation: -45,
            layoutSizingHorizontal: "FIXED",
            layoutSizingVertical: "FIXED",
            fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, visible: true }],
          }),
        ],
      }),
      node({
        id: "9:9",
        name: "Tilted Rule",
        type: "LINE",
        // 80x0 at (60, 250), rotated 15deg — a zero side is a real authored size,
        // not a failed solve. The inversion reaches it by cancellation, so the
        // residual is signed: at THIS angle it lands negative, which is why the
        // solve tolerates a sub-pixel negative instead of testing `>= 0`.
        absoluteBoundingBox: { x: 60, y: 229.2945, width: 77.2741, height: 20.7055 },
        rotation: 15,
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
        strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, visible: true }],
        strokeWeight: 1,
      }),
      node({
        id: "9:7",
        name: "Upside Down",
        type: "FRAME",
        // 50x30 at (300, 200), rotated a half-turn. REST reports 180deg for a
        // HORIZONTALLY FLIPPED node too and can't tell the two apart, so it
        // withholds the origin here and falls back to the AABB corner.
        absoluteBoundingBox: { x: 250, y: 170, width: 50, height: 30 },
        rotation: 180,
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
        fills: [{ type: "SOLID", color: { r: 0.6, g: 0.3, b: 0.8, a: 1 }, visible: true }],
      }),
      node({
        id: "9:4",
        name: "Tilted Group",
        type: "FRAME",
        // 120x90 at (40, 150), rotated 10deg
        absoluteBoundingBox: { x: 40, y: 129.1622, width: 133.8053, height: 109.4705 },
        rotation: 10,
        layoutSizingHorizontal: "FIXED",
        layoutSizingVertical: "FIXED",
        fills: [{ type: "SOLID", color: { r: 0.95, g: 0.95, b: 0.95, a: 1 }, visible: true }],
        children: [
          node({
            id: "9:5",
            name: "Inner Tilt",
            type: "FRAME",
            // 30x18 at (12, 9) inside the group, rotated a further 20deg — 30deg
            // against the page, which is the angle the AABB is aligned to.
            absoluteBoundingBox: { x: 53.3805, y: 141.7795, width: 34.9808, height: 30.5885 },
            rotation: 20,
            layoutSizingHorizontal: "FIXED",
            layoutSizingVertical: "FIXED",
            fills: [{ type: "SOLID", color: { r: 0.1, g: 0.7, b: 0.4, a: 1 }, visible: true }],
          }),
        ],
      }),
    ],
  }),
]);

export type GoldenFixture = {
  name: string;
  response: GetFileResponse | GetFileNodesResponse;
};

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  { name: "plain-frame", response: plainFrame },
  { name: "autolayout-frame", response: autoLayoutFrame },
  { name: "mixed-run-text", response: mixedRunText },
  { name: "gradient-fill", response: gradientFill },
  { name: "image-fill", response: imageFill },
  { name: "component-instance", response: componentInstance },
  { name: "named-styles", response: namedStyles },
  { name: "deep-nested", response: deepNested },
  { name: "rotated-nodes", response: rotatedNodes },
];
