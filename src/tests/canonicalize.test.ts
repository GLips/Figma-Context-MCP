import { describe, expect, it } from "vitest";
import type { Node as FigmaNode } from "@figma/rest-api-spec";
import { canonicalize } from "~/core/canonicalize.js";
import { restNodeToSnapshot } from "~/adapters/rest/node-to-snapshot.js";

// Phase 2 Done-when (Invariant 3): canonicalize with defaults emits EXPANDED
// output — every style value inline on its node, no globalVars refs, no element
// templates — because the plugin consumes it in-sandbox where ref indirection
// is pure overhead. Compression is the opt-in egress form.

function makeNode(overrides: Record<string, unknown>): FigmaNode {
  return { visible: true, ...overrides } as unknown as FigmaNode;
}

const RED = { r: 1, g: 0, b: 0, a: 1 };

function twoRedRects(): FigmaNode[] {
  return [
    makeNode({
      id: "1:1",
      name: "A",
      type: "RECTANGLE",
      fills: [{ type: "SOLID", color: RED, blendMode: "NORMAL" }],
    }),
    // cornerRadius keeps the two bodies distinct so compressed mode exercises
    // style refs rather than collapsing both nodes into one element template
    makeNode({
      id: "1:2",
      name: "B",
      type: "RECTANGLE",
      cornerRadius: 4,
      fills: [{ type: "SOLID", color: RED, blendMode: "NORMAL" }],
    }),
  ];
}

const snapshots = (nodes: FigmaNode[]) => nodes.map((n) => restNodeToSnapshot(n));

describe("canonicalize — expanded by default", () => {
  it("emits shared style values inline on every node, with nothing hoisted", async () => {
    const { nodes, globalVars, elements } = await canonicalize(snapshots(twoRedRects()));

    // Both nodes carry the concrete value — no string ref, even though the
    // value repeats (dedup is compression's job, not the walk's).
    expect(nodes[0].fills).toEqual(["#FF0000"]);
    expect(nodes[1].fills).toEqual(["#FF0000"]);
    expect(globalVars.styles).toEqual({});
    expect(elements).toEqual({});
  });

  it("emits run deltas inline in the tuple's style slot — globalVars stays empty", async () => {
    const text = makeNode({
      id: "2:1",
      name: "Text",
      type: "TEXT",
      characters: "abc bold",
      style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16, italic: true },
      characterStyleOverrides: [0, 0, 0, 0, 1, 1, 1, 1],
      // fontSize delta is not markdown-expressible, so it rides a run tuple
      styleOverrideTable: { "1": { fontSize: 32 } },
      lineTypes: [],
      lineIndentations: [],
    });

    const { nodes, globalVars } = await canonicalize(snapshots([text]));

    expect(nodes[0].text).toEqual(["abc ", ["bold", { fontSize: 32 }]]);
    expect(globalVars.styles).toEqual({});
    // The base text style itself is also inline, not a ref.
    expect(typeof nodes[0].textStyle).toBe("object");
  });

  it("compress: true restores the egress form — refs plus hoisted shared styles", async () => {
    const { nodes, globalVars } = await canonicalize(snapshots(twoRedRects()), {
      compress: true,
    });

    expect(typeof nodes[0].fills).toBe("string");
    expect(nodes[1].fills).toBe(nodes[0].fills);
    expect(globalVars.styles[nodes[0].fills as string]).toEqual(["#FF0000"]);
  });
});
