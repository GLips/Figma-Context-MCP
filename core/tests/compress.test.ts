import { describe, expect, it } from "vitest";
import { compressDesign } from "../src/compress.js";
import type { SimplifiedNode, StyleValue } from "../src/types.js";

// compressDesign is the pure functional core of the dedup features: given the
// already-walked node tree + styles table (style fields hold refs, as
// the walk emits them), it gates single-use styles inline. Testing it directly
// keeps these fast and free of Figma-fixture noise.

// Solid fills serialize to hex-string arrays in real output (see style.ts).
const RED: StyleValue = ["#FF0000"];
const BLUE: StyleValue = ["#0000FF"];

function node(overrides: Partial<SimplifiedNode> & { id: string }): SimplifiedNode {
  return { name: overrides.id, type: "FRAME", ...overrides };
}

describe("count-gated style hoisting", () => {
  it("inlines a single-use style onto its node and drops it from the styles table", () => {
    const nodes = [node({ id: "1", fills: "fill_red" })];
    const styles: Record<string, StyleValue> = { fill_red: RED };

    const result = compressDesign(nodes, styles, new Set());

    expect(result.nodes[0].fills).toEqual(RED);
    expect(result.styles).toEqual({});
  });

  it("keeps a 2+-use style hoisted and referenced by id", () => {
    // Distinct bodies (FRAME vs RECTANGLE) so template dedup doesn't fold them —
    // this isolates style gating: the shared fill is referenced, not inlined.
    const nodes = [
      node({ id: "1", type: "FRAME", fills: "fill_red" }),
      node({ id: "2", type: "RECTANGLE", fills: "fill_red" }),
    ];
    const styles: Record<string, StyleValue> = { fill_red: RED };

    const result = compressDesign(nodes, styles, new Set());

    expect(result.nodes[0].fills).toBe("fill_red");
    expect(result.nodes[1].fills).toBe("fill_red");
    expect(result.styles).toEqual({ fill_red: RED });
  });

  it("keeps a single-use named Figma style hoisted (design-system intent)", () => {
    const nodes = [node({ id: "1", type: "TEXT", textStyle: "Heading / Large" })];
    const styles: Record<string, StyleValue> = { "Heading / Large": { fontSize: 24 } };

    const result = compressDesign(nodes, styles, new Set(["Heading / Large"]));

    expect(result.nodes[0].textStyle).toBe("Heading / Large");
    expect(result.styles).toEqual({ "Heading / Large": { fontSize: 24 } });
  });

  it("drops a named style that no surviving node references (orphaned by node removal)", () => {
    // A named style can reach zero references when its only node is dropped after
    // registration — e.g. collapseSvgContainers registers a vector child's named
    // style, then folds the child away. A hoisted entry nothing points to is just
    // orphan noise, so it must be dropped rather than force-kept as "intent".
    const nodes = [node({ id: "1", type: "FRAME" })]; // references no style
    const styles: Record<string, StyleValue> = { "Heading / Large": { fontSize: 24 } };

    const result = compressDesign(nodes, styles, new Set(["Heading / Large"]));

    expect(result.styles).toEqual({});
  });

  it("inlines a single-use run delta into its tuple's style slot", () => {
    const nodes = [node({ id: "1", type: "TEXT", text: ["a ", ["b", "style_abc12345"]] })];
    const styles: Record<string, StyleValue> = { style_abc12345: { fontWeight: 700 } };

    const result = compressDesign(nodes, styles, new Set());

    expect(result.nodes[0].text).toEqual(["a ", ["b", { fontWeight: 700 }]]);
    expect(result.styles).toEqual({});
  });

  it("keeps a run delta shared by 2+ tuples hoisted as a ref", () => {
    const nodes = [
      node({ id: "1", type: "TEXT", text: [["a", "style_abc12345"]] }),
      node({ id: "2", type: "TEXT", text: [["b", "style_abc12345"]], opacity: 0.5 }),
    ];
    const styles: Record<string, StyleValue> = { style_abc12345: { fontWeight: 700 } };

    const result = compressDesign(nodes, styles, new Set());

    expect(result.nodes[0].text).toEqual([["a", "style_abc12345"]]);
    expect(result.nodes[1].text).toEqual([["b", "style_abc12345"]]);
    expect(result.styles).toEqual({ style_abc12345: { fontWeight: 700 } });
  });
});

