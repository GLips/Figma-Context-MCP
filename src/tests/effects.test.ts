import { describe, expect, it } from "vitest";
import { buildSimplifiedEffects } from "~/transformers/effects.js";
import type { Node as FigmaNode } from "@figma/rest-api-spec";

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
