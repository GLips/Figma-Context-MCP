import { compileTree } from "./compile-tree.js";
import { specNode } from "../../harness/spec-node.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { id } from "./flcm.js";
import { render } from "./render.js";
import { edit } from "./edit.js";
import { editMany } from "./edit-many.js";
import { find } from "./read.js";
import { sceneNodeToSnapshot } from "./node-to-snapshot.js";
import { simplify } from "@framelink/core";

let figma: ReturnType<typeof createFigmaMock>;
let warnings: string[];
const warn = console.warn;
beforeEach(() => { figma = createFigmaMock(); warnings = []; console.warn = (...args) => warnings.push(args.join(" ")); });
afterEach(() => { console.warn = warn; });
const boundKeys = ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const;
const boundsOf = (node: any) => Object.fromEntries(boundKeys.map(key => [key, node[key]]));

test("four bounds survive creation, canonical/plugin reads, edits, and explicit clearing", async () => {
  const bounds = { minWidth: 160, maxWidth: 240, minHeight: 40, maxHeight: 80 };
  const built = await render(({ type: "FRAME", width: 200, height: 60, layout: { mode: "row" }, ...bounds }));
  const node = await figma.getNodeByIdAsync(built.id);
  assert.deepEqual(boundsOf(built), bounds);
  const snapshot = await sceneNodeToSnapshot(node, async () => null);
  assert.deepEqual(boundsOf(snapshot), bounds);
  const result = await simplify([snapshot]);
  assert.deepEqual(boundsOf(result.nodes[0]), bounds);
  assert.deepEqual(boundsOf((await find({ type: "FRAME" }))[0]), bounds);
  await edit(id(node.id), { width: 210 });
  assert.deepEqual(boundsOf(node), bounds);
  await edit(id(node.id), { minWidth: "none", maxWidth: "none", minHeight: "none", maxHeight: "none" });
  assert.deepEqual(boundsOf(node), { minWidth: null, maxWidth: null, minHeight: null, maxHeight: null });
  assert.deepEqual(boundsOf((await simplify([await sceneNodeToSnapshot(node, async () => null)])).nodes[0]), Object.fromEntries(boundKeys.map(key => [key, undefined])));
});

test("same-edit bounds clamp successfully and warnings report requested, bound and actual values", async () => {
  const built = await render(({ type: "FRAME", width: 200, height: 60, layout: { mode: "row" } }));
  for (const [key, axis, bound, requested] of [
    ["minWidth", "width", 160, 145], ["maxWidth", "width", 240, 260],
    ["minHeight", "height", 40, 25], ["maxHeight", "height", 80, 95],
  ] as const) {
    warnings = [];
    const handle = await edit(built, { [key]: bound, [axis]: requested, opacity: 0.5 });
    assert.equal(handle[axis], bound);
    assert.equal((await figma.getNodeByIdAsync(handle.id)).opacity, 0.5);
    assert.match(warnings.join("\n"), new RegExp(axis + " requested " + requested + ", " + key + " " + bound + ", result " + bound));
    assert.doesNotMatch(warnings.join("\n"), /rollback|failed/);
  }
});

test("instance-only bounds persist through resize and clear without changing the component", async () => {
  const component = figma.createComponent(); component.layoutMode = "HORIZONTAL"; component.primaryAxisSizingMode = "FIXED"; component.counterAxisSizingMode = "FIXED"; component.resize(200, 60);
  const built = await render(({ type: "INSTANCE", componentId: component.id }));
  const node = await figma.getNodeByIdAsync(built.id);
  await edit(built, { minWidth: 160 });
  warnings = [];
  const resized = await edit(built, { width: 145 });
  assert.equal(resized.width, 160);
  assert.equal(node.minWidth, 160);
  assert.equal(component.minWidth, null);
  assert.match(warnings.join("\n"), /width requested 145, minWidth 160, result 160/);
  await edit(built, { minWidth: "none", width: 145 });
  assert.equal(node.width, 145);
  assert.equal(node.minWidth, null);
});

