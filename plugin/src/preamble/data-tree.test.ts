/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import * as flcm from "./runtime.js";
import type { NodeSpec } from "./schema.js";

test("plain templates stamp repeatedly; every returned node receives an id without aliasing input", async () => {
  const figma = createFigmaMock();
  const template = {
    type: "FRAME",
    width: 100,
    height: 100,
    children: [
      { type: "RECTANGLE", width: 20, height: 20, annotations: [{ text: "Keep this note" }] },
    ],
  };
  const before = JSON.stringify(template);
  const a = await flcm.render(template),
    b = await flcm.render(template);
  assert.equal(JSON.stringify(template), before);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.children![0].id, b.children![0].id);
  assert.notEqual(a.children, template.children);
  const child: any = await figma.getNodeByIdAsync(a.children![0].id!);
  assert.equal(child.annotations[0].labelMarkdown, "Keep this note");
});

test("get node data authors as-is: move recursively, edit props, keep omitted children", async () => {
  const figma = createFigmaMock();
  const root = await flcm.render({
    type: "FRAME",
    width: 200,
    height: 100,
    children: [{ type: "TEXT", text: "Existing" }],
  });
  const destination = await flcm.render({ type: "FRAME", width: 300, height: 200 });
  const { node } = await flcm.get(root);
  const input = { ...node, name: "Moved" };
  const result = await flcm.append(destination, input);
  assert.equal(result.id, root.id);
  assert.equal(result.children![0].id, root.children![0].id);
  const live: any = await figma.getNodeByIdAsync(root.id);
  assert.equal(live.parent.id, destination.id);
  assert.equal(live.name, "Moved");
  await flcm.append(destination, { id: root.id, children: [{ type: "TEXT", text: "Added" }] });
  assert.equal(live.children.length, 2);
  assert.equal(live.children[0].id, root.children![0].id);
});

test("a created parent can move an existing child and create its sibling", async () => {
  const figma = createFigmaMock();
  const old = await flcm.render({ type: "RECTANGLE", width: 20, height: 20, fill: "#FF0000" });
  const result = await flcm.render({
    type: "FRAME",
    width: 100,
    height: 100,
    children: [
      { id: old.id, fill: "#00FF00" },
      { type: "TEXT", text: "New" },
    ],
  });
  const parent: any = await figma.getNodeByIdAsync(result.id);
  assert.equal(parent.children[0].id, old.id);
  assert.deepEqual(parent.children[0].fills[0].color, { r: 0, g: 1, b: 0 });
  assert.equal(parent.children[1].id, result.children![1].id);
});

test("placements return input data with ids; before, after, prepend and replace order", async () => {
  const figma = createFigmaMock();
  const root = await flcm.render({ type: "FRAME", width: 100, height: 100 });
  const a = await flcm.append(root, { type: "RECTANGLE", name: "A" });
  const b = await flcm.prepend(root, { type: "RECTANGLE", name: "B" });
  const c = await flcm.insertBefore(a, { type: "RECTANGLE", name: "C" });
  await flcm.insertAfter(a, { id: b.id });
  const d = await flcm.replace(c, { type: "RECTANGLE", name: "D" });
  assert.deepEqual(
    ((await figma.getNodeByIdAsync(root.id)) as any).children.map((n: any) => n.id),
    [d.id, a.id, b.id],
  );
  assert.deepEqual(await flcm.append(root, { id: a.id }), { id: a.id });
});

test("deep malformed trees and duplicate live ids refuse before writes with their paths", async () => {
  const figma = createFigmaMock();
  const old = await flcm.render({ type: "RECTANGLE" });
  const count = figma.currentPage.children.length;
  await assert.rejects(
    flcm.render({
      type: "FRAME",
      children: [{ type: "FRAME", children: [{ type: "RECTANGLE", background: "red" }] }],
    }),
    /children\[0\].children\[0\].*background/,
  );
  await assert.rejects(
    flcm.render({ type: "FRAME", children: [{ id: old.id }, { id: old.id }] }),
    /spec\.children\[1\]\.id: the id "[^"]+" appears twice in this tree/,
  );
  await assert.rejects(
    flcm.render({ type: "FRAME", children: [{ id: "bad:id" }] }),
    /children\[0\]/,
  );
  assert.equal(figma.currentPage.children.length, count);
});

