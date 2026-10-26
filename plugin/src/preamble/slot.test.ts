/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import * as flcm from "./runtime.js";
import { specNode } from "../../harness/spec-node.js";
import { createSceneAccess } from "./scene-access.js";

async function fixture() {
  const figma = createFigmaMock();
  const component = await flcm.component(
    {
      type: "FRAME",
      width: 240,
      height: 200,
      children: [
        {
          type: "FRAME",
          width: 200,
          height: 100,
          componentPropertyReferences: { slot: "Body" },
          children: [{ type: "TEXT", text: "Placeholder" }],
        },
      ],
    },
    { propertyDefinitions: { Body: { type: "slot" } } },
  );
  const path = component.children![0].id!;
  const slotOf = async (target: { id: string }) =>
    ((await figma.getNodeByIdAsync(target.id)) as any).findOne((n: any) => n.type === "SLOT");
  return { figma, component, path, slotOf };
}

test("slot specs create content with returned ids and preserve unmentioned placeholders", async () => {
  const { component, path, slotOf } = await fixture();
  const input = {
    type: "INSTANCE",
    componentId: component.id,
    overrides: { [path]: { children: [{ type: "TEXT", key: "hello", text: "Hello" }] } },
  };
  const first = await flcm.render(input);
  const slot = await slotOf(first);
  assert.deepEqual(
    slot.children.map((n: any) => n.characters),
    ["Placeholder", "Hello"],
  );
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
  await flcm.edit(first, {
    overrides: {
      [path]: {
        children: [
          { id: live.id, text: "Inside" },
          { type: "TEXT", text: "New" },
        ],
      },
    },
  });
  const slot = await slotOf(first);
  assert.deepEqual(
    slot.children.map((n: any) => n.characters),
    ["Placeholder", "Inside", "New"],
  );
  assert.equal(slot.children[1].id, live.id);
  await flcm.edit(first, { overrides: { [path]: { children: [] } } });
  assert.equal(slot.children.length, 3);
  await flcm.remove({ id: live.id });
  assert.deepEqual(
    slot.children.map((n: any) => n.characters),
    ["Placeholder", "New"],
  );
});

test("nested instances in slot content compile their own trees and return every authored id", async () => {
  const { component, path, slotOf } = await fixture();
  const tree = await flcm.render({
    type: "INSTANCE",
    componentId: component.id,
    overrides: {
      [path]: {
        children: [
          {
            type: "INSTANCE",
            key: "nested",
            componentId: component.id,
            overrides: { [path]: { children: [{ type: "TEXT", key: "deep", text: "Deep" }] } },
          },
        ],
      },
    },
  });
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
    { id: instance.id, overrides: { [path]: { children: [{ type: "TEXT", text: "Added" }] } } },
    { id: placeholder.id, text: "Retained" },
  ]);
  assert.deepEqual(
    slot.children.map((n: any) => n.characters),
    ["Retained", "Added"],
  );
});

test("slot input errors identify their path and leave the document unchanged", async () => {
  const { figma, component, path } = await fixture();
  const before = [...figma.undoLog];
  await assert.rejects(
    flcm.render({
      type: "INSTANCE",
      componentId: component.id,
      overrides: { [path]: { children: [{ type: "TEXT", typo: true }] } },
    } as never),
    /overrides.*children\[0\].*typo/,
  );
  await assert.rejects(
    flcm.render({
      type: "INSTANCE",
      componentId: component.id,
      overrides: { [path]: { children: null } },
    } as never),
    /children.*array/,
  );
  await assert.rejects(
    flcm.render({
      type: "INSTANCE",
      componentId: component.id,
      overrides: {
        [path]: { children: [{ type: "TEXT", componentPropertyReferences: { text: "Unknown" } }] },
      },
    }),
    /componentPropertyReferences/,
  );
  assert.deepEqual(figma.undoLog, before);
});

