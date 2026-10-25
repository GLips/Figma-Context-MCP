/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { specNode } from "../../harness/spec-node.js";
// Editing a MAIN component — the capability with no verb of its own: `flcm.edit` on the COMPONENT
// and on its sublayers, plus the structural verbs, and every instance follows because that is what
// Figma does.
//
// What must not regress silently: a component's root takes a frame's words (and its instances get
// them), `propertyDefinitions` adds/changes/renames/deletes a declaration with instances following,
// `componentPropertyReferences` binds and unbinds a live sublayer, a bound compiled node may be inserted into
// an existing component (a new `slot` name declaring the property, since a slot IS its frame), an
// instance's SLOT takes the frame surface — and every refusal fires with zero writes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { component, variants } from "./component.js";
import { edit } from "./edit.js";
import { editMany } from "./edit-many.js";
import { render, append } from "./structure.js";
import { get } from "./read.js";

// A refusal pinned by its fields and the words that make it actionable, not by its whole sentence.
function refused(fields: { kind?: string; path?: string; node?: Record<string, unknown> }, reason: RegExp) {
  return (err: any): boolean => {
    for (const [key, value] of Object.entries(fields)) {
      if (key === "node") for (const [k, v] of Object.entries(value as object)) assert.equal(err.node?.[k], v, "node." + k);
      else assert.equal(err[key], value, key);
    }
    assert.match(err.reason, reason);
    return true;
  };
}

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

// A "Chip" carrying a bound boolean, a bound text and a bound slot frame — one sublayer per binding
// field an edit can reach, and one instance of it to watch follow.
async function chipComponent() {
  const out = await component(
    {
      type: "FRAME",
      key: "chip",
      fill: "#0000ff",
      layout: { mode: "row", gap: 4, padding: 8 },
      children: [
        {
          type: "RECTANGLE",
          key: "icon",
          name: "Icon",
          width: 12,
          height: 12,
          fill: "#ffffff",
          componentPropertyReferences: { visible: "Icon" },
        },
        {
          type: "TEXT",
          text: "Label",
          key: "label",
          name: "Label",
          componentPropertyReferences: { text: "Label" },
        },
        {
          type: "FRAME",
          key: "trailing",
          name: "Trailing",
          width: 20,
          height: 20,
          componentPropertyReferences: { slot: "Trailing" },
        },
      ],
    },
    {
      name: "Chip",
      propertyDefinitions: {
        Icon: { type: "boolean" },
        Label: { type: "text" },
        Trailing: { type: "slot" },
      },
    },
  );
  const comp = await figma.getNodeByIdAsync(out.id);
  const stamped = await render({
    type: "INSTANCE",
    componentId: comp.id,
    key: "live",
    left: 400,
    top: 400,
  });
  return {
    comp,
    icon: await figma.getNodeByIdAsync(specNode(out, "icon").id),
    label: await figma.getNodeByIdAsync(specNode(out, "label").id),
    trailing: await figma.getNodeByIdAsync(specNode(out, "trailing").id),
    inst: await figma.getNodeByIdAsync(stamped.id),
  };
}

// A bare component with no properties at all — the starting point for "declare, then bind".
async function plainComponent() {
  const out = await component(
    {
      type: "FRAME",
      key: "card",
      fill: "#111111",
      layout: { mode: "column", gap: 4, padding: 8 },
      children: [{ type: "TEXT", text: "Title", key: "title", name: "Title" }],
    },
    { name: "Card" },
  );
  const comp = await figma.getNodeByIdAsync(out.id);
  const stamped = await render({
    type: "INSTANCE",
    componentId: comp.id,
    key: "live",
    left: 400,
    top: 400,
  });
  return {
    comp,
    title: await figma.getNodeByIdAsync(specNode(out, "title").id),
    inst: await figma.getNodeByIdAsync(stamped.id),
  };
}

const bare = (full: string) =>
  full.lastIndexOf("#") === -1 ? full : full.slice(0, full.lastIndexOf("#"));
const fullName = (comp: { componentPropertyDefinitions: Record<string, unknown> }, name: string) =>
  Object.keys(comp.componentPropertyDefinitions).find((k) => bare(k) === name)!;

test("a component's root takes a frame's words, and its instances follow", async () => {
  const { comp, inst } = await chipComponent();
  await edit(comp.id, { fill: "#ff0000", layout: { gap: 12 }, name: "Chip A" });
  assert.deepEqual(comp.fills[0].color, { r: 1, g: 0, b: 0 });
  assert.equal(comp.itemSpacing, 12);
  assert.equal(comp.name, "Chip A");
  // The whole point of editing the main: every instance of it changes with it.
  assert.deepEqual(inst.fills[0].color, { r: 1, g: 0, b: 0 });
  assert.equal(inst.itemSpacing, 12);
});

test("`description` is a component word, and no other node type takes it", async () => {
  const { comp } = await chipComponent();
  await edit(comp.id, { description: "A compact labelled chip." });
  assert.equal(comp.description, "A compact labelled chip.");
  const plain = await render({ type: "FRAME", key: "plain", width: 10, height: 10 });
  await assert.rejects(edit("plain", { description: "nope" }), refused({ kind: "authoring", node: { type: "FRAME", id: plain.id } }, /has no `description` to edit/));
  assert.equal((await figma.getNodeByIdAsync(plain.id)).description, undefined);
});

test("editMany ADDS a property bound in the same batch, its default the layer's own content", async () => {
  const { comp, title, inst } = await plainComponent();
  await editMany([
    { id: comp.id, propertyDefinitions: { Heading: { type: "text" } } },
    { id: title.id, componentPropertyReferences: { text: "Heading" } },
  ]);
  const full = fullName(comp, "Heading");
  assert.equal(comp.componentPropertyDefinitions[full].type, "TEXT");
  // The layer's real content IS the default — nothing was invented to overwrite it.
  assert.equal(comp.componentPropertyDefinitions[full].defaultValue, "Title");
  assert.equal(title.characters, "Title");
  assert.equal(title.componentPropertyReferences.characters, full);
  assert.equal(inst.componentProperties[full].value, "Title");
});