test("read-only vocabulary refuses by field and annotations survive a data copy", async () => {
  createFigmaMock();
  for (const words of [
    { strokeDashes: [1, 2] },
    { fill: "fill_a1b2c3d4" },
    { layout: { mode: "grid" } },
  ]) {
    await assert.rejects(
      flcm.render({ type: "FRAME", ...words }),
      /strokeDashes|styles-table reference|grid/,
    );
  }
  const original = await flcm.render({
    type: "RECTANGLE",
    width: 25,
    height: 30,
    annotations: [{ text: "Intent" }],
  });
  const { node } = await flcm.get(original);
  const { id, ...copy } = node;
  const out = await flcm.render(copy);
  assert.notEqual(out.id, id);
  assert.deepEqual(out.annotations, node.annotations);
});

test("a read's aspectRatio pastes back as a proportion lock that follows a fill width", async () => {
  createFigmaMock();
  const column = await flcm.render({
    type: "FRAME",
    width: 300,
    layout: { mode: "column" },
    children: [{ type: "RECTANGLE", width: "fill", aspectRatio: 1.5 }],
  });
  const { node } = await flcm.get(column);
  const photo = node.children![0];
  assert.equal(photo.aspectRatio, 1.5);
  assert.equal(photo.height, 200);

  const { id, children, ...frame } = node;
  const copy = await flcm.render({ ...frame, width: 450, children: children!.map(({ id, ...child }) => child) });
  const live = await figma.getNodeByIdAsync(copy.children![0].id);
  assert.deepEqual([live.width, live.height], [450, 300]);
  assert.ok(live.targetAspectRatio, "the copy is locked, not just sized");
});

test("aspectRatio refuses what no box can hold", async () => {
  createFigmaMock();
  await assert.rejects(flcm.render({ type: "RECTANGLE", width: 100, height: 100, aspectRatio: 2 }), /width 100 and height 100 are a 1 ratio/);
  await assert.rejects(flcm.render({ type: "FRAME", width: "hug", aspectRatio: 2, layout: { mode: "row" } }), /"hug" axis/);
  await assert.rejects(flcm.render({ type: "TEXT", text: "Hi", aspectRatio: 2 }), /sizes itself to its text/);
  // Live sizing compile never saw: a hug axis that would drive, two axes filling after an edit.
  const row = await flcm.render({ type: "FRAME", height: 40, layout: { mode: "row" }, children: [{ type: "RECTANGLE", width: 20, height: 20 }] });
  await assert.rejects(flcm.edit(row, { aspectRatio: 2 }), /hugs its content on its width/);
  const column = await flcm.render({ type: "FRAME", width: 300, height: 300, layout: { mode: "column" }, children: [{ type: "RECTANGLE", width: "fill", height: "fill" }] });
  await assert.rejects(flcm.edit(column.children![0], { aspectRatio: 2 }), /both axes "fill"/);
});

test("a percent child sizes against its parent's ratio-settled box", async () => {
  const figma = createFigmaMock();
  const out = await flcm.render({
    type: "FRAME",
    width: 600,
    layout: { mode: "column" },
    children: [{ type: "FRAME", width: "fill", height: 400, aspectRatio: 2, children: [{ type: "RECTANGLE", width: 10, height: "50%", position: "absolute" }] }],
  });
  const child = await figma.getNodeByIdAsync(out.children![0].children![0].id);
  assert.equal(child.height, 150);
});

test("a thin locked node's read pastes back despite the rounding of its sizes", async () => {
  createFigmaMock();
  await flcm.render({ type: "RECTANGLE", width: 1000, height: 3.33, aspectRatio: 300.03 });
});

