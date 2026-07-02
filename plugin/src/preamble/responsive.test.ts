// Percent sizing ("N%") on w/h and absolute.x/y, plus absolute `anchor`. Percent has no construction-time
// meaning (the parent isn't known yet), so these exercise a live render against the in-memory figma mock:
// the bridge resolves a percent to pixels against the parent's REALIZED axis size in a post-walk pass, and
// fails loud only on the true cycle (an in-flow %-size child of a parent that hugs that axis) and the root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, text, render } from "./flcm.js";

createFigmaMock();

test('percent w/h resolves to a fraction of a free-form parent\'s fixed size', async () => {
  const out = await render(
    frame({ width: 300, height: 200 }, [
      rect({ key: "bar", width: "35%", height: "50%" }),
    ]),
  );
  const bar = figma.getNodeById(out.keyed.bar.id);
  assert.equal(bar.width, 105); // 35% of 300
  assert.equal(bar.height, 100); // 50% of 200
});

test("percent resolves against a percent-sized ancestor (chained)", async () => {
  const out = await render(
    frame({ width: 400 }, [
      frame({ key: "mid", width: "50%", height: 100 }, [
        rect({ key: "leaf", width: "50%", height: 20 }),
      ]),
    ]),
  );
  assert.equal(figma.getNodeById(out.keyed.mid.id).width, 200); // 50% of 400
  assert.equal(figma.getNodeById(out.keyed.leaf.id).width, 100); // 50% of the resolved 200
});

test("percent absolute x/y resolves against the parent box", async () => {
  const out = await render(
    frame({ width: 200, height: 100 }, [
      rect({ key: "badge", width: 40, height: 40, absolute: { x: "50%", y: "50%" } }),
    ]),
  );
  const badge = figma.getNodeById(out.keyed.badge.id);
  assert.equal(badge.x, 100); // 50% of 200
  assert.equal(badge.y, 50); // 50% of 100
});

test("percent absolute position works inside an auto-layout parent (out of flow)", async () => {
  const out = await render(
    frame({ layout: { mode: "row" }, width: 200, height: 100 }, [
      rect({ key: "pin", width: 20, height: 20, absolute: { x: "25%" } }),
    ]),
  );
  const pin = figma.getNodeById(out.keyed.pin.id);
  assert.equal(pin.x, 50); // 25% of 200 — position isn't tied to layout mode
  assert.equal(pin.layoutPositioning, "ABSOLUTE");
});

test("percent SIZE on an IN-FLOW child of a FIXED auto-layout parent resolves (static-only)", async () => {
  // v1.2: an in-flow %-child of an auto-layout parent that is FIXED (or fill) on that axis resolves to the
  // right static pixel — the old blanket auto-layout rejection is gone. It gets no reflow constraint
  // (Figma governs in-flow children by grow/hug), which is why this is static-only.
  const out = await render(
    frame({ layout: { mode: "row" }, width: 300, height: 40 }, [rect({ key: "half", width: "50%", height: 20 })]),
  );
  assert.equal(figma.getNodeById(out.keyed.half.id).width, 150); // 50% of the fixed 300
});

test("percent SIZE on an IN-FLOW child of a HUGGING auto-layout parent fails loud (true cycle)", async () => {
  // The one unresolvable case: the parent hugs the axis, so the child's size both defines and depends on it.
  await assert.rejects(
    render(frame({ layout: { mode: "column" } }, [rect({ width: "50%" })])), // column, no width → hugs width
    /cycle/,
  );
});

test('percent SIZE resolves against a "fill" parent\'s realized size (the scrub-bar case)', async () => {
  // The headline Phase-2 win: a fill track holds a percent playhead with zero hand-computed pixels. The
  // track's width is only knowable after it fills the row — resolvePercents reads it post-walk.
  const out = await render(
    frame({ layout: { mode: "row" }, width: 400, height: 20 }, [
      frame({ key: "track", width: "fill", height: 8 }, [rect({ key: "play", width: "40%", height: 8 })]),
    ]),
  );
  assert.equal(figma.getNodeById(out.keyed.track.id).width, 400); // fills the row
  assert.equal(figma.getNodeById(out.keyed.play.id).width, 160); // 40% of the realized 400
});

test("percent-width TEXT wraps at the resolved width (not silently ignored)", async () => {
  // A text node ignores a width resize while it auto-sizes width; the deferred resolver must flip it to
  // HEIGHT auto-resize so the percent width actually wraps, or the percent is silently dropped.
  const out = await render(
    frame({ width: 300, height: 200 }, [
      text("a fairly long headline that would overflow if it never wrapped", { key: "t", width: "50%" }),
    ]),
  );
  assert.equal(figma.getNodeById(out.keyed.t.id).width, 150); // 50% of 300, wrapping
});

test("percent SIZE on an ABSOLUTE (out-of-flow) child resolves inside an auto-layout parent", async () => {
  // An absolute child is out of the flow, so percent sizes against the parent's realized axis exactly like a
  // percent position does — and width:"fill" on it already works. Rejecting width:"50%" here would be inconsistent.
  const out = await render(
    frame({ layout: { mode: "row" }, width: 300, height: 100 }, [
      rect({ key: "overlay", width: "50%", height: 40, absolute: { x: 10, y: 10 } }),
    ]),
  );
  assert.equal(figma.getNodeById(out.keyed.overlay.id).width, 150); // 50% of 300
});

test("percent on the root node (no parent) fails loud", async () => {
  await assert.rejects(render(rect({ width: "50%" })), /root node/);
});

// --- Phase 2 (b): `anchor` on an absolute child ---