// The same batch may also change what the bound layer shows: the default is what it shows once its
// own entry lands, so the binding writes back exactly that and nothing else.
test("an added property's default is its binder's content after the batch's own edit of it", async () => {
  const { comp, title } = await plainComponent();
  await editMany([
    { id: comp.id, propertyDefinitions: { Heading: { type: "text" }, "Show Title": { type: "boolean" } } },
    { id: title.id, text: "Overview", visible: false, componentPropertyReferences: { text: "Heading", visible: "Show Title" } },
  ]);
  assert.equal(comp.componentPropertyDefinitions[fullName(comp, "Heading")].defaultValue, "Overview");
  assert.equal(comp.componentPropertyDefinitions[fullName(comp, "Show Title")].defaultValue, false);
  assert.equal(title.characters, "Overview");
  assert.equal(title.visible, false);
});

// A read hands `{ type }` (and a set's `{ type, variantOptions }`) back; written back unchanged, it
// changes nothing rather than refusing — so a component read round-trips through edit.
test("a read's propertyDefinitions written back unchanged are a no-op", async () => {
  const { comp } = await chipComponent();
  const { components } = await get(comp.id);
  const definitions = JSON.stringify(comp.componentPropertyDefinitions);
  await edit(comp.id, { propertyDefinitions: components![comp.id].propertyDefinitions as any });
  assert.equal(JSON.stringify(comp.componentPropertyDefinitions), definitions);
});

test("propertyDefinitions RENAMES a property — the bound sublayer follows, and the new name resolves", async () => {
  const { comp, label, inst } = await chipComponent();
  const before = fullName(comp, "Label");
  await edit(comp.id, { propertyDefinitions: { Label: { name: "Caption" } } });
  const after = fullName(comp, "Caption");
  assert.equal(comp.componentPropertyDefinitions[before], undefined);
  // Figma re-points every reference to it; the definition's own sublayer is the one flcm can see.
  assert.equal(label.componentPropertyReferences.characters, after);
  // And the new name is what an instance now addresses the property by.
  await edit(inst.id, { componentProperties: { Caption: "Hi" } });
  assert.equal(inst.findOne((n: { name: string }) => n.name === "Label").characters, "Hi");
  await assert.rejects(
    edit(inst.id, { componentProperties: { Label: "x" } }),
    /this component has no property "Label"/,
  );
});

// Whether the live API re-points a renamed property's bound layers is an ASSUMPTION (the mock's
// answer is yes, and it is the whole reason the test above passes). This is the other answer: a
// rename that moves the definition and leaves the layers pointing at a name nothing files a property
// under. The shipped path must land the same either way, since a stale reference is silent.
test("a rename re-points the definition's bound layers even when Figma leaves them behind", async () => {
  const { comp, label } = await chipComponent();
  const stale = fullName(comp, "Label");
  const real = comp.editComponentProperty.bind(comp);
  comp.editComponentProperty = (name: string, edits: unknown) => {
    const full = real(name, edits);
    label.componentPropertyReferences = { ...label.componentPropertyReferences, characters: stale };
    return full;
  };
  await edit(comp.id, { propertyDefinitions: { Label: { name: "Caption" } } });
  assert.equal(label.componentPropertyReferences.characters, fullName(comp, "Caption"));
});

test("a bag may rename onto a name it deletes, whatever order its keys are written in", async () => {
  const { comp, label } = await chipComponent();
  await edit(comp.id, { propertyDefinitions: { Label: { name: "Icon" }, Icon: null } });
  const names = Object.keys(comp.componentPropertyDefinitions).map(bare);
  assert.deepEqual(names.sort(), ["Icon", "Trailing"]);
  assert.equal(comp.componentPropertyDefinitions[fullName(comp, "Icon")].type, "TEXT");
  assert.equal(label.componentPropertyReferences.characters, fullName(comp, "Icon"));
});

test("a bag that lands two properties on one name refuses whatever its key order, and a swap lands either way", async () => {
  const { comp, icon, label } = await chipComponent();
  const before = figma.undoLog.length;
  for (const bag of [
    { Label: { name: "Caption" }, Caption: { type: "boolean" as const } },
    { Caption: { type: "boolean" as const }, Label: { name: "Caption" } },
  ]) {
    await assert.rejects(
      editMany([{ id: comp.id, propertyDefinitions: bag }, { id: icon.id, componentPropertyReferences: { visible: "Caption" } }]),
      /another entry of propertyDefinitions also lands on "Caption"/,
    );
  }
  assert.deepEqual(figma.undoLog.slice(before), []);
  const iconFull = fullName(comp, "Icon");
  const labelFull = fullName(comp, "Label");
  await edit(comp.id, { propertyDefinitions: { Icon: { name: "Label" }, Label: { name: "Icon" } } });
  assert.equal(comp.componentPropertyDefinitions[icon.componentPropertyReferences.visible].type, "BOOLEAN");
  assert.equal(bare(icon.componentPropertyReferences.visible), "Label");
  assert.equal(bare(label.componentPropertyReferences.characters), "Icon");
  assert.notEqual(icon.componentPropertyReferences.visible, iconFull);
  assert.notEqual(label.componentPropertyReferences.characters, labelFull);
});

// The entry naming the deleted property is a NEW declaration, judged as one — never a restatement
// of the property the same bag deletes, which would drop it without a word.
test("a bag that deletes a property and declares its name again re-declares it rather than dropping the entry", async () => {
  const { comp } = await chipComponent();
  const old = fullName(comp, "Label");
  const before = figma.undoLog.length;
  await assert.rejects(
    edit(comp.id, { propertyDefinitions: { [old]: null, Label: { type: "text" } } }),
    /\["Label"\]: nothing in this call binds "Label"/,
  );
  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(fullName(comp, "Label"), old);
});