test("IR words are rejected and no node constructors, fromRead or move are exported", async () => {
  createFigmaMock();
  for (const name of [
    "frame",
    "text",
    "rect",
    "ellipse",
    "line",
    "svg",
    "path",
    "instance",
    "fromRead",
    "move",
  ])
    assert.equal(name in flcm, false);
  await assert.rejects(flcm.render({ type: "RECTANGLE", fills: [] }), /fills/);
  const cycle: NodeSpec = { type: "FRAME" };
  cycle.children = [cycle];
  await assert.rejects(flcm.render(cycle), /spec\.children\[0\]: this object contains itself/);
});

test("replace can wrap the target it retains as an id-bearing child", async () => {
  const figma = createFigmaMock();
  const target = await flcm.render({ type: "TEXT", text: "Keep me" });
  const wrapped = await flcm.replace(target, {
    type: "FRAME",
    width: 100,
    height: 100,
    children: [{ id: target.id }],
  });
  const child: any = await figma.getNodeByIdAsync(target.id);
  assert.equal(child.parent.id, wrapped.id);
  assert.equal(wrapped.children![0].id, target.id);
});

test("resource and apply-time errors identify the node's indexed path", async () => {
  createFigmaMock();
  await assert.rejects(
    flcm.render({ type: "FRAME", children: [{ type: "INSTANCE", componentId: "1:999999" }] }),
    /spec.children\[0\]/,
  );
  await assert.rejects(
    flcm.render({ type: "FRAME", children: [{ type: "VECTOR", d: "bad path" }] }),
    /spec.children\[0\]/,
  );
});

test("duplicate authored keys across live and new nodes fail before writing", async () => {
  const figma = createFigmaMock();
  const old = await flcm.render({ type: "RECTANGLE", key: "same" });
  const before = [...figma.undoLog];
  await assert.rejects(
    flcm.render({
      type: "FRAME",
      children: [
        { id: old.id, key: "same" },
        { type: "TEXT", text: "Hi", key: "same" },
      ],
    }),
    /spec\.children\[1\]\.key: the key "same" appears twice in this tree/,
  );
  assert.deepEqual(figma.undoLog, before);
});

test("returned path data can move and edit its live vector without changing identity", async () => {
  const figma = createFigmaMock();
  const vector = await flcm.render({
    type: "VECTOR",
    d: "M0 0 L10 10",
    width: 24,
    height: 24,
    stroke: "#111",
  });
  const parent = await flcm.render({ type: "FRAME", width: 100, height: 100 });
  const result = await flcm.append(parent, { ...vector, d: "M0 0 L20 0" });
  const live: any = await figma.getNodeByIdAsync(vector.id);
  assert.equal(result.id, vector.id);
  assert.equal(live.parent.id, parent.id);
  assert.equal(live.vectorPaths[0].data, "M0 0 L20 0");
  assert.equal(live.width, 24);
});

test("a promoted frame's returned data can be placed again", async () => {
  const figma = createFigmaMock();
  const spec = await flcm.component({
    type: "FRAME",
    width: 100,
    height: 100,
    children: [{ type: "TEXT", text: "Label" }],
  });
  assert.equal(spec.type, "COMPONENT");
  assert.equal((await flcm.get(spec)).node.type, spec.type);
  const parent = await flcm.render({ type: "FRAME", width: 300, height: 300 });
  const result = await flcm.append(parent, spec);
  assert.equal(result.id, spec.id);
  assert.equal(((await figma.getNodeByIdAsync(result.id)) as any).parent.id, parent.id);
  assert.equal(result.children![0].id, spec.children![0].id);
  await assert.rejects(
    flcm.append(parent, { ...spec, type: "FRAME" }),
    /COMPONENT "[^"]*" \(id "[^"]+"\) at spec\.type: this layer is a COMPONENT, not a FRAME/,
  );
});

