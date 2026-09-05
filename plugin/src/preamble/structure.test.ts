// The structural verbs. What must not regress silently: an inserted spec is attached BEFORE it is
// sized (so parent-dependent sizing actually resolves — the invariant-3 hazard), a live target is
// MOVED rather than copied and has its flow marks re-aimed at the new parent, legality is re-asked
// against the DESTINATION, and every rejection fires with zero writes. The undo scaffold's call
// sequence is pinned by mutation-lock.test.ts, not re-asserted here.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, text, render, id } from "./flcm.js";
import { append, prepend, insertBefore, insertAfter, move, remove, clone } from "./structure.js";
import { get } from "./read.js";
import { readKey } from "./identity.js";

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
  assert.equal(out.to.id, row.id);
  assert.equal(out.to.width, 300);
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
  // The whole tree is authenticated, not just the root a constructor happened to mint: a
  // hand-built CHILD states cross-field combinations the compile can never produce (ADR-0012).
  await assert.rejects(
    append("row", frame({ width: 40, height: 40 }, [{ type: "RECTANGLE" }])),
    /hand-built "RECTANGLE"/,
  );
  await assert.rejects(append("row", [rect({}), rect({})]), /one node per call/);
  assert.deepEqual(names(row), ["RECTANGLE", "Frame"]);
  assert.deepEqual(figma.undoLog, before);
});

test("move reparents a live node, and refuses a spec — creating is append's job", async () => {
  const out = await render(
    frame({ key: "board", width: 400, height: 400 }, [
      frame({ key: "row", width: 300, height: 100, layout: { mode: "row" } }, [
        rect({ key: "chip", width: 40, height: 40 }),
      ]),
      frame({ key: "tray", width: 200, height: 200 }),
    ]),
  );
  const chip = await figma.getNodeByIdAsync(out.keyed.chip.id);
  const moved = await move("chip", "tray");
  assert.equal(chip.parent.id, out.keyed.tray.id);
  assert.equal(moved.node.id, chip.id);
  assert.equal(moved.from.key, "row");
  assert.equal(moved.to.key, "tray");
  const before = [...figma.undoLog];
  await assert.rejects(move(rect({}), "tray"), /moves a node that already exists/);
  assert.deepEqual(figma.undoLog, before);
});

test("remove deletes the subtree and reports the id plus the reflowed parent", async () => {
  const out = await render(
    frame({ key: "row", layout: { mode: "row", gap: 10 } }, [
      rect({ key: "a", width: 40, height: 40 }),
      rect({ key: "b", width: 40, height: 40 }),
    ]),
  );
  const row = await figma.getNodeByIdAsync(out.keyed.row.id);
  const a = await figma.getNodeByIdAsync(out.keyed.a.id);
  assert.equal(row.width, 90); // 40 + 10 gap + 40, hugged
  const gone = await remove("a");
  assert.equal(gone.removedId, a.id);
  assert.equal(a.removed, true);
  assert.deepEqual(row.children.map((c) => c.id), [out.keyed.b.id]);
  // Why remove reports the parent at all: a hug parent reflows the moment a child leaves.
  assert.equal(gone.from.width, 40);
});