test("propertyDefinitions DELETES a property — the sublayer is freed and instances fall back", async () => {
  const { comp, icon, inst } = await chipComponent();
  const iconProp = fullName(comp, "Icon");
  await edit(inst.id, { componentProperties: { Icon: false } });
  assert.equal(inst.findOne((n: { name: string }) => n.name === "Icon").visible, false);

  await edit(comp.id, { propertyDefinitions: { Icon: null } });
  assert.equal(comp.componentPropertyDefinitions[iconProp], undefined);
  assert.equal(icon.componentPropertyReferences.visible, undefined); // the definition's binding is gone
  // The instance's sublayer stops being driven and falls back to the definition's own value.
  assert.equal(inst.findOne((n: { name: string }) => n.name === "Icon").visible, true);
  await assert.rejects(
    edit(inst.id, { componentProperties: { Icon: true } }),
    /this component has no property "Icon"/,
  );
});

test("propertyDefinitions DELETES a SLOT too — the frame becomes an ordinary frame", async () => {
  const { comp, trailing } = await chipComponent();
  await edit(comp.id, { propertyDefinitions: { Trailing: null } });
  assert.ok(!Object.keys(comp.componentPropertyDefinitions).some((k) => bare(k) === "Trailing"));
  assert.equal(trailing.componentPropertyReferences.slotContentId, undefined);
  assert.equal(trailing.type, "FRAME"); // it was always a frame in the definition; now it is only that
  const stamped = await render({ type: "INSTANCE", componentId: comp.id, left: 800, top: 800 });
  const fresh = await figma.getNodeByIdAsync(stamped.id);
  assert.equal(fresh.findOne((n: { name: string }) => n.name === "Trailing").type, "FRAME");
});

test("editMany applies definition and root words across entries in one step", async () => {
  const { comp, inst } = await chipComponent();
  const second = await component(
    { type: "FRAME", key: "other", width: 40, height: 40, fill: "#222222", children: [{ type: "RECTANGLE", key: "dot", width: 4, height: 4 }] },
    { name: "Other" },
  );
  await editMany([
    { id: comp.id, propertyDefinitions: { Label: { name: "Caption" } }, fill: "#00ff00" },
    { id: second.id, propertyDefinitions: { Tone: { type: "boolean" } } },
    { id: specNode(second, "dot").id, componentPropertyReferences: { visible: "Tone" } },
  ]);
  assert.ok(fullName(comp, "Caption"));
  assert.deepEqual(comp.fills[0].color, { r: 0, g: 1, b: 0 });
  assert.deepEqual(inst.fills[0].color, { r: 0, g: 1, b: 0 });
  const other = await figma.getNodeByIdAsync(second.id);
  assert.deepEqual(other.componentPropertyDefinitions[fullName(other, "Tone")], { type: "BOOLEAN", defaultValue: true });
});

test("a definition edit and the node's own words are one delta, one undo step", async () => {
  const { comp } = await chipComponent();
  // The control: what ONE verb costs the undo log (entry seal + success commit).
  const control = figma.undoLog.length;
  await edit(comp.id, { name: "Chip A" });
  const perVerb = figma.undoLog.length - control;
  const before = figma.undoLog.length;
  await edit(comp.id, {
    name: "Chip B",
    propertyDefinitions: { Label: { name: "Caption" } },
  });
  assert.equal(comp.name, "Chip B");
  assert.ok(fullName(comp, "Caption"));
  // A rename and a root word land in one step, not two.
  assert.equal(figma.undoLog.length - before, perVerb);
  assert.ok(!figma.undoLog.includes("trigger"));
});

test("componentPropertyReferences BINDS a live sublayer, and the property then drives it", async () => {
  const { comp, title, inst } = await plainComponent();
  await editMany([
    { id: comp.id, propertyDefinitions: { Heading: { type: "text" } } },
    { id: title.id, componentPropertyReferences: { text: "Heading" } },
  ]);
  await edit(title.id, { componentPropertyReferences: { text: null } });
  await edit(title.id, { componentPropertyReferences: { text: "Heading" } });
  const heading = fullName(comp, "Heading");
  assert.equal(title.componentPropertyReferences.characters, heading);
  // A fresh instance is what proves the wire: the property now drives the bound sublayer.
  const stamped = await render({ type: "INSTANCE", componentId: comp.id, left: 800, top: 800 });
  const fresh = await figma.getNodeByIdAsync(stamped.id);
  await edit(fresh.id, { componentProperties: { Heading: "Ship it" } });
  assert.equal(fresh.findOne((n: { name: string }) => n.name === "Title").characters, "Ship it");
  assert.equal(inst.findOne((n: { name: string }) => n.name === "Title").characters, "Title"); // untouched
});

test("componentPropertyReferences UNBINDS a field with null, leaving its value alone", async () => {
  const { comp, label } = await chipComponent();
  await edit(label.id, { componentPropertyReferences: { text: null } });
  assert.equal(label.componentPropertyReferences.characters, undefined);
  assert.equal(label.characters, "Label"); // the field keeps the value it had
  // The property still exists — it just drives nothing now.
  assert.ok(fullName(comp, "Label"));
  await assert.rejects(
    edit(label.id, { componentPropertyReferences: { text: null } }),
    /nothing to unbind/,
  );
});

test("a binding edit merges onto the node's live bag rather than replacing it", async () => {
  const { comp, icon, label } = await chipComponent();
  await editMany([
    { id: comp.id, propertyDefinitions: { "Show Label": { type: "boolean" } } },
    { id: icon.id, componentPropertyReferences: { visible: "Show Label" } },
  ]);
  await edit(label.id, { componentPropertyReferences: { visible: "Show Label" } });
  assert.equal(label.componentPropertyReferences.characters, fullName(comp, "Label"));
  assert.equal(label.componentPropertyReferences.visible, fullName(comp, "Show Label"));
});