test("contradictory and malformed bounds reject before batch writes, valid interval moves succeed", async () => {
  const built = await render(({ type: "FRAME", width: 80, height: 80, layout: { mode: "row" }, minWidth: 20, maxWidth: 100 }));
  const node = await figma.getNodeByIdAsync(built.id);
  const before = [...figma.undoLog];
  await assert.rejects(editMany([{ target: built, changes: { minWidth: 120, opacity: 0.5 } }]), /minWidth 120 exceeds maxWidth 100/);
  assert.equal(node.opacity, 1);
  assert.deepEqual(figma.undoLog, before);
  for (const value of [0, -1, NaN, Infinity, "20px"]) await assert.rejects(edit(built, { maxHeight: value } as any), /finite positive/);
  assert.throws(() => compileTree(({ type: "FRAME", minHeight: 80, maxHeight: 40 }), "spec"), /minHeight 80 exceeds maxHeight 40/);
  await edit(built, { minWidth: 120, maxWidth: 200, width: 150 });
  assert.equal(node.width, 150);
});

test("overflow warning deduplicates clipped/unclipped containers, includes preexisting nested overflow, and excludes unaffected siblings", async () => {
  const built = await render(({ type: "FRAME", width: 500, height: 300, children: [
    ({ type: "FRAME", key: "clipped", width: 100, height: 100, clip: true, children: [({ type: "RECTANGLE", width: 150, height: 20 })] }),
    ({ type: "FRAME", key: "outer", width: 200, height: 100, left: 200, children: [({ type: "FRAME", key: "nested", width: 80, height: 40, children: [({ type: "RECTANGLE", width: 100, height: 20 })] })] }),
    ({ type: "FRAME", key: "unaffected", width: 100, height: 100, top: 150, children: [({ type: "RECTANGLE", width: 150, height: 20 })] }),
  ] }));
  warnings = [];
  const handles = await editMany([
    { target: specNode(built, "clipped"), changes: { width: 90 } },
    { target: specNode(built, "outer"), changes: { width: 190 } },
    { target: specNode(built, "nested"), changes: { height: 35 } },
  ]);
  assert.equal(handles.length, 3);
  const overflow = warnings.filter(message => message.includes(": overflow in"));
  assert.equal(overflow.length, 1);
  assert.match(overflow[0], /overflow in 2 containers; clipped \(1\):/);
  assert.ok(overflow[0].includes(specNode(built, "clipped").id));
  assert.ok(overflow[0].includes(specNode(built, "nested").id));
  assert.ok(!overflow[0].includes(specNode(built, "unaffected").id));
  assert.equal(overflow[0].split(specNode(built, "nested").id).length, 2);
  warnings = [];
  await edit(specNode(built, "clipped"), { opacity: 0.5 });
  assert.equal(warnings.length, 0);
});

test("overflow is measured after all batch sizes settle", async () => {
  const built = await render(({ type: "FRAME", width: 200, height: 100, children: [({ type: "RECTANGLE", key: "child", width: 180, height: 40 })] }));
  warnings = [];
  await editMany([{ target: built, changes: { width: 100 } }, { target: specNode(built, "child"), changes: { width: 80 } }]);
  assert.equal(warnings.filter(message => message.includes(": overflow in")).length, 0);
});

test("a resized parent's nested fill layout is inspected after reflow", async () => {
  const built = await render(({ type: "FRAME", width: 200, height: 100, layout: { mode: "row" }, children: [
    ({ type: "FRAME", key: "nested", width: "fill", height: 80, children: [({ type: "RECTANGLE", width: 180, height: 20 })] }),
  ] }));
  warnings = [];
  await edit(built, { width: 100 });
  const overflow = warnings.filter(message => message.includes(": overflow in"));
  assert.equal(overflow.length, 1);
  assert.ok(overflow[0].includes(specNode(built, "nested").id));
});

test("overflow uses container-local geometry when the container is rotated", async () => {
  const built = await render(({ type: "FRAME", width: 100, height: 100, children: [({ type: "RECTANGLE", key: "child", width: 20, height: 20 })] }));
  const root = await figma.getNodeByIdAsync(built.id);
  const child = await figma.getNodeByIdAsync(specNode(built, "child").id);
  root.absoluteTransform = [[0, -1, 0], [1, 0, 0]];
  child.absoluteTransform = [[0, -1, -20], [1, 0, 90]];
  warnings = [];
  await edit(built, { width: 100 });
  assert.match(warnings.join("\n"), /overflow in 1 containers/);
  child.absoluteTransform = [[0, -1, -20], [1, 0, 80]];
  warnings = [];
  await edit(built, { width: 100 });
  assert.equal(warnings.length, 0);
});
