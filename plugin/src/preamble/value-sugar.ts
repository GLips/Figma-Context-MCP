/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// value-sugar — the public value verbs (flcm.gradient, flcm.image, flcm.effects) and the effects
// sugar the `effects` word accepts. Each returns a plain typed value an author passes as a word.

import { keySet, wordsOf, WORD_GROUPS, NESTED_WORDS, WORD_VALUES } from "./vocabulary.js";
import { WritePaint, GradientStop, WriteEffect, WriteCssEffects } from "./ir.js";
import { linearGradient, radialGradient } from "./paint.js";
import { layerBlurFromCssPx, backgroundBlurFromCssPx, shadow, glass, noise, texture, progressiveBlur } from "./effects.js";
import { parseColor, parseImageAdjustments, parseCssEffects, length, percent } from "./css.js";
import { rejectUnknownKeys, words } from "./validate.js";
import { FlcmError } from "./flcm-error.js";

// The authoring surface (verb Props + gradient/effects sugar) is defined ONCE in schema.ts as zod schemas
// with per-field docs; these are the z.infer'd types. Imported `import type` ONLY so schema.ts's zod is
// erased by esbuild and never reaches the sandbox bundle. Change a prop by editing the schema, not here.
import type {
  ImageOpts, EffectsInput, GradientSugar, GradientStopInput, EffectsSugar, ShadowSugar, BlurSugar, GlassSugar,
  NoiseSugar, TextureSugar, ProgressiveBlurSugar,
} from "./schema.js";

const IMAGE_KEYS = wordsOf(["image"]);
const GRADIENT_KEYS = wordsOf(["gradient"]);
const EFFECTS_KEYS = wordsOf(["effects"]);
// The CSS-effects bag (WriteCssEffects) — the string form of `effects`, routed to parseCssEffects. This
// ONE list drives both the is-this-CSS detection and the reject (normalizeEffects).
const CSS_EFFECTS_KEYS = keySet(NESTED_WORDS.cssEffects);
// The `effects:` prop accepts EITHER vocabulary in one bag, so its closed set is the union — the reject
// has to run before the split, or a typo lands in whichever half claims it and gets named by that half's
// gate instead of by `effects` (which is where the author wrote it).
const EFFECTS_INPUT_KEYS = keySet(WORD_GROUPS.effects, NESTED_WORDS.cssEffects);

// ---- gradient() sugar: a structured bag -> typed WritePaint (no string round-trip). The transform math
// lives in paint.ts, shared with css.ts's gradient-string parser, so sugar and hand-written CSS agree.
// GradientSugar / GradientStopInput are defined in schema.ts (the authoring-surface source). ----

function gradient(a: GradientSugar | "linear" | "radial", b?: GradientStopInput[], c?: number): WritePaint {
  // Only the object form carries author-supplied keys to check; the positional form builds a closed bag.
  if (a && typeof a === "object") rejectUnknownKeys(a, GRADIENT_KEYS, "flcm.gradient");
  const sugar: GradientSugar = a && typeof a === "object" ? a : { type: a, stops: b, angle: c };
  const stops = gradientStops(sugar.stops);
  const type = sugar.type || "linear";
  if (type === "linear") return linearGradient(typeof sugar.angle === "number" ? sugar.angle : 180, stops);
  if (type === "radial") {
    const x = sugar.at && sugar.at.x != null ? sugar.at.x : 50;
    const y = sugar.at && sugar.at.y != null ? sugar.at.y : 50;
    return radialGradient("GRADIENT_RADIAL", x, y, stops);
  }
  throw new FlcmError("authoring", 'type must be "linear" or "radial" — got ' + JSON.stringify(sugar.type) + ".", { call: "flcm.gradient" });
}

// stops: ['#000','#fff'] | [{ color, pos }] -> typed stops, even spread when pos is omitted.
function gradientStops(stops: GradientStopInput[] | undefined): GradientStop[] {
  if (!Array.isArray(stops) || !stops.length) {
    throw new FlcmError("authoring", 'needs a non-empty stops array, e.g. ["#000","#fff"].', { call: "flcm.gradient" });
  }
  const n = stops.length;
  return stops.map((st, i) => {
    const raw = typeof st === "string" ? { color: st } : st;
    return { position: stopPercent(raw, i, n) / 100, color: parseColor(raw.color) };
  });
}

