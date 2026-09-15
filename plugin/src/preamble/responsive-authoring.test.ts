import { withoutIds } from "../../harness/spec-node.js";
import { compileTree } from "./compile-tree.js";
import { specNode } from "../../harness/spec-node.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { id } from "./flcm.js";
import { render } from "./render.js";
import { edit } from "./edit.js";
import { append } from "./structure.js";
import { component } from "./component.js";
import { get } from "./read.js";

test("wrap and unequal CSS gaps create, edit, inherit and round-trip", async () => {
  const figma = createFigmaMock();
  const built = await render(({ type: "FRAME", width: 220, layout: { mode: "row", wrap: true, gap: "12px 24px" }, children: [({ type: "RECTANGLE", width: 80 }), ({ type: "RECTANGLE", width: 80 }), ({ type: "RECTANGLE", width: 80 })] }));
  const native = await figma.getNodeByIdAsync(built.id);
  assert.equal(native.layoutWrap, "WRAP");
  assert.equal(native.itemSpacing, 24);
  assert.equal(native.counterAxisSpacing, 12);
  const read = await get(id(native.id));
  assert.equal(read.node.layout.gap, "12px 24px");
  assert.equal(withoutIds(read.node).layout.wrap, true);
  await edit(id(native.id), { layout: { gap: 6 } });
  assert.equal(native.itemSpacing, 6); assert.equal(native.counterAxisSpacing, 6);
  await assert.rejects(edit(id(native.id), { layout: { mode: "column" } }), /disable wrap/);
  assert.equal(native.layoutMode, "HORIZONTAL");
  await edit(id(native.id), { layout: { mode: "column", wrap: false, gap: 9 } });
  assert.equal(native.layoutMode, "VERTICAL"); assert.equal(native.layoutWrap, "NO_WRAP"); assert.equal(native.itemSpacing, 9);
  await assert.rejects(edit(id(native.id), { layout: { gap: "4px 8px" } }), /unequal.*require/);
  assert.throws(() => compileTree(({ type: "FRAME", layout: { mode: "column", wrap: true } }), "spec"), /requires.*row/);
  assert.throws(() => compileTree(({ type: "FRAME", layout: { mode: "row", wrap: true, gap: "-1px 8px" } }), "spec"), /non-negative/);
  const comp = await component(({ type: "FRAME", width: 200, layout: { mode: "row", wrap: true, gap: "5px 9px" } }));
  const stamped = await render(({ type: "INSTANCE", componentId: comp.id, layout: { gap: "7px 11px" } }));
  const inst = await figma.getNodeByIdAsync(stamped.id);
  assert.equal(inst.counterAxisSpacing, 7); assert.equal(inst.itemSpacing, 11);
});

test("new text fills independently bounded columns; explicit sizing and edits are preserved", async () => {
  const figma = createFigmaMock();
  const tree = await render(({ type: "FRAME", width: 240, layout: { mode: "column" }, children: [
    ({ type: "TEXT", text: "A long paragraph that should wrap rather than grow the column", key: "implicit" }),
    ({ type: "TEXT", text: "Explicit hug", key: "hug", width: "hug" }),
    ({ type: "TEXT", text: "Explicit fixed", key: "fixed", width: 90 }),
    ({ type: "FRAME", width: "fill", layout: { mode: "column" }, children: [({ type: "TEXT", text: "Nested", key: "nested" })] }),
  ] }));
  for (const key of ["implicit", "nested"]) {
    const node = await figma.getNodeByIdAsync(specNode(tree, key).id);
    assert.equal(node.layoutAlign, "STRETCH"); assert.equal(node.textAutoResize, "HEIGHT");
  }
  assert.notEqual((await figma.getNodeByIdAsync(specNode(tree, "hug").id)).layoutAlign, "STRETCH");
  assert.equal((await figma.getNodeByIdAsync(specNode(tree, "fixed").id)).width, 90);
  const inserted = await append(id(tree.id), ({ type: "TEXT", text: "Inserted" }));
  assert.equal((await figma.getNodeByIdAsync(inserted.id)).layoutAlign, "STRETCH");
  await edit(id(specNode(tree, "hug").id), { text: "Edit leaves explicit hug alone" });
  assert.notEqual((await figma.getNodeByIdAsync(specNode(tree, "hug").id)).layoutAlign, "STRETCH");
  const hugColumn = await render(({ type: "FRAME", layout: { mode: "column" }, children: [({ type: "TEXT", text: "Content", key: "content" }), ({ type: "FRAME", width: "fill", layout: { mode: "column" }, children: [({ type: "TEXT", text: "Nested content", key: "nested-content" })] })] }));
  for (const key of ["content", "nested-content"]) assert.notEqual((await figma.getNodeByIdAsync(specNode(hugColumn, key).id)).layoutAlign, "STRETCH");
  const row = await render(({ type: "FRAME", width: 240, layout: { mode: "row" }, children: [({ type: "TEXT", text: "Row default", key: "row-text" })] }));
  assert.equal((await figma.getNodeByIdAsync(specNode(row, "row-text").id)).textAutoResize, "WIDTH_AND_HEIGHT");
});

test("nested exposure is applied after promotion and placement, and rejected outside a definition", async () => {
  const figma = createFigmaMock();
  const inner = await component(({ type: "FRAME", children: [({ type: "TEXT", text: "Label" })] }));
  const count = figma.currentPage.children.length;
  await assert.rejects(render(({ type: "INSTANCE", componentId: inner.id, exposed: true })), /exposed needs/);
  assert.equal(figma.currentPage.children.length, count);
  const outer = await component(({ type: "FRAME", children: [({ type: "INSTANCE", componentId: inner.id, key: "nested", exposed: true })] }));
  const nested = await figma.getNodeByIdAsync(specNode(outer, "nested").id);
  assert.equal(nested.isExposedInstance, true);
  assert.equal((await get(id(nested.id))).node.exposed, true);
  await edit(id(nested.id), { exposed: false });
  assert.equal(nested.isExposedInstance, false);
  assert.equal((await get(id(nested.id))).node.exposed, undefined);
  const appended = await append(id(outer.id), ({ type: "INSTANCE", componentId: inner.id, exposed: true }));
  assert.equal((await figma.getNodeByIdAsync(appended.id)).isExposedInstance, true);
  const visible = await render(({ type: "INSTANCE", componentId: outer.id }));
  const inherited = (await figma.getNodeByIdAsync(visible.id)).children[0];
  await assert.rejects(edit(id(inherited.id), { exposed: false }), /primary nested instance/);
});
