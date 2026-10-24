/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// A read pasted back is the standard agent move, so every word it echoes must state no change: the
// read of a component, an instance and a slot each place back unchanged, whether pasted within the
// call or as the JSON an earlier call's output carried. An echoed binding is the risk: read as a new
// one, it has no declaring component and the paste is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock, seedStyle, seedVariables } from "../../harness/figma-mock.mjs";
import { safeSerialize } from "../serialize.js";
import { projectForEgress } from "./egress.js";
import { stableStringify } from "@framelink/core";
import * as flcm from "./runtime.js";

async function chipOnHolder() {
  const figma = createFigmaMock();
  (globalThis as any).__flcmHost = { runCancellation: () => null, whenCancelled: () => new Promise(() => {}), isRunFinished: () => false };
  seedVariables({ collection: "Brand", variables: [{ name: "color/brand", type: "COLOR", values: { Default: { r: 0, g: 0, b: 1, a: 1 } } }] });
  const holder = await flcm.render({ type: "FRAME", width: 400, height: 400 });
  const comp = await flcm.component(
    {
      type: "FRAME",
      fill: { variable: "color/brand" },
      layout: { mode: "row", gap: 4, padding: 8 },
      children: [
        { type: "RECTANGLE", width: 12, height: 12, fill: "#ffffff", componentPropertyReferences: { visible: "Icon" } },
        { type: "TEXT", text: "Label", componentPropertyReferences: { text: "Label" } },
        { type: "FRAME", width: "fill", height: 20, componentPropertyReferences: { slot: "Trailing" } },
      ],
    },
    { name: "Chip", propertyDefinitions: { Icon: { type: "boolean" }, Label: { type: "text" }, Trailing: { type: "slot" } } },
  );
  await flcm.append(holder, comp);
  const slotPath = comp.children![2].id!;
  const inst = await flcm.append(holder, {
    type: "INSTANCE",
    componentId: comp.id,
    componentProperties: { Label: "Hi" },
    overrides: { [slotPath]: { children: [{ type: "TEXT", text: "Inside" }] } },
  });
  const live = (target: { id: string }) => figma.getNodeByIdAsync(target.id) as Promise<any>;
  // Everything a paste could disturb: the whole read, plus the live bindings and declarations a
  // read spells by bare name.
  const state = async () => stableStringify({
    read: (await flcm.get(holder)).node,
    definitions: (await live(comp)).componentPropertyDefinitions,
    references: (await live(comp)).children.map((child: any) => child.componentPropertyReferences),
  });
  return { comp, inst, holder, live, state, wire: (value: unknown) => JSON.parse(JSON.stringify(safeSerialize(projectForEgress(value, "result")))) };
}

test("a component, an instance and a slot pasted back from their own reads are no-ops", async () => {
  const { comp, inst, holder, live, state, wire } = await chipOnHolder();
  const slot = (await live(comp)).children[2];
  const before = await state();
  for (const paste of [(read: unknown) => read, wire]) {
    // Each is its parent's last child, so appending it there again is placing it where it is.
    await flcm.insertBefore(inst, paste((await flcm.get(comp)).node) as any);
    await flcm.append(comp, paste((await flcm.get(slot.id)).node) as any);
    await flcm.append(holder, paste((await flcm.get(inst)).node) as any);
    assert.equal(await state(), before);
  }
});

test("a component moves by its own read, and its bindings come along intact", async () => {
  const { comp, live } = await chipOnHolder();
  const staging = await flcm.render({ type: "FRAME", width: 400, height: 400 });
  const references = stableStringify((await live(comp)).children.map((child: any) => child.componentPropertyReferences));
  await flcm.append(staging, (await flcm.get(comp)).node);
  assert.equal((await live(comp)).parent.id, staging.id);
  assert.equal(stableStringify((await live(comp)).children.map((child: any) => child.componentPropertyReferences)), references);
  // Changed words in the same paste still land.
  await flcm.append(staging, { ...(await flcm.get(comp)).node, opacity: 0.5 });
  assert.equal((await live(comp)).opacity, 0.5);
});

test("a read spread with one word changed writes only that word, inside a bag too", async () => {
  const figma = createFigmaMock();
  const column = await flcm.render({
    type: "FRAME",
    width: 300,
    layout: { mode: "column", alignItems: "center", gap: 4 },
    children: [{ type: "FRAME", width: "fill", height: 10 }, { type: "FRAME", width: 20, height: 10 }],
  });
  const live = await figma.getNodeByIdAsync(column.id) as any;
  const sizing = () => live.children.map((child: any) => child.layoutSizingHorizontal);
  const before = sizing();
  const read = (await flcm.get(column)).node;
  // Re-sent, the restated alignItems would un-stretch the fill child.
  await flcm.render({ ...read, layout: { ...read.layout!, gap: "6px" } });
  assert.equal(live.itemSpacing, 6);
  assert.deepEqual(sizing(), before);
});

