import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { createReadEgress, safeSerialize } from "../serialize.js";
import * as flcm from "./runtime.js";

function setup() {
  const figma = createFigmaMock();
  const egress = createReadEgress();
  (globalThis as any).__flcmHost = { registerRead: egress.registerRead, isRunCancelled: () => false, isRunFinished: () => false };
  return { figma, wire: (value: unknown) => safeSerialize(egress.project(value)) as any };
}

test("read objects project wherever returned or logged; authored lookalikes and extracted path strings remain whole", async () => {
  const { wire } = setup();
  const authored = await flcm.render({ type: "VECTOR", d: "M0 0 L8 0 L0 8 Z", fill: "#123456" });
  const read = await flcm.get(authored);
  assert.equal(read.node.type, "VECTOR");
  assert.equal(read.node.d, "M0 0 L8 0 L0 8 Z");
  const out = wire({ nested: [read], child: read.node, own: authored, path: read.node.d });
  assert.equal(out.nested[0].node.type, "IMAGE-SVG");
  assert.equal(out.child.type, "IMAGE-SVG");
  assert.equal(out.own.type, "VECTOR");
  assert.equal(out.own.d, authored.d);
  assert.equal(out.path, read.node.d);
  assert.deepEqual(wire(read.node).elided, { d: JSON.stringify(read.node.d).length });
  read.node.d = "M0 0 L20 20";
  assert.equal(wire(read).node.d, read.node.d);
  assert.equal(wire(read).node.type, "VECTOR");
  const replacement = await flcm.get(authored);
  replacement.node = { id: "computed", type: "VECTOR", d: "mine" };
  assert.equal(wire(replacement).node.d, "mine");
});

test("VECTOR reads can move/edit or create a copy, including multiple paths and winding rules", async () => {
  const { figma } = setup();
  for (const geometry of [
    { d: "M0 0 L8 0 L0 8 Z" },
    { vectorPaths: [{ data: "M0 0 L8 0 L0 8 Z", windingRule: "EVENODD" as const }, { data: "M1 1 L2 2", windingRule: "NONE" as const }] },
  ]) {
    const original = await flcm.render({ type: "VECTOR", ...geometry, fill: "#123456" });
    const { node } = await flcm.get(original);
    const before = (await figma.getNodeByIdAsync(original.id)).vectorPaths;
    const moved = await flcm.render(node);
    assert.equal(moved.id, original.id);
    const template = { ...node };
    delete template.id;
    const copy = await flcm.render(template);
    assert.notEqual(copy.id, original.id);
    assert.deepEqual((await figma.getNodeByIdAsync(copy.id)).vectorPaths, before);
    assert.deepEqual((await figma.getNodeByIdAsync(original.id)).vectorPaths, before);
  }
});

test("a retyped marker preserves live children and is never created as content", async () => {
  const { figma } = setup();
  const parent = await flcm.render({ type: "FRAME", children: [{ type: "TEXT", text: "Keep" }] });
  const live = await figma.getNodeByIdAsync(parent.id);
  const child = live.children[0];
  const marker = { elided: { children: 42 } };
  await flcm.render({ id: parent.id, children: [marker as any] });
  assert.deepEqual(live.children, [child]);
  await assert.rejects(flcm.render(marker as any), /only valid inside a children array/);
  await assert.rejects(flcm.render({ id: parent.id, children: [{ elided: {} } as any] }), /type must be/);
  assert.deepEqual(live.children, [child]);
});

test("blend modes, constraints and clipping read back in authorable fields", async () => {
  const { figma } = setup();
  const original = await flcm.render({ type: "FRAME", width: 80, height: 60, clip: true, mixBlendMode: "multiply", pin: { x: "right", y: "bottom" } });
  const { node } = await flcm.get(original);
  assert.equal(node.clip, true);
  assert.equal(node.mixBlendMode, "multiply");
  assert.deepEqual(node.pin, { x: "right", y: "bottom" });
  assert.equal(node.readOnlySource!.blendMode, "MULTIPLY");
  const template = { ...node }; delete template.id;
  const copy = await flcm.render(template);
  const live = await figma.getNodeByIdAsync(copy.id);
  assert.equal(live.clipsContent, true);
  assert.equal(live.blendMode, "MULTIPLY");
  assert.deepEqual(live.constraints, { horizontal: "MAX", vertical: "MAX" });
});

test("unresolved style ids remain readable without inventing a style name", async () => {
  const { figma, wire } = setup();
  const original = await flcm.render({ type: "RECTANGLE", fill: "#123456" });
  const live = await figma.getNodeByIdAsync(original.id);
  live.fillStyleId = "missing-style";
  const { node } = await flcm.get(original);
  assert.deepEqual(node.readOnlySource!.styles!.fill, { id: "missing-style" });
  assert.equal(wire(node).fill, "#123456");
});

test("inherited instance echoes survive verb copies and JSON round-trips without source metadata", async () => {
  const { figma } = setup();
  const component = await flcm.component({ type: "FRAME", children: [{ type: "FRAME", children: [{ type: "TEXT", text: "Before" }] }] });
  const instance = await flcm.render({ type: "INSTANCE", componentId: component.id });
  const parent = await flcm.render({ type: "FRAME" });
  const { node } = await flcm.get(instance);
  const live = await figma.getNodeByIdAsync(instance.id);
  const children = [...live.children];
  const first = await flcm.append(parent, node);
  const copy = await flcm.append(parent, first);
  const third = await flcm.append(parent, JSON.parse(JSON.stringify(copy)));
  assert.equal(third.id, instance.id);
  assert.deepEqual(live.children, children);
  const withoutSource = JSON.parse(JSON.stringify(node), (key, value) => key === "readOnlySource" ? undefined : value);
  await flcm.append(parent, withoutSource);
  assert.deepEqual(live.children, children);
  for (const child of [{ type: "TEXT", text: "New" }, { id: "foreign", type: "TEXT" }, { ...node.children![0], children: [{ id: "foreign" }] }]) {
    await assert.rejects(flcm.append(parent, { ...node, children: [child] } as any), /must belong to this instance/);
    assert.deepEqual(live.children, children);
  }
});

test("hidden nodes report visible false in get, predicates and slim handles", async () => {
  setup();
  const parent = await flcm.render({ type: "FRAME", children: [{ type: "TEXT", text: "Hidden", visible: false }] });
  const full = await flcm.get(parent);
  const hidden = full.node.children![0];
  assert.equal(hidden.visible, false);
  assert.equal((await flcm.get(hidden.id)).node.visible, false);
  const hits = await flcm.find({ within: parent, type: "TEXT" }, node => node.visible === false);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].visible, false);
});

test("warnings are stripped from placement specs and edit deltas", async () => {
  const { figma, wire } = setup();
  const r = await flcm.render({ type: "FRAME", width: 100, height: 100 });
  const diagnostic = { id: r.id, message: "stale diagnostic" };
  const moved = await flcm.render({ ...r, warnings: [diagnostic] });
  assert.equal(moved.warnings, undefined);
  const edited = await flcm.edit(r, { opacity: 0.5, warnings: [diagnostic] } as any);
  assert.equal(edited.warnings, undefined);
  assert.equal((await figma.getNodeByIdAsync(r.id)).opacity, 0.5);
  assert.equal(wire(edited).warnings, undefined);
});
