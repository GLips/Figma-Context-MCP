import { describe, expect, it } from "vitest";
import { buildSimplifiedEffects } from "~/transformers/effects.js";
import type { DropShadowEffect, InnerShadowEffect, Node as FigmaNode } from "@figma/rest-api-spec";

// Only the effects array is read; cast through unknown like the other walker tests.
function nodeWithEffects(effects: unknown[]): FigmaNode {
  return { type: "FRAME", effects } as unknown as FigmaNode;
}

describe("buildSimplifiedEffects — blur", () => {
  // Figma's blur radius is ~2x the CSS blur() radius, so a Figma 32 must render
  // as blur(16px). Covers both the layer-blur (filter) and background-blur
  // (backdrop-filter) paths.
  it("halves a layer blur radius onto the CSS filter property", () => {
    const result = buildSimplifiedEffects(
      nodeWithEffects([{ type: "LAYER_BLUR", radius: 32, visible: true }]),
    );
    expect(result.filter).toBe("blur(16px)");
  });

  it("halves a background blur radius onto the CSS backdrop-filter property", () => {
    const result = buildSimplifiedEffects(
      nodeWithEffects([{ type: "BACKGROUND_BLUR", radius: 32, visible: true }]),
    );
    expect(result.backdropFilter).toBe("blur(16px)");
  });

  // A zero-radius blur is a no-op; emitting blur(0px) is dead output.
  it("omits a zero-radius blur entirely", () => {
    const result = buildSimplifiedEffects(
      nodeWithEffects([
        { type: "LAYER_BLUR", radius: 0, visible: true },
        { type: "BACKGROUND_BLUR", radius: 0, visible: true },
      ]),
    );
    expect(result.filter).toBeUndefined();
    expect(result.backdropFilter).toBeUndefined();
  });
});

describe("buildSimplifiedEffects — shadows", () => {
  const dropShadow: DropShadowEffect = {
    type: "DROP_SHADOW",
    showShadowBehindNode: false,
    visible: true,
    blendMode: "NORMAL",
    color: { r: 0, g: 0, b: 0, a: 0.5 },
    offset: { x: 2, y: 3 },
    radius: 4,
  };
  const innerShadow: InnerShadowEffect = {
    ...dropShadow,
    type: "INNER_SHADOW",
    spread: 2,
  };

  it.each([undefined, 0, 5])("omits spread %s from CSS text-shadow", (spread) => {
    const node = {
      ...nodeWithEffects([{ ...dropShadow, spread }]),
      type: "TEXT",
    } as FigmaNode;

    expect(buildSimplifiedEffects(node)).toEqual({
      textShadow: "2px 3px 4px rgba(0, 0, 0, 0.5)",
    });
  });

  it("keeps visible text drop shadows without an unsupported inset entry", () => {
    const node = {
      ...nodeWithEffects([
        dropShadow,
        innerShadow,
        { ...dropShadow, visible: false },
        { ...dropShadow, offset: { x: -2, y: -3 }, radius: 0 },
      ]),
      type: "TEXT",
    } as FigmaNode;

    expect(buildSimplifiedEffects(node)).toEqual({
      textShadow: "2px 3px 4px rgba(0, 0, 0, 0.5), -2px -3px 0px rgba(0, 0, 0, 0.5)",
    });
  });

  it("omits unsupported text inner shadows without dropping blur effects", () => {
    const node = {
      ...nodeWithEffects([innerShadow, { type: "LAYER_BLUR", radius: 8, visible: true }]),
      type: "TEXT",
    } as FigmaNode;

    expect(buildSimplifiedEffects(node)).toEqual({ filter: "blur(4px)" });
  });

  it("preserves spread and inset for non-text box shadows", () => {
    expect(
      buildSimplifiedEffects(nodeWithEffects([{ ...dropShadow, spread: 5 }, innerShadow])),
    ).toEqual({
      boxShadow: "2px 3px 4px 5px rgba(0, 0, 0, 0.5), inset 2px 3px 4px 2px rgba(0, 0, 0, 0.5)",
    });
  });
});
