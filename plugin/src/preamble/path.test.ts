// Phase 1: flcm.path auto-normalizes any valid SVG `d` into Figma's absolute M/L/C/Q/Z subset. These tests
// prove (a) output is subset-only, (b) geometry is preserved within tolerance, (c) malformed data fails loud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePathData } from "./path.js";

// Every non-M/L/C/Q/Z-or-number-or-space character betrays an unconverted command (H V S T A, lowercase).
const SUBSET_ONLY = /^[MLCQZ0-9.\-,\s]+$/;

// Sample a cubic bezier at parameter t → [x, y].
function cubicAt(t: number, p0: number[], c1: number[], c2: number[], p1: number[]): number[] {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const dd = t * t * t;
  return [a * p0[0] + b * c1[0] + c * c2[0] + dd * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + dd * p1[1]];
}

test("H and V convert to absolute L at the running point", () => {
  const out = normalizePathData("M10 10 H50 V30");
  assert.match(out, SUBSET_ONLY);
  assert.equal(out, "M10 10 L50 10 L50 30");
});

test("relative/lowercase commands resolve to absolute", () => {
  const out = normalizePathData("m10 10 l5 0 l0 5 z");
  assert.match(out, SUBSET_ONLY);
  assert.equal(out, "M10 10 L15 10 L15 15 Z");
});

test("implicit lineto after a moveto (extra coordinate pairs)", () => {
  // "M" with three pairs → one moveto + two implicit linetos; lowercase "m" implies relative linetos.
  assert.equal(normalizePathData("M0 0 1 1 2 2"), "M0 0 L1 1 L2 2");
  assert.equal(normalizePathData("m0 0 1 1 2 2"), "M0 0 L1 1 L3 3");
});

test("smooth cubic S reflects the previous control point", () => {
  // After "C0 0 4 0 4 4", the previous 2nd control is (4,0); S reflects it about the current point (4,4)
  // → first control (4,8). Endpoint stays as given.
  const out = normalizePathData("M0 0 C0 0 4 0 4 4 S8 8 8 4");
  assert.match(out, SUBSET_ONLY);
  // Second cubic's first control should be the reflection (4,8) of the previous control (4,0) about (4,4).
  const cubics = out.split(/(?=[MLCQZ])/).filter((s) => s.startsWith("C"));
  const nums = cubics[1].slice(1).trim().split(/\s+/).map(Number);
  assert.deepEqual([nums[0], nums[1]], [4, 8]);
});

test("smooth quad T reflects the previous control point", () => {
  // After "Q1 1 2 0", control (1,1) reflected about current (2,0) → (3,-1).
  const out = normalizePathData("M0 0 Q1 1 2 0 T4 0");
  assert.match(out, SUBSET_ONLY);
  const segs = out.split(/(?=[MLCQZ])/).filter((s) => s.startsWith("Q"));
  const nums = segs[1].slice(1).trim().split(/\s+/).map(Number);
  assert.deepEqual([nums[0], nums[1]], [3, -1]);
});

test("S/T with no preceding curve use the current point as the control", () => {
  // No cubic before S → first control coincides with the current point (0,0).
  const s = normalizePathData("M0 0 S4 4 4 0");
  const sNums = s.split(/(?=[MLCQZ])/).find((p) => p.startsWith("C"))!.slice(1).trim().split(/\s+/).map(Number);
  assert.deepEqual([sNums[0], sNums[1]], [0, 0]);
});

test("arc converts to cubics that trace the circle within tolerance", () => {
  // Quarter circle radius 10, centered so it runs from (10,0) to (0,10).
  const out = normalizePathData("M10 0 A10 10 0 0 1 0 10");
  assert.match(out, SUBSET_ONLY);
  const segs = out.split(/(?=[MLCQZ])/);
  const start = [10, 0];
  let cur = start;
  const samples: number[][] = [];
  for (const seg of segs) {
    if (!seg.startsWith("C")) continue;
    const nums = seg.slice(1).trim().split(/\s+/).map(Number);
    const c1 = [nums[0], nums[1]];
    const c2 = [nums[2], nums[3]];
    const end = [nums[4], nums[5]];
    for (let t = 0; t <= 1.0001; t += 0.25) samples.push(cubicAt(t, cur, c1, c2, end));
    cur = end;
  }
  // Endpoint reached.
  assert.ok(Math.hypot(cur[0] - 0, cur[1] - 10) < 0.01, "arc should end at (0,10)");
  // Every sampled point lies on the radius-10 circle centered at origin.
  for (const [x, y] of samples) {
    assert.ok(Math.abs(Math.hypot(x, y) - 10) < 0.05, `sample (${x},${y}) off the circle`);
  }
});

