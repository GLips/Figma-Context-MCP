import type { NodeSnapshot, SnapshotColor, SnapshotEffect, SnapshotVector } from "../snapshot.js";
import { formatRGBAColor, formatSolidColor } from "./style.js";
import { pixelRound } from "../utils.js";

/** Object form of the beyond-CSS effects — read == create (each mirrors its flcm.effects sugar). */
export interface SimplifiedGlass {
  lightIntensity: number;
  lightAngle: number;
  refraction: number;
  depth: number;
  dispersion: number;
  radius: number;
}
export interface SimplifiedNoise {
  type: "monotone" | "duotone" | "multitone";
  color: string;
  noiseSize: number;
  density: number;
  secondaryColor?: string;
  opacity?: number;
}
export interface SimplifiedTexture {
  noiseSize: number;
  radius: number;
  clipToShape: boolean;
}
export interface SimplifiedProgressiveBlur {
  startRadius: number;
  endRadius: number;
  startOffset: { x: number; y: number };
  endOffset: { x: number; y: number };
}

/** CSS-representable effects: shadow → boxShadow/textShadow, blur → filter/backdropFilter. */
interface CssEffects {
  boxShadow?: string;
  filter?: string;
  backdropFilter?: string;
  textShadow?: string;
}

/**
 * The beyond-CSS effects — no CSS spelling, so they read back as the flcm.effects({...}) OBJECT form
 * (ADR-0002 symmetry: read object-form == create object-form). Split out from the CSS half so the two
 * effect vocabularies stay a structural distinction.
 */
interface BeyondCssEffects {
  glass?: SimplifiedGlass;
  noise?: SimplifiedNoise;
  texture?: SimplifiedTexture;
  progressiveBlur?: SimplifiedProgressiveBlur;
}

export type SimplifiedEffects = CssEffects & BeyondCssEffects;
export type BeyondCssEffect = keyof BeyondCssEffects;

// The runtime enumerable of the beyond-CSS set — a ratified Phase 5 Done-when ("the non-CSS effect set is
// enumerable in code"), for the edit plan and future read tooling that must tell the two effect vocabularies
// apart. LOOKS UNUSED: nothing in this repo iterates it yet — its consumers land with the edit surface —
// so don't cut it as dead code; it's the public handle on the set. Derived from a Record over
// BeyondCssEffect, so adding/removing an effect on the type forces this table to match in BOTH directions
// (a missing key fails the Record, an extra key isn't a BeyondCssEffect) — the set can't silently drift.
const BEYOND_CSS_EFFECT_TABLE: Record<BeyondCssEffect, true> = {
  glass: true,
  noise: true,
  texture: true,
  progressiveBlur: true,
};
export const BEYOND_CSS_EFFECTS = Object.keys(BEYOND_CSS_EFFECT_TABLE) as BeyondCssEffect[];

// Per-effect narrowing aliases. Each Figma effect type always carries its own fields (create always sets
// them and the live runtime carries them), but the snapshot types them optional to share one bag across
// every effect. The type-predicate `find`s below assert the fields for a matched type — the same pattern
// SnapshotShadowEffect uses — so the simplifiers read total inputs instead of papering over the optionality
// with `?? 0` (which would silently emit a wrong explicit value, e.g. a `0` angle, if a field were absent).
type SnapshotShadowEffect = SnapshotEffect & { offset: SnapshotVector; color: SnapshotColor };
type SnapshotGlassEffect = SnapshotEffect & {
  lightIntensity: number;
  lightAngle: number;
  refraction: number;
  depth: number;
  dispersion: number;
};
type SnapshotNoiseEffect = SnapshotEffect & {
  noiseType: "MONOTONE" | "DUOTONE" | "MULTITONE";
  color: SnapshotColor;
  noiseSize: number;
  density: number;
};
type SnapshotTextureEffect = SnapshotEffect & { noiseSize: number; clipToShape: boolean };
type SnapshotProgressiveEffect = SnapshotEffect & {
  startRadius: number;
  startOffset: SnapshotVector;
  endOffset: SnapshotVector;
};

