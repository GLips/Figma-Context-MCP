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
  // CSS grid's commonest pair: stretch is a request to fill the cell, on either axis.
  const cell = id(built.children![1].id);
  await edit(cell, { layout: { alignSelf: "stretch", justifySelf: "stretch" } });
  const stretched = (await get(built)).node.children![1];
  assert.deepEqual([stretched.width, stretched.height], ["fill", "fill"]);
  const cellBox = await measure(cell);
  assert.deepEqual([cellBox.width, cellBox.height], [290, 60]); // the 1fr column of a 400 grid, row 0
  await assert.rejects(edit(cell, { height: 20, layout: { alignSelf: "stretch" } }), /alignSelf "stretch" conflicts with the authored height/);
  await assert.rejects(edit(cell, { width: 20, layout: { justifySelf: "stretch" } }), /justifySelf "stretch" conflicts with the authored width/);
  // Authored at create, and out of any flow it still has no cell to fill.
  const stretchedAtCreate = await render({ type: "FRAME", width: 200, height: 100, layout: { mode: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "100px" },
    children: [{ type: "RECTANGLE", layout: { alignSelf: "stretch", justifySelf: "stretch" } }] });
  const filled = (await get(stretchedAtCreate)).node.children![0];
  assert.deepEqual([filled.width, filled.height], ["fill", "fill"]);
  await assert.rejects(render({ type: "FRAME", width: 90, height: 90, children: [{ type: "RECTANGLE", width: 10, height: 10, layout: { alignSelf: "stretch" } }] }), /requires an in-flow row\/column or grid parent/);
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

test("a grid that fills its row/column parent divides that parent's real width", async () => {
  createFigmaMock();
  const tiles = () => Array.from({ length: 4 }, (_, n) => ({ type: "FRAME" as const, name: "tile" + n, width: "fill" as const, height: "hug" as const,
    layout: { mode: "column" as const, gap: 8 }, children: [{ type: "RECTANGLE" as const, width: "fill" as const, height: 100 }] }));
  const grid = { type: "FRAME" as const, name: "Gallery grid", width: "fill" as const,
    layout: { mode: "grid" as const, gridTemplateColumns: "repeat(4, 1fr)", gap: "30px 24px" }, children: tiles() };
  // The commonest placement for a grid: a fill-width child of the page column that frames it.
  const column = await render({ type: "FRAME", width: 1200, layout: { mode: "column", padding: "48px 56px 56px 56px" }, children: [grid] });
  const inColumn = column.children![0];
  assert.equal((await get(id(inColumn.id))).node.width, "fill");
  assert.equal((await measure(id(inColumn.id))).width, 1088); // 1200 - 56 - 56
  assert.equal((await measure(id(inColumn.children![0].id))).width, 254); // (1088 - 3 * 24) / 4
  // The main axis of a row is the other half of the same rule (layoutGrow, not STRETCH).
  const row = await render({ type: "FRAME", width: 600, height: 400, layout: { mode: "row" }, children: [grid] });
  const inRow = row.children![0];
  assert.equal((await get(id(inRow.id))).node.width, "fill");
  assert.equal((await measure(id(inRow.id))).width, 600);
  // And an edit re-fills a grid that was sized fixed, without the tracks clobbering the fill.
  await edit(id(inRow.id), { width: 300 });
  assert.equal((await measure(id(inRow.id))).width, 300);
  await edit(id(inRow.id), { width: "fill", layout: { gridTemplateColumns: "repeat(4, 2fr)" } });
  assert.equal((await get(id(inRow.id))).node.width, "fill");
  assert.equal((await measure(id(inRow.id))).width, 600);
});
