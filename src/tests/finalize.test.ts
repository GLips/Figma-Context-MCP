import { describe, expect, it } from "vitest";
import { finalizeDesign } from "~/extractors/finalize.js";
import type { GlobalVars, SimplifiedNode, StyleTypes } from "~/extractors/types.js";

// finalizeDesign is the pure functional core of the dedup features: given the
// already-walked node tree + globalVars (style fields hold globalVars refs, as
// the walker emits them), it gates single-use styles inline. Testing it directly
// keeps these fast and free of Figma-fixture noise.

// Solid fills serialize to hex-string arrays in real output (see style.ts).
const RED: StyleTypes = ["#FF0000"];

function node(overrides: Partial<SimplifiedNode> & { id: string }): SimplifiedNode {
  return { name: overrides.id, type: "FRAME", ...overrides };
}

describe("count-gated style hoisting", () => {
  it("inlines a single-use style onto its node and drops it from globalVars", () => {
    const nodes = [node({ id: "1", fills: "fill_red" })];
    const globalVars: GlobalVars = { styles: { fill_red: RED } };

    const result = finalizeDesign(nodes, globalVars, new Set());

    expect(result.nodes[0].fills).toEqual(RED);
    expect(result.globalVars.styles).toEqual({});
  });

  it("keeps a 2+-use style hoisted and referenced by id", () => {
    // Distinct bodies (FRAME vs RECTANGLE) so element dedup doesn't fold them —
    // this isolates style gating: the shared fill is referenced, not inlined.
    const nodes = [
      node({ id: "1", type: "FRAME", fills: "fill_red" }),
      node({ id: "2", type: "RECTANGLE", fills: "fill_red" }),
    ];
    const globalVars: GlobalVars = { styles: { fill_red: RED } };

    const result = finalizeDesign(nodes, globalVars, new Set());

    expect(result.nodes[0].fills).toBe("fill_red");
    expect(result.nodes[1].fills).toBe("fill_red");
    expect(result.globalVars.styles).toEqual({ fill_red: RED });
  });

  it("keeps a single-use named Figma style hoisted (design-system intent)", () => {
    const nodes = [node({ id: "1", type: "TEXT", textStyle: "Heading / Large" })];
    const globalVars: GlobalVars = { styles: { "Heading / Large": { fontSize: 24 } } };

    const result = finalizeDesign(nodes, globalVars, new Set(["Heading / Large"]));

    expect(result.nodes[0].textStyle).toBe("Heading / Large");
    expect(result.globalVars.styles).toEqual({ "Heading / Large": { fontSize: 24 } });
  });

  it("never inlines or drops inline-text-style (ts*) entries — they're referenced from text", () => {
    const nodes = [node({ id: "1", type: "TEXT", text: "a {ts1}b{/ts1}" })];
    const globalVars: GlobalVars = { styles: { ts1: { fontWeight: 700 } } };

    const result = finalizeDesign(nodes, globalVars, new Set());

    expect(result.globalVars.styles).toEqual({ ts1: { fontWeight: 700 } });
  });
});