export function buildSimplifiedEffects(n: NodeSnapshot): SimplifiedEffects {
  if (!n.effects) return {};
  const effects = n.effects.filter((e) => e.visible);

  // Handle drop and inner shadows (both go into CSS box-shadow)
  const dropShadows = effects
    .filter((e): e is SnapshotShadowEffect => e.type === "DROP_SHADOW")
    .map(simplifyDropShadow);

  const innerShadows = effects
    .filter((e): e is SnapshotShadowEffect => e.type === "INNER_SHADOW")
    .map(simplifyInnerShadow);

  const boxShadow = [...dropShadows, ...innerShadows].join(", ");

  // Handle blur effects - separate by CSS property. A zero-radius blur is a
  // no-op, so drop it entirely rather than emit a dead `blur(0px)`. A PROGRESSIVE
  // blur (of EITHER kind — the runtime allows a progressive BACKGROUND_BLUR too)
  // is beyond-CSS (handled below), so both plain-blur paths exclude it rather than
  // flatten it into a plain, wrong `blur()` at half the radius.
  // Layer blurs use the CSS 'filter' property
  const filterBlurValues = effects
    .filter((e) => e.type === "LAYER_BLUR" && e.blurType !== "PROGRESSIVE" && e.radius > 0)
    .map(simplifyBlur)
    .join(" ");

  // Background blurs use the CSS 'backdrop-filter' property
  const backdropFilterValues = effects
    .filter((e) => e.type === "BACKGROUND_BLUR" && e.blurType !== "PROGRESSIVE" && e.radius > 0)
    .map(simplifyBlur)
    .join(" ");

  const result: SimplifiedEffects = {};

  if (boxShadow) {
    if (n.type === "TEXT") {
      result.textShadow = boxShadow;
    } else {
      result.boxShadow = boxShadow;
    }
  }
  if (filterBlurValues) result.filter = filterBlurValues;
  if (backdropFilterValues) result.backdropFilter = backdropFilterValues;

  // Beyond-CSS effects — the object form. Each is singular in the sugar (one glass, one noise, …), so we
  // emit the first visible occurrence of each type; a design that stacks two of the same reads back the
  // first (the write surface can't author two anyway).
  const glass = effects.find((e): e is SnapshotGlassEffect => e.type === "GLASS");
  if (glass) result.glass = simplifyGlass(glass);

  const noise = effects.find((e): e is SnapshotNoiseEffect => e.type === "NOISE");
  if (noise) result.noise = simplifyNoise(noise);

  const texture = effects.find((e): e is SnapshotTextureEffect => e.type === "TEXTURE");
  if (texture) result.texture = simplifyTexture(texture);

  // Keyed off `blurType` alone — only blur effects carry it, and a PROGRESSIVE blur reads as the object
  // form whether it's a LAYER_BLUR or a BACKGROUND_BLUR (both are typed progressive). The create surface
  // only authors the LAYER_BLUR variant, so a background-progressive re-creates as a layer one — a
  // create-side limitation for the edit plan, still far more faithful than a halved plain CSS blur.
  const progressive = effects.find(
    (e): e is SnapshotProgressiveEffect => e.blurType === "PROGRESSIVE",
  );
  if (progressive) result.progressiveBlur = simplifyProgressiveBlur(progressive);

  return result;
}

// The beyond-CSS radii/values are RAW Figma-domain — no CSS-px halving (see simplifyBlur / effects.ts:
// the ×2 factor is a CSS-blur-only artifact).
function simplifyGlass(e: SnapshotGlassEffect): SimplifiedGlass {
  return {
    lightIntensity: e.lightIntensity,
    lightAngle: e.lightAngle,
    refraction: e.refraction,
    depth: e.depth,
    dispersion: e.dispersion,
    radius: e.radius,
  };
}

// Figma spells the noise type in uppercase; the sugar takes the lowercase word.
const NOISE_TYPE: Record<SnapshotNoiseEffect["noiseType"], SimplifiedNoise["type"]> = {
  MONOTONE: "monotone",
  DUOTONE: "duotone",
  MULTITONE: "multitone",
};

function simplifyNoise(e: SnapshotNoiseEffect): SimplifiedNoise {
  const noise: SimplifiedNoise = {
    type: NOISE_TYPE[e.noiseType],
    color: formatSolidColor(e.color),
    noiseSize: e.noiseSize,
    density: e.density,
  };
  if (e.secondaryColor) noise.secondaryColor = formatSolidColor(e.secondaryColor);
  if (e.opacity != null) noise.opacity = e.opacity;
  return noise;
}

function simplifyTexture(e: SnapshotTextureEffect): SimplifiedTexture {
  return { noiseSize: e.noiseSize, radius: e.radius, clipToShape: e.clipToShape };
}

function simplifyProgressiveBlur(e: SnapshotProgressiveEffect): SimplifiedProgressiveBlur {
  return {
    startRadius: e.startRadius,
    endRadius: e.radius,
    startOffset: e.startOffset,
    endOffset: e.endOffset,
  };
}

function simplifyDropShadow(effect: SnapshotShadowEffect) {
  return `${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${effect.spread ?? 0}px ${formatRGBAColor(effect.color)}`;
}

function simplifyInnerShadow(effect: SnapshotShadowEffect) {
  return `inset ${effect.offset.x}px ${effect.offset.y}px ${effect.radius}px ${effect.spread ?? 0}px ${formatRGBAColor(effect.color)}`;
}

function simplifyBlur(effect: SnapshotEffect) {
  // Figma's blur radius is ~2x the CSS blur() radius — verified by direct CSS
  // test and corroborated by Figma's own Dev Mode output (a Figma blur of 32
  // renders as CSS blur(16px)). Halve it so the emitted value matches CSS.
  return `blur(${pixelRound(effect.radius / 2)}px)`;
}
