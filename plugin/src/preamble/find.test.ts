import { specNode } from "../../harness/spec-node.js";
// flcm.find / findOne / selection — the locate verbs return SlimHandles: the identity core plus a cheap
// layout world-model, a sparse projection of the same canonical shape `get` emits. These pin the live-path
// plumbing (query filter → simplify index → slim projection) over the figma mock; the shape's parity with
// `get` is pinned by the REST↔scene harness and get.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { find, findOne, selection } from "./flcm.js";
import { render } from "./render.js";

test("find returns matching nodes as slim handles with in-context sizing intent", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    key: "card",
    width: 200,
    height: 100,
    layout: { mode: "row", gap: 8, padding: 12 },
    children: [
      { type: "RECTANGLE", key: "chip", width: 40, height: 40 },
      { type: "TEXT", text: "hi", key: "label" },
    ],
  });

  const rects = await find({ type: "RECTANGLE" });
  assert.equal(rects.length, 1);
  const chip = rects[0];
  assert.equal(chip.type, "RECTANGLE");
  assert.equal(chip.key, "chip");
  // Authored-fixed axis → a real px number, NOT a misleading computed size.
  assert.equal(chip.width, 40);
  assert.equal(chip.height, 40);
  // A leaf in auto-layout flow: no layout mode, no out-of-flow position.
  assert.equal(chip.layout, undefined);
  assert.equal(chip.position, undefined);

  const texts = await find({ type: "TEXT" });
  // A hugging text reports sizing INTENT, never a fabricated px width.
  assert.equal(texts[0].width, "hug");
  assert.equal(texts[0].text, "hi");
});

test("find surfaces container mode + childCount, and out-of-flow position/left/top", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    key: "card",
    width: 200,
    height: 120,
    layout: { mode: "column", gap: 8 },
    children: [{ type: "RECTANGLE", key: "floaty", left: 5, top: 7, width: 10, height: 10 }],
  });

  const [card] = await find({ key: "card" });
  assert.deepEqual(card.layout, { mode: "column" });
  assert.equal(card.childCount, 1);

  const [floaty] = await find({ key: "floaty" });
  assert.equal(floaty.position, "absolute");
  assert.equal(floaty.left, 5);
  assert.equal(floaty.top, 7);
});

test("find AND-combines facets; name is a case-insensitive substring", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    key: "root",
    name: "Root",
    children: [
      { type: "FRAME", name: "Primary Button", width: 80, height: 30 },
      { type: "FRAME", name: "Secondary Button", width: 80, height: 30 },
      { type: "TEXT", text: "Button label", name: "Label" },
    ],
  });

  const buttons = await find({ type: "FRAME", name: "button" });
  assert.deepEqual(buttons.map((h) => h.name).sort(), ["Primary Button", "Secondary Button"]);
});

test("find returns empty for no match; an unknown query key fails loud", async () => {
  createFigmaMock();
  await render({ type: "FRAME", key: "root", children: [{ type: "RECTANGLE", key: "card" }] });

  assert.deepEqual(await find({ type: "ELLIPSE" }), []);
  // A typo'd facet must not silently match everything (ADR-0003 fail-loud).
  await assert.rejects(find({ tpye: "FRAME" } as never), /unknown query key.*"tpye"/s);
});

test("findOne returns the single hit, and throws naming the count on 0 or >1", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    key: "root",
    children: [
      { type: "RECTANGLE", key: "only", width: 10, height: 10 },
      { type: "RECTANGLE", name: "dup" },
      { type: "RECTANGLE", name: "dup" },
    ],
  });

  const one = await findOne({ key: "only" });
  assert.equal(one.key, "only");

  await assert.rejects(findOne({ key: "ghost" }), /expected exactly one match.*found 0/s);
  await assert.rejects(findOne({ type: "RECTANGLE" }), /expected exactly one match.*found 3/s);
});

test("selection returns the current selection as slim handles; empty when nothing is selected", async () => {
  const figma = createFigmaMock();
  const out = await render({
    type: "FRAME",
    key: "card",
    width: 100,
    height: 100,
    layout: { mode: "column" },
    children: [{ type: "RECTANGLE", key: "chip", width: 20, height: 20 }],
  });

  assert.deepEqual(await selection(), []);

  const chipNode = await figma.getNodeByIdAsync(specNode(out, "chip").id);
  figma.currentPage.selection = [chipNode];
  const sel = await selection();
  assert.equal(sel.length, 1);
  assert.equal(sel[0].key, "chip");
  assert.equal(sel[0].width, 20);
});

