import { describe, it, expect } from "vitest";
import type { SimplifiedDesign } from "@framelink/core";
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
            fill: { type: "IMAGE", imageRef, ...(gifRef ? { gifRef } : {}), scaleMode: "FILL" },
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
        nodes: [{ id: "1", name: "Swatch", type: "RECTANGLE", fill: hex }],
      } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(withColor("#000000"))).not.toEqual(parityView(withColor("#FFFFFF")));
  });

  it("compares the components sidecar — it is core output now, not envelope provenance (pin 2)", () => {
    // The REST-only components/componentSets tables retired: both producers fold the same
    // provenance onto their nodes and the core builds ONE sidecar. So a populated sidecar and
    // an empty one are a real divergence, where the old tables were forgiven.
    const rich = design({
      components: { "1:1": { type: "COMPONENT", key: "libkey", name: "Card" } },
    } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(rich)).not.toEqual(parityView(design({})));
  });

  it("expands style refs inside a sidecar entry's children, like any other node", () => {
    const entry = (fill: string, styles: Record<string, string> = {}) =>
      design({
        components: {
          "1:1": {
            type: "COMPONENT",
            name: "Card",
            children: [{ id: "1:2", name: "Label", type: "TEXT", fill }],
          },
        },
        styles,
      } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(entry("fill_abc", { fill_abc: "#123456" }))).toEqual(
      parityView(entry("#123456")),
    );
  });

  it("compares a definition's propertyDefinitions, now that they live in the sidecar", () => {
    const withDefs = (defaultValue: string) =>
      design({
        components: {
          "1:1": {
            type: "COMPONENT_SET",
            name: "Button",
            propertyDefinitions: {
              Variant: { type: "variant", defaultValue, variantOptions: ["Primary", "Secondary"] },
            },
          },
        },
      } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(withDefs("Primary"))).toEqual(parityView(withDefs("Primary")));
    expect(parityView(withDefs("Primary"))).not.toEqual(parityView(withDefs("Secondary")));
  });

  it("expands a hoisted style ref so it matches the same value inlined", () => {
    const hoisted = design({
      nodes: [{ id: "1", name: "T", type: "TEXT", fill: "fill_abc" }],
      styles: { fill_abc: "#123456" },
    } as unknown as Partial<SimplifiedDesign>);
    const inlined = design({
      nodes: [{ id: "1", name: "T", type: "TEXT", fill: "#123456" }],
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
      templates: { "EL-x": { type: "FRAME", fill: "#FFFFFF" } },
    } as unknown as Partial<SimplifiedDesign>);
    const inline = design({
      nodes: [
        { id: "1", name: "a", type: "FRAME", fill: "#FFFFFF" },
        { id: "2", name: "b", type: "FRAME", fill: "#FFFFFF" },
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

  it("forgives only the MEASUREMENT in the degenerate band, never the sizing word", () => {
    // The band costs REST the solved number. It does not cost either producer the
    // fill/hug/contextual word, which is read off the sizing flags — forgiving that
    // would let a real sizing-intent divergence hide behind a 45deg rotation.
    const chip = (width: unknown, extra: Record<string, unknown> = {}) =>
      design({
        nodes: [
          { id: "1", name: "Chip", type: "FRAME", rotation: -45, width, height: 20, ...extra },
        ],
      } as unknown as Partial<SimplifiedDesign>);

    expect(parityView(chip(56.57))).toEqual(parityView(chip(60)));
    expect(parityView(chip("fill"))).not.toEqual(parityView(chip("hug")));
    expect(parityView(chip("fill"))).not.toEqual(parityView(chip(60)));
    // designedWidth/Height and aspectRatio are the same solved size in other clothing —
    // a string, and its two axes divided — so they go with the numbers.
    expect(parityView(chip("contextual", { designedWidth: "56.57px" }))).toEqual(
      parityView(chip("contextual", { designedWidth: "60px" })),
    );
    expect(parityView(chip(56.57, { aspectRatio: 1 }))).toEqual(
      parityView(chip(60, { aspectRatio: 3 })),
    );
  });

  it("accumulates emitted group rotations into the child's degenerate band", () => {
    const inGroup = (childWidth: number) =>
      design({
        nodes: [
          {
            id: "1",
            name: "Tilted Group",
            type: "GROUP",
            rotation: -25,
            children: [
              {
                id: "2",
                name: "Skew Tile",
                type: "FRAME",
                rotation: -20,
                width: childWidth,
                height: 20,
              },
            ],
          },
        ],
      } as unknown as Partial<SimplifiedDesign>);

    // -25 + -20 = -45: REST cannot recover this child's own size.
    expect(parityView(inGroup(80))).toEqual(parityView(inGroup(88)));
  });

  it("ignores the top-level design name (provenance metadata)", () => {
    expect(parityView(design({ name: "From REST" }))).toEqual(
      parityView(design({ name: "From plugin" })),
    );
  });
});