// A "Tag" whose three value properties exist but bind nothing — the state after an unbind, or a
// component someone else built — beside unbound layers showing real content.
async function unboundTag() {
  const badgeA = figma.createComponent();
  badgeA.name = "Badge A";
  figma.currentPage.appendChild(badgeA);
  const badgeB = figma.createComponent();
  badgeB.name = "Badge B";
  figma.currentPage.appendChild(badgeB);
  const out = await component(
    {
      type: "FRAME",
      key: "tag",
      layout: { mode: "row", gap: 4 },
      children: [
        { type: "RECTANGLE", key: "icon", name: "Icon", width: 8, height: 8, componentPropertyReferences: { visible: "Shown" } },
        { type: "TEXT", text: "Label", key: "label", name: "Label", componentPropertyReferences: { text: "Label" } },
        { type: "INSTANCE", componentId: badgeA.id, key: "badge", name: "Badge", componentPropertyReferences: { componentId: "Badge" } },
        { type: "TEXT", text: "Overview", key: "title", name: "Title" },
        { type: "RECTANGLE", key: "dot", name: "Dot", width: 8, height: 8, visible: false },
        { type: "INSTANCE", componentId: badgeB.id, key: "mark", name: "Mark" },
      ],
    },
    { name: "Tag", propertyDefinitions: { Shown: { type: "boolean" }, Label: { type: "text" }, Badge: { type: "instance_swap" } } },
  );
  const node = async (key: string) => figma.getNodeByIdAsync(specNode(out, key).id);
  const [comp, icon, label, badge, title, dot, mark] = await Promise.all(["tag", "icon", "label", "badge", "title", "dot", "mark"].map((key) => key === "tag" ? figma.getNodeByIdAsync(out.id) : node(key)));
  await editMany([
    { id: icon.id, componentPropertyReferences: { visible: null } },
    { id: label.id, componentPropertyReferences: { text: null } },
    { id: badge.id, componentPropertyReferences: { componentId: null } },
  ]);
  return { comp, label, title, dot, mark, badgeB };
}

// Binding writes the property's default into the layer, so with nothing else bound to it the layer
// sets the default first — its content survives, and the default follows it.
test("binding a layer to an existing property nothing else binds keeps its content, and the default follows", async () => {
  const { comp, title, dot, mark, badgeB } = await unboundTag();
  await editMany([
    { id: title.id, componentPropertyReferences: { text: "Label" } },
    { id: dot.id, componentPropertyReferences: { visible: "Shown" } },
  ]);
  await edit(mark.id, { componentPropertyReferences: { componentId: "Badge" } });
  const defaults = comp.componentPropertyDefinitions;
  assert.equal(title.characters, "Overview");
  assert.equal(dot.visible, false);
  assert.equal(mark.mainComponent, badgeB);
  assert.equal(defaults[fullName(comp, "Label")].defaultValue, "Overview");
  assert.equal(defaults[fullName(comp, "Shown")].defaultValue, false);
  assert.equal(defaults[fullName(comp, "Badge")].defaultValue, badgeB.id);
  // A bound insert is the same binding, reached by building the layer.
  const { comp: other } = await unboundTag();
  await append(other.id, { type: "TEXT", text: "Fresh", name: "Fresh", componentPropertyReferences: { text: "Label" } });
  assert.equal(other.findOne((n: { name: string }) => n.name === "Fresh").characters, "Fresh");
  assert.equal(other.componentPropertyDefinitions[fullName(other, "Label")].defaultValue, "Fresh");
});

test("binders of an existing property that show different content are refused, each named", async () => {
  const { comp, label, title } = await unboundTag();
  const before = figma.undoLog.length;
  // In the same call…
  await assert.rejects(
    editMany([
      { id: title.id, componentPropertyReferences: { text: "Label" } },
      { id: label.id, componentPropertyReferences: { text: "Label" } },
    ]),
    /2 layers bind "Label" and show different text — "Title" at entry 0 is "Overview", "Label" at entry 1 is "Label"/,
  );
  assert.deepEqual(figma.undoLog.slice(before), []);
  // …and against a layer already bound to it, whichever path the new binder takes.
  await edit(title.id, { componentPropertyReferences: { text: "Label" } });
  const bound = figma.undoLog.length;
  await assert.rejects(
    edit(label.id, { componentPropertyReferences: { text: "Label" } }),
    /2 layers bind "Label" and show different text — "Title" \(already bound\) is "Overview", "Label" .* is "Label"/,
  );
  await assert.rejects(
    append(comp.id, { type: "TEXT", text: "Other", name: "Other", componentPropertyReferences: { text: "Label" } }),
    /2 layers bind "Label" and show different text — "Title" \(already bound\) is "Overview", "Other" .* is "Other"/,
  );
  assert.deepEqual(figma.undoLog.slice(bound), []);
  assert.equal(label.characters, "Label");
  // A layer the same batch unbinds no longer counts, so the binding moves and the default follows.
  await editMany([
    { id: title.id, componentPropertyReferences: { text: null } },
    { id: label.id, componentPropertyReferences: { text: "Label" } },
  ]);
  assert.equal(label.characters, "Label");
  assert.equal(comp.componentPropertyDefinitions[fullName(comp, "Label")].defaultValue, "Label");
  await editMany([
    { id: label.id, componentPropertyReferences: { text: null } },
    { id: title.id, componentPropertyReferences: { text: "Label" } },
  ]);
  // The same content just binds.
  await edit(label.id, { text: "Overview", componentPropertyReferences: { text: "Label" } });
  assert.equal(label.componentPropertyReferences.characters, fullName(comp, "Label"));
  assert.equal(title.characters, "Overview");
  assert.equal(comp.componentPropertyDefinitions[fullName(comp, "Label")].defaultValue, "Overview");
});

