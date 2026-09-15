import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import * as flcm from "./runtime.js";
import { specNode } from "../../harness/spec-node.js";

async function fixture() {
  const figma = createFigmaMock();
  const component = await flcm.component({ type: "FRAME", width: 240, height: 200, children: [
    { type: "FRAME", width: 200, height: 100, componentPropertyReferences: { slot: "Body" }, children: [{ type: "TEXT", text: "Placeholder" }] },
  ] }, { propertyDefinitions: { Body: { type: "slot" } } });
  const path = component.children![0].id!;
  const slotOf = async (target: { id: string }) => (await figma.getNodeByIdAsync(target.id) as any).findOne((n: any) => n.type === "SLOT");
  return { figma, component, path, slotOf };
}

test("slot specs create content with returned ids and preserve unmentioned placeholders", async () => {
  const { component, path, slotOf } = await fixture();
  const input = { type: "INSTANCE", componentId: component.id, overrides: { [path]: { children: [{ type: "TEXT", key: "hello", text: "Hello" }] } } };
  const first = await flcm.render(input);
  const slot = await slotOf(first);
  assert.deepEqual(slot.children.map((n: any) => n.characters), ["Placeholder", "Hello"]);
  assert.equal(specNode(first, "hello").id, slot.children[1].id);
  assert.equal("id" in input.overrides[path].children[0], false);
  const { node } = await flcm.get(first);
  const moved = await flcm.render(node);
  assert.equal(moved.id, first.id);
  assert.equal((await slotOf(moved)).children.length, 2);
});

test("slot edits move id-bearing content, create new children, and retain omissions", async () => {
  const { component, path, slotOf } = await fixture();
  const first = await flcm.render({ type: "INSTANCE", componentId: component.id });
  const live = await flcm.render({ type: "TEXT", text: "Outside" });
  await flcm.edit(first, { overrides: { [path]: { children: [{ id: live.id, text: "Inside" }, { type: "TEXT", text: "New" }] } } });
  const slot = await slotOf(first);
  assert.deepEqual(slot.children.map((n: any) => n.characters), ["Placeholder", "Inside", "New"]);
  assert.equal(slot.children[1].id, live.id);
  await flcm.edit(first, { overrides: { [path]: { children: [] } } });
  assert.equal(slot.children.length, 3);
  await flcm.remove({ id: live.id });
  assert.deepEqual(slot.children.map((n: any) => n.characters), ["Placeholder", "New"]);
});

test("nested instances in slot content compile their own trees and return every authored id", async () => {
  const { component, path, slotOf } = await fixture();
  const tree = await flcm.render({ type: "INSTANCE", componentId: component.id, overrides: { [path]: { children: [
    { type: "INSTANCE", key: "nested", componentId: component.id, overrides: { [path]: { children: [{ type: "TEXT", key: "deep", text: "Deep" }] } } },
  ] } } });
  const nested = specNode(tree, "nested");
  const slot = await slotOf(nested);
  assert.equal(slot.children[1].characters, "Deep");
  assert.equal(slot.children[1].id, specNode(tree, "deep").id);
});

test("slot content and edits to retained children can share a batch", async () => {
  const { component, path, slotOf } = await fixture();
  const instance = await flcm.render({ type: "INSTANCE", componentId: component.id });
  const slot = await slotOf(instance);
  const placeholder = slot.children[0];
  await flcm.editMany([
    { target: instance, changes: { overrides: { [path]: { children: [{ type: "TEXT", text: "Added" }] } } } },
    { target: { id: placeholder.id }, changes: { text: "Retained" } },
  ]);
  assert.deepEqual(slot.children.map((n: any) => n.characters), ["Retained", "Added"]);
});

test("slot input errors identify their path and leave the document unchanged", async () => {
  const { figma, component, path } = await fixture();
  const before = [...figma.undoLog];
  await assert.rejects(flcm.render({ type: "INSTANCE", componentId: component.id, overrides: { [path]: { children: [{ type: "TEXT", typo: true }] } } } as never), /overrides.*children\[0\].*typo/);
  await assert.rejects(flcm.render({ type: "INSTANCE", componentId: component.id, overrides: { [path]: { children: null } } } as never), /children.*array/);
  await assert.rejects(flcm.render({ type: "INSTANCE", componentId: component.id, overrides: { [path]: { children: [{ type: "TEXT", componentPropertyReferences: { text: "Unknown" } }] } } }), /componentPropertyReferences/);
  assert.deepEqual(figma.undoLog, before);
});
