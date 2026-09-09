import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, text, line, ellipse, path, svg } from "./flcm.js";
import { render } from "./render.js";
import { get, find, selection, resolveTarget } from "./read.js";
import { edit } from "./edit.js";
import { editMany } from "./edit-many.js";
import { fromRead } from "./from-read.js";
import { clone } from "./structure.js";

test("a hidden deeply nested task is found and completed, preserving the same-text survivor and its pins", async () => {
  createFigmaMock();
  const root = await render(frame({ key: "root" }, [frame({}, [frame({}, [rect({ key: "task", visible: false })])])]));
  const task = await resolveTarget("task");
  task.annotations = [{ label: "Show this layer" }, { label: "Show this layer", properties: [{ type: "width" }, { type: "fills" }] }];
  assert.deepEqual(await find({ within: root.node, name: "Rectangle" }), []);
  const [hit] = await find({ within: root.node, hasAnnotations: true });
  assert.equal(hit.id, task.id);
  assert.deepEqual(hit.annotations, [{ text: "Show this layer" }, { text: "Show this layer", properties: ["width", "fills"] }]);
  // Re-read immediately before the replacement; choose one entry's identity, never all matching text.
  const [fresh] = await find({ within: root.node, hasAnnotations: true });
  const completed = fresh.annotations![0];
  await edit(fresh, { visible: true, annotations: fresh.annotations!.filter((note) => note !== completed) });
  assert.equal(task.visible, true);
  assert.deepEqual((await get(task)).node.annotations, [{ text: "Show this layer", properties: ["width", "fills"] }]);
  await edit(task, { name: "Done" });
  assert.equal(task.annotations.length, 1);
  await edit(task, { annotations: [] });
  assert.equal("annotations" in (await get(task)).node, false);
  assert.deepEqual(await find({ within: root.node, hasAnnotations: true }), []);
});

test("categories reuse exact trimmed names and retain their color across constructors, edits, and selection", async () => {
  createFigmaMock();
  const existing = await figma.annotations.addAnnotationCategoryAsync({ label: "Agent", color: "green" });
  await figma.annotations.addAnnotationCategoryAsync({ label: "agent", color: "red" });
  const note = { annotations: [{ text: "Tapping opens filters", category: " Agent " }] };
  const out = await render(frame(note, [rect(note), text("Label", note), line(note), ellipse(note), path({ d: "M0 0 L10 10", ...note }), svg('<svg width="10" height="10"></svg>', note)]));
  const root = await resolveTarget(out.node);
  await editMany(root.children.map((node) => ({ target: node, changes: note })));
  assert.equal((await figma.annotations.getAnnotationCategoriesAsync()).length, 2);
  assert.equal(existing.color, "green");
  assert.equal(root.annotations[0].categoryId, existing.id);
  figma.currentPage.selection = [root];
  assert.equal((await selection())[0].annotations![0].category, "Agent");
  for (const child of root.children) assert.equal(child.annotations[0].categoryId, existing.id);
});

test("a category is created once across a tree and later verbs; a property-only note round-trips", async () => {
  createFigmaMock();
  const note = { annotations: [{ text: "Intent", category: "Agent" }] };
  const out = await render(frame(note, [rect(note), rect(note)]));
  await edit(out.node, { annotations: [{ properties: ["width"] }, ...note.annotations] });
  assert.equal((await figma.annotations.getAnnotationCategoriesAsync()).length, 1);
  assert.deepEqual((await get(out.node)).node.annotations, [{ properties: ["width"] }, ...note.annotations]);
});

test("invalid edits and ambiguous categories create nothing; a failed apply removes its new category", async () => {
  createFigmaMock();
  const out = await render(rect({}));
  const note = { annotations: [{ text: "Intent", category: "New" }] };
  await assert.rejects(edit(out.node, { ...note, opacity: "bad" } as never), /opacity/);
  await assert.rejects(editMany([{ target: out.node, changes: note }, { target: "missing", changes: { name: "bad" } }]), /missing/);
  await assert.rejects(edit(out.node, { annotations: [{ text: "bad", category: " " }] }), /non-blank/);
  await assert.rejects(edit(out.node, { annotations: [{ properties: ["fake"] }] }), /pinned property/);
  assert.equal((await figma.annotations.getAnnotationCategoriesAsync()).length, 0);
  const a = await figma.annotations.addAnnotationCategoryAsync({ label: "Agent", color: "red" });
  const b = await figma.annotations.addAnnotationCategoryAsync({ label: "Agent", color: "blue" });
  await assert.rejects(edit(out.node, { annotations: [...note.annotations, { text: "Ambiguous", category: "Agent" }] }), (err: Error) => err.message.includes(a.id) && err.message.includes(b.id));
  assert.equal((await figma.annotations.getAnnotationCategoriesAsync()).length, 2);
  const node = await resolveTarget(out.node);
  Object.defineProperty(node, "annotations", { get: () => [], set: () => { throw new Error("Figma refused annotations"); } });
  await assert.rejects(edit(out.node, note), /Figma refused/);
  assert.deepEqual((await figma.annotations.getAnnotationCategoriesAsync()).map((c) => c.id), [a.id, b.id]);
});

test("fromRead drops annotations throughout a rebuild; clone keeps pending tasks and design intent", async () => {
  createFigmaMock();
  const out = await render(frame({ annotations: [{ text: "Resize this", category: "Agent" }] }, [text("Filters", { annotations: [{ text: "Opens filters" }] })]));
  const rebuilt = await render(fromRead((await get(out.node)).node));
  assert.equal((await get(rebuilt.node)).node.annotations, undefined);
  assert.deepEqual(await find({ within: rebuilt.node, hasAnnotations: true }), []);
  const copied = await clone(out.node);
  assert.deepEqual((await get(copied.node)).node.annotations, (await get(out.node)).node.annotations);
  assert.equal((await find({ within: copied.node, hasAnnotations: true })).length, 1);
});

test("the documented node matrix admits polygon and star but refuses group, section and SLOT", async () => {
  createFigmaMock();
  const out = await render(frame({}));
  const node = await resolveTarget(out.node);
  for (const type of ["POLYGON", "STAR", "COMPONENT", "COMPONENT_SET"]) {
    node.type = type;
    await edit(node, { annotations: [{ text: "Intent" }] });
  }
  for (const type of ["GROUP", "SECTION", "SLOT"]) {
    node.type = type;
    await assert.rejects(edit(node, { annotations: [] }), /not a .* word/);
  }
});

test("a target deleted during category creation rejects and removes the category", async () => {
  createFigmaMock();
  const out = await render(rect({}));
  const node = await resolveTarget(out.node);
  const addCategory = figma.annotations.addAnnotationCategoryAsync;
  figma.annotations.addAnnotationCategoryAsync = async (input) => {
    const category = await addCategory(input);
    node.remove();
    return category;
  };
  await assert.rejects(edit(out.node, { annotations: [{ text: "Intent", category: "Agent" }] }), /removed|deleted|no longer exists/);
  assert.deepEqual(await figma.annotations.getAnnotationCategoriesAsync(), []);
});
