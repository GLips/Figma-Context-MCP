// Focused fail-loud tests for the metric/effect parsers (ADR-0003 code fixes). These are pure functions,
// so we test them directly: each out-of-subset metric must THROW naming the value, never silently coerce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { length, lineHeight, letterSpacing, parseCssEffects } from "./css.js";

test("length: number and strict Npx pass; out-of-subset units and junk throw", () => {
  assert.equal(length(24), 24);
  assert.equal(length("24px"), 24);
  assert.equal(length("-4px"), -4);
  assert.equal(length("0.5px"), 0.5);
  // The parseFloat leniency this fix removes: each of these used to silently coerce to a wrong number.
  for (const bad of ["8em", "50%", "12foo", "24", "px", ""]) {
    assert.throws(() => length(bad), /expected a number or "Npx"/, `length(${JSON.stringify(bad)}) should throw`);
  }
});

test("lineHeight: px/em/%/auto in-subset; rem and trailing junk throw", () => {
  assert.deepEqual(lineHeight(24), { value: 24, unit: "PIXELS" });
  assert.deepEqual(lineHeight("24px"), { value: 24, unit: "PIXELS" });
  assert.deepEqual(lineHeight("1.5em"), { value: 150, unit: "PERCENT" });
  assert.deepEqual(lineHeight("150%"), { value: 150, unit: "PERCENT" });
  assert.deepEqual(lineHeight("auto"), { unit: "AUTO" });
  assert.deepEqual(lineHeight("normal"), { unit: "AUTO" });
  // "1.5rem" must NOT be read as 1.5em (its slice(-2) is "em"); "12foo%" must not parseFloat to 12.
  for (const bad of ["1.5rem", "12foo%", "1.5 em", "%"]) {
    assert.throws(() => lineHeight(bad), /bad lineHeight/, `lineHeight(${JSON.stringify(bad)}) should throw`);
  }
});

test("letterSpacing: em is *100 PERCENT, px is PIXELS; rem throws", () => {
  assert.deepEqual(letterSpacing("0.05em"), { value: 5, unit: "PERCENT" });
  assert.deepEqual(letterSpacing("2px"), { value: 2, unit: "PIXELS" });
  assert.deepEqual(letterSpacing(1), { value: 1, unit: "PIXELS" });
  assert.throws(() => letterSpacing("1.5rem"), /bad letterSpacing/);
});

test("parseCssEffects: a colorless box-shadow rejects (CSS currentColor is unavailable)", () => {
  assert.throws(() => parseCssEffects({ boxShadow: "0px 4px 8px" }), /needs an explicit color/);
  // With an explicit color it parses to one shadow effect.
  const fx = parseCssEffects({ boxShadow: "0px 4px 8px rgba(0,0,0,0.25)" });
  assert.equal(fx.length, 1);
  assert.equal(fx[0].kind, "shadow");
});

test("parseCssEffects: a bare 0 is a length, any other unitless number is not", () => {
  // The spelling every CSS author actually writes. Reading it as "no length here" made the most
  // ordinary shadow string in the world fail with "needs at least <x>px <y>px".
  const [bare] = parseCssEffects({ boxShadow: "0 2px 6px rgba(0,0,0,0.18)" });
  const [unit] = parseCssEffects({ boxShadow: "0px 2px 6px rgba(0,0,0,0.18)" });
  assert.deepEqual(bare, unit);
  // A unitless NON-zero is not a CSS length — it falls through to the color and fails there.
  assert.throws(() => parseCssEffects({ boxShadow: "0 2 6 rgba(0,0,0,0.18)" }), /box-shadow/);
});
