import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { render } from "./render.js";
import { get } from "./read.js";
import { edit } from "./edit.js";
import { editMany } from "./edit-many.js";
import { append, measure } from "./structure.js";
import { id } from "./flcm.js";

test("grid vocabulary round-trips through render/get/edit/editMany, with parent-dependent alignment", async () => {
  createFigmaMock();
  const layout = { mode: "grid", gridTemplateColumns: "80px 1fr", gridTemplateRows: "60px 90px", gap: "8px 12px" } as const;
  const built = await render({ type: "FRAME", width: 300, height: 158, layout, children: [
    { type: "RECTANGLE", width: "fill", height: "fill" },
    { type: "RECTANGLE", width: 20, height: 30, layout: { justifySelf: "center", alignSelf: "end" } },
    { type: "FRAME", width: "fill", height: "fill", layout: { mode: "grid", gridTemplateColumns: "1fr", gridTemplateRows: "1fr" }, children: [{ type: "RECTANGLE", width: "fill", height: "fill" }] },
  ] });
  const read = (await get(built)).node;
  assert.deepEqual(read.layout, layout);
  assert.equal(read.children![0].width, "fill");
  assert.equal(read.children![1].layout!.justifySelf, "center");
  assert.equal(read.children![1].layout!.alignSelf, "end");
  const echoed = await render(JSON.parse(JSON.stringify(read, (key, value) => key === "id" ? undefined : value)));
  assert.notEqual(echoed.id, built.id);
  assert.deepEqual((await get(echoed)).node.layout, read.layout);
  await edit(built, { layout: { gap: "4px 10px", gridTemplateColumns: "100px 1fr" } });
  await editMany([{ id: built.children![1].id, layout: { justifySelf: "start", alignSelf: "center" } }, { id: built.id, width: 400 }]);
  const updated = (await get(built)).node;
  assert.equal(updated.layout!.gridTemplateColumns, "100px 1fr");
  assert.equal(updated.layout!.gridTemplateRows, layout.gridTemplateRows);
  assert.equal(updated.layout!.gap, "4px 10px");
  assert.equal(updated.children![1].layout!.justifySelf, "start");
  assert.equal(updated.children![1].layout!.alignSelf, "center");
  const flow = await render({ type: "FRAME", width: 120, height: 70, layout: { mode: "row" }, children: [{ type: "RECTANGLE", width: 20, layout: { alignSelf: "stretch" } }] });
  const flowRead = (await get(flow)).node;
  assert.equal(flowRead.children![0].height, "fill");
  assert.equal(flowRead.children![0].layout?.alignSelf, undefined);
  const flowCopy = await render(JSON.parse(JSON.stringify(flowRead, (key, value) => key === "id" ? undefined : value)));
  assert.equal((await get(flowCopy)).node.children![0].height, "fill");
  for (const mode of ["row", "column"] as const) {
    const parent = mode === "row" ? flow : await render({ type: "FRAME", width: 120, height: 70, layout: { mode }, children: [{ type: "RECTANGLE", width: 20, height: 20 }] });
    const target = id(parent.children![0].id);
    for (const alignSelf of ["flex-start", "center", "flex-end", "auto", "start", "end"]) {
      const layout = { alignSelf } as never;
      const reason = /layout\.alignItems.*parent.*every child.*fill-sized frame.*alignItems/;
      await assert.rejects(edit(target, { layout }), reason);
      await assert.rejects(editMany([{ id: parent.children![0].id, layout }]), reason);
      await assert.rejects(render({ type: "FRAME", layout: { mode }, children: [{ type: "RECTANGLE", layout }] }), reason);
    }
  }
  assert.equal((await get(flow)).node.children![0].height, "fill");
  await assert.rejects(edit(id(built.children![1].id), { layout: { alignSelf: "stretch" } }), /stretch.*requires.*row\/column/);
});

