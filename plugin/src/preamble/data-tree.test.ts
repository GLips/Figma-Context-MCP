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
    /children\[1\].id.*duplicate/,
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
    { aspectRatio: 2 },
    { fill: "fill_a1b2c3d4" },
    { layout: { mode: "grid" } },
  ]) {
    await assert.rejects(
      flcm.render({ type: "FRAME", ...words }),
      /strokeDashes|aspectRatio|REFERENCE|grid/,
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
  await assert.rejects(flcm.render(cycle), /children\[0\].*cyclic/);
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
    /children\[1\].key.*duplicate/,
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
    /type FRAME does not match live COMPONENT/,
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
    { type: "FRAME", width: 100, height: 100 },
    { propertyDefinitions: { Label: { type: "text", defaultValue: "Default" } } },
  );
  const text = await flcm.render({ type: "TEXT", text: "Moved" });
  await flcm.append(component, { id: text.id, componentPropertyReferences: { text: "Label" } });
  const live: any = await figma.getNodeByIdAsync(text.id);
  assert.equal(live.parent.id, component.id);
  assert.match(live.componentPropertyReferences.characters, /^Label#/);
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
