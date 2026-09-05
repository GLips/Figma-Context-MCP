// ADR-0003 code-fix tests that need construction and/or a live render. Constructors are inert POJOs, so
// pad rejection is checked on the built WriteNode; cross:"stretch" and the clip default are render-time
// (bridge) behavior, exercised against the in-memory figma mock the dogfood harness uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, text, ellipse, line, rect, render, gradient, effects } from "./flcm.js";

// The bridge reads figma.* only inside render(); constructors never touch it. Install the mock before any
// render runs. (flcm.js imports are figma-free at module load, so static import above is safe.)
createFigmaMock();

test("pad: numbers, the CSS box shorthand and edge objects compile; an out-of-subset unit rejects", () => {
  // mode named on the positives: padding without a row/column mode rejects at create (the shared
  // realizability gate), so the pad-compile assertions need a legal container.
  assert.deepEqual(frame({ layout: { mode: "row", padding: 24 } }).layout!.padding, { top: 24, right: 24, bottom: 24, left: 24 });
  assert.deepEqual(frame({ layout: { mode: "row", padding: { x: 8, y: 16 } } }).layout!.padding, { top: 16, right: 8, bottom: 16, left: 8 });
  assert.deepEqual(frame({ layout: { mode: "row", padding: { top: 4, left: 2 } } }).layout!.padding, { top: 4, right: 0, bottom: 0, left: 2 });
  // The read shape's own spelling: `get` returns padding as a CSS box shorthand, so a spec re-authors
  // as-is. All four CSS arities, since the 1/2/3-part forms mirror sides rather than defaulting to 0.
  assert.deepEqual(frame({ layout: { mode: "row", padding: "24px" } }).layout!.padding, { top: 24, right: 24, bottom: 24, left: 24 });
  assert.deepEqual(frame({ layout: { mode: "row", padding: "12px 16px" } }).layout!.padding, { top: 12, right: 16, bottom: 12, left: 16 });
  assert.deepEqual(frame({ layout: { mode: "row", padding: "1px 2px 3px" } }).layout!.padding, { top: 1, right: 2, bottom: 3, left: 2 });
  assert.deepEqual(frame({ layout: { mode: "row", padding: "1px 2px 3px 4px" } }).layout!.padding, { top: 1, right: 2, bottom: 3, left: 4 });
  // An edge takes the same number-or-"Npx" every other metric does; anything outside that subset
  // fails loud rather than coercing to a wrong pixel.
  assert.deepEqual(frame({ layout: { mode: "row", padding: { x: "24px" } } }).layout!.padding, { top: 0, right: 24, bottom: 0, left: 24 });
  assert.throws(() => frame({ layout: { padding: { x: "24em" } as never } }), /pad\.x must be a number or "Npx"/);
  assert.throws(() => frame({ layout: { padding: [] as never } }), /pad must be a number, a CSS box shorthand/);
});

test("strokeAlign takes the read shape's own lowercase words and rejects anything else", () => {
  // Same spelling on both sides of the surface: a `get` result reports "outside"/"center" and spreads
  // straight back into a constructor. Absent means Figma's INSIDE, which is the CSS `border`.
  assert.equal(rect({ stroke: "#000", strokeAlign: "outside" }).strokeAlign, "OUTSIDE");
  assert.equal(rect({ stroke: "#000", strokeAlign: "center" }).strokeAlign, "CENTER");
  assert.equal(rect({ stroke: "#000" }).strokeAlign, undefined);
  assert.throws(() => rect({ strokeAlign: "outer" as never }), /strokeAlign is "inside", "outside" or "center"/);
});