// A restated word is no change only while the call leaves alone what the read described it against.
test("a word equal to the read still lands when the same call changes its context", async () => {
  const figma = createFigmaMock();
  const live = (target: { id: string }) => figma.getNodeByIdAsync(target.id) as Promise<any>;

  // The parent re-flows: the child's fill was a share of the column, and the row reads it afresh.
  const column = await flcm.render({ type: "FRAME", width: 300, height: 400, layout: { mode: "column" }, children: [{ type: "FRAME", width: "fill", height: 10 }] });
  const child = column.children![0];
  await flcm.render({ id: column.id, layout: { mode: "row" }, children: [{ id: child.id, width: "fill" }] });
  assert.equal((await live(child)).layoutSizingHorizontal, "FILL");

  // The instance swaps: its read described the component it is leaving.
  const faded = await flcm.component({ type: "FRAME", width: 20, height: 20, opacity: 0.5 });
  const solid = await flcm.component({ type: "FRAME", width: 20, height: 20 });
  const inst = await flcm.render({ type: "INSTANCE", componentId: faded.id });
  await flcm.render({ id: inst.id, componentId: solid.id, opacity: 0.5 });
  assert.equal((await live(inst)).opacity, 0.5);

  // A restated family anchors a new weight across mixed runs.
  const text = await flcm.render({ type: "TEXT", text: "a **b**" });
  await flcm.render({ id: text.id, textStyle: { fontFamily: "Inter", fontWeight: 700 } });
  assert.deepEqual((await live(text)).fontName, { family: "Inter", style: "Bold" });
});

test("edit and editMany given words copied from a read change nothing", async () => {
  const { inst, state } = await chipOnHolder();
  const before = await state();
  const { id, type, children, readOnlySource, ...words } = (await flcm.get(inst)).node as any;
  // The Label sublayer: its echoed binding would be refused as a new one, and its echoed values
  // would pin inherited values as overrides.
  const { id: label, type: _, readOnlySource: __, ...echoed } = children[1];
  await flcm.edit(inst, words);
  await flcm.edit(label, echoed);
  await flcm.editMany([{ id: label, ...echoed }]);
  assert.equal(await state(), before);
});

// A written textStyle sets the whole node, so on run-styled text a base word restates only beside
// the runs it is the base of: alone, or beside new text, it is a reset.
test("a run-styled text's base style restates only beside its own runs", async () => {
  const figma = createFigmaMock();
  const live = (target: { id: string }) => figma.getNodeByIdAsync(target.id) as Promise<any>;
  const text = await flcm.render({ type: "TEXT", text: "Hello **World**" });
  const { textStyle, text: runs } = (await flcm.get(text)).node as any;
  await flcm.edit(text, { text: runs, textStyle });
  assert.equal((await live(text)).fontName, figma.mixed);
  await flcm.edit(text, { textStyle: { fontFamily: textStyle.fontFamily, fontWeight: textStyle.fontWeight } });
  assert.deepEqual((await live(text)).fontName, { family: "Inter", style: "Regular" });
});

// No word is skipped on a pre-call comparison: each lands at its write point, and the finalizer
// checks it after. So a paste must leave bindings, style ids, annotations and run fonts exactly.
test("a pasted read changes nothing semantic, and a deliberate change lands without disturbing the rest", async () => {
  const figma = createFigmaMock();
  seedVariables({ collection: "Brand", variables: [
    { name: "color/brand", type: "COLOR", values: { Default: { r: 0, g: 0, b: 1, a: 1 } } },
    { name: "size/card", type: "FLOAT", values: { Default: 240 } },
  ] });
  seedStyle({ type: "PAINT", name: "Surface", paints: [{ type: "SOLID", color: { r: 0, g: 1, b: 0 }, opacity: 1, visible: true, blendMode: "NORMAL" }] });
  const comp = await flcm.component(
    {
      type: "FRAME", fill: { variable: "color/brand" }, width: { variable: "size/card" }, height: 120,
      children: [
        { type: "TEXT", text: ["Hello ", ["World", { fontWeight: 700 }], " again"], textStyle: { fontSize: 14 } },
        { type: "RECTANGLE", width: 20, height: 20, fill: { style: "Surface" }, annotations: [{ text: "Note", category: "Agent" }] },
        { type: "RECTANGLE", width: 12, height: 12, componentPropertyReferences: { visible: "Icon" } },
      ],
    },
    { name: "Card", propertyDefinitions: { Icon: { type: "boolean" } } },
  );
  const card = await figma.getNodeByIdAsync(comp.id!) as any;
  const [title, swatch, icon] = card.children;
  const segments = () => title.getStyledTextSegments(["fontName", "fills"]).map((s: any) => [s.characters, s.fontName.style, s.fills[0].color]);
  const live = () => ({
    bound: [card.boundVariables, card.fills[0].boundVariables],
    style: swatch.fillStyleId,
    annotations: swatch.annotations,
    references: icon.componentPropertyReferences,
  });
  const state = async () => stableStringify({ read: (await flcm.get(comp)).node, live: live(), segments: segments() });
  const before = await state();
  const read = (await flcm.get(comp)).node as any;
  const words = ({ id: _id, type: _type, children: _children, readOnlySource: _source, ...rest }: any) => rest;
  for (const child of read.children) await flcm.edit(child.id, words(child));
  await flcm.editMany(read.children.map((child: any) => ({ id: child.id, ...words(child) })));
  await flcm.render(read);
  assert.equal(await state(), before);

  const untouched = stableStringify(live());
  const [head, [word, style], tail] = read.children[0].text;
  await flcm.editMany([{ id: title.id, text: [head, [word, { ...style, color: "#ff0000" }], tail], textStyle: read.children[0].textStyle }]);
  assert.deepEqual(segments(), [["Hello ", "Regular", { r: 0, g: 0, b: 0 }], ["World", "Bold", { r: 1, g: 0, b: 0 }], [" again", "Regular", { r: 0, g: 0, b: 0 }]]);
  assert.equal(stableStringify(live()), untouched);

  // A literal is a deliberate value, so it unbinds even where it equals the variable's.
  await flcm.edit(card.id, { width: 240 });
  assert.equal(card.boundVariables.width, undefined);
  assert.equal(card.width, 240);
});
