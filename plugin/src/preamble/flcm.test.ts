import { specNode } from "../../harness/spec-node.js";
import { compileTree } from "./compile-tree.js";
// ADR-0003 code-fix tests that need construction and/or a live render. Constructors build plain POJOs, so
// pad rejection is checked on the built WriteNode; cross:"stretch" and the clip default are render-time
// (bridge) behavior, exercised against the in-memory figma mock the dogfood harness uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { gradient, effects } from "./flcm.js";
import { render } from "./render.js";

// The bridge reads figma.* only inside render(); compilers never touch it. Install the mock before any
// render runs. (flcm.js imports are figma-free at module load, so static import above is safe.)
createFigmaMock();

test("pad: numbers, the CSS box shorthand and edge objects compile; an out-of-subset unit rejects", () => {
  // mode named on the positives: padding without a row/column mode rejects at create (the shared
  // realizability gate), so the pad-compile assertions need a legal container.
  assert.deepEqual(compileTree(({ type: "FRAME", layout: { mode: "row", padding: 24 } }), "spec").layout!.padding, { top: 24, right: 24, bottom: 24, left: 24 });
  assert.deepEqual(compileTree(({ type: "FRAME", layout: { mode: "row", padding: { x: 8, y: 16 } } }), "spec").layout!.padding, { top: 16, right: 8, bottom: 16, left: 8 });
  assert.deepEqual(compileTree(({ type: "FRAME", layout: { mode: "row", padding: { top: 4, left: 2 } } }), "spec").layout!.padding, { top: 4, right: 0, bottom: 0, left: 2 });
  // The read shape's own spelling: `get` returns padding as a CSS box shorthand, so a `get` result re-authors
  // as-is. All four CSS arities, since the 1/2/3-part forms mirror sides rather than defaulting to 0.
  assert.deepEqual(compileTree(({ type: "FRAME", layout: { mode: "row", padding: "24px" } }), "spec").layout!.padding, { top: 24, right: 24, bottom: 24, left: 24 });
  assert.deepEqual(compileTree(({ type: "FRAME", layout: { mode: "row", padding: "12px 16px" } }), "spec").layout!.padding, { top: 12, right: 16, bottom: 12, left: 16 });
  assert.deepEqual(compileTree(({ type: "FRAME", layout: { mode: "row", padding: "1px 2px 3px" } }), "spec").layout!.padding, { top: 1, right: 2, bottom: 3, left: 2 });
  assert.deepEqual(compileTree(({ type: "FRAME", layout: { mode: "row", padding: "1px 2px 3px 4px" } }), "spec").layout!.padding, { top: 1, right: 2, bottom: 3, left: 4 });
  // An edge takes the same number-or-"Npx" every other metric does; anything outside that subset
  // fails loud rather than coercing to a wrong pixel.
  assert.deepEqual(compileTree(({ type: "FRAME", layout: { mode: "row", padding: { x: "24px" } } }), "spec").layout!.padding, { top: 0, right: 24, bottom: 0, left: 24 });
  assert.throws(() => compileTree(({ type: "FRAME", layout: { padding: { x: "24em" } as never } }), "spec"), /pad\.x must be a number or "Npx"/);
  assert.throws(() => compileTree(({ type: "FRAME", layout: { padding: [] as never } }), "spec"), /pad must be a number, a CSS box shorthand/);
});

test("strokeAlign takes the read shape's own lowercase words and rejects anything else", () => {
  // Same spelling on both sides of the surface: a `get` result reports "outside"/"center" and spreads
  // straight back into a compiler. Absent means Figma's INSIDE, which is the CSS `border`.
  assert.equal(compileTree(({ type: "RECTANGLE", stroke: "#000", strokeAlign: "outside" }), "spec").strokeAlign, "OUTSIDE");
  assert.equal(compileTree(({ type: "RECTANGLE", stroke: "#000", strokeAlign: "center" }), "spec").strokeAlign, "CENTER");
  assert.equal(compileTree(({ type: "RECTANGLE", stroke: "#000" }), "spec").strokeAlign, undefined);
  assert.throws(() => compileTree(({ type: "RECTANGLE", strokeAlign: "outer" as never }), "spec"), /strokeAlign is "inside", "outside" or "center"/);
});