test("create rejects layout words the type can't realize — the SAME gate edit consults (no asymmetry)", () => {
  // One authority answers for both verbs (layout-legality.ts assertLayoutRealizableForType), so
  // the pin is one test per rule, not per verb — a rule can't be strict in edit and lax in create.
  assert.throws(() => text("hi", { height: 80 }), /a TEXT's height follows its content/);
  // "hug" IS what a created text does, so the word is the default restated, not a request to refuse
  // (read reports every text as height:"hug", and a read spec spreads straight into flcm.text).
  assert.doesNotThrow(() => text("hi", { height: "hug" }));
  assert.throws(() => rect({ width: "hug" }), /"hug" sizes to content/);
  assert.throws(() => frame({ width: "hug" }), /"hug" sizes to content/);
  assert.throws(() => frame({ layout: { gap: 12 } }), /need an auto-layout/);
  // The words themselves stay legal where the type can realize them.
  assert.doesNotThrow(() => frame({ width: "hug", layout: { mode: "row", gap: 12 } }));
  assert.doesNotThrow(() => text("hi", { width: "hug" }));
});

test("a metric is a number or \"Npx\" everywhere — width/height and left/top read the same as gap", () => {
  // One spelling rule across the whole surface: if a prop takes px, it takes both forms. The
  // alternative (numbers here, strings there) is a rule an author has to memorize per prop.
  const px = frame({ width: "320px", height: 200, left: "16px", top: 8 });
  assert.deepEqual(px.layout!.dimensions, { width: 320, height: 200 });
  assert.equal(px.layout!.left, 16);
  assert.equal(px.layout!.top, 8);
  // The subset still holds — an unsupported unit fails loud rather than coercing to wrong pixels.
  assert.throws(() => frame({ width: "20em" }), /width\/height must be a number/);
  assert.throws(() => frame({ left: "20vw" }), /left must be a number/);
});

test("hand-built node POJOs reject whole — the compiled IR is not an authoring surface", async () => {
  // A hand-built object can state cross-field combinations the constructors' compile can never
  // produce (a dimension without its sizing twin, a mode on a shape), and each would land as a
  // silent partial write — so the dialect is refused at the door, root and child alike.
  await assert.rejects(render({ type: "RECTANGLE", layout: { mode: "row", gap: 12 } } as never), /hand-built "RECTANGLE" object/);
  await assert.rejects(
    render(frame({ width: 300, height: 200 }, [{ type: "TEXT", text: "hi", layout: { percentSize: { height: 50 } } } as never])),
    /hand-built "TEXT" object/,
  );
  // Provenance is WeakSet identity, so no lookalike passes: a spread-copy and a prototype child
  // are different objects from anything the constructors minted.
  await assert.rejects(render({ ...frame({ width: 100, height: 100 }) } as never), /hand-built "FRAME" object/);
  await assert.rejects(render(Object.create(frame({ width: 100, height: 100 })) as never), /hand-built "FRAME" object/);
  // Constructor output is deep-frozen: post-hoc mutation cannot smuggle unvalidated IR past the
  // gate (strict mode makes the write itself throw).
  const sealed = frame({ width: 100, height: 100 });
  assert.throws(() => { (sealed as { layout?: unknown }).layout = { mode: "row", gap: 12 }; }, TypeError);
});

test("the seal clones caller inputs — nothing caller-reachable is frozen, nothing mutable leaks in", () => {
  // The caller's own effects array survives the seal unfrozen (the node froze a clone)…
  const fx = effects({ shadow: "0 4px 8px #00000022" });
  rect({ width: 10, height: 10, effects: fx });
  assert.doesNotThrow(() => fx.push(fx[0]));
  // …and a caller-frozen SHELL can't shield mutable descendants: the node keeps a clone, so
  // mutating the original spec's stops after construction changes nothing the node will render.
  const g = gradient("linear", [{ color: "#000000" }, { color: "#ffffff" }]);
  Object.freeze(g); // shallow — g.stops entries stay mutable in the caller's hands
  const wn = rect({ width: 10, height: 10, fill: g });
  const before = JSON.stringify(wn.fills![0]);
  (g as { stops: { color: { r: number } }[] }).stops[0].color.r = 0.75;
  assert.equal(JSON.stringify(wn.fills![0]), before);
  // The one exception: a passed CHILDREN array is frozen IN PLACE — a push after frame() would
  // otherwise build a node the author believes has children and silently render an empty frame.
  const kids = [rect({ width: 5, height: 5 })];
  frame({ width: 50, height: 50 }, kids);
  assert.throws(() => kids.push(rect({ width: 5, height: 5 })), TypeError);
});

test("root position words land on the page; an in-flow child's explicit pin is stored", async () => {
  // Both are create/edit symmetry pins: edit applies left/top to a page child and writes an
  // explicit pin unconditionally, so create dropping either would diverge the verbs.
  const out = await render(frame({ width: 40, height: 40, left: 42, top: 17, layout: { mode: "row", gap: 4 } }, [
    rect({ width: 10, height: 10, pin: { x: "right" } }),
  ]));
  const root = await figma.getNodeByIdAsync(out.root.id);
  assert.equal(root.x, 42);
  assert.equal(root.y, 17);
  assert.equal(root.children[0].constraints.horizontal, "MAX");
});

test('parent-relative strictness at render: a root "fill" and an out-of-flow TEXT height:"fill" reject', async () => {
  // Same rules as edit's live gates, shared predicates in layout-legality.ts — the root sits on
  // the page (no bounded size), and out of flow a text's fill-height would silently not stick.
  await assert.rejects(render(frame({ width: "fill", layout: { mode: "row" } })), /root node's parent is the page/);
  await assert.rejects(
    render(frame({ width: 300, height: 200 }, [text("t", { height: "fill" })])),
    /in-flow child of a row\/column auto-layout parent/,
  );
});

test("a present-but-mistyped scalar rejects loud on the constructor paths (QuickJS has no type checking)", () => {
  // The silent-drop bug this pins: a typeof guard used to skip the bad value and commit the rest.
  assert.throws(() => rect({ opacity: "bad" as never }), /`opacity` must be a number/);
  assert.throws(() => line({ rotation: "bad" as never }), /`rotation` must be a number/);
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
