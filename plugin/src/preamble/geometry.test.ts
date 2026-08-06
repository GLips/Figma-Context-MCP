// Handle geometry: render() returns each handle's SETTLED geometry, spelled the way the read verbs spell it
// (flat width/height; left/top only when the parent's auto-layout doesn't place the node). Two contracts
// here — the timing (handles are minted after the whole tree is laid out, so a covered child reports its
// settled size and not the provisional hug it held mid-walk) and the spelling (a render handle and a found
// one describe the same node with the same field names — see find.test.ts's out-of-flow case).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, text, render, findOne } from "./flcm.js";

test("a handle reports the node's measured size, and its offset inside a free-form parent", async () => {
  createFigmaMock();
  const out = await render(
    frame({ width: 300, height: 200 }, [
      rect({ key: "box", name: "Box", width: 40, height: 24, absolute: { x: 20, y: 12 } }),
    ]),
  );
  // A free-form parent places nothing, so the child's offset is its own — left/top, and no `position`
  // marker (that marks a child lifted OUT of an auto-layout flow, exactly as the core emits it). The whole
  // shape is asserted: a handle carries identity + this geometry and nothing else.
  assert.deepEqual(out.keyed.box, {
    id: out.keyed.box.id, type: "RECTANGLE", name: "Box", key: "box",
    width: 40, height: 24, left: 20, top: 12,
  });
});

test("a covered child reports its SETTLED size, not its walk-time provisional one", async () => {
  createFigmaMock();
  // w:"fill" only stretches to 300 once the tree settles; handles are minted after that, not at stampKey
  // time when the child still holds its hug width.
  const out = await render(
    frame({ width: 300, height: 200 }, [rect({ key: "bar", width: "fill", height: 12 })]),
  );
  assert.equal(out.keyed.bar.width, 300);
});

test("the root handle carries its size and no offset — a page child has no parent box to be relative to", async () => {
  createFigmaMock();
  const out = await render(frame({ name: "Root", width: 120, height: 80 }));
  assert.deepEqual(out.root, { id: out.root.id, type: "FRAME", name: "Root", width: 120, height: 80 });
});

test("an auto-layout parent's in-flow child reports no offset; an absolute one reports position/left/top", async () => {
  createFigmaMock();
  const out = await render(
    frame({ width: 200, height: 120, layout: { mode: "column", gap: 8, padding: 10 } }, [
      rect({ key: "inflow", width: 40, height: 24 }),
      rect({ key: "floaty", width: 10, height: 10, absolute: { x: 5, y: 7 } }),
    ]),
  );
  // The parent owns an in-flow child's position, so reporting it would invite the agent to pin what the
  // layout decides — the read side omits it for the same reason.
  assert.equal(out.keyed.inflow.left, undefined);
  assert.equal(out.keyed.inflow.top, undefined);
  assert.equal(out.keyed.inflow.position, undefined);
  assert.deepEqual(
    { position: out.keyed.floaty.position, left: out.keyed.floaty.left, top: out.keyed.floaty.top },
    { position: "absolute", left: 5, top: 7 },
  );
});

test("a render handle and a found handle describe one node in one spelling", async () => {
  createFigmaMock();
  const out = await render(
    frame({ width: 200, height: 120, layout: { mode: "column" } }, [
      rect({ key: "floaty", width: 10, height: 10, absolute: { x: 5, y: 7 } }),
    ]),
  );
  const found = await findOne({ key: "floaty" });
  const rendered = out.keyed.floaty;
  assert.deepEqual(
    { position: found.position, left: found.left, top: found.top, width: found.width },
    { position: rendered.position, left: rendered.left, top: rendered.top, width: rendered.width },
  );
});

test("a hugging node reports measured px on a render handle, sizing intent on a found one", async () => {
  createFigmaMock();
  const out = await render(frame({ layout: { mode: "row" } }, [text("hi", { key: "label" })]));
  // The deliberate divergence in the shared spelling: render just laid the node out, so it hands back the
  // number it settled on; a located node reports intent, since a computed px would read as authored-fixed.
  assert.equal(typeof out.keyed.label.width, "number");
  assert.equal((await findOne({ key: "label" })).width, "hug");
});
