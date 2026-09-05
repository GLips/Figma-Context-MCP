import { describe, expect, it } from "vitest";
import { simplifyRestResponse } from "~/adapters/rest/rest.js";
import type { GetFileResponse, Node as FigmaNode } from "@figma/rest-api-spec";

// An instance is emitted as a diff against its component's published children, which changes what
// an ABSENT field means: outside an override it means "the CSS default", inside one it means "same
// as the component". Every case below is a way those two readings collide, or a difference the diff
// could state only by looking somewhere other than the field values.

const node = (overrides: Record<string, unknown>) =>
  ({ visible: true, ...overrides }) as unknown as FigmaNode;

const solid = (r: number, g: number, b: number) => [
  { type: "SOLID", color: { r, g, b, a: 1 }, opacity: 1 },
];

function page(children: FigmaNode[]): GetFileResponse {
  return {
    name: "F",
    document: {
      id: "0:0",
      name: "D",
      type: "DOCUMENT",
      children: [node({ id: "1:1", name: "Page", type: "CANVAS", children })],
    },
    components: {},
    componentSets: {},
    styles: {},
  } as unknown as GetFileResponse;
}

describe("instances as diffs", () => {
  it("keeps a style an override references reachable through compression", async () => {
    // Two instances recolor the same sublayer, so the value is shared and belongs hoisted. The
    // count that decides that has to see INTO `overrides`; a ref counted zero times is treated as
    // single-use, dropped from the table, and never inlined — leaving the color unrecoverable.
    const design = await simplifyRestResponse(
      page([
        node({
          id: "10:1",
          name: "Card",
          type: "COMPONENT",
          children: [
            node({ id: "10:2", name: "L", type: "TEXT", characters: "x", fills: solid(1, 0, 0) }),
          ],
        }),
        node({
          id: "11:1",
          name: "A",
          type: "INSTANCE",
          componentId: "10:1",
          children: [
            node({
              id: "I11:1;10:2",
              name: "L",
              type: "TEXT",
              characters: "x",
              fills: solid(0, 0, 1),
            }),
          ],
        }),
        node({
          id: "12:1",
          name: "B",
          type: "INSTANCE",
          componentId: "10:1",
          children: [
            node({
              id: "I12:1;10:2",
              name: "L",
              type: "TEXT",
              characters: "x",
              fills: solid(0, 0, 1),
            }),
          ],
        }),
      ]),
    );

    const serialized = JSON.stringify(design);
    for (const ref of serialized.match(/"(fill|layout|effects|textStyle|style)_[0-9a-f]+"/g) ??
      []) {
      expect(Object.keys(design.styles)).toContain(JSON.parse(ref));
    }
    expect(serialized).toContain("#0000FF");
  });

  it("states a field the instance put back to its default", async () => {
    const design = await simplifyRestResponse(
      page([
        node({
          id: "40:1",
          name: "C",
          type: "COMPONENT",
          children: [
            node({ id: "40:2", name: "Box", type: "FRAME", opacity: 0.5, cornerRadius: 8 }),
          ],
        }),
        node({
          id: "41:1",
          name: "I",
          type: "INSTANCE",
          componentId: "40:1",
          children: [
            node({ id: "I41:1;40:2", name: "Box", type: "FRAME", opacity: 1, cornerRadius: 0 }),
          ],
        }),
      ]),
    );

    // `null`, not an omitted key: the read shape has no value for "the default", and omitting the
    // key would rebuild the component's 0.5 on a node the designer set back to 1.
    expect(design.nodes[0].children?.[1].overrides).toEqual({
      "40:2": { opacity: null, borderRadius: null },
    });
  });

  it("reports an instance whose every sublayer was hidden", async () => {
    const design = await simplifyRestResponse(
      page([
        node({
          id: "20:1",
          name: "Btn",
          type: "COMPONENT",
          children: [node({ id: "20:2", name: "L", type: "TEXT", characters: "Go" })],
        }),
        node({
          id: "21:1",
          name: "I",
          type: "INSTANCE",
          componentId: "20:1",
          children: [
            node({ id: "I21:1;20:2", name: "L", type: "TEXT", characters: "Go", visible: false }),
          ],
        }),
      ]),
    );

    // The walk drops hidden nodes, so this instance reaches the diff with no children at all —
    // indistinguishable from an untouched one unless the walk says it emptied it.
    expect(design.nodes[0].children?.[1].overrides).toEqual({ "20:2": { visible: false } });
  });

  it("republishes children the designer resequenced", async () => {
    const design = await simplifyRestResponse(
      page([
        node({
          id: "30:1",
          name: "Row",
          type: "COMPONENT",
          children: [
            node({ id: "30:2", name: "A", type: "FRAME" }),
            node({ id: "30:3", name: "B", type: "FRAME" }),
          ],
        }),
        node({
          id: "31:1",
          name: "I",
          type: "INSTANCE",
          componentId: "30:1",
          children: [
            node({ id: "I31:1;30:3", name: "B", type: "FRAME" }),
            node({ id: "I31:1;30:2", name: "A", type: "FRAME" }),
          ],
        }),
      ]),
    );

    // Sibling order is the z-order and the layout flow, and a path-keyed diff cannot state it —
    // so the level comes back whole rather than as a silent no-difference.
    const instance = design.nodes[0].children?.[1];
    expect(instance?.overrides).toBeUndefined();
    expect(instance?.children?.map((child) => child.name)).toEqual(["B", "A"]);
  });
});
