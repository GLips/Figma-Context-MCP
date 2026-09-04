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
    const withRef = (imageRef: string, gifRef?: string) =>
      design({
        nodes: [
          {
            id: "1",
            name: "Photo",
            type: "RECTANGLE",
            fills: [{ type: "IMAGE", imageRef, ...(gifRef ? { gifRef } : {}), scaleMode: "FILL" }],
          },
        ],
      } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(withRef("rest-abc", "rest-gif"))).toEqual(
      parityView(withRef("plugin-xyz", "plugin-gif")),
    );
    // gifRef presence itself is producer-specific (the plugin can't see gif
    // refs), so a REST-only gifRef must scope away entirely.
    expect(parityView(withRef("rest-abc", "rest-gif"))).toEqual(parityView(withRef("plugin-xyz")));
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

  it("forgives the degenerate 45deg band on the node and its children's origin", () => {
    // REST can't invert a 45deg node's AABB, so it emits the square shadow's
    // numbers where the plugin reports the authored box — and the child's origin
    // is measured from a corner REST never placed.
    const chip = (own: Record<string, number>, label: Record<string, number>) =>
      design({
        nodes: [
          {
            id: "1",
            name: "Chip",
            type: "FRAME",
            rotation: -45,
            ...own,
            children: [
              {
                id: "2",
                name: "Label",
                type: "FRAME",
                rotation: 45,
                width: 20,
                height: 8,
                ...label,
              },
            ],
          },
        ],
      } as unknown as Partial<SimplifiedDesign>);

    const rest = chip(
      { width: 56.57, height: 56.57, left: 220, top: 37.57 },
      { left: 8.49, top: 42.43 },
    );
    const plugin = chip({ width: 60, height: 20, left: 220, top: 80 }, { left: 6, top: 6 });
    expect(parityView(rest)).toEqual(parityView(plugin));
  });

  it("does NOT forgive a size difference on a rotated node outside the band", () => {
    // 15deg inverts cleanly, so the producers have no excuse. Same for a child
    // that rotates back square with the page: only its ORIGIN is unrecoverable
    // under a degenerate parent, never its size.
    const card = (width: number) =>
      design({
        nodes: [{ id: "1", name: "Card", type: "FRAME", rotation: -15, width, height: 24 }],
      } as unknown as Partial<SimplifiedDesign>);
    expect(parityView(card(40))).not.toEqual(parityView(card(44.85)));

    const labelUnderChip = (width: number) =>
      design({
        nodes: [
          {
            id: "1",
            name: "Chip",
            type: "FRAME",
            rotation: -45,
            children: [{ id: "2", name: "Label", type: "FRAME", rotation: 45, width, height: 8 }],
          },
        ],
      } as unknown as Partial<SimplifiedDesign>);
    expect(parityView(labelUnderChip(20))).not.toEqual(parityView(labelUnderChip(28.28)));
  });

  it("forgives a half-turn's origin but never its size", () => {
    // REST can't tell a half-turn from a horizontal flip, so it withholds the
    // corner — but the size inverts fine at 180deg, so that still has to match.
    const flipped = (left: number, top: number, width = 50) =>
      design({
        nodes: [
          {
            id: "1",
            name: "Upside Down",
            type: "FRAME",
            rotation: -180,
            width,
            height: 30,
            left,
            top,
          },
        ],
      } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(flipped(250, 170))).toEqual(parityView(flipped(300, 200)));
    expect(parityView(flipped(250, 170, 50))).not.toEqual(parityView(flipped(250, 170, 62)));
  });

  it("ignores the top-level design name (provenance metadata)", () => {
    expect(parityView(design({ name: "From REST" }))).toEqual(
      parityView(design({ name: "From plugin" })),
    );
  });
});