test("arc flags parse when abutting the following number (single-digit flag packing)", () => {
  // "0110 0" packs large=0, sweep=1, then x=10 — the flags abut the coordinate with no separator. This is
  // exactly why flags get their own one-char reader (readFlag) instead of readNumber; it must parse
  // identically to the fully-spaced form.
  const packed = normalizePathData("M0 0 A5 5 0 0110 0");
  const spaced = normalizePathData("M0 0 A5 5 0 0 1 10 0");
  assert.equal(packed, spaced);
  assert.match(packed, SUBSET_ONLY);
});

test("degenerate arc radius collapses to a straight line", () => {
  assert.equal(normalizePathData("M0 0 A0 0 0 0 1 10 10"), "M0 0 L10 10");
});

test("arc with coincident endpoints is omitted, not emitted as a broken curve (spec F.6.2)", () => {
  const out = normalizePathData("M10 10 A5 5 0 1 1 10 10");
  assert.match(out, SUBSET_ONLY);
  assert.equal(out, "M10 10");
});

test("already-subset absolute paths round-trip unchanged", () => {
  assert.equal(normalizePathData("M8 5 L19 12 L8 19 Z"), "M8 5 L19 12 L8 19 Z");
});

test("scientific notation and comma/space separator flexibility", () => {
  assert.equal(normalizePathData("M1e1,1e1L2e1 2e1"), "M10 10 L20 20");
});

test("realistically small authored coordinates survive normalization", () => {
  // Rounding sheds float noise but must not collapse genuinely nonzero authored precision to zero.
  assert.equal(normalizePathData("M0 0 L0.0625 0.03125"), "M0 0 L0.0625 0.03125");
  assert.equal(normalizePathData("M0 0 L0.00004 0"), "M0 0 L0.00004 0");
});

test("a huge-but-finite coordinate fails loud rather than serializing Infinity", () => {
  assert.throws(() => normalizePathData("M1e308 0"), /out of range/);
});

test("a huge-radius (near-straight) arc still reaches its commanded endpoint", () => {
  // Large radii make point() catastrophically cancel; the final segment is pinned to (x2,y2), so the
  // path must still terminate exactly at the endpoint rather than collapsing short of it.
  const out = normalizePathData("M0 0 A100000000 100000000 0 0 1 1 0");
  assert.match(out, SUBSET_ONLY);
  const last = out.split(/(?=[MLCQZ])/).pop()!.slice(1).trim().split(/\s+/).map(Number);
  assert.deepEqual([last[last.length - 2], last[last.length - 1]], [1, 0]);
});

test("pathological arc radii/rotation fail loud instead of silently vanishing", () => {
  // A rotation so large the trig is meaningless, and denormal radii that can't be scaled, both drive the
  // arc math non-finite — these must throw, not drop the arc (the plan's never-silent-no-op invariant).
  assert.throws(() => normalizePathData("M0 0 A5 5 1e308 0 1 10 0"), /cannot be realized/);
  assert.throws(() => normalizePathData("M0 0 A1e-160 1e-160 0 0 1 1 0"), /cannot be realized/);
});

test("malformed path data fails loud", () => {
  assert.throws(() => normalizePathData("M12 banana"), /could not parse/);
  assert.throws(() => normalizePathData("L10 10"), /must start with a moveto/);
  assert.throws(() => normalizePathData("M0 0 A5 5 0 3 1 10 0"), /flag must be 0 or 1/);
  assert.throws(() => normalizePathData("M0 0 X"), /unknown command/);
});
