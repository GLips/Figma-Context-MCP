import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, text, rect, instance, id } from "./flcm.js";
import { render } from "./render.js";
import { edit } from "./edit.js";
import { append } from "./structure.js";
import { component } from "./component.js";
import { get } from "./read.js";
import { fromRead } from "./from-read.js";

test("wrap and unequal CSS gaps create, edit, inherit and round-trip", async () => {
  const figma = createFigmaMock();
  const built = await render(frame({ width: 220, layout: { mode: "row", wrap: true, gap: "12px 24px" } }, [rect({ width: 80 }), rect({ width: 80 }), rect({ width: 80 })]));
  const native = await figma.getNodeByIdAsync(built.node.id);
  assert.equal(native.layoutWrap, "WRAP");
  assert.equal(native.itemSpacing, 24);
  assert.equal(native.counterAxisSpacing, 12);
  const read = await get(id(native.id));
  assert.equal(read.node.layout.gap, "12px 24px");
  assert.equal(fromRead(read.node).layout.wrap, true);
  await edit(id(native.id), { layout: { gap: 6 } });
  assert.equal(native.itemSpacing, 6); assert.equal(native.counterAxisSpacing, 6);
  await assert.rejects(edit(id(native.id), { layout: { mode: "column" } }), /disable wrap/);
  assert.equal(native.layoutMode, "HORIZONTAL");
  await edit(id(native.id), { layout: { mode: "column", wrap: false, gap: 9 } });
  assert.equal(native.layoutMode, "VERTICAL"); assert.equal(native.layoutWrap, "NO_WRAP"); assert.equal(native.itemSpacing, 9);
  await assert.rejects(edit(id(native.id), { layout: { gap: "4px 8px" } }), /unequal.*require/);
  assert.throws(() => frame({ layout: { mode: "column", wrap: true } }), /requires.*row/);
  assert.throws(() => frame({ layout: { mode: "row", wrap: true, gap: "-1px 8px" } }), /non-negative/);
  const comp = await component(frame({ width: 200, layout: { mode: "row", wrap: true, gap: "5px 9px" } }));
  const stamped = await render(instance(comp.node.id, { layout: { gap: "7px 11px" } }));
  const inst = await figma.getNodeByIdAsync(stamped.node.id);
  assert.equal(inst.counterAxisSpacing, 7); assert.equal(inst.itemSpacing, 11);
});

test("new text fills independently bounded columns; explicit sizing and edits are preserved", async () => {
  const figma = createFigmaMock();
  const tree = await render(frame({ width: 240, layout: { mode: "column" } }, [
    text("A long paragraph that should wrap rather than grow the column", { key: "implicit" }),
    text("Explicit hug", { key: "hug", width: "hug" }),
    text("Explicit fixed", { key: "fixed", width: 90 }),
    frame({ width: "fill", layout: { mode: "column" } }, [text("Nested", { key: "nested" })]),
  ]));
  for (const key of ["implicit", "nested"]) {
    const node = await figma.getNodeByIdAsync(tree.keyed[key].id);
    assert.equal(node.layoutAlign, "STRETCH"); assert.equal(node.textAutoResize, "HEIGHT");
  }
  assert.notEqual((await figma.getNodeByIdAsync(tree.keyed.hug.id)).layoutAlign, "STRETCH");
  assert.equal((await figma.getNodeByIdAsync(tree.keyed.fixed.id)).width, 90);
  const inserted = await append(id(tree.node.id), text("Inserted"));
  assert.equal((await figma.getNodeByIdAsync(inserted.node.id)).layoutAlign, "STRETCH");
  await edit(id(tree.keyed.hug.id), { text: "Edit leaves explicit hug alone" });
  assert.notEqual((await figma.getNodeByIdAsync(tree.keyed.hug.id)).layoutAlign, "STRETCH");
  const hugColumn = await render(frame({ layout: { mode: "column" } }, [text("Content", { key: "content" }), frame({ width: "fill", layout: { mode: "column" } }, [text("Nested content", { key: "nested-content" })])]));
  for (const key of ["content", "nested-content"]) assert.notEqual((await figma.getNodeByIdAsync(hugColumn.keyed[key].id)).layoutAlign, "STRETCH");
  const row = await render(frame({ width: 240, layout: { mode: "row" } }, [text("Row default", { key: "row-text" })]));
  assert.equal((await figma.getNodeByIdAsync(row.keyed["row-text"].id)).textAutoResize, "WIDTH_AND_HEIGHT");
});

test("nested exposure is applied after promotion and placement, and rejected outside a definition", async () => {
  const figma = createFigmaMock();
  const inner = await component(frame({}, [text("Label")]));
  const count = figma.currentPage.children.length;
  await assert.rejects(render(instance(inner.node.id, { exposed: true })), /exposed needs/);
  assert.equal(figma.currentPage.children.length, count);
  const outer = await component(frame({}, [instance(inner.node.id, { key: "nested", exposed: true })]));
  const nested = await figma.getNodeByIdAsync(outer.keyed.nested.id);
  assert.equal(nested.isExposedInstance, true);
  assert.equal((await get(id(nested.id))).node.exposed, true);
  await edit(id(nested.id), { exposed: false });
  assert.equal(nested.isExposedInstance, false);
  assert.equal((await get(id(nested.id))).node.exposed, undefined);
  const appended = await append(id(outer.node.id), instance(inner.node.id, { exposed: true }));
  assert.equal((await figma.getNodeByIdAsync(appended.node.id)).isExposedInstance, true);
  const visible = await render(instance(outer.node.id));
  const inherited = (await figma.getNodeByIdAsync(visible.node.id)).children[0];
  await assert.rejects(edit(id(inherited.id), { exposed: false }), /primary nested instance/);
});