// A layer this call creates with the bound field unwritten has no content to lose, so it shows the
// property's default rather than driving it.
test("a new layer with its bound field unwritten inherits the existing property's default", async () => {
  const { comp, title, dot } = await unboundTag();
  const label = fullName(comp, "Label");
  const shown = fullName(comp, "Shown");
  // Shown's default becomes false, which a new layer's unwritten `visible` (true) would contradict.
  await edit(dot.id, { componentPropertyReferences: { visible: "Shown" } });
  const before = comp.componentPropertyDefinitions;
  await append(comp.id, { type: "TEXT", name: "Blank", componentPropertyReferences: { text: "Label" } });
  await append(comp.id, { type: "FRAME", name: "Dot2", width: 4, height: 4, componentPropertyReferences: { visible: "Shown" } });
  const blank = comp.findOne((n: { name: string }) => n.name === "Blank");
  assert.equal(comp.componentPropertyDefinitions[label].defaultValue, before[label].defaultValue);
  assert.equal(blank.characters, before[label].defaultValue);
  assert.equal(comp.componentPropertyDefinitions[shown].defaultValue, before[shown].defaultValue);
  assert.equal(comp.findOne((n: { name: string }) => n.name === "Dot2").visible, before[shown].defaultValue);
  // Bound alongside a layer with content, it takes that content instead of conflicting with it…
  const { comp: other, title: title2 } = await unboundTag();
  await edit(title2.id, { componentPropertyReferences: { text: "Label" } });
  await append(other.id, { type: "TEXT", name: "Blank2", componentPropertyReferences: { text: "Label" } });
  assert.equal(other.findOne((n: { name: string }) => n.name === "Blank2").characters, "Overview");
  // …and one whose `text` IS written still drives the value, so a conflict is still refused.
  await assert.rejects(
    append(other.id, { type: "TEXT", name: "Written", text: "", componentPropertyReferences: { text: "Label" } }),
    /show different text — "Title" \(already bound\) is "Overview", "Blank2" \(already bound\) is "Overview", "Written" .* is ""/,
  );
});

// While a layer is still bound, writing its field writes the property's default and every other layer
// bound to it — so a layer leaving a property is freed before any of the call's writes land.
test("a layer leaving a property is freed before the call's writes, so they don't reach its old binders", async () => {
  const { comp, label, title, mark, badgeB } = await unboundTag();
  await edit(title.id, { componentPropertyReferences: { text: "Label" } });
  await edit(label.id, { text: "Overview", componentPropertyReferences: { text: "Label" } });
  await edit(label.id, { text: "Z", componentPropertyReferences: { text: null } });
  assert.equal(label.characters, "Z");
  assert.equal(title.characters, "Overview");
  assert.equal(comp.componentPropertyDefinitions[fullName(comp, "Label")].defaultValue, "Overview");

  // A rebind too: the swap binder moving to a new property must not be swapped to Badge's new
  // default and back on the way (which would drop its overrides).
  const badge = comp.findOne((n: { name: string }) => n.name === "Badge");
  await edit(badge.id, { componentPropertyReferences: { componentId: "Badge" } });
  const swaps: unknown[] = [];
  const swap = badge.swapComponent.bind(badge);
  badge.swapComponent = (main: unknown) => (swaps.push(main), swap(main));
  await editMany([
    { id: comp.id, propertyDefinitions: { Alt: { type: "instance_swap" } } },
    { id: badge.id, componentPropertyReferences: { componentId: "Alt" } },
    { id: mark.id, componentPropertyReferences: { componentId: "Badge" } },
  ]);
  assert.deepEqual(swaps, []);
  assert.equal(comp.componentPropertyDefinitions[fullName(comp, "Badge")].defaultValue, badgeB.id);
});

test("an insert into a component may carry bindings — an existing property, and a NEW slot it declares", async () => {
  const { comp } = await chipComponent();
  await append(comp.id, {
    type: "FRAME",
    layout: { mode: "row", gap: 2 },
    children: [
      {
        type: "TEXT",
        text: "Label",
        key: "sub",
        name: "Sub",
        componentPropertyReferences: { text: "Label" },
      },
      {
        type: "FRAME",
        key: "extra",
        name: "Extra",
        width: 16,
        height: 16,
        componentPropertyReferences: { slot: "Extra" },
      },
    ],
  });
  const sub = comp.findOne((n: { name: string }) => n.name === "Sub");
  const extra = comp.findOne((n: { name: string }) => n.name === "Extra");
  assert.equal(sub.componentPropertyReferences.characters, fullName(comp, "Label"));
  // A slot has no other birth after the component exists — the bound frame IS the slot, so the
  // insert declares the property.
  const extraProp = fullName(comp, "Extra");
  assert.equal(comp.componentPropertyDefinitions[extraProp].type, "SLOT");
  assert.equal(extra.componentPropertyReferences.slotContentId, extraProp);
  // And every instance stamped from here shows that frame as a SLOT.
  const stamped = await render({ type: "INSTANCE", componentId: comp.id, left: 900, top: 900 });
  const fresh = await figma.getNodeByIdAsync(stamped.id);
  assert.equal(fresh.findOne((n: { name: string }) => n.name === "Extra").type, "SLOT");
});