test("inherited slot content moves out of its instance as a copy, and its old id follows the copy", async () => {
  const figma = createFigmaMock();
  const tile = await flcm.component({ type: "FRAME", name: "Tile", width: 40, height: 40 });
  const slot = (name: string) => ({ type: "FRAME", name, width: 100, height: 100, componentPropertyReferences: { slot: name } });
  const host = await flcm.component(
    { type: "FRAME", name: "Host", width: 300, height: 300, children: [slot("Source"), slot("Destination")] },
    { propertyDefinitions: { Source: { type: "slot" }, Destination: { type: "slot" } } },
  );
  const filled = { type: "INSTANCE", componentId: host.id, overrides: { [host.children![0].id!]: { children: [{ type: "INSTANCE", componentId: tile.id }] } } };
  const enclosing = await flcm.component({ type: "FRAME", name: "Enclosing", width: 400, height: 400, children: [filled] } as never);
  const outer = await flcm.render({ type: "INSTANCE", componentId: enclosing.id, left: 500 });
  const frame = await flcm.render({ type: "FRAME", width: 100, height: 100, left: 1000 });
  const [source, destination] = ((await figma.getNodeByIdAsync(outer.id)) as any).children[0].children;
  const subject = source.children[0].id;

  const moved = await flcm.append(destination.id, { id: subject });
  assert.equal(destination.children[0].id, moved.id);
  assert.equal(source.children.length, 0);

  const out = await flcm.append(frame, { id: moved.id }) as any;
  assert.notEqual(out.id, moved.id);
  assert.match(out.warnings[0].message, /placed a copy here and removed the original/);
  assert.equal(destination.children.length, 0);
  const copy = await figma.getNodeByIdAsync(out.id) as any;
  assert.equal(copy.name, "Tile");
  assert.equal(copy.parent.id, frame.id);
  // A later call naming the old id reaches the copy.
  assert.equal((await flcm.edit(moved.id, { name: "Moved" })).id, copy.id);
  assert.equal(copy.name, "Moved");
});

test("a copied instance's slot content moves out at every depth", async () => {
  const figma = createFigmaMock() as any;
  const tile = figma.createComponent(); figma.currentPage.appendChild(tile); tile.name = "Tile";
  const badge = figma.createFrame(); badge.name = "Badge"; tile.appendChild(badge);
  badge.componentPropertyReferences = { slotContentId: tile.addComponentProperty("Badge", "SLOT", "") };
  const section = figma.createComponent(); figma.currentPage.appendChild(section);
  const body = figma.createFrame(); body.name = "Body"; section.appendChild(body);
  body.componentPropertyReferences = { slotContentId: section.addComponentProperty("Body", "SLOT", "") };
  const instance = section.createInstance(); figma.currentPage.appendChild(instance);
  const userTile = tile.createInstance(); instance.children[0].appendChild(userTile);
  userTile.children[0].appendChild(figma.createStar());
  // A native clone gives all of the copy's slot content path ids, as a reload does to the original.
  const copy = await figma.getNodeByIdAsync((await flcm.clone(instance.id)).id);
  const movedTo = new Map<string, string>();
  for (const type of ["STAR", "INSTANCE"]) {
    const layer = copy.findOne((n: any) => n.type === type);
    assert.match(layer.id, /^I/);
    const out = await flcm.append(figma.currentPage.id, { id: layer.id });
    const moved = await figma.getNodeByIdAsync(out.id);
    assert.equal(moved.parent, figma.currentPage);
    assert.equal(moved.type, type);
    movedTo.set(layer.id, out.id);
  }
  assert.equal(copy.findAll(() => true).filter((n: any) => n.parent.type === "SLOT").length, 0);
  // The old ids keep reaching the copies after the instance they came from is gone.
  copy.remove();
  for (const [old, now] of movedTo) assert.equal((await flcm.get(old) as any).node.id, now);
});

test("an old id reaches its copy only once the verb that moved it commits", async () => {
  const figma = createFigmaMock() as any;
  const tile = figma.createComponent(); figma.currentPage.appendChild(tile);
  const body = figma.createFrame(); tile.appendChild(body);
  body.componentPropertyReferences = { slotContentId: tile.addComponentProperty("Body", "SLOT", "") };
  const instance = tile.createInstance(); figma.currentPage.appendChild(instance);
  instance.children[0].appendChild(figma.createStar());
  instance.children[0].appendChild(figma.createEllipse());
  const copy = instance.clone();
  const access = createSceneAccess(() => figma);
  const move = async (type: string, committed: boolean) => {
    const old = copy.findOne((n: any) => n.type === type).id;
    const view = await access.api.getNodeByIdAsync(old) as SceneNode;
    access.api.currentPage.appendChild(view);
    access.settleMovedIds(committed);
    return { old, now: view.id };
  };
  const kept = await move("STAR", true);
  assert.equal((await access.api.getNodeByIdAsync(kept.old))?.id, kept.now);
  // A rolled-back verb's undo restores the original, so its old id must not lead to the copy.
  const undone = await move("ELLIPSE", false);
  assert.notEqual((await access.api.getNodeByIdAsync(undone.old))?.id, undone.now);
});
