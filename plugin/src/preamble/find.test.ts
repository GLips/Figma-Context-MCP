// flcm.find / findOne / selection — the locate verbs return SlimHandles: the identity core plus a cheap
// layout world-model, a sparse projection of the same canonical shape `get` emits. These pin the live-path
// plumbing (query filter → simplify index → slim projection) over the figma mock; the shape's parity with
// `get` is pinned by the REST↔scene harness and get.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, text, render, find, findOne, selection } from "./flcm.js";

test("find returns matching nodes as slim handles with in-context sizing intent", async () => {
  createFigmaMock();
  await render(
    frame({ key: "card", width: 200, height: 100, layout: { mode: "row", gap: 8, padding: 12 } }, [
      rect({ key: "chip", width: 40, height: 40 }),
      text("hi", { key: "label" }),
    ]),
  );

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
  await render(
    frame({ key: "card", width: 200, height: 120, layout: { mode: "column", gap: 8 } }, [
      rect({ key: "floaty", absolute: { x: 5, y: 7 }, width: 10, height: 10 }),
    ]),
  );

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
  await render(
    frame({ key: "root", name: "Root" }, [
      frame({ name: "Primary Button", width: 80, height: 30 }),
      frame({ name: "Secondary Button", width: 80, height: 30 }),
      text("Button label", { name: "Label" }),
    ]),
  );

  const buttons = await find({ type: "FRAME", name: "button" });
  assert.deepEqual(
    buttons.map((h) => h.name).sort(),
    ["Primary Button", "Secondary Button"],
  );
});

test("find returns empty for no match; an unknown query key fails loud", async () => {
  createFigmaMock();
  await render(frame({ key: "root" }, [rect({ key: "card" })]));

  assert.deepEqual(await find({ type: "ELLIPSE" }), []);
  // A typo'd facet must not silently match everything (ADR-0003 fail-loud).
  await assert.rejects(find({ tpye: "FRAME" } as never), /unknown query key.*"tpye"/s);
});

test("findOne returns the single hit, and throws naming the count on 0 or >1", async () => {
  createFigmaMock();
  await render(
    frame({ key: "root" }, [rect({ key: "only", width: 10, height: 10 }), rect({ name: "dup" }), rect({ name: "dup" })]),
  );

  const one = await findOne({ key: "only" });
  assert.equal(one.key, "only");

  await assert.rejects(findOne({ key: "ghost" }), /expected exactly one match.*found 0/s);
  await assert.rejects(findOne({ type: "RECTANGLE" }), /expected exactly one match.*found 3/s);
});

test("selection returns the current selection as slim handles; empty when nothing is selected", async () => {
  const figma = createFigmaMock();
  const out = await render(
    frame({ key: "card", width: 100, height: 100, layout: { mode: "column" } }, [
      rect({ key: "chip", width: 20, height: 20 }),
    ]),
  );

  assert.deepEqual(await selection(), []);

  const chipNode = figma.getNodeById(out.keyed.chip.id);
  figma.currentPage.selection = [chipNode];
  const sel = await selection();
  assert.equal(sel.length, 1);
  assert.equal(sel[0].key, "chip");
  assert.equal(sel[0].width, 20);
});

test("find excludes hidden nodes — the read shape covers the rendered document, like get", async () => {
  const figma = createFigmaMock();
  const out = await render(
    frame({ key: "wrap", width: 100, height: 100, layout: { mode: "column" } }, [
      rect({ key: "shown", width: 10, height: 10 }),
      rect({ key: "gone", width: 10, height: 10 }),
    ]),
  );
  figma.getNodeById(out.keyed.gone.id).visible = false;

  const rects = await find({ type: "RECTANGLE" });
  assert.deepEqual(
    rects.map((h) => h.key),
    ["shown"],
  );
  // A hit whose ancestor is hidden is also unrendered.
  figma.getNodeById(out.keyed.wrap.id).visible = false;
  assert.deepEqual(await find({ type: "RECTANGLE" }), []);
});

test("a hit inside a core-collapsed SVG container still projects identity (no geometry)", async () => {
  // The shared core collapses an SVG-heavy container (a free-form frame whose children are all shape
  // primitives) into one IMAGE-SVG node, dropping the descendants — the same egress behavior REST's read
  // has. A hit inside such a container is absent from the simplify index, so its slim handle is
  // identity-only rather than throwing. (To inspect it fully, `get(hit)` roots the node and doesn't
  // collapse a lone primitive.)
  createFigmaMock();
  await render(frame({ key: "icon", width: 24, height: 24 }, [rect({ key: "dot", width: 4, height: 4 })]));

  const [dot] = await find({ key: "dot" });
  assert.equal(dot.key, "dot");
  assert.equal(dot.type, "RECTANGLE");
  assert.equal(dot.width, undefined);
});
