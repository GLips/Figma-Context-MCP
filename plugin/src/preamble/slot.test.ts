// Filling an instance's SLOT. What must not regress silently: `children` at a slot's path in
// `overrides` REPLACES the slot's content (at create and under edit, `[]` empties it), keys inside
// the content come back, a nested instance inside the content fills ITS slot, the structural verbs
// treat the filled content as the open tree it is while the instance's own list stays closed, an
// emptied slot reads back as emptied rather than as untouched, a fill and a write to the content
// that fill removes refuse each other, and every refusal fires with zero writes naming the path to
// write.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, text, instance, id, get } from "./flcm.js";
import { render } from "./render.js";
import { component } from "./component.js";
import { edit } from "./edit.js";
import { editMany } from "./edit-many.js";
import { append, insertBefore, remove, move } from "./structure.js";
import { fromRead } from "./from-read.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

// A "Card" whose body is a slot frame holding a text placeholder — the shape a designer leaves for
// content to land in. The slot's PATH is the definition frame's own id.
async function cardComponent() {
  const out = await component(
    frame({ key: "card", fill: "#111111", layout: { mode: "column", gap: 4, padding: 8 } }, [
      text("Title", { key: "title", name: "Title" }),
      frame({ key: "body", name: "Body", layout: { mode: "column", gap: 2 }, componentPropertyReferences: { slot: "Body" } }, [
        text("Placeholder", { key: "placeholder", name: "Placeholder" }),
      ]),
    ]),
    { name: "Card", propertyDefinitions: { Body: { type: "slot" } } },
  );
  const comp = await figma.getNodeByIdAsync(out.node.id);
  const slotPath: string = out.keyed.body.id;
  // Component-relative paths ARE the definition nodes' own ids — the same string `get` keys an
  // instance's overrides by, which is why a key on the definition names the path.
  return { comp, slotPath, placeholderPath: out.keyed.placeholder.id as string, title: await figma.getNodeByIdAsync(out.keyed.title.id) };
}

const liveSlotOf = (inst: any) => inst.findOne((n: { type: string }) => n.type === "SLOT");

test("`children` at the slot's path fills it at create, keys come back, and the read republishes it", async () => {
  const { comp, slotPath } = await cardComponent();
  const out = await render(
    instance(comp.id, {
      key: "card1",
      overrides: {
        [slotPath]: { children: [text("Hello", { key: "hello" }), rect({ key: "swatch", width: 10, height: 10, fill: "#ff0000" })] },
      },
    }),
  );
  const inst = await figma.getNodeByIdAsync(out.node.id);
  const slot = liveSlotOf(inst);
  assert.equal(slot.children.length, 2);
  assert.equal(slot.children[0].characters, "Hello");
  assert.equal(slot.children[1].type, "RECTANGLE");
  assert.equal(out.keyed.hello.id, slot.children[0].id);
  assert.equal(out.keyed.swatch.id, slot.children[1].id);
  // The placeholder went with the fill: content REPLACES, it does not join.
  assert.equal(slot.findOne((n: { name: string }) => n.name === "Placeholder"), null);
  const { node: spec } = await get(id(inst.id));
  const content = (spec as any).overrides[slotPath].children;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, "TEXT");
  // Read words are write words: the read spec re-authors whole, content and all.
  const again = await render(fromRead(spec));
  assert.equal(liveSlotOf(await figma.getNodeByIdAsync(again.node.id)).children.length, 2);
});