// A stop's percent position: explicit `pos`/`position`, else an even spread across the run.
function stopPercent(raw: { pos?: number; position?: number }, i: number, n: number): number {
  if (typeof raw.pos === "number") return raw.pos;
  if (typeof raw.position === "number") return raw.position;
  return n > 1 ? (i / (n - 1)) * 100 : 0;
}

// ---- image() paint compiler: a source + intent -> an image WritePaint (a fill value, like
// flcm.gradient). The source is an https url or a local file path (CSS url() takes both; the server
// confines paths to its asset root). The sandbox NEVER touches network or disk — the paint carries only the
// source string; the trusted server loads + validates the bytes and the bridge resolves them to a plugin
// ImagePaint at render (keyed by source). `placeholder` marks a stand-in so a later read can tell it from a
// real asset (bridge persists it on the node). Fails loud on a non-string/empty source or a scaleMode
// outside the set — never a silent blank fill.

const IMAGE_SCALE_MODES: ReadonlySet<string> = new Set(WORD_VALUES.scaleMode);

function image(url: unknown, opts: ImageOpts = {}): WritePaint {
  if (typeof url !== "string" || !url.trim()) {
    throw new FlcmError(
      "authoring",
      "expected an image url, local file path, or upload handle string, e.g. flcm.image(\"https://example.com/photo.jpg\") or flcm.image(\"assets/logo.png\") — got " + JSON.stringify(url) + ".",
      { call: "flcm.image" },
    );
  }
  opts = opts ?? {};
  rejectUnknownKeys(opts, IMAGE_KEYS, "flcm.image opts");
  const scaleMode = opts.scaleMode != null ? opts.scaleMode : "FILL";
  if (!IMAGE_SCALE_MODES.has(scaleMode)) {
    throw new FlcmError("authoring", "scaleMode must be one of " + words(IMAGE_SCALE_MODES) + " — got " + JSON.stringify(scaleMode) + ".", { call: "flcm.image" });
  }
  return {
    kind: "image", url: url.trim(), scaleMode, placeholder: opts.placeholder === true,
    ...parseImageAdjustments(opts, "flcm.image opts"),
  };
}

// ---- effects() sugar: { shadow, blur, backgroundBlur } -> typed WriteEffect[] (no string round-trip).
// Values are CSS px; the blur ×2 factor lives in the *FromCssPx compilers (effects.ts). EffectsSugar /
// ShadowSugar / BlurSugar are defined in schema.ts (the authoring-surface source). ----

function effects(sugar: EffectsSugar): WriteEffect[] {
  if (!sugar || typeof sugar !== "object") {
    throw new FlcmError(
      "authoring",
      "expected { shadow?, blur?, backgroundBlur?, glass?, noise?, texture?, progressiveBlur?, progressiveBackgroundBlur? } — got " + JSON.stringify(sugar) + ".",
      { call: "flcm.effects" },
    );
  }
  rejectUnknownKeys(sugar, EFFECTS_KEYS, "flcm.effects");
  const out: WriteEffect[] = [];
  if (sugar.shadow !== undefined) out.push(...sugarShadows(sugar.shadow));
  if (sugar.blur !== undefined) out.push(layerBlurFromCssPx(blurRadius(sugar.blur)));
  if (sugar.backgroundBlur !== undefined) out.push(backgroundBlurFromCssPx(blurRadius(sugar.backgroundBlur)));
  if (sugar.glass !== undefined) out.push(sugarGlass(sugar.glass));
  if (sugar.noise !== undefined) out.push(sugarNoise(sugar.noise));
  if (sugar.texture !== undefined) out.push(sugarTexture(sugar.texture));
  if (sugar.progressiveBlur !== undefined) out.push(sugarProgressiveBlur(sugar.progressiveBlur, "LAYER_BLUR"));
  if (sugar.progressiveBackgroundBlur !== undefined) out.push(sugarProgressiveBlur(sugar.progressiveBackgroundBlur, "BACKGROUND_BLUR"));
  return out;
}

// ---- Beyond-CSS effect sugar: friendly bag -> typed effect, defaults filled here (the sugar layer owns
// defaults + color parsing, mirroring sugarShadows). `true` gives a usable effect with all defaults.
// Values are raw Figma-domain (no CSS-px scaling) — see ir.ts.

