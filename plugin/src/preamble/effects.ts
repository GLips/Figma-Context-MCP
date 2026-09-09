// effects — the typed effect domain: build an WriteEffect from numeric inputs and map it to a plugin
// Effect[]. No CSS strings live here (css.ts owns those). Shared by two callers: the string parser
// (css.ts) and the effects() sugar.
//
// THE BLUR-RADIUS FACTOR (preserved from findings.md / figma-mcp's effects transformer): Figma's blur
// radius is ~2x the CSS blur() radius (a Figma blur of 32 renders as CSS blur(16px); read HALVES it). So
// a CSS-px blur becomes radius N*2. box-shadow blur is 1:1 (read emits the Figma radius directly), so it
// is NOT doubled — the asymmetry is real. The ×2 lives ONLY in the *FromCssPx constructors below, so a
// value that is already a Figma radius can never be double-doubled.

import { WriteEffect, WriteShadow, WriteBlur, WriteGlass, WriteNoise, WriteTexture, WriteProgressiveBlur, Rgba } from "./ir.js";

export interface ShadowParts {
  inner: boolean;
  color: Rgba;
  x: number;
  y: number;
  radius: number; // Figma radius, 1:1 with CSS box-shadow blur
  spread: number;
}

export function shadow(p: ShadowParts): WriteShadow {
  return { kind: "shadow", inner: p.inner, color: p.color, offset: { x: p.x, y: p.y }, radius: p.radius, spread: p.spread };
}

export function layerBlurFromCssPx(cssRadius: number): WriteBlur {
  return { kind: "blur", type: "LAYER_BLUR", radius: cssRadius * 2 };
}

export function backgroundBlurFromCssPx(cssRadius: number): WriteBlur {
  return { kind: "blur", type: "BACKGROUND_BLUR", radius: cssRadius * 2 };
}

// ---- Beyond-CSS effect builders. These take Figma-domain values verbatim (no CSS-px ×2 scaling — there
// is no CSS spelling to scale from). They own the `kind` tag and enum-casing so flcm.ts never hand-builds
// an WriteEffect literal.
//
// RANGE VALIDATION is delegated to the live runtime, which was probed (execute_code) to reject out-of-range
// values loudly — lightIntensity/refraction/dispersion 0–1 and noise density 0–1 all throw on set. The ONE
// exception is glass `depth`: the runtime SILENTLY CLAMPS depth < 1 up to 1 (verified: depth 0 read back as
// 1, no throw). Silent-clamp is a silent-wrong divergence (ADR-0003), so we guard depth ourselves below;
// every other bound is left to the runtime's loud rejection rather than duplicated here.

export type GlassParts = Omit<WriteGlass, "kind">;
export type TextureParts = Omit<WriteTexture, "kind">;
export type ProgressiveBlurParts = Omit<WriteProgressiveBlur, "kind">;
export interface NoiseParts {
  noiseType: "monotone" | "duotone" | "multitone";
  color: Rgba;
  noiseSize: number;
  density: number;
  secondaryColor?: Rgba; // duotone
  opacity?: number; // multitone
}

export function glass(p: GlassParts): WriteGlass {
  if (p.depth < 1) throw new Error(`flcm.effects: glass.depth must be >= 1 — got ${p.depth}. (Figma silently clamps a smaller depth to 1, so we reject it rather than surprise you.)`);
  return { kind: "glass", ...p };
}
export function texture(p: TextureParts): WriteTexture { return { kind: "texture", ...p }; }
export function progressiveBlur(p: ProgressiveBlurParts): WriteProgressiveBlur { return { kind: "progressiveBlur", ...p }; }

const NOISE_TYPES = { monotone: "MONOTONE", duotone: "DUOTONE", multitone: "MULTITONE" } as const;

export function noise(p: NoiseParts): WriteNoise {
  const noiseType = NOISE_TYPES[p.noiseType];
  if (!noiseType) throw new Error(`flcm.effects: noise.type must be monotone | duotone | multitone — got ${JSON.stringify(p.noiseType)}.`);
  return { kind: "noise", noiseType, color: p.color, noiseSize: p.noiseSize, density: p.density, secondaryColor: p.secondaryColor, opacity: p.opacity };
}

// WriteEffect[] -> plugin Effect[]. The bridge routes node.effects through here; the single typed->plugin
// boundary for effects, so the plugin-typings casts live here. Shadows carry blendMode; blurs do not.
//
// FAIL-LOUD RUNTIME GUARD: the beyond-CSS effects (glass/noise/texture/progressive blur) exist in
// plugin-typings@1.130.0 but the *running* Figma may predate them. We do NOT swallow — the bridge assigns
// node.effects directly, so a runtime that doesn't recognize a type throws on set, surfacing loudly. Never
// wrap this in a try/catch that degrades to a no-op.
//
// NOISE.blendMode is DELIBERATELY OMITTED: it's in the 1.130.0 typing but the live runtime (apiVersion
// 1.0.0, verified via execute_code) rejects it — `set_effects … Unrecognized key(s): 'blendMode'`. Emitting
// it would make every noise effect fail loud, so we ground on the fields the runtime accepts.
export function toFigmaEffects(effects: WriteEffect[]): Effect[] {
  return effects.map((effect) => {
    switch (effect.kind) {
      case "shadow":
        return {
          type: effect.inner ? "INNER_SHADOW" : "DROP_SHADOW",
          color: effect.color,
          offset: effect.offset,
          radius: effect.radius,
          spread: effect.spread,
          visible: true,
          blendMode: "NORMAL",
        } as Effect;
      case "blur":
        return { type: effect.type, radius: effect.radius, visible: true } as Effect;
      case "glass":
        return {
          type: "GLASS",
          lightIntensity: effect.lightIntensity,
          lightAngle: effect.lightAngle,
          refraction: effect.refraction,
          depth: effect.depth,
          dispersion: effect.dispersion,
          radius: effect.radius,
          visible: true,
        } as Effect;
      case "noise":
        return {
          type: "NOISE",
          noiseType: effect.noiseType,
          color: effect.color,
          noiseSize: effect.noiseSize,
          density: effect.density,
          ...(effect.secondaryColor ? { secondaryColor: effect.secondaryColor } : {}),
          ...(effect.opacity != null ? { opacity: effect.opacity } : {}),
          visible: true,
        } as Effect;
      case "texture":
        return { type: "TEXTURE", noiseSize: effect.noiseSize, radius: effect.radius, clipToShape: effect.clipToShape, visible: true } as Effect;
      case "progressiveBlur":
        return {
          type: "LAYER_BLUR",
          blurType: "PROGRESSIVE",
          radius: effect.radius,
          startRadius: effect.startRadius,
          startOffset: effect.startOffset,
          endOffset: effect.endOffset,
          visible: true,
        } as Effect;
      default:
        // A new WriteEffect kind without a case fails to compile here; a bogus kind reaching us at
        // runtime (normalizeEffects forwards agent-passed WriteEffect[] unvalidated) throws loud rather
        // than emitting an undefined Effect.
        effect satisfies never;
        throw new Error("flcm.effects: unknown effect kind " + JSON.stringify(effect));
    }
  });
}