// A binding is to one component's property: the same name in another component is another property.
test("a bound layer moved into another component with a same-named property is bound to that component's", async () => {
  const bound = (name: string) => component(
    { type: "FRAME", name, width: 100, height: 100, children: [{ type: "RECTANGLE", name: name + " dot", width: 10, height: 10, componentPropertyReferences: { visible: "Show" } }] },
    { propertyDefinitions: { Show: { type: "boolean" } } },
  );
  const from = await figma.getNodeByIdAsync((await bound("From")).id);
  const to = await figma.getNodeByIdAsync((await bound("To")).id);
  const dot = from.children[0];
  await append(to.id, { id: dot.id, componentPropertyReferences: { visible: "Show" } } as never);
  assert.equal(dot.parent, to);
  assert.equal(dot.componentPropertyReferences.visible, fullName(to, "Show"));
  assert.notEqual(fullName(to, "Show"), fullName(from, "Show"));
});

test("an instance's SLOT takes gap, padding and fills; its direction stays the component's", async () => {
  const { comp } = await chipComponent();
  await edit(comp.findOne((n: { name: string }) => n.name === "Trailing").id, { layout: { mode: "row" } });
  const stamped = await render({ type: "INSTANCE", componentId: comp.id, left: 900, top: 900 });
  const slot = (await figma.getNodeByIdAsync(stamped.id)).findOne((n: { type: string }) => n.type === "SLOT");
  assert.ok(slot);
  await edit(slot.id, { fill: "#00ff00", clip: true, layout: { gap: 6, padding: 3 } });
  assert.deepEqual(slot.fills[0].color, { r: 0, g: 1, b: 0 });
  assert.equal(slot.clipsContent, true);
  assert.equal(slot.itemSpacing, 6);
  assert.equal(slot.paddingLeft, 3);
  // The slot node itself is a layer of the instance: Figma ignores a direction change there.
  await assert.rejects(edit(slot.id, { layout: { mode: "column" } }), /\(instance\.layout-mode-change\)/);
  assert.equal(slot.layoutMode, "HORIZONTAL");
  // Still a slot, not a text: the words are a frame's, not everything.
  await assert.rejects(edit(slot.id, { text: "nope" }), refused({ kind: "authoring", node: { type: "SLOT", id: slot.id } }, /has no `text` to edit/));
});

test("editMany refuses a batch that both renames a property and binds to it, naming both entries", async () => {
  const { comp, title } = await plainComponent();
  await editMany([
    { id: comp.id, propertyDefinitions: { Heading: { type: "text" } } },
    { id: title.id, componentPropertyReferences: { text: "Heading" } },
  ]);
  await edit(title.id, { componentPropertyReferences: { text: null } });
  const before = figma.undoLog.length;
  await assert.rejects(
    editMany([
      { id: comp.id, propertyDefinitions: { Heading: { name: "Caption" } } },
      { id: title.id, componentPropertyReferences: { text: "Heading" } },
    ]),
    /\[1\].*in the same batch — the two would have to run in an order this call never states/s,
  );
  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.deepEqual(title.componentPropertyReferences, {});
});

test("a batch may delete one property and add-and-bind another", async () => {
  const { comp, icon, label } = await chipComponent();
  await editMany([
    { id: comp.id, propertyDefinitions: { Icon: null, Shown: { type: "boolean" } } },
    { id: icon.id, componentPropertyReferences: { visible: "Shown" } },
  ]);
  assert.equal(fullName(comp, "Icon"), undefined);
  assert.equal(icon.componentPropertyReferences.visible, fullName(comp, "Shown"));
  // A binder that ALSO names a live property the batch renames is still the ordering hazard.
  await assert.rejects(
    editMany([
      { id: comp.id, propertyDefinitions: { Label: { name: "Caption" }, Extra: { type: "boolean" } } },
      { id: label.id, componentPropertyReferences: { visible: "Extra", text: "Label" } },
    ]),
    /\[1\].*Split them: rename or delete in one call/s,
  );
});

test("an added property's binders must agree, and each is named when they don't", async () => {
  const { comp, label, icon } = await chipComponent();
  await edit(icon.id, { visible: false });
  const before = figma.undoLog.length;
  await assert.rejects(
    editMany([
      { id: comp.id, propertyDefinitions: { Shown: { type: "boolean" } } },
      { id: icon.id, componentPropertyReferences: { visible: "Shown" } },
      { id: label.id, componentPropertyReferences: { visible: "Shown" } },
    ]),
    /2 layers bind "Shown" and show different visible — "Icon" at entry 1 is false, "Label" at entry 2 is true/,
  );
  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(fullName(comp, "Shown"), undefined);
  // Made to agree in the same call, it lands.
  await editMany([
    { id: comp.id, propertyDefinitions: { Shown: { type: "boolean" } } },
    { id: icon.id, visible: true, componentPropertyReferences: { visible: "Shown" } },
    { id: label.id, componentPropertyReferences: { visible: "Shown" } },
  ]);
  assert.equal(comp.componentPropertyDefinitions[fullName(comp, "Shown")].defaultValue, true);
});

// An instance entry is not a lesser case of the same hazard: the appliers run setProperties BEFORE
// the definition writes, so a batch deleting a property while an instance sets it would land the
// value and then throw it away — a silent no-op, which this surface refuses everywhere else.
test("editMany refuses a batch that deletes a property and sets it on an instance, naming both entries", async () => {
  const { comp, inst } = await chipComponent();
  const label = fullName(comp, "Label");
  const before = figma.undoLog.length;
  await assert.rejects(
    editMany([
      { id: comp.id, propertyDefinitions: { Label: null } },
      { id: inst.id, componentProperties: { Label: "Hi" } },
    ]),
    /\[1\].* sets `componentProperties` on an instance of .*in the same batch — the two would have to run in an order this call never states/s,
  );
  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.ok(comp.componentPropertyDefinitions[label]);
  assert.equal(inst.componentProperties[label].value, "Label");
});