function sugarGlass(g: GlassSugar): WriteEffect {
  const s = g === true ? {} : g;
  return glass({
    lightIntensity: s.lightIntensity != null ? s.lightIntensity : 0.5,
    lightAngle: s.lightAngle != null ? s.lightAngle : 130,
    refraction: s.refraction != null ? s.refraction : 0.25,
    depth: s.depth != null ? s.depth : 12,
    dispersion: s.dispersion != null ? s.dispersion : 0.08,
    radius: s.radius != null ? s.radius : 4,
  });
}

function sugarNoise(n: NoiseSugar): WriteEffect {
  const s = n === true ? {} : n;
  const type = s.type || "monotone";
  return noise({
    noiseType: type,
    color: parseColor(s.color || "rgba(0,0,0,0.4)"),
    noiseSize: s.noiseSize != null ? s.noiseSize : 1,
    density: s.density != null ? s.density : 0.2,
    secondaryColor: s.secondaryColor != null ? parseColor(s.secondaryColor) : type === "duotone" ? parseColor("rgba(255,255,255,0.4)") : undefined,
    opacity: s.opacity != null ? s.opacity : type === "multitone" ? 0.5 : undefined,
  });
}

function sugarTexture(t: TextureSugar): WriteEffect {
  const s = t === true ? {} : t;
  return texture({
    noiseSize: s.noiseSize != null ? s.noiseSize : 3,
    radius: s.radius != null ? s.radius : 6,
    clipToShape: s.clipToShape != null ? s.clipToShape : true,
  });
}

function sugarProgressiveBlur(b: ProgressiveBlurSugar, type: "LAYER_BLUR" | "BACKGROUND_BLUR"): WriteEffect {
  const s = typeof b === "number" ? { endRadius: b } : b;
  return progressiveBlur({
    type,
    startRadius: s.startRadius != null ? s.startRadius : 0,
    radius: s.endRadius != null ? s.endRadius : 20,
    startOffset: s.startOffset || { x: 0, y: 0 },
    endOffset: s.endOffset || { x: 0, y: 1 },
  });
}

function sugarShadows(input: ShadowSugar | ShadowSugar[]): WriteEffect[] {
  const list = Array.isArray(input) ? input : [input];
  return list.map((raw) => {
    const s = raw === true || raw == null ? {} : raw;
    return shadow({
      inner: !!s.inner,
      color: parseColor(s.color || "rgba(0,0,0,0.25)"),
      x: s.x || 0,
      y: s.y != null ? s.y : 4,
      radius: s.blur != null ? s.blur : 8, // CSS box-shadow blur, 1:1 with the Figma radius
      spread: s.spread || 0,
    });
  });
}

// A blur radius (CSS px) from a number or a { layer | background | radius } object.
function blurRadius(b: BlurSugar): number {
  if (typeof b === "number") return b;
  if (b.layer != null) return b.layer;
  if (b.background != null) return b.background;
  return b.radius || 0;
}

// Accept the sugar bag ({ shadow, blur, backgroundBlur }), an already-typed WriteEffect[] (what
// flcm.effects returns), or a CSS WriteEffects bag — all converge on WriteEffect[].
//
// The two string/object vocabularies are SPLIT, not routed: one read `effects` value carries both at once
// (a frame with a drop shadow AND native glass reads back as { boxShadow, glass }), so picking a single
// path by "does this look CSS?" would reject exactly the shape `get` hands back. The closed-set reject runs
// ONCE over the union first — parseCssEffects reads a positive list, so without a gate a typo beside a real
// CSS key would vanish silently; and gating after the split would name the half the typo fell into rather
// than `effects`, where it was written, with only half the legal vocabulary listed.
export function normalizeEffects(v: EffectsInput): WriteEffect[] {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object") throw new FlcmError("authoring", "effects must be an object — got " + JSON.stringify(v) + ".");
  rejectUnknownKeys(v, EFFECTS_INPUT_KEYS, "effects");
  const bag = v as Record<string, unknown>;
  const css: Record<string, unknown> = {};
  const sugar: Record<string, unknown> = {};
  for (const k of Object.keys(bag)) (CSS_EFFECTS_KEYS.has(k) ? css : sugar)[k] = bag[k];
  const out: WriteEffect[] = [];
  if (Object.keys(css).length) out.push(...parseCssEffects(css as WriteCssEffects));
  if (Object.keys(sugar).length) out.push(...effects(sugar as EffectsSugar));
  return out;
}

export { gradient, image, effects };
