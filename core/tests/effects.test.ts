import { describe, expect, it } from "vitest";
import { buildSimplifiedEffects } from "../src/transformers/effects.js";
import type { NodeSnapshot } from "../src/snapshot.js";

// Only the effects array is read; cast through unknown like the other walker tests.
function nodeWithEffects(effects: unknown[]): NodeSnapshot {
  return { type: "FRAME", effects } as unknown as NodeSnapshot;
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

// Beyond-CSS effects have no CSS spelling, so they read back as the flcm.effects({...}) object form (read
// == create). Raw Figma-domain values — no CSS-px halving. These pin the core's emission; the plugin's
// get.test.ts pins the full create-sugar → read round-trip through the live-ish path.
describe("buildSimplifiedEffects — beyond-CSS object form", () => {
  it("emits glass as the object form, radius unscaled", () => {
    const result = buildSimplifiedEffects(
      nodeWithEffects([
        {
          type: "GLASS",
          visible: true,
          lightIntensity: 0.5,
          lightAngle: 130,
          refraction: 0.25,
          depth: 12,
          dispersion: 0.08,
          radius: 4,
        },
      ]),
    );
    expect(result.glass).toEqual({
      lightIntensity: 0.5,
      lightAngle: 130,
      refraction: 0.25,
      depth: 12,
      dispersion: 0.08,
      radius: 4,
    });
  });

  it("emits noise with a lowercased type and a CSS color; secondary/opacity only when present", () => {
    const monotone = buildSimplifiedEffects(
      nodeWithEffects([
        {
          type: "NOISE",
          visible: true,
          noiseType: "MONOTONE",
          color: { r: 0, g: 0, b: 0, a: 0.4 },
          noiseSize: 1,
          density: 0.2,
        },
      ]),
    );
    expect(monotone.noise).toEqual({
      type: "monotone",
      color: "rgba(0, 0, 0, 0.4)",
      noiseSize: 1,
      density: 0.2,
    });

    const duotone = buildSimplifiedEffects(
      nodeWithEffects([
        {
          type: "NOISE",
          visible: true,
          noiseType: "DUOTONE",
          color: { r: 1, g: 1, b: 1, a: 1 },
          secondaryColor: { r: 0, g: 0, b: 0, a: 1 },
          opacity: 0.5,
          noiseSize: 2,
          density: 0.3,
        },
      ]),
    );
    expect(duotone.noise).toEqual({
      type: "duotone",
      color: "#FFFFFF",
      secondaryColor: "#000000",
      opacity: 0.5,
      noiseSize: 2,
      density: 0.3,
    });
  });

  it("emits texture as the object form", () => {
    const result = buildSimplifiedEffects(
      nodeWithEffects([
        { type: "TEXTURE", visible: true, noiseSize: 3, radius: 6, clipToShape: true },
      ]),
    );
    expect(result.texture).toEqual({ noiseSize: 3, radius: 6, clipToShape: true });
  });

  it("emits a progressive layer blur as the object form, never as a CSS filter", () => {
    const result = buildSimplifiedEffects(
      nodeWithEffects([
        {
          type: "LAYER_BLUR",
          blurType: "PROGRESSIVE",
          visible: true,
          radius: 20,
          startRadius: 0,
          startOffset: { x: 0, y: 0 },
          endOffset: { x: 0, y: 1 },
        },
      ]),
    );
    expect(result.progressiveBlur).toEqual({
      startRadius: 0,
      endRadius: 20,
      startOffset: { x: 0, y: 0 },
      endOffset: { x: 0, y: 1 },
    });
    // A progressive blur must not leak into the plain CSS filter path.
    expect(result.filter).toBeUndefined();
  });

  // A progressive blur can carry type BACKGROUND_BLUR too (typed in plugin-typings). It must read as the
  // object form, NOT leak into the plain backdrop-filter path at a halved radius.
  it("emits a progressive background blur as the object form, never as backdrop-filter", () => {
    const result = buildSimplifiedEffects(
      nodeWithEffects([
        {
          type: "BACKGROUND_BLUR",
          blurType: "PROGRESSIVE",
          visible: true,
          radius: 30,
          startRadius: 4,
          startOffset: { x: 0, y: 0 },
          endOffset: { x: 1, y: 0 },
        },
      ]),
    );
    expect(result.progressiveBlur).toEqual({
      startRadius: 4,
      endRadius: 30,
      startOffset: { x: 0, y: 0 },
      endOffset: { x: 1, y: 0 },
    });
    expect(result.backdropFilter).toBeUndefined();
  });

  // A plain (non-progressive) layer blur is unaffected by the progressive carve-out.
  it("still emits a plain layer blur as a CSS filter", () => {
    const result = buildSimplifiedEffects(
      nodeWithEffects([{ type: "LAYER_BLUR", radius: 32, visible: true }]),
    );
    expect(result.filter).toBe("blur(16px)");
    expect(result.progressiveBlur).toBeUndefined();
  });
});