describe("templates", () => {
  it("dedupes two identical subtrees into one template entry + two template refs", () => {
    // Both cards share fill_red (count 2 → stays a ref), so their post-gating
    // bodies are byte-identical and hash to the same template. A third node
    // (distinct body) also uses fill_red so it stays a hoisted ref rather than
    // being inlined by exclusive-style expansion.
    const nodes = [
      node({ id: "1", name: "Card A", fills: "fill_red" }),
      node({ id: "2", name: "Card B", fills: "fill_red" }),
      node({ id: "9", name: "Header", type: "RECTANGLE", fills: "fill_red" }),
    ];
    const styles: Record<string, StyleValue> = { fill_red: RED };

    const result = compressDesign(nodes, styles, new Set());

    const [hash] = Object.keys(result.templates);
    expect(Object.keys(result.templates)).toHaveLength(1);
    expect(result.templates[hash]).toEqual({ type: "FRAME", fills: "fill_red" });

    // Each card keeps its per-instance id/name, body replaced by the ref.
    expect(result.nodes[0]).toEqual({ id: "1", name: "Card A", template: hash });
    expect(result.nodes[1]).toEqual({ id: "2", name: "Card B", template: hash });
    // The shared style stays hoisted (referenced from the template body + Header).
    expect(result.styles).toEqual({ fill_red: RED });
  });

  it("inlines a style used only by one template, dropping the global entry", () => {
    // fill_red is used by exactly the two cards (count 2) that fold into one
    // template (2 instances). Exclusive → expanded inline, global entry removed,
    // collapsing template → ref → value down to template → value.
    const nodes = [
      node({ id: "1", name: "Card A", fills: "fill_red" }),
      node({ id: "2", name: "Card B", fills: "fill_red" }),
    ];
    const styles: Record<string, StyleValue> = { fill_red: RED };

    const result = compressDesign(nodes, styles, new Set());

    const [hash] = Object.keys(result.templates);
    expect(result.templates[hash]).toEqual({ type: "FRAME", fills: RED });
    expect(result.styles).toEqual({});
  });

  it("does not expand a named style even when exclusive to one template", () => {
    const nodes = [
      node({ id: "1", name: "Card A", type: "TEXT", textStyle: "Heading / Large" }),
      node({ id: "2", name: "Card B", type: "TEXT", textStyle: "Heading / Large" }),
    ];
    const styles: Record<string, StyleValue> = { "Heading / Large": { fontSize: 24 } };

    const result = compressDesign(nodes, styles, new Set(["Heading / Large"]));

    const [hash] = Object.keys(result.templates);
    expect(result.templates[hash]).toEqual({ type: "TEXT", textStyle: "Heading / Large" });
    expect(result.styles).toEqual({ "Heading / Large": { fontSize: 24 } });
  });

  it("leaves a unique subtree inline (no template)", () => {
    const nodes = [
      node({ id: "1", name: "Card A", fills: "fill_red" }),
      node({ id: "2", name: "Card B", fills: "fill_red" }),
      node({ id: "3", name: "Solo", fills: "fill_blue" }),
    ];
    const styles: Record<string, StyleValue> = { fill_red: RED, fill_blue: BLUE };

    const result = compressDesign(nodes, styles, new Set());

    // The solo card's body is unique → no template, and its single-use fill
    // inlines onto the node.
    expect(result.nodes[2].template).toBeUndefined();
    expect(result.nodes[2].fills).toEqual(BLUE);
    expect(result.nodes[2].type).toBe("FRAME");
  });

  it("dedupes repeated children while keeping per-instance ids", () => {
    // A grid of two identical cards, each wrapping an identical icon.
    const card = (id: string): SimplifiedNode =>
      node({
        id,
        name: `Card ${id}`,
        fills: "fill_red",
        children: [node({ id: `${id}-icon`, name: "Icon", type: "IMAGE-SVG", opacity: 0.5 })],
      });
    const nodes = [card("1"), card("2")];
    const styles: Record<string, StyleValue> = { fill_red: RED };

    const result = compressDesign(nodes, styles, new Set());

    // Two distinct templates: the card body and the icon body.
    expect(Object.keys(result.templates)).toHaveLength(2);
    expect(result.nodes[0].template).toBe(result.nodes[1].template);
    expect(result.nodes[0].children?.[0].template).toBe(result.nodes[1].children?.[0].template);
    expect(result.nodes[0].children?.[0].id).toBe("1-icon");
    expect(result.nodes[1].children?.[0].id).toBe("2-icon");
  });

  it("does not dedupe type-only bodies (a template would grow the payload)", () => {
    const nodes = [node({ id: "1" }), node({ id: "2" })];

    const result = compressDesign(nodes, {}, new Set());

    expect(result.templates).toEqual({});
    expect(result.nodes[0].template).toBeUndefined();
    expect(result.nodes[0].type).toBe("FRAME");
  });

  it("is deterministic: identical input yields identical template hashes", () => {
    const build = (): SimplifiedNode[] => [
      node({ id: "1", fills: "fill_red" }),
      node({ id: "2", fills: "fill_red" }),
    ];
    const a = compressDesign(build(), { fill_red: RED }, new Set());
    const b = compressDesign(build(), { fill_red: RED }, new Set());

    expect(Object.keys(a.templates)).toEqual(Object.keys(b.templates));
  });
});