test("anchor centres a child on the resolved point (no half-width offset)", async () => {
  const out = await render(
    frame({ width: 200, height: 100 }, [
      rect({ key: "knob", width: 40, height: 40, absolute: { x: "50%", y: "50%", anchor: { x: "center", y: "center" } } }),
    ]),
  );
  const knob = figma.getNodeById(out.keyed.knob.id);
  assert.equal(knob.x, 80); // 50% of 200 = 100, minus half the 40px width
  assert.equal(knob.y, 30); // 50% of 100 = 50, minus half the 40px height
});

test("anchor right/bottom pins a child's far edge to the point", async () => {
  const out = await render(
    frame({ width: 300, height: 200 }, [
      rect({ key: "badge", width: 24, height: 24, absolute: { x: "100%", y: 0, anchor: { x: "right", y: "top" } } }),
    ]),
  );
  const badge = figma.getNodeById(out.keyed.badge.id);
  assert.equal(badge.x, 276); // right edge at 100% (300) → x = 300 - 24
  assert.equal(badge.y, 0); // top anchor: no offset
});

test("anchor works with a numeric position too (no percent required)", async () => {
  const out = await render(
    frame({ width: 200, height: 100 }, [rect({ key: "dot", width: 10, height: 10, absolute: { x: 100, anchor: { x: "center" } } })]),
  );
  assert.equal(figma.getNodeById(out.keyed.dot.id).x, 95); // 100 - half of 10
});

test("a bad anchor value fails loud", () => {
  assert.throws(() => rect({ absolute: { x: 0, anchor: { x: "top" } } } as never), /anchor\.x must be one of/);
  assert.throws(() => rect({ absolute: { x: 0, anchor: { y: "left" } } } as never), /anchor\.y must be one of/);
});

// --- Phase 4.2: auto-constraints on a free-form parent's children + `pin` override ---

test("a free-form child's constraints derive from its size/position intent", async () => {
  const out = await render(
    frame({ width: 300, height: 200 }, [
      rect({ key: "plain", width: 40, height: 40 }),                                    // numeric → MIN (Figma default)
      rect({ key: "fillW", width: "fill", height: 40 }),                                // fill → STRETCH
      rect({ key: "pctW", width: "50%", height: 40 }),                                  // percent size → SCALE
      rect({ key: "pctPos", width: 40, height: 40, absolute: { x: "50%", y: "50%" } }), // percent position → CENTER
      rect({ key: "numPos", width: 40, height: 40, absolute: { x: 20, y: 20 } }),       // numeric position → MIN
    ]),
  );
  const c = (k: string) => figma.getNodeById(out.keyed[k].id).constraints;
  assert.deepEqual(c("plain"), { horizontal: "MIN", vertical: "MIN" });
  assert.equal(c("fillW").horizontal, "STRETCH");
  assert.equal(c("pctW").horizontal, "SCALE");
  assert.deepEqual(c("pctPos"), { horizontal: "CENTER", vertical: "CENTER" });
  assert.deepEqual(c("numPos"), { horizontal: "MIN", vertical: "MIN" });
});

test('free-form width:"fill" actually stretches to the parent box (no warn-and-ignore)', async () => {
  const out = await render(frame({ width: 300, height: 200 }, [rect({ key: "bar", width: "fill", height: 12 })]));
  assert.equal(figma.getNodeById(out.keyed.bar.id).width, 300);
});

test("`pin` overrides the auto-derived constraint per axis", async () => {
  const out = await render(
    frame({ width: 300, height: 200 }, [
      rect({ key: "r", width: "fill", height: 40, pin: { x: "right", y: "bottom" } }),           // over fill/MIN
      rect({ key: "c", width: 40, height: 40, absolute: { x: 10, y: 10 }, pin: { x: "center", y: "scale" } } as never),
    ]),
  );
  assert.deepEqual(figma.getNodeById(out.keyed.r.id).constraints, { horizontal: "MAX", vertical: "MAX" });
  assert.deepEqual(figma.getNodeById(out.keyed.c.id).constraints, { horizontal: "CENTER", vertical: "SCALE" });
});

test("an IN-FLOW auto-layout child ignores pin (it reflows via layoutGrow/stretch)", async () => {
  const out = await render(
    frame({ layout: { mode: "row" }, width: 300, height: 80 }, [
      rect({ key: "grow", width: "fill", height: 40, pin: { x: "right" } } as never),
    ]),
  );
  const node = figma.getNodeById(out.keyed.grow.id);
  assert.equal(node.layoutGrow, 1); // fill still rides layoutGrow, unchanged
  assert.deepEqual(node.constraints, { horizontal: "MIN", vertical: "MIN" }); // pin ignored, default untouched
});

test("an ABSOLUTE child of an auto-layout parent honors pin/constraints (out of flow)", async () => {
  // An absolute child is lifted out of the flow, and Figma DOES apply constraints to it — the badge-in-corner
  // case. So pin/auto-derivation must flow through even under an auto-layout parent (not a silent no-op).
  const out = await render(
    frame({ layout: { mode: "row" }, width: 320, height: 200 }, [
      rect({ key: "badge", width: 28, height: 28, absolute: { x: 284, y: 12 }, pin: { x: "right", y: "top" } } as never),
    ]),
  );
  assert.deepEqual(figma.getNodeById(out.keyed.badge.id).constraints, { horizontal: "MAX", vertical: "MIN" });
});

test("a bad `pin` value fails loud", () => {
  assert.throws(() => rect({ pin: { x: "middle" } } as never), /pin\.x must be one of/);
  assert.throws(() => rect({ pin: { y: "left" } } as never), /pin\.y must be one of/);
  assert.throws(() => rect({ pin: "right" } as never), /pin must be an object/);
});