test("under edit the fill replaces the content whole, and [] empties the slot", async () => {
  const { comp, slotPath } = await cardComponent();
  const out = await render(instance(comp.id, { key: "card1" }));
  const inst = await figma.getNodeByIdAsync(out.node.id);
  const slot = liveSlotOf(inst);
  assert.equal(slot.children.length, 1);
  // A DELTA builds nodes here, which is the one thing a delta otherwise never does — an INSTANCE
  // spec among the content is the case that needs the edit path's own instance plans (without them
  // the build walk throws from inside the sealed span, mid-edit, with a report-a-bug message).
  await edit(id(inst.id), { overrides: { [slotPath]: { children: [text("One"), instance(comp.id, { key: "inner" })] } } });
  assert.deepEqual(slot.children.map((c: any) => c.type), ["TEXT", "INSTANCE"]);
  assert.equal(slot.children[0].characters, "One");
  assert.equal(slot.children[1].mainComponent.id, comp.id);
  await edit(id(inst.id), { overrides: { [slotPath]: { children: [text("One"), text("Two")] } } });
  assert.deepEqual(slot.children.map((c: any) => c.characters), ["One", "Two"]);
  // The slot's own words ride the same delta, and land before the content does.
  await edit(id(inst.id), { overrides: { [slotPath]: { layout: { mode: "row" }, children: [text("Three")] } } });
  assert.equal(slot.layoutMode, "HORIZONTAL");
  assert.deepEqual(slot.children.map((c: any) => c.characters), ["Three"]);
  await edit(id(inst.id), { overrides: { [slotPath]: { children: [] } } });
  assert.equal(slot.children.length, 0);
  // An emptied slot must not read back as untouched. The read has no `children: []` word for it —
  // core answers an emptied container by hiding every one of the component's children by path —
  // but it must say SOMETHING, and re-authoring what it says must not restore the placeholder.
  const { node: spec } = await get(id(inst.id));
  const placeholderPath = Object.keys((spec as any).overrides).find((p) => p !== slotPath)!;
  assert.deepEqual((spec as any).overrides[placeholderPath], { visible: false });
  const again = await render(fromRead(spec));
  const reslot = liveSlotOf(await figma.getNodeByIdAsync(again.node.id));
  assert.deepEqual(
    reslot.children.filter((c: any) => c.visible).map((c: any) => c.characters),
    [],
  );
});

test("a nested instance inside the content fills its own slot", async () => {
  const { comp, slotPath } = await cardComponent();
  const out = await render(
    instance(comp.id, {
      overrides: { [slotPath]: { children: [instance(comp.id, { key: "inner", overrides: { [slotPath]: { children: [text("Deep", { key: "deep" })] } } })] } },
    }),
  );
  const outer = await figma.getNodeByIdAsync(out.node.id);
  const inner = await figma.getNodeByIdAsync(out.keyed.inner.id);
  assert.equal(inner.parent, liveSlotOf(outer));
  assert.equal(liveSlotOf(inner).children[0].characters, "Deep");
  assert.equal(out.keyed.deep.id, liveSlotOf(inner).children[0].id);
});

