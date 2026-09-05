// Beyond-CSS effect sugar (Phase 4). These are pure builders, so we test them directly: shape + defaults,
// fail-loud on a bad enum, and the plugin-Effect mapping. The mapping tests are the load-bearing ones —
// they pin decisions grounded against the LIVE runtime (verified via execute_code), which the in-memory
// mock can't enforce: noise carries NO blendMode (the running runtime rejects it despite the 1.130.0
// typing), and progressive blur maps to the LAYER_BLUR/PROGRESSIVE variant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { effects } from "./flcm.js";
import { toFigmaEffects } from "./effects.js";
import type {
  SimplifiedGlass,
  SimplifiedNoise,
  SimplifiedTexture,
  SimplifiedProgressiveBlur,
} from "@framelink/core";
import type { GlassSugar, NoiseSugar, TextureSugar, ProgressiveBlurSugar } from "./schema.js";

// ADR-0002 read↔create symmetry, tier-2: the core's beyond-CSS OBJECT form (what `get` emits) must feed
// straight back into the create sugar (what flcm.effects({...}) accepts) — two toolchains, no shared type.
// The check has two halves, because assignability ALONE is too weak: every sugar field is optional, so a
// read-side field RENAME would be an excess property on the read type and still `extends` the sugar. So we
// also assert every read key has a create-side counterpart — then a rename (read emits `glassDepth`, create
// still reads `depth`) fails to compile here rather than silently round-tripping to a create default.
type ReadMatchesCreate<Read, Sugar> = (Read extends Sugar ? true : never) &
  (keyof Read extends keyof (Sugar & object) ? true : never);
const _glassSym: ReadMatchesCreate<SimplifiedGlass, GlassSugar> = true;
const _noiseSym: ReadMatchesCreate<SimplifiedNoise, NoiseSugar> = true;
const _textureSym: ReadMatchesCreate<SimplifiedTexture, TextureSugar> = true;
const _progressiveSym: ReadMatchesCreate<SimplifiedProgressiveBlur, ProgressiveBlurSugar> = true;
void _glassSym;
void _noiseSym;
void _textureSym;
void _progressiveSym;

test("effects sugar: glass/noise/texture/progressiveBlur build with defaults from `true`/number", () => {
  const specs = effects({ glass: true, noise: true, texture: true, progressiveBlur: 24 });
  assert.deepEqual(specs.map((s) => s.kind), ["glass", "noise", "texture", "progressiveBlur"]);

  const glass = specs[0] as Extract<(typeof specs)[number], { kind: "glass" }>;
  assert.equal(glass.depth, 12);
  assert.equal(glass.lightIntensity, 0.5);

  const noise = specs[1] as Extract<(typeof specs)[number], { kind: "noise" }>;
  assert.equal(noise.noiseType, "MONOTONE");
  assert.equal(noise.secondaryColor, undefined); // monotone: no secondary
  assert.equal(noise.opacity, undefined);

  const pblur = specs[3] as Extract<(typeof specs)[number], { kind: "progressiveBlur" }>;
  assert.equal(pblur.radius, 24); // a bare number is the END radius
  assert.deepEqual(pblur.endOffset, { x: 0, y: 1 }); // default top→bottom fade
});

test("noise: duotone gets a default secondaryColor, multitone a default opacity; bad type fails loud", () => {
  const duo = effects({ noise: { type: "duotone" } })[0] as Extract<ReturnType<typeof effects>[number], { kind: "noise" }>;
  assert.ok(duo.secondaryColor, "duotone must carry a secondaryColor");
  assert.equal(duo.opacity, undefined);

  const multi = effects({ noise: { type: "multitone" } })[0] as Extract<ReturnType<typeof effects>[number], { kind: "noise" }>;
  assert.equal(typeof multi.opacity, "number");

  // @ts-expect-error — an out-of-set noise type must fail loud, not silently pass to the runtime.
  assert.throws(() => effects({ noise: { type: "sepia" } }), /monotone \| duotone \| multitone/);
});

test("glass: depth < 1 fails loud (the runtime silently clamps it, so we reject to stay faithful)", () => {
  assert.throws(() => effects({ glass: { depth: 0.5 } }), /depth must be >= 1/);
  // The default (depth 12) and any depth >= 1 build fine.
  assert.doesNotThrow(() => effects({ glass: true }));
  assert.doesNotThrow(() => effects({ glass: { depth: 1 } }));
});

test("toFigmaEffects: noise omits blendMode (live runtime rejects it); progressive blur is LAYER_BLUR/PROGRESSIVE", () => {
  const [noiseFx] = toFigmaEffects(effects({ noise: true }));
  assert.equal(noiseFx.type, "NOISE");
  assert.ok(!("blendMode" in noiseFx), "noise must NOT carry blendMode — the running runtime rejects the key");

  const [pblurFx] = toFigmaEffects(effects({ progressiveBlur: { startRadius: 2, endRadius: 30 } })) as any[];
  assert.equal(pblurFx.type, "LAYER_BLUR");
  assert.equal(pblurFx.blurType, "PROGRESSIVE");
  assert.equal(pblurFx.radius, 30);
  assert.equal(pblurFx.startRadius, 2);
});