test("every definition refusal names the cause and writes nothing", async () => {
  const { comp, icon, label, trailing, inst } = await chipComponent();
  const before = figma.undoLog.length;
  const definitions = JSON.stringify(comp.componentPropertyDefinitions);

  // A type can't change — Figma has no such call.
  await assert.rejects(
    edit(comp.id, { propertyDefinitions: { Label: { type: "boolean" } } }),
    /is "text" and Figma can't change a property's type\. Delete it in one call .* in ONE flcm\.editMany/s,
  );
  // A slot IS a frame, so it is made by inserting one, never declared on its own.
  await assert.rejects(
    edit(comp.id, { propertyDefinitions: { Extra: { type: "slot" } } }),
    /a slot IS the frame that holds its placeholder content/,
  );
  // One delta can't bind a sublayer, so a property it adds has no layer to read its default off.
  await assert.rejects(
    edit(comp.id, { propertyDefinitions: { Heading: { type: "text" } } }),
    /nothing in this call binds "Heading"\. A property's default IS its bound layer's content, so add it and bind the layer that shows its value in ONE flcm\.editMany/,
  );
  // An editMany add nothing in the batch binds is the same refusal.
  await assert.rejects(
    editMany([{ id: comp.id, propertyDefinitions: { Heading: { type: "text" } } }]),
    /nothing in this call binds "Heading"/,
  );
  // A default is not a word: it is the bound layer's content.
  await assert.rejects(
    edit(comp.id, { propertyDefinitions: { Label: { defaultValue: "Save" } as any } }),
    /unknown prop "defaultValue".*A property's default is its bound layer's content/,
  );
  // `variantOptions` restates a set's axis, and nothing else.
  await assert.rejects(
    edit(comp.id, { propertyDefinitions: { Label: { type: "text", variantOptions: ["x"] } } }),
    /`variantOptions` belongs to a set's variant axis/,
  );
  // An entry that names nothing at all.
  await assert.rejects(
    edit(comp.id, { propertyDefinitions: { Label: {} } }),
    /names nothing/,
  );
  // A rename onto a name the component already uses.
  await assert.rejects(
    edit(comp.id, { propertyDefinitions: { Label: { name: "Icon" } } }),
    /already has a property named "Icon"/,
  );
  // A name that isn't there and isn't being declared.
  await assert.rejects(
    edit(comp.id, { propertyDefinitions: { Nope: null } }),
    /this component has no property "Nope"/,
  );
  // The definition words reach a COMPONENT, not one of its layers or an instance.
  await assert.rejects(
    edit(icon.id, { propertyDefinitions: { Icon: null } }),
    refused({ kind: "authoring", node: { type: "RECTANGLE", id: icon.id } }, /has no `propertyDefinitions` to edit/),
  );
  await assert.rejects(
    edit(inst.id, { propertyDefinitions: { Icon: null } }),
    /has no `propertyDefinitions` to edit/,
  );

  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(JSON.stringify(comp.componentPropertyDefinitions), definitions);
  assert.equal(label.componentPropertyReferences.characters, fullName(comp, "Label"));
  assert.ok(trailing.componentPropertyReferences.slotContentId);
});

test("a variant's properties live on the SET, and the refusal points there", async () => {
  const small = await component(
    { type: "FRAME", width: 96, height: 32, fill: "#111111", children: [{ type: "TEXT", key: "small-label", text: "Go" }] },
    { name: "Button" },
  );
  const large = await component(
    { type: "FRAME", width: 128, height: 44, fill: "#111111", children: [{ type: "TEXT", key: "large-label", text: "Go" }] },
    { name: "Button" },
  );
  const set = await variants(
    [
      { component: small, variant: { Size: "Small" } },
      { component: large, variant: { Size: "Large" } },
    ],
    { name: "Button" },
  );
  const setNode = await figma.getNodeByIdAsync(set.id);
  const variant = setNode.children[0];
  const before = figma.undoLog.length;
  await assert.rejects(
    edit(variant.id, { propertyDefinitions: { Label: { type: "text" } } }),
    /is a VARIANT, and a set's properties live on the SET/,
  );
  assert.deepEqual(figma.undoLog.slice(before), []);
  // On the SET itself it lands, bound by a layer in EACH variant — they agree, so that is the default.
  await editMany([
    { id: set.id, propertyDefinitions: { Label: { type: "text" } } },
    { id: specNode(small, "small-label").id, componentPropertyReferences: { text: "Label" } },
    { id: specNode(large, "large-label").id, componentPropertyReferences: { text: "Label" } },
  ]);
  assert.equal(setNode.componentPropertyDefinitions[fullName(setNode, "Label")].defaultValue, "Go");
  // The axis it already has is not a definition anyone can change — but restating it is a no-op.
  await edit(set.id, { propertyDefinitions: { Size: { type: "variant", variantOptions: setNode.componentPropertyDefinitions[fullName(setNode, "Size")].variantOptions } } });
  await assert.rejects(
    edit(set.id, { propertyDefinitions: { Size: null } }),
    /is a VARIANT axis, and a set's axes ARE its member components' names/,
  );
});

// One slot property on a SET, one frame in EACH variant: a binding lives per variant, so "a slot is
// one hole" is counted inside the variant, never across the set.
test("a set's slot needs its own frame in every variant, and each variant's is its only one", async () => {
  const small = await component(
    { type: "FRAME", width: 96, height: 32, fill: "#111111" },
    { name: "Button" },
  );
  const large = await component(
    { type: "FRAME", width: 128, height: 44, fill: "#111111" },
    { name: "Button" },
  );
  const set = await variants(
    [
      { component: small, variant: { Size: "Small" } },
      { component: large, variant: { Size: "Large" } },
    ],
    { name: "Button" },
  );
  const setNode = await figma.getNodeByIdAsync(set.id);
  const [a, b] = setNode.children;
  const slotFrame = () => ({
    type: "FRAME",
    name: "Trailing",
    width: 20,
    height: 20,
    componentPropertyReferences: { slot: "Trailing" },
  });
  // Into the first variant the insert MINTS the set's slot property; into the second it binds that
  // same property, which is what makes the set's slot whole.
  await append(a.id, slotFrame());
  await append(b.id, slotFrame());
  const trailing = fullName(setNode, "Trailing");
  const frameA = a.findOne((n: { name: string }) => n.name === "Trailing");
  const frameB = b.findOne((n: { name: string }) => n.name === "Trailing");
  assert.equal(frameA.componentPropertyReferences.slotContentId, trailing);
  assert.equal(frameB.componentPropertyReferences.slotContentId, trailing);
  // The other variant's frame is no help to this one: unbinding leaves THIS variant with a slot
  // property and nowhere to put an instance's content.
  await assert.rejects(
    edit(frameA.id, { componentPropertyReferences: { slot: null } }),
    /this is the only frame in .* bound to slot property "Trailing"/,
  );
  // And within one variant it is still one hole.
  await assert.rejects(
    append(a.id, slotFrame()),
    /slot property "Trailing" already has its frame/,
  );
});

