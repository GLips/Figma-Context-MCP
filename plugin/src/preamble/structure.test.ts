// The structural verbs. What must not regress silently: an inserted spec is attached BEFORE it is
// sized (so parent-dependent sizing actually resolves — the invariant-3 hazard), a live target is
// MOVED rather than copied and has its flow marks re-aimed at the new parent, legality is re-asked
// against the DESTINATION, and every rejection fires with zero writes. The undo scaffold's call
// sequence is pinned by mutation-lock.test.ts, not re-asserted here.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, text, render, id } from "./flcm.js";
import { append, prepend, insertBefore, insertAfter } from "./structure.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

// A 300px-wide row with two keyed children, the shape most of these tests place into.
async function renderRow() {
  const out = await render(
    frame({ key: "row", width: 300, height: 100, layout: { mode: "row", gap: 10, padding: 5 } }, [
      rect({ key: "a", width: 40, height: 40 }),
      rect({ key: "b", width: 40, height: 40 }),
    ]),
  );
  return figma.getNodeByIdAsync(out.keyed.row.id);
}

const names = (node) => node.children.map((c) => c.name);

test("append builds a spec into the destination and sizes it THERE — fill fills the live parent", async () => {
  const row = await renderRow();
  const out = await append("row", rect({ key: "filler", name: "filler", width: "fill", height: 20 }));
  assert.deepEqual(names(row), ["RECTANGLE", "RECTANGLE", "filler"]);
  // The ordering hazard: sized before attaching, "fill" would have collapsed to the rect's own
  // intrinsic 100. The row is 300 wide with 5px padding either side.
  const filler = row.children[2];
  assert.equal(filler.layoutGrow, 1);
  assert.equal(filler.width, 290);
  // render's own return shape, plus the attach point with fresh geometry.
  assert.equal(out.root.id, filler.id);
  assert.equal(out.keyed.filler.id, filler.id);
  assert.equal(out.parent.id, row.id);
  assert.equal(out.parent.width, 300);
});

test("a percent size on an inserted spec resolves against the live destination", async () => {
  await render(frame({ key: "board", width: 200, height: 200 }));
  const out = await append("board", rect({ name: "half", width: "50%", height: 20 }));
  assert.equal(out.root.width, 100);
});

test("prepend, insertBefore and insertAfter each land where their name says", async () => {
  const row = await renderRow();
  await prepend("row", rect({ name: "first" }));
  await insertBefore("a", rect({ name: "before-a" }));
  await insertAfter("b", rect({ name: "after-b" }));
  assert.deepEqual(names(row), ["first", "before-a", "RECTANGLE", "RECTANGLE", "after-b"]);
});

test("placing a LIVE target moves it — including a reorder inside one parent", async () => {
  const row = await renderRow();
  const b = row.children[1];
  const out = await insertBefore("a", "b");
  assert.deepEqual(row.children.map((c) => c.id), [b.id, row.children[1].id]);
  assert.equal(out.node.id, b.id);
  assert.equal(out.to.id, row.id);
  // A reorder inside one parent reports the container once, as `to`.
  assert.equal(out.from, undefined);
});

test("a moved node's fill is re-aimed at the new parent's axes, not left on the old one's", async () => {
  const out = await render(
    frame({ key: "page-root", width: 400, height: 400 }, [
      frame({ key: "row", width: 300, height: 100, layout: { mode: "row" } }, [
        rect({ key: "grower", width: "fill", height: 20 }),
      ]),
      frame({ key: "col", width: 200, height: 300, layout: { mode: "column" } }),
    ]),
  );
  const grower = await figma.getNodeByIdAsync(out.keyed.grower.id);
  const col = await figma.getNodeByIdAsync(out.keyed.col.id);
  assert.equal(grower.layoutGrow, 1); // width-fill under a ROW = the primary axis
  const moved = await append("col", "grower");
  assert.equal(grower.parent.id, col.id);
  // Under a COLUMN the same width-fill is the COUNTER axis: the primary mark must be gone or the
  // rect would silently start filling the column's HEIGHT instead.
  assert.equal(grower.layoutGrow, 0);
  assert.equal(grower.layoutAlign, "STRETCH");
  assert.equal(grower.width, 200);
  assert.equal(moved.from.key, "row");
  assert.equal(moved.to.key, "col");
});

test("legality is re-asked against the DESTINATION: a fill can't land on the page", async () => {
  await render(
    frame({ key: "row", width: 300, height: 100, layout: { mode: "row" } }, [
      rect({ key: "grower", width: "fill", height: 20 }),
    ]),
  );
  const before = [...figma.undoLog];
  await assert.rejects(
    append(id(figma.currentPage.id), rect({ width: "fill", height: 20 })),
    /"fill" and "N%" resolve against a parent frame/,
  );
  // A node whose live width fills its row can't be moved to the page either — the words were
  // legal where it sat, not where it would land.
  await assert.rejects(append(id(figma.currentPage.id), "grower"), /parent frame/);
  assert.deepEqual(figma.undoLog, before); // every reject fired in prepare, before any seal
});

test("prepare rejects a non-container destination, a cycle, and a hand-built spec — with zero writes", async () => {
  const out = await render(
    frame({ key: "row", width: 300, height: 100 }, [
      rect({ key: "a", width: 40, height: 40 }),
      frame({ key: "inner", width: 40, height: 40 }),
    ]),
  );
  const row = await figma.getNodeByIdAsync(out.keyed.row.id);
  const before = [...figma.undoLog];
  await assert.rejects(append("a", rect({})), /holds no children/);
  await assert.rejects(append("row", "row"), /can't be placed inside itself/);
  await assert.rejects(append("inner", "row"), /its own descendant/);
  await assert.rejects(append("row", { type: "FRAME" }), /flcm constructors/);
  await assert.rejects(append("row", [rect({}), rect({})]), /one node per call/);
  assert.deepEqual(names(row), ["RECTANGLE", "Frame"]);
  assert.deepEqual(figma.undoLog, before);
});

test("an instance is closed to structural writes, in both directions, naming the instance", async () => {
  const out = await render(
    frame({ key: "src", width: 60, height: 60 }, [frame({ key: "slot", width: 20, height: 20 })]),
  );
  const src = await figma.getNodeByIdAsync(out.keyed.src.id);
  const component = figma.createComponentFromNode(src);
  const instance = component.createInstance();
  instance.name = "Card instance";
  await render(frame({ key: "dest", width: 100, height: 100 }));
  await assert.rejects(append(id(instance.id), rect({})), /inside component instance "Card instance"/);
  await assert.rejects(append(id(instance.children[0].id), rect({})), /inside component instance "Card instance"/);
  await assert.rejects(append("dest", id(instance.children[0].id)), /node being moved is inside component instance/);
});