test("placement orders mentioned children last and leaves omitted children in relative order", async () => {
  const figma = createFigmaMock();
  const root = await flcm.render({
    type: "FRAME",
    children: [
      { type: "TEXT", text: "A" },
      { type: "TEXT", text: "B" },
      { type: "TEXT", text: "C" },
      { type: "TEXT", text: "D" },
    ],
  });
  const destination = await flcm.render({
    type: "FRAME",
    children: [{ type: "TEXT", text: "Existing" }],
  });
  const [a, b, c, d] = root.children!;
  await flcm.prepend(destination, { id: root.id, children: [{ id: d.id }, { id: b.id }] });
  const live = (await figma.getNodeByIdAsync(root.id)) as FrameNode;
  assert.deepEqual(
    live.children.map((child) => child.id),
    [a.id, c.id, d.id, b.id],
  );
  assert.equal(
    ((await figma.getNodeByIdAsync(destination.id)) as FrameNode).children[0].id,
    root.id,
  );
  await flcm.append(destination, { id: root.id, children: [] });
  assert.deepEqual(
    live.children.map((child) => child.id),
    [a.id, c.id, d.id, b.id],
  );
});

test("moved nodes bind to properties in their destination component", async () => {
  const figma = createFigmaMock();
  const component = await flcm.component(
    { type: "FRAME", width: 100, height: 100, children: [{ type: "TEXT", text: "Default", componentPropertyReferences: { text: "Label" } }] },
    { propertyDefinitions: { Label: { type: "text" } } },
  );
  const text = await flcm.render({ type: "TEXT", text: "Moved" });
  // Its binders show one value, the default: the moved layer is made to agree in the same call.
  await flcm.append(component, { id: text.id, text: "Default", componentPropertyReferences: { text: "Label" } });
  const live: any = await figma.getNodeByIdAsync(text.id);
  assert.equal(live.parent.id, component.id);
  assert.match(live.componentPropertyReferences.characters, /^Label#/);
  assert.equal(live.characters, "Default");
});

test("component promotion can declare bindings on existing children and derive their values", async () => {
  const figma = createFigmaMock();
  const text = await flcm.render({ type: "TEXT", text: "Existing label" });
  const component = await flcm.component(
    {
      type: "FRAME",
      width: 100,
      height: 100,
      children: [{ id: text.id, componentPropertyReferences: { text: "Label" } }],
    },
    { propertyDefinitions: { Label: { type: "text" } } },
  );
  const live: any = await figma.getNodeByIdAsync(component.id);
  const definition: any = Object.values(live.componentPropertyDefinitions)[0];
  assert.equal(definition.defaultValue, "Existing label");
  assert.equal(live.children[0].id, text.id);
});

test("promoting a live keyed frame keeps its key on the component", async () => {
  const figma = createFigmaMock();
  const frame = await flcm.render({ type: "FRAME", key: "card", width: 100, height: 100, children: [{ type: "RECTANGLE", width: 20, height: 20 }] });
  const result = await flcm.component({ id: frame.id!, children: [{ id: frame.children![0].id! }] });
  const comp: any = await figma.getNodeByIdAsync(result.id!);
  assert.equal(comp.type, "COMPONENT");
  assert.equal(comp.getPluginData("flcm/key"), "card");
  assert.equal(result.children![0].id, frame.children![0].id);
});

test("children on a node that can't hold them refuse in one wording, created or live", async () => {
  createFigmaMock();
  const refusal = /an ELLIPSE can't have children\. Wrap them in a FRAME/;
  await assert.rejects(flcm.render({ type: "ELLIPSE", children: [{ type: "RECTANGLE" }] } as never), refusal);
  const dot = await flcm.render({ type: "ELLIPSE" });
  await assert.rejects(flcm.render({ type: "FRAME", children: [{ id: dot.id, children: [{ type: "RECTANGLE" }] }] } as never), refusal);
});