test("the structural verbs work inside a filled slot, and the instance's own list stays closed", async () => {
  const { comp, slotPath } = await cardComponent();
  const out = await render(instance(comp.id, { overrides: { [slotPath]: { children: [text("A", { key: "a" }), text("B", { key: "b" })] } } }));
  const inst = await figma.getNodeByIdAsync(out.node.id);
  const slot = liveSlotOf(inst);
  await append(id(slot.id), text("C"));
  await insertBefore(id(out.keyed.a.id), text("Z"));
  assert.deepEqual(slot.children.map((c: any) => c.characters), ["Z", "A", "B", "C"]);
  await remove(id(out.keyed.b.id));
  await move(id(out.keyed.a.id), id(slot.id));
  assert.deepEqual(slot.children.map((c: any) => c.characters), ["Z", "C", "A"]);
  // Content may be nested and still be open: a frame IN the slot takes children.
  const holder = await append(id(slot.id), frame({ key: "holder", width: 20, height: 20 }));
  await append(id(holder.node.id), text("Inside"));
  // The instance's own child list, and its non-slot sublayers, are as closed as ever.
  await assert.rejects(append(id(inst.id), text("nope")), /whose child list Figma won't let a plugin change.*place into one of its SLOTs.*"Body" \(id "Ii8:8;4:4"\)/s);
  await assert.rejects(remove(id(slot.id)), /node being moved or removed is inside component instance/);
  await assert.rejects(move(id(slot.id), id(holder.node.id)), /node being moved or removed is inside component instance/);
});

test("a fill refuses with zero writes: a non-slot path, a binding inside, a raw read spec, null", async () => {
  const { comp, slotPath, title } = await cardComponent();
  const out = await render(instance(comp.id, { key: "card1" }));
  const inst = await figma.getNodeByIdAsync(out.node.id);
  const before = figma.undoLog.length;
  await assert.rejects(
    render(instance(comp.id, { overrides: { [title.id]: { children: [text("x")] } } })),
    new RegExp("`children` fills a SLOT, and TEXT \"Title\".*is not one\\. The slot of COMPONENT \"Card\".*is at " + JSON.stringify(slotPath)),
  );
  await assert.rejects(
    edit(id(inst.id), { overrides: { [title.id]: { children: [text("x")] } } }),
    /`children` fills a SLOT.*is not one/,
  );
  assert.throws(
    () => instance(comp.id, { overrides: { [slotPath]: { children: [text("x", { componentPropertyReferences: { text: "Body" } })] }} }),
    /componentPropertyReferences/,
  );
  const { node: read } = await get(id(title.id));
  assert.throws(() => instance(comp.id, { overrides: { [slotPath]: { children: [read as any] } } }), /read spec.*flcm\.fromRead/s);
  assert.throws(() => instance(comp.id, { overrides: { [slotPath]: { children: null as any } } }), /no null form/);
  assert.throws(() => instance(comp.id, { overrides: { [slotPath]: { children: text("x") as any } } }), /must be an array/);
  assert.deepEqual(figma.undoLog.slice(before), []);
});

test("a slot named as a componentProperty, or `children` on the SLOT node itself, points at the fill word", async () => {
  const { comp, slotPath } = await cardComponent();
  const out = await render(instance(comp.id, { key: "card1" }));
  const inst = await figma.getNodeByIdAsync(out.node.id);
  const slot = liveSlotOf(inst);
  const before = figma.undoLog.length;
  await assert.rejects(
    render(instance(comp.id, { componentProperties: { Body: "x" } })),
    new RegExp("is a slot, and a slot has no value.*overrides\\[" + JSON.stringify(slotPath) + "\\] = \\{ children:"),
  );
  await assert.rejects(edit(id(slot.id), { children: [text("x")] as any }), /stated from its instance.*overrides.*children.*flcm\.append\(slot/s);
  assert.deepEqual(figma.undoLog.slice(before), []);
});

test("a fill and a write to the content it removes are refused, in one delta and across a batch", async () => {
  const { comp, slotPath, placeholderPath } = await cardComponent();
  const one = await figma.getNodeByIdAsync((await render(instance(comp.id, { key: "one" }))).node.id);
  const two = await figma.getNodeByIdAsync((await render(instance(comp.id, { key: "two" }))).node.id);
  const placeholder = liveSlotOf(two).children[0];
  const before = figma.undoLog.length;
  await assert.rejects(
    edit(id(one.id), { overrides: { [slotPath]: { children: [text("New")] }, [placeholderPath]: { text: "Edited" } } }),
    new RegExp("sits inside the slot at " + JSON.stringify(slotPath) + ", whose `children` this same call replaces"),
  );
  await assert.rejects(
    editMany([
      { target: id(placeholder.id), changes: { text: "Edited" } },
      { target: id(two.id), changes: { overrides: { [slotPath]: { children: [text("New")] } } } },
    ]),
    /\[0\] sits inside the slot at .* which entry \[1\] FILLS in the same batch/,
  );
  // Zero writes on both counts — a refusal, not a rollback, and the placeholder is still alive.
  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(placeholder.removed, false);
  assert.equal(placeholder.characters, "Placeholder");
});

test("editMany fills two instances' slots in one step, and keys stay unique across the batch", async () => {
  const { comp, slotPath } = await cardComponent();
  const one = await figma.getNodeByIdAsync((await render(instance(comp.id, { key: "one" }))).node.id);
  const two = await figma.getNodeByIdAsync((await render(instance(comp.id, { key: "two" }))).node.id);
  await editMany([
    { target: id(one.id), changes: { overrides: { [slotPath]: { children: [text("First", { key: "first" })] } } } },
    { target: id(two.id), changes: { overrides: { [slotPath]: { children: [text("Second", { key: "second" })] } } } },
  ]);
  assert.equal(liveSlotOf(one).children[0].characters, "First");
  assert.equal(liveSlotOf(two).children[0].characters, "Second");
  const before = figma.undoLog.length;
  await assert.rejects(
    editMany([
      { target: id(one.id), changes: { overrides: { [slotPath]: { children: [text("x", { key: "dup" })] } } } },
      { target: id(two.id), changes: { overrides: { [slotPath]: { children: [text("y", { key: "dup" })] } } } },
    ]),
    /duplicate key "dup"/,
  );
  // One walk for the batch: the collision is found while the second entry builds, and the whole
  // batch is rolled back (commit-then-undo — the mock records the sequence, it cannot replay it).
  assert.deepEqual(figma.undoLog.slice(before), ["commit", "commit", "trigger"]);
});
