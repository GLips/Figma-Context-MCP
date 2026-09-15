import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { render, measure, findOne, edit } from "./runtime.js";

test("returned sizes preserve intent; measure reports final pixels after parent settlement", async () => {
  createFigmaMock();
  const tree = await render({ type: "FRAME", width: 300, height: 200, layout: { mode: "column" }, children: [{ type: "RECTANGLE", key: "bar", width: "fill", height: 12 }] });
  assert.equal(tree.children![0].width, "fill");
  assert.equal((await measure(tree.children![0])).width, 300);
  assert.equal((await findOne({ key: "bar" })).width, "fill");
  await edit(tree, { width: 400 });
  assert.equal(tree.children![0].width, "fill");
  assert.equal((await measure(tree.children![0])).width, 400);
});

test("returned coordinates keep authored percentages while measure uses parent-relative pixels", async () => {
  createFigmaMock();
  const tree = await render({ type: "FRAME", width: 200, height: 100, children: [{ type: "RECTANGLE", width: 20, height: 10, left: "50%", top: 12 }] });
  assert.equal(tree.children![0].left, "50%");
  assert.deepEqual(await measure(tree.children![0]), { x: 100, y: 12, width: 20, height: 10 });
});