test("find includes hidden nodes and descendants of hidden ancestors", async () => {
  const figma = createFigmaMock();
  const out = await render({
    type: "FRAME",
    key: "wrap",
    width: 100,
    height: 100,
    layout: { mode: "column" },
    children: [
      { type: "RECTANGLE", key: "shown", width: 10, height: 10 },
      { type: "RECTANGLE", key: "gone", width: 10, height: 10 },
    ],
  });
  (await figma.getNodeByIdAsync(specNode(out, "gone").id)).visible = false;

  const rects = await find({ type: "RECTANGLE" });
  assert.deepEqual(
    rects.map((h) => h.key),
    ["shown", "gone"],
  );
  // A hit whose ancestor is hidden is also unrendered.
  (await figma.getNodeByIdAsync(specNode(out, "wrap").id)).visible = false;
  assert.equal((await find({ type: "RECTANGLE" })).length, 2);
});

test("find with a predicate keeps only nodes it accepts, against inline styling values", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    key: "wrap",
    width: 200,
    height: 100,
    layout: { mode: "row", gap: 8 },
    children: [
      { type: "RECTANGLE", key: "white", width: 40, height: 40, fill: "#ffffff" },
      { type: "RECTANGLE", key: "black", width: 40, height: 40, fill: "#000000" },
    ],
  });

  // The predicate reads the EXPANDED read shape — a fill is an inline hex value, not a "fill_…" ref.
  const whites = await find({ type: "RECTANGLE" }, (n) => n.fill === "#FFFFFF");
  assert.deepEqual(
    whites.map((h) => h.key),
    ["white"],
  );
  // Matches still come back as SlimHandles (find's contract holds) — identity + layout world-model.
  assert.equal(whites[0].type, "RECTANGLE");
  assert.equal(whites[0].width, 40);
});

test("a predicate-only find (no query facets) materializes every rendered candidate", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    key: "wrap",
    width: 100,
    height: 100,
    layout: { mode: "column" },
    fill: "#112233",
    children: [
      { type: "RECTANGLE", key: "opaque", width: 10, height: 10 },
      { type: "RECTANGLE", key: "faded", width: 10, height: 10, opacity: 0.5 },
    ],
  });

  const faded = await find({}, (n) => n.opacity !== undefined && n.opacity < 1);
  assert.deepEqual(
    faded.map((h) => h.key),
    ["faded"],
  );
});

test("query pre-filter narrows what the predicate sees (hybrid filter)", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    key: "wrap",
    width: 200,
    height: 100,
    layout: { mode: "row", gap: 8 },
    children: [
      { type: "FRAME", key: "panel", width: 40, height: 40, fill: "#ffffff" },
      { type: "RECTANGLE", key: "chip", width: 40, height: 40, fill: "#ffffff" },
    ],
  });

  // Same fill predicate, but the query facet restricts candidates to FRAMEs — the rect is never tested.
  const whiteFrames = await find({ type: "FRAME" }, (n) => n.fill === "#FFFFFF");
  assert.deepEqual(
    whiteFrames.map((h) => h.key),
    ["panel"],
  );
});

test("findOne threads the predicate and keeps its cardinality guard", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    key: "wrap",
    width: 200,
    height: 100,
    layout: { mode: "row", gap: 8 },
    children: [
      { type: "RECTANGLE", key: "white", width: 40, height: 40, fill: "#ffffff" },
      { type: "RECTANGLE", key: "black", width: 40, height: 40, fill: "#000000" },
    ],
  });

  const one = await findOne({ type: "RECTANGLE" }, (n) => n.fill === "#FFFFFF");
  assert.equal(one.key, "white");
  // No white ellipse → 0 matches → the count-naming throw still fires.
  await assert.rejects(
    findOne({ type: "ELLIPSE" }, (n) => n.fill === "#FFFFFF"),
    /expected exactly one match.*found 0/s,
  );
});

test("a predicate-only find fails loud past the materialization cap, naming it", async () => {
  const figma = createFigmaMock();
  // Exercise the actual indexed acquisition boundary with a large candidate set.
  for (let i = 0; i < 5001; i++) figma.currentPage.appendChild(figma.createRectangle());

  await assert.rejects(
    find({}, () => true),
    /5001 candidate nodes, over the 5000-node materialization cap/s,
  );
});

test("find predicates see geometry inside SVG-heavy containers", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    key: "icon",
    width: 24,
    height: 24,
    children: [{ type: "RECTANGLE", key: "dot", width: 4, height: 4 }],
  });

  const [dot] = await find({ key: "dot" });
  assert.equal(dot.key, "dot");
  assert.equal(dot.type, "RECTANGLE");
  assert.equal(dot.width, 4);

  assert.equal((await find({ key: "dot" }, (n) => n.width === 4)).length, 1);
});