test("every binding refusal names the cause and writes nothing", async () => {
  const { comp, icon, label, trailing, inst } = await chipComponent();
  const plain = await render({ type: "FRAME", key: "outside", width: 10, height: 10 });
  const before = figma.undoLog.length;

  // Outside every component there is no property to point at.
  await assert.rejects(
    edit("outside", { componentPropertyReferences: { visible: "Icon" } }),
    /is not inside a component/,
  );
  // Inside an INSTANCE the binding belongs to the definition. (Its echoed `text: "Label"` is no change.)
  const liveLabel = inst.findOne((n: { name: string }) => n.name === "Label");
  await assert.rejects(
    edit(liveLabel.id, { componentPropertyReferences: { visible: "Icon" } }),
    refused({ kind: "figma", node: { id: liveLabel.id } }, /this layer is inside INSTANCE "Chip".* A binding belongs to the DEFINITION/s),
  );
  // Per-type field legality, exactly as at construction — read off the LIVE node's type.
  await assert.rejects(
    edit(label.id, { componentPropertyReferences: { slot: "Trailing" } }),
    /`slot` is not one of a TEXT's binding fields \(visible, text\)/,
  );
  // A field drives one property TYPE.
  await assert.rejects(
    edit(icon.id, { componentPropertyReferences: { visible: "Label" } }),
    /`visible` is driven by a "boolean" property, and "Label" is "text"\. Bind `visible` to a "boolean" property, or bind "Label" from `text`/,
  );
  // An unknown name lists the component's own.
  await assert.rejects(
    edit(icon.id, { componentPropertyReferences: { visible: "Nope" } }),
    /this component has no property "Nope"/,
  );
  // A slot with no frame has nowhere to put an instance's content — delete the property instead.
  await assert.rejects(
    edit(trailing.id, { componentPropertyReferences: { slot: null } }),
    /this is the only frame in .* bound to slot property "Trailing"/,
  );

  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(label.componentPropertyReferences.characters, fullName(comp, "Label"));
  assert.equal(icon.componentPropertyReferences.visible, fullName(comp, "Icon"));
  assert.equal(
    plain.id && (await figma.getNodeByIdAsync(plain.id)).componentPropertyReferences,
    undefined,
  );
});

test("every bound-insert refusal names the cause and writes nothing", async () => {
  const { comp, trailing } = await chipComponent();
  const plain = await render({ type: "FRAME", key: "outside", width: 100, height: 100 });
  const before = figma.undoLog.length;

  // The standing refusal, unchanged everywhere but inside a component.
  await assert.rejects(
    append("outside", { type: "TEXT", text: "Hi", componentPropertyReferences: { text: "Label" } }),
    /`componentPropertyReferences` binds a node to a component property, and nothing here declares one/s,
  );
  // A non-slot binding names a property that must already exist.
  await assert.rejects(
    append(comp.id, {
      type: "TEXT",
      text: "Hi",
      componentPropertyReferences: { text: "Nope" },
    }),
    /this component has no property "Nope"/,
  );
  // A slot is one hole, whether the second claim comes from the document or from this same tree.
  await assert.rejects(
    append(comp.id, {
      type: "FRAME",
      width: 10,
      height: 10,
      componentPropertyReferences: { slot: "Trailing" },
    }),
    /slot property "Trailing" already has its frame/,
  );
  await assert.rejects(
    append(comp.id, {
      type: "FRAME",
      layout: { mode: "row" },
      children: [
        { type: "FRAME", width: 10, height: 10, componentPropertyReferences: { slot: "Twin" } },
        { type: "FRAME", width: 10, height: 10, componentPropertyReferences: { slot: "Twin" } },
      ],
    }),
    refused({ path: "flcm.append.spec.children[1].componentPropertyReferences.slot" }, /another frame in this tree also claims slot "Twin"/),
  );

  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(comp.children.length, 3);
  assert.equal((await figma.getNodeByIdAsync(plain.id)).children.length, 0);
  assert.ok(trailing.componentPropertyReferences.slotContentId);
});

test("an insert into a COMPONENT_SET is refused — its children are its variants", async () => {
  const small = await component(
    { type: "FRAME", width: 96, height: 32, fill: "#111111" },
    { name: "Button" },
  );
  const large = await component(
    { type: "FRAME", width: 128, height: 44, fill: "#111111" },
    { name: "Button" },
  );
  const set = await variants(
    [
      { component: small, variant: { Size: "Small" } },
      { component: large, variant: { Size: "Large" } },
    ],
    { name: "Button" },
  );
  const setNode = await figma.getNodeByIdAsync(set.id);
  const before = figma.undoLog.length;
  await assert.rejects(
    append(set.id, { type: "RECTANGLE", width: 10, height: 10 }),
    refused({ kind: "authoring", node: { type: "COMPONENT_SET", name: "Button" } }, /a COMPONENT_SET's children are its variants/),
  );
  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(setNode.children.length, 2);
});
