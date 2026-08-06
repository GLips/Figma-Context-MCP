// ADR-0003 code-fix tests that need construction and/or a live render. Constructors are inert POJOs, so
// pad rejection is checked on the built WriteNode; cross:"stretch" and the clip default are render-time
// (bridge) behavior, exercised against the in-memory figma mock the dogfood harness uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, text, ellipse, render } from "./flcm.js";

// The bridge reads figma.* only inside render(); constructors never touch it. Install the mock before any
// render runs. (flcm.js imports are figma-free at module load, so static import above is safe.)
createFigmaMock();

test("pad: numbers and edge objects compile; a px-string or non-numeric edge rejects", () => {
  assert.deepEqual(frame({ layout: { padding: 24 } }).layout!.padding, { top: 24, right: 24, bottom: 24, left: 24 });
  assert.deepEqual(frame({ layout: { padding: { x: 8, y: 16 } } }).layout!.padding, { top: 16, right: 8, bottom: 16, left: 8 });
  assert.deepEqual(frame({ layout: { padding: { top: 4, left: 2 } } }).layout!.padding, { top: 4, right: 0, bottom: 0, left: 2 });
  // The silent-zero bug this fixes: "24px" is neither a number nor an edge object, and used to yield 0 pad.
  assert.throws(() => frame({ layout: { padding: "24px" as never } }), /pad must be a number or an object/);
  assert.throws(() => frame({ layout: { padding: { x: "24px" } as never } }), /pad\.x must be a number/);
});

test('cross:"stretch" stretches an auto-sized child but leaves a fixed counter-axis child alone', async () => {
  const out = await render(
    frame({ layout: { mode: "row", alignItems: "stretch" } }, [
      ellipse({ key: "auto" }), // no explicit height -> stretches on the row's counter (vertical) axis
      ellipse({ key: "fixed", height: 50 }), // explicit counter-axis size -> keeps it, no stretch
    ]),
  );
  const auto = await figma.getNodeByIdAsync(out.keyed.auto.id);
  const fixed = await figma.getNodeByIdAsync(out.keyed.fixed.id);
  assert.equal(auto.layoutAlign, "STRETCH");
  assert.notEqual(fixed.layoutAlign, "STRETCH");
});

test("align/cross: supported words map; an unrealizable value (space-around/evenly) fails loud, not a silent MIN", async () => {
  // The supported words flow through to the layout IR (the bridge maps them to Figma enums).
  assert.equal(frame({ layout: { mode: "row", justifyContent: "space-between" } }).layout!.justifyContent, "between");
  assert.equal(frame({ layout: { mode: "row", alignItems: "stretch" } }).layout!.alignItems, "stretch");
  // Figma auto-layout can't realize CSS space-around/space-evenly. Before the describe-layer gate the bridge
  // silently resolved the miss to MIN (ADR-0003 silent no-op) — now it's a loud, set-naming rejection.
  assert.throws(() => frame({ layout: { mode: "row", justifyContent: "space-around" as never } }), /layout\.justifyContent must be one of/);
  assert.throws(() => frame({ layout: { mode: "row", justifyContent: "space-evenly" as never } }), /space-around\/space-evenly/);
  assert.throws(() => frame({ layout: { mode: "row", alignItems: "space-between" as never } }), /layout\.alignItems must be one of/);
});

test("layout.mode: an unrealizable direction (grid) fails loud, not a silent degrade to free-form", () => {
  // flcm can't author grid — the schema doc promises fail-loud. Before the gate a stray mode fell through
  // to "none" (free-form), silently inerting gap/padding/justify/align (ADR-0003 silent no-op).
  assert.equal(frame({ layout: { mode: "column" } }).layout!.mode, "column");
  assert.equal(frame({}).layout!.mode, "none"); // omitted mode is free-form, not an error
  assert.throws(() => frame({ layout: { mode: "grid" as never } }), /layout\.mode must be one of/);
});

test("textStyle.textAlign: supported words pass; an unrecognized value fails loud, not a silent left", () => {
  assert.equal(text("t", { textStyle: { textAlign: "center" } }).textStyle!.textAlign, "center");
  assert.throws(() => text("t", { textStyle: { textAlign: "middle" as never } }), /textStyle\.textAlign must be one of/);
});

test("blend: a CSS mix-blend-mode name maps to the Figma enum on any node; unknown fails loud", async () => {
  assert.equal(frame({ mixBlendMode: "screen" }).blendMode, "SCREEN");
  assert.equal(text("hi", { mixBlendMode: "soft-light" }).blendMode, "SOFT_LIGHT");
  assert.equal(ellipse({ mixBlendMode: "MULTIPLY" }).blendMode, "MULTIPLY"); // case-insensitive (CSS keywords are)
  assert.throws(() => frame({ mixBlendMode: "plus-lighter" }), /unsupported blend/); // real CSS keyword, no Figma mapping
  // Applied once in the shared dispatch (buildNode), so every node kind gets it live.
  const out = await render(frame({ mixBlendMode: "overlay" }, [ellipse({ key: "dot", mixBlendMode: "screen" })]));
  assert.equal((await figma.getNodeByIdAsync(out.root.id)).blendMode, "OVERLAY");
  assert.equal((await figma.getNodeByIdAsync(out.keyed.dot.id)).blendMode, "SCREEN");
});

test("maxLines: clamps to N lines against a bounded width; unbounded or non-integer fails loud", async () => {
  assert.equal(text("t", { textStyle: { lineClamp: 2 }, width: 200 }).maxLines, 2);
  assert.equal(text("t", { textStyle: { lineClamp: 1 }, width: "fill" }).maxLines, 1);
  assert.equal(text("t", { textStyle: { lineClamp: 3 }, width: "50%" }).maxLines, 3);
  // Unbounded (hug / absent width): a width-hugging text has no wrap to clamp -> loud, not a silent no-op.
  assert.throws(() => text("t", { textStyle: { lineClamp: 2 } }), /bounded width/);
  assert.throws(() => text("t", { textStyle: { lineClamp: 2 }, width: "hug" }), /bounded width/);
  // N must be a whole number ≥ 1.
  assert.throws(() => text("t", { textStyle: { lineClamp: 0 }, width: 200 }), /whole number/);
  assert.throws(() => text("t", { textStyle: { lineClamp: 1.5 }, width: 200 }), /whole number/);
  // Sets the plugin truncation props at render (textTruncation:"ENDING" gives the automatic ellipsis).
  const t = await figma.getNodeByIdAsync((await render(text("A very long title indeed", { textStyle: { lineClamp: 2 }, width: 120 }))).root.id);
  assert.equal(t.maxLines, 2);
  assert.equal(t.textTruncation, "ENDING");
});

test("frames don't clip by default; clip:true opts in", async () => {
  const def = await figma.getNodeByIdAsync((await render(frame({}))).root.id);
  const on = await figma.getNodeByIdAsync((await render(frame({ clip: true }))).root.id);
  const off = await figma.getNodeByIdAsync((await render(frame({ clip: false }))).root.id);
  assert.equal(def.clipsContent, false);
  assert.equal(on.clipsContent, true);
  assert.equal(off.clipsContent, false);
});
