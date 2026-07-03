import { describe, it, expect } from "vitest";
import type { SimplifiedDesign } from "~/core/types.js";
import { parityView } from "./shared-subset.js";

/**
 * Direct tests of the comparator policy — the semantic core of the harness.
 * These pin each "legitimate difference" rule (equal views) and guard the floor
 * (a real difference in a shared field must NOT reduce away).
 */

// Minimal design builder — the fields parityView reads; cast past the full
// SimplifiedNode shape so tests stay to the point.
function design(parts: Partial<SimplifiedDesign>): SimplifiedDesign {
  return {
    name: "test",
    nodes: [],
    components: {},
    componentSets: {},
    styles: {},
    templates: {},
    ...parts,
  } as SimplifiedDesign;
}

describe("parityView comparator policy", () => {
  it("collapses differing image refs to the same view (compare by presence)", () => {
    const withRef = (imageRef: string, gifRef: string) =>
      design({
        nodes: [
          {
            id: "1",
            name: "Photo",
            type: "RECTANGLE",
            fills: [{ type: "IMAGE", imageRef, gifRef, scaleMode: "FILL" }],
          },
        ],
      } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(withRef("rest-abc", "rest-gif"))).toEqual(
      parityView(withRef("plugin-xyz", "plugin-gif")),
    );
  });

  it("does NOT collapse a difference in a real fill color (shared field floor)", () => {
    const withColor = (hex: string) =>
      design({
        nodes: [{ id: "1", name: "Swatch", type: "RECTANGLE", fills: [hex] }],
      } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(withColor("#000000"))).not.toEqual(parityView(withColor("#FFFFFF")));
  });

  it("reduces component/componentSet tables to id → propertyDefinitions", () => {
    const propertyDefinitions = { Title: { type: "text", defaultValue: "x" } };
    const rich = design({
      components: {
        "1:1": {
          id: "1:1",
          key: "libkey",
          name: "Card",
          componentSetId: "9:9",
          propertyDefinitions,
        },
      },
    } as unknown as Partial<SimplifiedDesign>);
    // Same semantics, different provenance: no publish key/name, and assembled
    // into componentSets rather than components.
    const lean = design({
      componentSets: { "1:1": { id: "1:1", propertyDefinitions } },
    } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(rich)).toEqual(parityView(lean));
  });

  it("drops envelope-only components with no shared propertyDefinitions", () => {
    // REST lists every component in the response envelope, including ones the
    // core walk never produces (variant/instance-swap-only props, or a master on
    // another page) — those carry no propertyDefinitions. The plugin producer,
    // which builds its table from the walk alone, can't produce them, so they
    // must scope away rather than fail parity on table membership.
    const withEnvelopeOnly = design({
      components: {
        "1:1": {
          id: "1:1",
          key: "k",
          name: "Card",
          propertyDefinitions: { P: { type: "boolean", defaultValue: true } },
        },
        "2:2": { id: "2:2", key: "k2", name: "Off-page master" }, // no propertyDefinitions
      },
    } as unknown as Partial<SimplifiedDesign>);
    const walkOnly = design({
      components: {
        "1:1": { id: "1:1", propertyDefinitions: { P: { type: "boolean", defaultValue: true } } },
      },
    } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(withEnvelopeOnly)).toEqual(parityView(walkOnly));
  });

  it("expands a hoisted style ref so it matches the same value inlined", () => {
    const hoisted = design({
      nodes: [{ id: "1", name: "T", type: "TEXT", fills: "fill_abc" }],
      styles: { fill_abc: ["#123456"] },
    } as unknown as Partial<SimplifiedDesign>);
    const inlined = design({
      nodes: [{ id: "1", name: "T", type: "TEXT", fills: ["#123456"] }],
    } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(hoisted)).toEqual(parityView(inlined));
  });

  it("erases same-name style disambiguation by resolving refs to values", () => {
    // Two producers hoist the same value under different keys (one plain name,
    // one id-disambiguated). After expansion the keys are gone; values match.
    const plainKey = design({
      nodes: [{ id: "1", name: "H", type: "TEXT", textStyle: "Heading / Large" }],
      styles: { "Heading / Large": { fontSize: 14 } },
    } as unknown as Partial<SimplifiedDesign>);
    const suffixedKey = design({
      nodes: [{ id: "1", name: "H", type: "TEXT", textStyle: "Heading / Large (161:300)" }],
      styles: { "Heading / Large (161:300)": { fontSize: 14 } },
    } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(plainKey)).toEqual(parityView(suffixedKey));
  });

  it("expands element templates so they match the fully-inlined bodies", () => {
    const templated = design({
      nodes: [
        { id: "1", name: "a", template: "EL-x" },
        { id: "2", name: "b", template: "EL-x" },
      ],
      templates: { "EL-x": { type: "FRAME", fills: ["#FFFFFF"] } },
    } as unknown as Partial<SimplifiedDesign>);
    const inline = design({
      nodes: [
        { id: "1", name: "a", type: "FRAME", fills: ["#FFFFFF"] },
        { id: "2", name: "b", type: "FRAME", fills: ["#FFFFFF"] },
      ],
    } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(templated)).toEqual(parityView(inline));
  });

  it("ignores the top-level design name (provenance metadata)", () => {
    expect(parityView(design({ name: "From REST" }))).toEqual(
      parityView(design({ name: "From plugin" })),
    );
  });
});