test("create rejects layout words the type can't realize — the SAME gate edit consults (no asymmetry)", () => {
  // One authority answers for both verbs (layout-legality.ts assertLayoutRealizableForType), so
  // the pin is one test per rule, not per verb — a rule can't be strict in edit and lax in create.
  assert.throws(() => compileTree(({ type: "TEXT", text: "hi", height: 80 }), "spec"), /a TEXT's height follows its content/);
  // "hug" IS what a created text does, so the word is the default restated, not a request to refuse.
  assert.doesNotThrow(() => compileTree(({ type: "TEXT", text: "hi", height: "hug" }), "spec"));
  assert.throws(() => compileTree(({ type: "RECTANGLE", width: "hug" }), "spec"), /"hug" sizes to content/);
  assert.throws(() => compileTree(({ type: "FRAME", width: "hug" }), "spec"), /"hug" sizes to content/);
  assert.throws(() => compileTree(({ type: "FRAME", layout: { gap: 12 } }), "spec"), /need an auto-layout/);
  // The words themselves stay legal where the type can realize them.
  assert.doesNotThrow(() => compileTree(({ type: "FRAME", width: "hug", layout: { mode: "row", gap: 12 } }), "spec"));
  assert.doesNotThrow(() => compileTree(({ type: "TEXT", text: "hi", width: "hug" }), "spec"));
});

test("a metric is a number or \"Npx\" everywhere — width/height and left/top read the same as gap", () => {
  // One spelling rule across the whole surface: if a prop takes px, it takes both forms. The
  // alternative (numbers here, strings there) is a rule an author has to memorize per prop.
  const px = compileTree(({ type: "FRAME", width: "320px", height: 200, left: "16px", top: 8 }), "spec");
  assert.deepEqual(px.layout!.dimensions, { width: 320, height: 200 });
  assert.equal(px.layout!.left, 16);
  assert.equal(px.layout!.top, 8);
  // The subset still holds — an unsupported unit fails loud rather than coercing to wrong pixels.
  assert.throws(() => compileTree(({ type: "FRAME", width: "20em" }), "spec"), /width\/height must be a number/);
  assert.throws(() => compileTree(({ type: "FRAME", left: "20vw" }), "spec"), /left must be a number/);
});

test("root position words land on the page; an in-flow child's explicit pin is stored", async () => {
  // Both are create/edit symmetry pins: edit applies left/top to a page child and writes an
  // explicit pin unconditionally, so create dropping either would diverge the verbs.
  const out = await render(({ type: "FRAME", width: 40, height: 40, left: 42, top: 17, layout: { mode: "row", gap: 4 }, children: [
    ({ type: "RECTANGLE", width: 10, height: 10, pin: { x: "right" } }),
  ] }));
  const root = await figma.getNodeByIdAsync(out.id);
  assert.equal(root.x, 42);
  assert.equal(root.y, 17);
  assert.equal(root.children[0].constraints.horizontal, "MAX");
});

test('parent-relative strictness at render: a root "fill" and an out-of-flow TEXT height:"fill" reject', async () => {
  // Same rules as edit's live gates, shared predicates in layout-legality.ts — the root sits on
  // the page (no bounded size), and out of flow a text's fill-height would silently not stick.
  await assert.rejects(render(({ type: "FRAME", width: "fill", layout: { mode: "row" } })), /node's parent is the page/);
  await assert.rejects(
    render(({ type: "FRAME", width: 300, height: 200, children: [({ type: "TEXT", text: "t", height: "fill" })] })),
    /in-flow child of a row\/column auto-layout parent/,
  );
});

test("a present-but-mistyped scalar rejects loud on the compiler paths (QuickJS has no type checking)", () => {
  // The silent-drop bug this pins: a typeof guard used to skip the bad value and commit the rest.
  assert.throws(() => compileTree(({ type: "RECTANGLE", opacity: "bad" as never }), "spec"), /`opacity` must be a number/);
  assert.throws(() => compileTree(({ type: "LINE", rotation: "bad" as never }), "spec"), /`rotation` must be a number/);
});

test('cross:"stretch" stretches an auto-sized child but leaves a fixed counter-axis child alone', async () => {
  const out = await render(
    ({ type: "FRAME", layout: { mode: "row", alignItems: "stretch" }, children: [
      ({ type: "ELLIPSE", key: "auto" }), // no explicit height -> stretches on the row's counter (vertical) axis
      ({ type: "ELLIPSE", key: "fixed", height: 50 }), // explicit counter-axis size -> keeps it, no stretch
    ] }),
  );
  const auto = await figma.getNodeByIdAsync(specNode(out, "auto").id);
  const fixed = await figma.getNodeByIdAsync(specNode(out, "fixed").id);
  assert.equal(auto.layoutAlign, "STRETCH");
  assert.notEqual(fixed.layoutAlign, "STRETCH");
});

test("align/cross: supported words map; an unrealizable value (space-around/evenly) fails loud, not a silent MIN", async () => {
  // The supported words flow through to the layout IR (the bridge maps them to Figma enums).
  assert.equal(compileTree(({ type: "FRAME", layout: { mode: "row", justifyContent: "space-between" } }), "spec").layout!.justifyContent, "between");
  assert.equal(compileTree(({ type: "FRAME", layout: { mode: "row", alignItems: "stretch" } }), "spec").layout!.alignItems, "stretch");
  // Figma auto-layout can't realize CSS space-around/space-evenly. Before the describe-layer gate the bridge
  // silently resolved the miss to MIN (ADR-0003 silent no-op) — now it's a loud, set-naming rejection.
  assert.throws(() => compileTree(({ type: "FRAME", layout: { mode: "row", justifyContent: "space-around" as never } }), "spec"), /layout\.justifyContent must be one of/);
  assert.throws(() => compileTree(({ type: "FRAME", layout: { mode: "row", justifyContent: "space-evenly" as never } }), "spec"), /space-around\/space-evenly/);
  assert.throws(() => compileTree(({ type: "FRAME", layout: { mode: "row", alignItems: "space-between" as never } }), "spec"), /layout\.alignItems must be one of/);
});

test("layout.mode: an unrealizable direction (grid) fails loud, not a silent degrade to free-form", () => {
  // flcm can't author grid — the schema doc promises fail-loud. Before the gate a stray mode fell through
  // to "none" (free-form), silently inerting gap/padding/justify/align (ADR-0003 silent no-op).
  assert.equal(compileTree(({ type: "FRAME", layout: { mode: "column" } }), "spec").layout!.mode, "column");
  assert.equal(compileTree(({ type: "FRAME" }), "spec").layout!.mode, "none"); // omitted mode is free-form, not an error
  assert.throws(() => compileTree(({ type: "FRAME", layout: { mode: "grid" as never } }), "spec"), /layout\.mode must be one of/);
});

test("textStyle.textAlign: supported words pass; an unrecognized value fails loud, not a silent left", () => {
  assert.equal(compileTree(({ type: "TEXT", text: "t", textStyle: { textAlign: "center" } }), "spec").textStyle!.textAlign, "center");
  assert.throws(() => compileTree(({ type: "TEXT", text: "t", textStyle: { textAlign: "middle" as never } }), "spec"), /textStyle\.textAlign must be one of/);
});

test("blend: a CSS mix-blend-mode name maps to the Figma enum on any node; unknown fails loud", async () => {
  assert.equal(compileTree(({ type: "FRAME", mixBlendMode: "screen" }), "spec").blendMode, "SCREEN");
  assert.equal(compileTree(({ type: "TEXT", text: "hi", mixBlendMode: "soft-light" }), "spec").blendMode, "SOFT_LIGHT");
  assert.equal(compileTree(({ type: "ELLIPSE", mixBlendMode: "MULTIPLY" }), "spec").blendMode, "MULTIPLY"); // case-insensitive (CSS keywords are)
  assert.throws(() => compileTree(({ type: "FRAME", mixBlendMode: "plus-lighter" }), "spec"), /unsupported blend/); // real CSS keyword, no Figma mapping
  // Applied once in the shared dispatch (buildNode), so every node kind gets it live.
  const out = await render(({ type: "FRAME", mixBlendMode: "overlay", children: [({ type: "ELLIPSE", key: "dot", mixBlendMode: "screen" })] }));
  assert.equal((await figma.getNodeByIdAsync(out.id)).blendMode, "OVERLAY");
  assert.equal((await figma.getNodeByIdAsync(specNode(out, "dot").id)).blendMode, "SCREEN");
});

test("maxLines: clamps to N lines against a bounded width; unbounded or non-integer fails loud", async () => {
  assert.equal(compileTree(({ type: "TEXT", text: "t", textStyle: { lineClamp: 2 }, width: 200 }), "spec").maxLines, 2);
  assert.equal(compileTree(({ type: "TEXT", text: "t", textStyle: { lineClamp: 1 }, width: "fill" }), "spec").maxLines, 1);
  assert.equal(compileTree(({ type: "TEXT", text: "t", textStyle: { lineClamp: 3 }, width: "50%" }), "spec").maxLines, 3);
  // Unbounded (hug / absent width): a width-hugging text has no wrap to clamp -> loud, not a silent no-op.
  assert.throws(() => compileTree(({ type: "TEXT", text: "t", textStyle: { lineClamp: 2 } }), "spec"), /bounded width/);
  assert.throws(() => compileTree(({ type: "TEXT", text: "t", textStyle: { lineClamp: 2 }, width: "hug" }), "spec"), /bounded width/);
  // N must be a whole number ≥ 1.
  assert.throws(() => compileTree(({ type: "TEXT", text: "t", textStyle: { lineClamp: 0 }, width: 200 }), "spec"), /whole number/);
  assert.throws(() => compileTree(({ type: "TEXT", text: "t", textStyle: { lineClamp: 1.5 }, width: 200 }), "spec"), /whole number/);
  // Sets the plugin truncation props at render (textTruncation:"ENDING" gives the automatic ellipsis).
  const t = await figma.getNodeByIdAsync((await render(({ type: "TEXT", text: "A very long title indeed", textStyle: { lineClamp: 2 }, width: 120 }))).id);
  assert.equal(t.maxLines, 2);
  assert.equal(t.textTruncation, "ENDING");
});

test("frames don't clip by default; clip:true opts in", async () => {
  const def = await figma.getNodeByIdAsync((await render(({ type: "FRAME" }))).id);
  const on = await figma.getNodeByIdAsync((await render(({ type: "FRAME", clip: true }))).id);
  const off = await figma.getNodeByIdAsync((await render(({ type: "FRAME", clip: false }))).id);
  assert.equal(def.clipsContent, false);
  assert.equal(on.clipsContent, true);
  assert.equal(off.clipsContent, false);
});
