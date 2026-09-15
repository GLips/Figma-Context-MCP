import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { createReadEgress, safeSerialize } from "../serialize.js";
import { elision } from "@framelink/core";
import * as flcm from "./runtime.js";

function setup() {
  const figma = createFigmaMock();
  const egress = createReadEgress();
  (globalThis as any).__flcmHost = { registerRead: egress.registerRead, isRunCancelled: () => false };
  return { figma, wire: (value: unknown) => safeSerialize(egress.project(value)) as any };
}

test("read objects project wherever returned or logged; authored lookalikes and extracted path strings remain whole", async () => {
  const { wire } = setup();
  const authored = await flcm.render({ type: "VECTOR", d: "M0 0 L8 0 L0 8 Z", width: 8, height: 8, fill: "#123456" });
  const read = await flcm.get(authored);
  assert.equal(read.node.type, "VECTOR");
  assert.equal(read.node.d, "M0 0 L8 0 L0 8 Z");
  const out = wire({ nested: [read], child: read.node, own: authored, path: read.node.d });
  assert.equal(out.nested[0].node.type, "IMAGE-SVG");
  assert.equal(out.child.type, "IMAGE-SVG");
  assert.equal(out.own.type, "VECTOR");
  assert.equal(out.own.d, authored.d);
  assert.equal(out.path, read.node.d);
  assert.equal(wire(read.node).elided.some((entry: any) => entry.$elided.field === "d"), true);
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
    const original = await flcm.render({ type: "VECTOR", ...geometry, width: 8, height: 8, fill: "#123456" });
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
  const marker = elision(parent.id, "children", [child.id]);
  await flcm.render({ id: parent.id, children: [marker as any] });
  assert.deepEqual(live.children, [child]);
  await assert.rejects(flcm.render(marker as any), /only valid inside a children array/);
  await assert.rejects(flcm.render({ id: parent.id, children: [{ $elided: {} } as any] }), /type must be/);
  assert.deepEqual(live.children, [child]);
});

test("blend modes, constraints and clipping read back in authorable fields", async () => {
  const { figma } = setup();
  const original = await flcm.render({ type: "FRAME", width: 80, height: 60, clip: true, mixBlendMode: "multiply", pin: { x: "right", y: "bottom" } });
  const { node } = await flcm.get(original);
  assert.equal(node.clip, true);
  assert.equal(node.mixBlendMode, "multiply");
  assert.deepEqual(node.pin, { x: "right", y: "bottom" });
  assert.equal(node.details!.blendMode, "MULTIPLY");
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
  assert.deepEqual(node.details!.styles!.fill, { id: "missing-style" });
  assert.equal(wire(node).fill, "#123456");
});

test("editing an inherited child tree is refused rather than silently ignored", async () => {
  setup();
  const component = await flcm.component({ type: "FRAME", children: [{ type: "TEXT", text: "Before" }] });
  const instance = await flcm.render({ type: "INSTANCE", componentId: component.id });
  const { node } = await flcm.get(instance);
  node.children![0].text = "After";
  await assert.rejects(flcm.render(node), /inherited instance children are read-only/);
  assert.equal((await flcm.get(instance)).node.children![0].text, "Before");
});
