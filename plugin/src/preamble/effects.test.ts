// Beyond-CSS effect sugar (Phase 4). These are pure builders, so we test them directly: shape + defaults,
// fail-loud on a bad enum, and the plugin-Effect mapping. The mapping tests are the load-bearing ones —
// they pin decisions grounded against the LIVE runtime (verified via execute_code), which the in-memory
// mock can't enforce: noise carries NO blendMode (the running runtime rejects it despite the 1.130.0
// typing), and progressive blur maps to the LAYER_BLUR/PROGRESSIVE variant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { effects } from "./flcm.js";
import { toFigmaEffects } from "./effects.js";

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
