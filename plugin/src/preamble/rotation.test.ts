/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Rotation turns a node about its centre, as CSS and the Figma UI do — not about the top-left, where
// Figma's own `rotation` setter pivots. The mock models that setter faithfully (it keeps x/y), so these
// pin the compensation, and that `left`/`top` mean the unrotated box on both read and write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { render, edit, editMany, get, measure, append, clone } from "./runtime.js";

async function liveNode(key: string): Promise<any> {
  const { node } = await get(key);
  return figma.getNodeByIdAsync(node.id);
}

// The centre of a node's own box, in its parent's frame.
function centreOf(node: any): { x: number; y: number } {
  const [[a, b, x], [c, d, y]] = node.relativeTransform;
  return { x: x + a * node.width / 2 + b * node.height / 2, y: y + c * node.width / 2 + d * node.height / 2 };
}

function assertNear(actual: { x: number; y: number }, expected: { x: number; y: number }): void {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-6 && Math.abs(actual.y - expected.y) < 1e-6,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const board = (child: object) => ({ type: "FRAME", key: "board", width: 400, height: 300, children: [child] });

test("a rotated node turns about its centre, and its read pastes back to the same place", async () => {
  createFigmaMock();
  await render(board({ type: "RECTANGLE", key: "tile", width: 80, height: 40, left: 100, top: 50, rotation: 30 }));
  const tile = await liveNode("tile");
  assertNear(centreOf(tile), { x: 140, y: 70 });
  assert.equal(tile.rotation, -30);

  // The root of a read has no parent to be placed in, so the board is read to see the tile's place.
  const { node: boardRead } = await get("board");
  const read = boardRead.children![0];
  assert.equal(read.left, 100);
  assert.equal(read.top, 50);
  assert.equal(read.rotation, 30);
  assert.deepEqual(await measure("tile"), { x: 100, y: 50, width: 80, height: 40 });

  // Pasted back, it lands where it was: as a copy (no id), as a move of the live node (its id), and
  // as an edit restating its own words.
  const { id, ...copy } = read;
  await render({ ...board({ ...copy, key: "copy" }), key: "copyBoard" });
  assertNear(centreOf(await liveNode("copy")), { x: 140, y: 70 });
  await render({ ...board(read), key: "moveBoard" });
  assert.equal(tile.parent.id, (await liveNode("moveBoard")).id);
  assertNear(centreOf(tile), { x: 140, y: 70 });
  await edit("tile", { left: read.left, top: read.top, rotation: read.rotation });
  await edit("tile", { left: read.left, top: read.top, rotation: read.rotation });
  assertNear(centreOf(tile), { x: 140, y: 70 });
});

test("editing rotation keeps the centre; size and position edits move the unrotated box", async () => {
  createFigmaMock();
  await render(board({ type: "RECTANGLE", key: "tile", width: 80, height: 40, left: 100, top: 50 }));
  const tile = await liveNode("tile");
  await edit("tile", { rotation: 45 });
  assertNear(centreOf(tile), { x: 140, y: 70 });
  await edit("tile", { rotation: 90 });
  assertNear(centreOf(tile), { x: 140, y: 70 });

  // A resize alone keeps left/top, as CSS would, so the centre follows the new size.
  await edit("tile", { width: 120 });
  assertNear(centreOf(tile), { x: 160, y: 70 });
  await edit("tile", { left: 10, top: 20, width: 60, height: 60 });
  assertNear(centreOf(tile), { x: 40, y: 50 });
  assert.deepEqual(await measure("tile"), { x: 10, y: 20, width: 60, height: 60 });

  await edit("tile", { rotation: 0 });
  assert.equal(tile.x, 10);
  assert.equal(tile.y, 20);
});

test("a rotated line turns about its midpoint", async () => {
  createFigmaMock();
  await render(board({ type: "LINE", key: "rule", width: 100, left: 50, top: 100, rotation: 90 }));
  const rule = await liveNode("rule");
  assertNear(centreOf(rule), { x: 100, y: 100 });
  assertNear({ x: rule.x, y: rule.y }, { x: 100, y: 50 });
  const { node: boardRead } = await get("board");
  assert.equal(boardRead.children![0].left, 50);
  assert.equal(boardRead.children![0].top, 100);
});

test("a batch percent position resolves against the unrotated box before the pivot", async () => {
  createFigmaMock();
  await render(board({ type: "RECTANGLE", key: "tile", width: 80, height: 40, left: 0, top: 0, rotation: 60 }));
  const tile = await liveNode("tile");
  await editMany([{ id: tile.id, left: "50%", top: "50%" }]);
  assertNear(centreOf(tile), { x: 240, y: 170 });
});

test("the flow places an in-flow child; an absolute one pivots about its centre", async () => {
  createFigmaMock();
  await render({
    type: "FRAME", key: "row", width: 400, height: 200, layout: { mode: "row" },
    children: [
      { type: "RECTANGLE", key: "flowing", width: 80, height: 40, rotation: 30 },
      { type: "RECTANGLE", key: "floating", width: 80, height: 40, position: "absolute", left: 200, top: 100, rotation: 30 },
    ],
  });
  const flowing = await liveNode("flowing");
  assert.equal(flowing.x, 0);
  assert.equal(flowing.y, 0);
  assertNear(centreOf(await liveNode("floating")), { x: 240, y: 120 });
});

test("a moved or cloned rotated node lands with its unrotated box at the authored place", async () => {
  createFigmaMock();
  await render(board({ type: "RECTANGLE", key: "tile", width: 80, height: 40, left: 100, top: 50, rotation: 30 }));
  await render({ type: "FRAME", key: "shelf", width: 400, height: 300 });
  const tile = await liveNode("tile");
  await append("shelf", { id: tile.id, left: 20, top: 30 });
  assertNear(centreOf(tile), { x: 60, y: 50 });
  const copy = await figma.getNodeByIdAsync((await clone(tile.id, { left: 200, top: 100 }, "shelf")).id);
  assertNear(centreOf(copy), { x: 240, y: 120 });
});

test("a rotated hug node keeps its unrotated corner when what it hugs grows", async () => {
  const figma: any = createFigmaMock();
  // A moved live node that gains a child, with no other words — the move alone opens the span.
  await render(board({ type: "FRAME", key: "chip", left: 100, top: 50, rotation: 30, layout: { mode: "row" },
    children: [{ type: "RECTANGLE", key: "a", width: 40, height: 40 }] }));
  const chip = await liveNode("chip");
  await render({ id: chip.id, children: [{ id: (await liveNode("a")).id }, { type: "RECTANGLE", width: 40, height: 40 }] } as never);
  assert.deepEqual(await measure("chip"), { x: 100, y: 50, width: 80, height: 40 });

  // An instance resized by its own component property and by an override: both land after the
  // edit's layout stages, and the pivot waits for them.
  const built = await render({ type: "FRAME", key: "src", layout: { mode: "row", padding: 8 },
    children: [{ type: "TEXT", text: "Label", key: "label", textStyle: { fontSize: 12 } }] });
  const comp = figma.createComponentFromNode(await figma.getNodeByIdAsync(built.id));
  const label = await liveNode("label");
  label.componentPropertyReferences = { characters: comp.addComponentProperty("Label", "TEXT", "Label") };
  await render(board({ type: "INSTANCE", componentId: comp.id, key: "pill", left: 100, top: 50, rotation: 30 }));
  const pill = await liveNode("pill");
  const width = pill.width;
  await edit(pill.id, { componentProperties: { Label: "A much much longer label" } } as never);
  assert.ok(pill.width > width);
  assert.deepEqual(await measure(pill.id), { x: 100, y: 50, width: pill.width, height: pill.height });
  await edit(pill.id, { componentProperties: { Label: "Label" } } as never);
  await edit(pill.id, { overrides: { [label.id]: { text: "A much much longer label" } } } as never);
  assert.deepEqual(await measure(pill.id), { x: 100, y: 50, width: pill.width, height: pill.height });
});
