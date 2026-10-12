import { describe, expect, it } from "vitest";
import { compressDesign } from "../src/compress.js";
import type { SimplifiedNode, StyleValue } from "../src/types.js";

// compressDesign is the REST egress pass over project()'s expanded output: style fields hold
// values, and compression decides which to hoist and which bodies to template. Testing it directly
// keeps these fast and free of Figma-fixture noise.

// A lone solid fill serializes to a bare hex string in real output (see foldPaintStack).
const RED: StyleValue = "#FF0000";
const BLUE: StyleValue = "#0000FF";

function node(overrides: Partial<SimplifiedNode> & { id: string }): SimplifiedNode {
  return { name: overrides.id, type: "FRAME", ...overrides };
}

function compress(nodes: SimplifiedNode[]) {
  return compressDesign({ nodes, styles: {}, templates: {}, components: {} });
}

/** The hoisted key a value was given, so assertions don't spell content hashes. */
function refOf(styles: Record<string, StyleValue>, value: StyleValue): string {
  const entry = Object.entries(styles).find(([, v]) => JSON.stringify(v) === JSON.stringify(value));
  if (!entry) throw new Error(`no hoisted style holds ${JSON.stringify(value)}`);
  return entry[0];
}

describe("count-gated style hoisting", () => {
  it("leaves a single-use style inline and the styles table empty", () => {
    const result = compress([node({ id: "1", fill: RED })]);

    expect(result.nodes[0].fill).toEqual(RED);
    expect(result.styles).toEqual({});
  });

  it("hoists a 2+-use style under one content-addressed ref", () => {
    // Distinct bodies (FRAME vs RECTANGLE) so template dedup doesn't fold them —
    // this isolates style gating: the shared fill is referenced, not inlined.
    const result = compress([
      node({ id: "1", type: "FRAME", fill: RED }),
      node({ id: "2", type: "RECTANGLE", fill: RED }),
    ]);

    const ref = refOf(result.styles, RED);
    expect(ref).toMatch(/^fill_[0-9a-f]{8}$/);
    expect(result.nodes.map((n) => n.fill)).toEqual([ref, ref]);
    expect(result.styles).toEqual({ [ref]: RED });
  });

  it("treats a style reference like any other value: inline at one use, hoisted at two", () => {
    const heading = { style: { id: "S:1", name: "Heading / Large" } };
    const single = compress([node({ id: "1", type: "TEXT", textStyle: heading })]);
    expect(single.nodes[0].textStyle).toEqual(heading);
    expect(single.styles).toEqual({});

    const shared = compress([
      node({ id: "1", type: "TEXT", textStyle: heading }),
      node({ id: "2", type: "TEXT", textStyle: heading, opacity: 0.5 }),
    ]);
    const ref = refOf(shared.styles, heading);
    expect(shared.nodes.map((n) => n.textStyle)).toEqual([ref, ref]);
  });

  it("hoists a run delta shared by 2+ tuples, and leaves a single-use one in its tuple", () => {
    const bold = { fontWeight: 700 };
    const result = compress([
      node({ id: "1", type: "TEXT", text: [["a", bold]] }),
      node({ id: "2", type: "TEXT", text: [["b", bold]], opacity: 0.5 }),
      node({ id: "3", type: "TEXT", text: ["c ", ["d", { fontWeight: 300 }]], opacity: 0.2 }),
    ]);

    const ref = refOf(result.styles, bold);
    expect(result.nodes[0].text).toEqual([["a", ref]]);
    expect(result.nodes[2].text).toEqual(["c ", ["d", { fontWeight: 300 }]]);
  });

  it("never hoists the 'none' removal word", () => {
    const result = compress([
      node({ id: "1", type: "TEXT", fill: "none" }),
      node({ id: "2", type: "TEXT", fill: "none", opacity: 0.5 }),
    ]);

    expect(result.nodes.map((n) => n.fill)).toEqual(["none", "none"]);
    expect(result.styles).toEqual({});
  });
});