test("clone duplicates an INSTANCE-bearing subtree and strips every flcm/key from the copy", async () => {
  // A component instance is the case a spec REBUILD can't reproduce — the reason clone exists.
  const src = await render(frame({ key: "badge", width: 60, height: 60 }, [rect({ width: 20, height: 20 })]));
  const component = figma.createComponentFromNode(await figma.getNodeByIdAsync(src.keyed.badge.id));
  const out = await render(
    frame({ key: "card", width: 200, height: 200 }, [text("Hi", { key: "title" })]),
  );
  const card = await figma.getNodeByIdAsync(out.keyed.card.id);
  card.appendChild(component.createInstance());
  const tray = await render(frame({ key: "tray", width: 300, height: 300 }));

  const copied = await clone("card", "tray");
  const copy = await figma.getNodeByIdAsync(copied.node.id);
  assert.equal(copy.parent.id, tray.keyed.tray.id);
  assert.equal(copied.to.id, tray.keyed.tray.id);
  // Faithful: the same children in the same order, the instance still an instance of the same main.
  assert.deepEqual(copy.children.map((c) => c.type), ["TEXT", "INSTANCE"]);
  assert.equal(copy.children[0].characters, "Hi");
  assert.equal(copy.children[1].mainComponent.id, component.id);
  // Key-less, all the way down — a copied key would mint a second node at the same address.
  const keysUnder = (n) => [readKey(n), ...n.children.flatMap(keysUnder)];
  assert.deepEqual(keysUnder(copy).filter(Boolean), []);
  // …and so the originals' keys still resolve, each to exactly one node (resolveTarget throws on a clash).
  assert.equal((await get("card")).id, card.id);
  assert.equal((await get("title")).id, out.keyed.title.id);
});

test("an instance's CHILD LIST is closed, but the instance itself is an ordinary node", async () => {
  const out = await render(
    frame({ key: "src", width: 60, height: 60 }, [frame({ key: "slot", width: 20, height: 20 })]),
  );
  const src = await figma.getNodeByIdAsync(out.keyed.src.id);
  const component = figma.createComponentFromNode(src);
  const instance = component.createInstance();
  instance.name = "Card instance";
  const dest = await render(frame({ key: "dest", width: 100, height: 100 }));
  await assert.rejects(append(id(instance.id), rect({})), /inside component instance "Card instance"/);
  await assert.rejects(append(id(instance.children[0].id), rect({})), /inside component instance "Card instance"/);
  await assert.rejects(append("dest", id(instance.children[0].id)), /node being moved or removed is inside component instance/);
  // …and the other half of the rule: Figma freezes an instance's CHILDREN, not the instance, which
  // is a normal child of its own parent. Moving and deleting one are everyday operations.
  await move(id(instance.id), "dest");
  assert.equal(instance.parent.id, dest.keyed.dest.id);
  const second = component.createInstance();
  const gone = await remove(id(second.id));
  assert.equal(gone.removedId, second.id);
});

test("a `get` result is refused rather than silently moving the node it describes", async () => {
  const out = await render(
    frame({ key: "card", width: 200, height: 100, fill: "#fff" }, [
      rect({ key: "plain", width: 20, height: 20 }),
    ]),
  );
  const card = await figma.getNodeByIdAsync(out.keyed.card.id);
  const plain = await figma.getNodeByIdAsync(out.keyed.plain.id);
  await render(frame({ key: "tray", width: 300, height: 300 }));
  // The trap this closes: a read spec carries a live `id`, exactly as a handle does, so a
  // shape-based dispatch would have taken this for a target and CUT the node out of its parent.
  await assert.rejects(append("tray", await get("card")), /is a `get` result/);
  // …including the bare read shape that carries no styling at all to give it away. That one is
  // caught by identity (the read-side brand), which is why the field sniff can stay a fallback.
  await assert.rejects(append("tray", await get("plain")), /is a `get` result/);
  assert.equal(card.parent.id, figma.currentPage.id);
  assert.equal(plain.parent.id, card.id);
});

test("clone with no parent lands the copy on the original's own coordinates", async () => {
  const out = await render(frame({ key: "board", width: 400, height: 400 }, [
    rect({ key: "chip", width: 40, height: 40, left: 30, top: 50 }),
  ]));
  const copied = await clone("chip");
  const copy = await figma.getNodeByIdAsync(copied.node.id);
  assert.equal(copy.parent.id, out.keyed.board.id); // no parent named ⇒ the original's own
  assert.equal(copied.to.id, out.keyed.board.id);
  // Faithful means faithful: in a free-form parent the copy sits exactly on top of the original.
  assert.deepEqual([copy.x, copy.y], [30, 50]);
});