test("grid spans and template edits use read words and refuse unresolved layout before changing it", async () => {
  createFigmaMock();
  const layout = { mode: "grid", gridTemplateColumns: "40px 40px 40px", gridTemplateRows: "30px 30px 30px" } as const;
  const built = await render({ type: "FRAME", layout, children: [{ type: "RECTANGLE", width: "fill", height: "fill", layout: { gridColumn: "2 / span 2", gridRow: "2 / span 2" } }] });
  const child = id(built.children![0].id);
  const read = (await get(built)).node.children![0];
  assert.equal(read.layout!.gridColumn, "2 / span 2");
  assert.equal(read.layout!.gridRow, "2 / span 2");
  await edit(child, { layout: { gridColumn: "1 / span 2", gridRow: "1" } });
  assert.equal((await get(built)).node.children![0].layout!.gridColumn, "span 2");
  await edit(built, { layout: { gridTemplateColumns: "repeat(4, 40px)", gridTemplateRows: "fit-content(100%) 30px 30px" } });
  assert.equal((await get(built)).node.layout!.gridTemplateColumns, "40px 40px 40px 40px");
  assert.equal((await get(built)).node.layout!.gridTemplateRows, "fit-content(100%) 30px 30px");
  await assert.rejects(edit(child, { width: "50%" }), /percent sizes on in-flow GRID/);
  await assert.rejects(render({ type: "FRAME", width: 120, height: 90, layout, children: [{ type: "RECTANGLE", width: "50%" }] }), /percent sizes on in-flow GRID/);
  await assert.rejects(edit(built, { layout: { gridTemplateColumns: "1fr 1fr 1fr 1fr" } }), /fractional grid tracks require explicit/);
  await assert.rejects(edit(child, { layout: { mode: "none" } }), /unknown prop "mode"/);
  await assert.rejects(editMany([{ id: built.children![0].id, layout: { padding: 4 } }]), /unknown prop "padding"/);
  await assert.rejects(edit(child, { layout: { overflowScroll: ["x"] } } as never), /has no authored form/);
  await assert.rejects(render({ type: "FRAME", layout: { mode: "grid" } }), /requires.*gridTemplate/);
  await edit(built, { width: 200, layout: { gridTemplateColumns: "1fr 1fr 1fr 1fr" } });
  assert.equal((await get(built)).node.layout!.gridTemplateColumns, "1fr 1fr 1fr 1fr");
});

test("one explicit grid zIndex reserves its slot; edits reorder either way without changing anchors", async () => {
  createFigmaMock();
  const built = await render({ type: "FRAME", layout: { mode: "grid", gridTemplateColumns: "40px 40px 40px", gridTemplateRows: "40px" }, children: [
    { type: "RECTANGLE", name: "first", width: 120, height: 40, layout: { zIndex: 2 } },
    { type: "RECTANGLE", name: "second", width: 120, height: 40 },
    { type: "RECTANGLE", name: "third", width: 120, height: 40 },
  ] });
  const stacking = async () => (await get(built)).node.children!.map(c => [c.name, c.layout?.zIndex ?? null]);
  assert.deepEqual(await stacking(), [["second", 0], ["third", 1], ["first", 2]]);
  const positions = () => Promise.all(built.children!.map(child => measure(id(child.id))));
  const before = await positions();
  const first = id(built.children![0].id);
  await edit(first, { layout: { zIndex: 0 } });
  assert.deepEqual(await stacking(), [["first", null], ["second", null], ["third", null]]);
  await edit(first, { layout: { zIndex: 2 } });
  assert.deepEqual(await stacking(), [["second", 0], ["third", 1], ["first", 2]]);
  await editMany([{ id: built.children![0].id, layout: { zIndex: 0 } }, { id: built.children![2].id, layout: { zIndex: 1 } }]);
  assert.deepEqual(await stacking(), [["first", null], ["third", 1], ["second", 2]]);
  assert.deepEqual(await positions(), before);
});

test("rows omitted are implicit: hug tracks derived from placement, growing as children arrive", async () => {
  createFigmaMock();
  // The tile wall the row count is impossible to know up front: a double-wide header, then tiles.
  const built = await render({ type: "FRAME", width: 400, layout: { mode: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }, children: [
    { type: "RECTANGLE", width: "fill", height: 40, layout: { gridColumn: "span 2" } },
    ...Array.from({ length: 6 }, () => ({ type: "RECTANGLE" as const, width: "fill" as const, height: 30 })),
  ] });
  const read = (await get(built)).node;
  // 2 + 6 cells over 4 columns = 2 rows.
  assert.equal(read.layout!.gridTemplateRows, "fit-content(100%) fit-content(100%)");
  assert.equal(read.layout!.gridTemplateColumns, "1fr 1fr 1fr 1fr");
  // Re-authoring the read is the round trip: explicit hug rows are the same grid.
  const echoed = await render(JSON.parse(JSON.stringify(read, (key, value) => key === "id" ? undefined : value)));
  assert.equal((await get(echoed)).node.layout!.gridTemplateRows, read.layout!.gridTemplateRows);
  // Appending past the last cell grows a hug row rather than leaning on Figma's FIXED growth.
  await append(built, { type: "RECTANGLE", width: "fill", height: 30 });
  await append(built, { type: "RECTANGLE", width: "fill", height: 30 });
  assert.equal((await get(built)).node.layout!.gridTemplateRows, "fit-content(100%) fit-content(100%) fit-content(100%)");
  // Naming rows makes them explicit; the grid stops growing for later children.
  await edit(built, { height: 200, layout: { gridTemplateRows: "40px 40px 40px 40px" } });
  assert.equal((await get(built)).node.layout!.gridTemplateRows, "40px 40px 40px 40px");
  await append(built, { type: "RECTANGLE", width: "fill", height: 30 });
  assert.equal((await get(built)).node.layout!.gridTemplateRows, "40px 40px 40px 40px");
});