describe("templates", () => {
  it("dedupes two identical subtrees into one template entry + two template refs", () => {
    // A third node (distinct body) also uses RED so it stays a hoisted ref rather than being
    // inlined by exclusive-style expansion.
    const result = compress([
      node({ id: "1", name: "Card A", fill: RED }),
      node({ id: "2", name: "Card B", fill: RED }),
      node({ id: "9", name: "Header", type: "RECTANGLE", fill: RED }),
    ]);

    const ref = refOf(result.styles, RED);
    const [hash] = Object.keys(result.templates);
    expect(Object.keys(result.templates)).toHaveLength(1);
    expect(result.templates[hash]).toEqual({ type: "FRAME", fill: ref });

    // Each card keeps its per-instance id/name, body replaced by the ref.
    expect(result.nodes[0]).toEqual({ id: "1", name: "Card A", template: hash });
    expect(result.nodes[1]).toEqual({ id: "2", name: "Card B", template: hash });
  });

  it("inlines a style used only by one template, dropping the global entry", () => {
    // RED is used by exactly the two cards that fold into one template. Exclusive → expanded
    // inline, collapsing template → ref → value down to template → value.
    const result = compress([
      node({ id: "1", name: "Card A", fill: RED }),
      node({ id: "2", name: "Card B", fill: RED }),
    ]);

    const [hash] = Object.keys(result.templates);
    expect(result.templates[hash]).toEqual({ type: "FRAME", fill: RED });
    expect(result.styles).toEqual({});
  });

  it("leaves a unique subtree inline (no template)", () => {
    const result = compress([
      node({ id: "1", name: "Card A", fill: RED }),
      node({ id: "2", name: "Card B", fill: RED }),
      node({ id: "3", name: "Solo", fill: BLUE }),
    ]);

    expect(result.nodes[2].template).toBeUndefined();
    expect(result.nodes[2].fill).toEqual(BLUE);
    expect(result.nodes[2].type).toBe("FRAME");
  });

  it("keeps a node's elision marker on its reference, out of the shared body", () => {
    const result = compress([
      node({ id: "1", fill: RED, elided: { d: 120 } }),
      node({ id: "2", fill: RED }),
    ]);

    const [hash] = Object.keys(result.templates);
    expect(result.nodes[0]).toEqual({ id: "1", name: "1", template: hash, elided: { d: 120 } });
    expect(result.nodes[1]).toEqual({ id: "2", name: "2", template: hash });
  });

  it("dedupes repeated children while keeping per-instance ids", () => {
    const card = (id: string): SimplifiedNode =>
      node({
        id,
        name: `Card ${id}`,
        fill: RED,
        children: [node({ id: `${id}-icon`, name: "Icon", type: "IMAGE-SVG", opacity: 0.5 })],
      });
    const result = compress([card("1"), card("2")]);

    // Two distinct templates: the card body and the icon body.
    expect(Object.keys(result.templates)).toHaveLength(2);
    expect(result.nodes[0].template).toBe(result.nodes[1].template);
    expect(result.nodes[0].children?.[0].template).toBe(result.nodes[1].children?.[0].template);
    expect(result.nodes[0].children?.[0].id).toBe("1-icon");
    expect(result.nodes[1].children?.[0].id).toBe("2-icon");
  });

  it("does not dedupe type-only bodies (a template would grow the payload)", () => {
    const result = compress([node({ id: "1" }), node({ id: "2" })]);

    expect(result.templates).toEqual({});
    expect(result.nodes[0].template).toBeUndefined();
    expect(result.nodes[0].type).toBe("FRAME");
  });

  it("is deterministic: identical input yields identical template and style ids", () => {
    const build = (): SimplifiedNode[] => [
      node({ id: "1", fill: RED }),
      node({ id: "2", fill: RED }),
      node({ id: "3", type: "RECTANGLE", fill: RED }),
    ];
    const a = compress(build());
    const b = compress(build());

    expect(Object.keys(a.templates)).toEqual(Object.keys(b.templates));
    expect(Object.keys(a.styles)).toEqual(Object.keys(b.styles));
  });
});
