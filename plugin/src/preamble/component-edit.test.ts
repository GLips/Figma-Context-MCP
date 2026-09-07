// Editing a MAIN component — the capability with no verb of its own: `flcm.edit` on the COMPONENT
// and on its sublayers, plus the structural verbs, and every instance follows because that is what
// Figma does.
//
// What must not regress silently: a component's root takes a frame's words (and its instances get
// them), `propertyDefinitions` adds/changes/renames/deletes a declaration with instances following,
// `componentPropertyReferences` binds and unbinds a live sublayer, a bound spec may be inserted into
// an existing component (a new `slot` name declaring the property, since a slot IS its frame), an
// instance's SLOT takes the frame surface — and every refusal fires with zero writes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, text, instance, id } from "./flcm.js";
import { render } from "./render.js";
import { component, variants } from "./component.js";
import { edit } from "./edit.js";
import { editMany } from "./edit-many.js";
import { append } from "./structure.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

// A "Chip" carrying a bound boolean, a bound text and a bound slot frame — one sublayer per binding
// field an edit can reach, and one instance of it to watch follow.
async function chipComponent() {
  const out = await component(
    frame({ key: "chip", fill: "#0000ff", layout: { mode: "row", gap: 4, padding: 8 } }, [
      rect({ key: "icon", name: "Icon", width: 12, height: 12, fill: "#ffffff", componentPropertyReferences: { visible: "Icon" } }),
      text("Label", { key: "label", name: "Label", componentPropertyReferences: { text: "Label" } }),
      frame({ key: "trailing", name: "Trailing", width: 20, height: 20, componentPropertyReferences: { slot: "Trailing" } }),
    ]),
    {
      name: "Chip",
      propertyDefinitions: { Icon: { type: "boolean" }, Label: { type: "text" }, Trailing: { type: "slot" } },
    },
  );
  const comp = await figma.getNodeByIdAsync(out.node.id);
  const stamped = await render(instance(comp.id, { key: "live", left: 400, top: 400 }));
  return {
    comp,
    icon: await figma.getNodeByIdAsync(out.keyed.icon.id),
    label: await figma.getNodeByIdAsync(out.keyed.label.id),
    trailing: await figma.getNodeByIdAsync(out.keyed.trailing.id),
    inst: await figma.getNodeByIdAsync(stamped.node.id),
  };
}

// A bare component with no properties at all — the starting point for "declare, then bind".
async function plainComponent() {
  const out = await component(
    frame({ key: "card", fill: "#111111", layout: { mode: "column", gap: 4, padding: 8 } }, [
      text("Title", { key: "title", name: "Title" }),
    ]),
    { name: "Card" },
  );
  const comp = await figma.getNodeByIdAsync(out.node.id);
  const stamped = await render(instance(comp.id, { key: "live", left: 400, top: 400 }));
  return { comp, title: await figma.getNodeByIdAsync(out.keyed.title.id), inst: await figma.getNodeByIdAsync(stamped.node.id) };
}

const bare = (full: string) => (full.lastIndexOf("#") === -1 ? full : full.slice(0, full.lastIndexOf("#")));
const fullName = (comp: { componentPropertyDefinitions: Record<string, unknown> }, name: string) =>
  Object.keys(comp.componentPropertyDefinitions).find((k) => bare(k) === name)!;

test("a component's root takes a frame's words, and its instances follow", async () => {
  const { comp, inst } = await chipComponent();
  await edit(id(comp.id), { fill: "#ff0000", layout: { gap: 12 }, name: "Chip A" });
  assert.deepEqual(comp.fills[0].color, { r: 1, g: 0, b: 0 });
  assert.equal(comp.itemSpacing, 12);
  assert.equal(comp.name, "Chip A");
  // The whole point of editing the main: every instance of it changes with it.
  assert.deepEqual(inst.fills[0].color, { r: 1, g: 0, b: 0 });
  assert.equal(inst.itemSpacing, 12);
});

test("`description` is a component word, and no other node type takes it", async () => {
  const { comp } = await chipComponent();
  await edit(id(comp.id), { description: "A compact labelled chip." });
  assert.equal(comp.description, "A compact labelled chip.");
  const plain = await render(frame({ key: "plain", width: 10, height: 10 }));
  await assert.rejects(edit("plain", { description: "nope" }), /`description` is not a FRAME word/);
  assert.equal((await figma.getNodeByIdAsync(plain.node.id)).description, undefined);
});

test("propertyDefinitions ADDS a property, and every instance gains it at the stated default", async () => {
  const { comp, inst } = await plainComponent();
  await edit(id(comp.id), { propertyDefinitions: { Heading: { type: "text", defaultValue: "Untitled" } } });
  const full = fullName(comp, "Heading");
  assert.equal(comp.componentPropertyDefinitions[full].type, "TEXT");
  assert.equal(comp.componentPropertyDefinitions[full].defaultValue, "Untitled");
  assert.equal(inst.componentProperties[full].value, "Untitled");
});

test("propertyDefinitions CHANGES a default, and only the instances still on the old one follow", async () => {
  const { comp, inst } = await chipComponent();
  const label = fullName(comp, "Label");
  const stamped = await render(instance(comp.id, { key: "second", left: 600, top: 600 }));
  const own = await figma.getNodeByIdAsync(stamped.node.id);
  await edit(id(own.id), { componentProperties: { Label: "Mine" } });

  await edit(id(comp.id), { propertyDefinitions: { Label: { defaultValue: "Save" } } });
  assert.equal(comp.componentPropertyDefinitions[label].defaultValue, "Save");
  // The untouched instance takes the new default, down to the bound sublayer's own characters.
  assert.equal(inst.componentProperties[label].value, "Save");
  assert.equal(inst.findOne((n: { name: string }) => n.name === "Label").characters, "Save");
  // The one that stated its own value keeps it.
  assert.equal(own.componentProperties[label].value, "Mine");
});

test("propertyDefinitions RENAMES a property — the bound sublayer follows, and the new name resolves", async () => {
  const { comp, label, inst } = await chipComponent();
  const before = fullName(comp, "Label");
  await edit(id(comp.id), { propertyDefinitions: { Label: { name: "Caption" } } });
  const after = fullName(comp, "Caption");
  assert.equal(comp.componentPropertyDefinitions[before], undefined);
  // Figma re-points every reference to it; the definition's own sublayer is the one flcm can see.
  assert.equal(label.componentPropertyReferences.characters, after);
  // And the new name is what an instance now addresses the property by.
  await edit(id(inst.id), { componentProperties: { Caption: "Hi" } });
  assert.equal(inst.findOne((n: { name: string }) => n.name === "Label").characters, "Hi");
  await assert.rejects(edit(id(inst.id), { componentProperties: { Label: "x" } }), /this component has no property "Label"/);
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
  await edit(id(comp.id), { propertyDefinitions: { Label: { name: "Caption" } } });
  assert.equal(label.componentPropertyReferences.characters, fullName(comp, "Caption"));
});

test("a bag may rename onto a name it deletes, whatever order its keys are written in", async () => {
  const { comp, label } = await chipComponent();
  await edit(id(comp.id), { propertyDefinitions: { Label: { name: "Icon" }, Icon: null } });
  const names = Object.keys(comp.componentPropertyDefinitions).map(bare);
  assert.deepEqual(names.sort(), ["Icon", "Trailing"]);
  assert.equal(comp.componentPropertyDefinitions[fullName(comp, "Icon")].type, "TEXT");
  assert.equal(label.componentPropertyReferences.characters, fullName(comp, "Icon"));
});

test("propertyDefinitions DELETES a property — the sublayer is freed and instances fall back", async () => {
  const { comp, icon, inst } = await chipComponent();
  const iconProp = fullName(comp, "Icon");
  await edit(id(inst.id), { componentProperties: { Icon: false } });
  assert.equal(inst.findOne((n: { name: string }) => n.name === "Icon").visible, false);

  await edit(id(comp.id), { propertyDefinitions: { Icon: null } });
  assert.equal(comp.componentPropertyDefinitions[iconProp], undefined);
  assert.equal(icon.componentPropertyReferences.visible, undefined); // the definition's binding is gone
  // The instance's sublayer stops being driven and falls back to the definition's own value.
  assert.equal(inst.findOne((n: { name: string }) => n.name === "Icon").visible, true);
  await assert.rejects(edit(id(inst.id), { componentProperties: { Icon: true } }), /this component has no property "Icon"/);
});

test("propertyDefinitions DELETES a SLOT too — the frame becomes an ordinary frame", async () => {
  const { comp, trailing } = await chipComponent();
  await edit(id(comp.id), { propertyDefinitions: { Trailing: null } });
  assert.ok(!Object.keys(comp.componentPropertyDefinitions).some((k) => bare(k) === "Trailing"));
  assert.equal(trailing.componentPropertyReferences.slotContentId, undefined);
  assert.equal(trailing.type, "FRAME"); // it was always a frame in the definition; now it is only that
  const stamped = await render(instance(comp.id, { left: 800, top: 800 }));
  const fresh = await figma.getNodeByIdAsync(stamped.node.id);
  assert.equal(fresh.findOne((n: { name: string }) => n.name === "Trailing").type, "FRAME");
});

test("editMany applies definition and root words across entries in one step", async () => {
  const { comp, inst } = await chipComponent();
  const second = await component(frame({ key: "other", width: 40, height: 40, fill: "#222222" }), { name: "Other" });
  await editMany([
    { target: id(comp.id), changes: { propertyDefinitions: { Label: { defaultValue: "Save" } }, fill: "#00ff00" } },
    { target: id(second.node.id), changes: { propertyDefinitions: { Tone: { type: "boolean", defaultValue: true } } } },
  ]);
  assert.equal(comp.componentPropertyDefinitions[fullName(comp, "Label")].defaultValue, "Save");
  assert.deepEqual(comp.fills[0].color, { r: 0, g: 1, b: 0 });
  assert.deepEqual(inst.fills[0].color, { r: 0, g: 1, b: 0 });
  const other = await figma.getNodeByIdAsync(second.node.id);
  assert.equal(other.componentPropertyDefinitions[fullName(other, "Tone")].type, "BOOLEAN");
});

test("a definition edit and the node's own words are one delta, one undo step", async () => {
  const { comp } = await chipComponent();
  // The control: what ONE verb costs the undo log (entry seal + success commit).
  const control = figma.undoLog.length;
  await edit(id(comp.id), { name: "Chip A" });
  const perVerb = figma.undoLog.length - control;
  const before = figma.undoLog.length;
  await edit(id(comp.id), { name: "Chip B", propertyDefinitions: { Label: { name: "Caption", defaultValue: "Save" } } });
  assert.equal(comp.name, "Chip B");
  assert.equal(comp.componentPropertyDefinitions[fullName(comp, "Caption")].defaultValue, "Save");
  // A rename, a re-default and a root word land in one step, not three.
  assert.equal(figma.undoLog.length - before, perVerb);
  assert.ok(!figma.undoLog.includes("trigger"));
});

test("componentPropertyReferences BINDS a live sublayer, and the property then drives it", async () => {
  const { comp, title, inst } = await plainComponent();
  await edit(id(comp.id), { propertyDefinitions: { Heading: { type: "text", defaultValue: "Untitled" } } });
  await edit(id(title.id), { componentPropertyReferences: { text: "Heading" } });
  const heading = fullName(comp, "Heading");
  assert.equal(title.componentPropertyReferences.characters, heading);
  // A fresh instance is what proves the wire: the property now drives the bound sublayer.
  const stamped = await render(instance(comp.id, { left: 800, top: 800 }));
  const fresh = await figma.getNodeByIdAsync(stamped.node.id);
  await edit(id(fresh.id), { componentProperties: { Heading: "Ship it" } });
  assert.equal(fresh.findOne((n: { name: string }) => n.name === "Title").characters, "Ship it");
  assert.equal(inst.findOne((n: { name: string }) => n.name === "Title").characters, "Title"); // untouched
});

test("componentPropertyReferences UNBINDS a field with null, leaving its value alone", async () => {
  const { comp, label } = await chipComponent();
  await edit(id(label.id), { componentPropertyReferences: { text: null } });
  assert.equal(label.componentPropertyReferences.characters, undefined);
  assert.equal(label.characters, "Label"); // the field keeps the value it had
  // The property still exists — it just drives nothing now.
  assert.ok(fullName(comp, "Label"));
  await assert.rejects(edit(id(label.id), { componentPropertyReferences: { text: null } }), /nothing to unbind/);
});

test("a binding edit merges onto the node's live bag rather than replacing it", async () => {
  const { comp, label } = await chipComponent();
  await edit(id(comp.id), { propertyDefinitions: { "Show Label": { type: "boolean", defaultValue: true } } });
  await edit(id(label.id), { componentPropertyReferences: { visible: "Show Label" } });
  assert.equal(label.componentPropertyReferences.characters, fullName(comp, "Label"));
  assert.equal(label.componentPropertyReferences.visible, fullName(comp, "Show Label"));
});

test("an insert into a component may carry bindings — an existing property, and a NEW slot it declares", async () => {
  const { comp } = await chipComponent();
  await append(
    id(comp.id),
    frame({ layout: { mode: "row", gap: 2 } }, [
      text("Sub", { key: "sub", name: "Sub", componentPropertyReferences: { text: "Label" } }),
      frame({ key: "extra", name: "Extra", width: 16, height: 16, componentPropertyReferences: { slot: "Extra" } }),
    ]),
  );
  const sub = comp.findOne((n: { name: string }) => n.name === "Sub");
  const extra = comp.findOne((n: { name: string }) => n.name === "Extra");
  assert.equal(sub.componentPropertyReferences.characters, fullName(comp, "Label"));
  // A slot has no other birth after the component exists — the bound frame IS the slot, so the
  // insert declares the property.
  const extraProp = fullName(comp, "Extra");
  assert.equal(comp.componentPropertyDefinitions[extraProp].type, "SLOT");
  assert.equal(extra.componentPropertyReferences.slotContentId, extraProp);
  // And every instance stamped from here shows that frame as a SLOT.
  const stamped = await render(instance(comp.id, { left: 900, top: 900 }));
  const fresh = await figma.getNodeByIdAsync(stamped.node.id);
  assert.equal(fresh.findOne((n: { name: string }) => n.name === "Extra").type, "SLOT");
});

test("an instance's SLOT takes the frame surface under edit", async () => {
  const { inst } = await chipComponent();
  const slot = inst.findOne((n: { type: string }) => n.type === "SLOT");
  assert.ok(slot);
  await edit(id(slot.id), { layout: { mode: "column", gap: 6 }, fill: "#00ff00" });
  assert.equal(slot.layoutMode, "VERTICAL");
  assert.equal(slot.itemSpacing, 6);
  assert.deepEqual(slot.fills[0].color, { r: 0, g: 1, b: 0 });
  // Still a slot, not a text: the words are a frame's, not everything.
  await assert.rejects(edit(id(slot.id), { text: "nope" }), /`text` is not a SLOT word/);
});

test("editMany refuses a batch that both re-declares a property and binds to it, naming both entries", async () => {
  const { comp, title } = await plainComponent();
  await edit(id(comp.id), { propertyDefinitions: { Heading: { type: "text", defaultValue: "Untitled" } } });
  const before = figma.undoLog.length;
  await assert.rejects(
    editMany([
      { target: id(comp.id), changes: { propertyDefinitions: { Heading: { name: "Caption" } } } },
      { target: id(title.id), changes: { componentPropertyReferences: { text: "Heading" } } },
    ]),
    /\[1\].*in the same batch — the two would have to run in an order this call never states/s,
  );
  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(title.componentPropertyReferences, undefined);
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
      { target: id(comp.id), changes: { propertyDefinitions: { Label: null } } },
      { target: id(inst.id), changes: { componentProperties: { Label: "Hi" } } },
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
    edit(id(comp.id), { propertyDefinitions: { Label: { type: "boolean", defaultValue: true } } }),
    /is "text" and Figma can't change a property's type/,
  );
  // A slot IS a frame, so it is made by inserting one, never declared on its own.
  await assert.rejects(
    edit(id(comp.id), { propertyDefinitions: { Extra: { type: "slot" } } }),
    /a slot IS the frame that holds its placeholder content/,
  );
  // Nothing binds a property an edit adds, so there is no node to derive its default from.
  await assert.rejects(
    edit(id(comp.id), { propertyDefinitions: { Heading: { type: "text" } } }),
    /needs a `defaultValue` — nothing in this call binds it/,
  );
  // A slot has no value at all.
  await assert.rejects(
    edit(id(comp.id), { propertyDefinitions: { Trailing: { defaultValue: "x" } } }),
    /is a slot, and a slot has no value/,
  );
  // `type` alone can only restate what the property already is.
  await assert.rejects(edit(id(comp.id), { propertyDefinitions: { Label: { type: "text" } } }), /names nothing that can change/);
  // A rename onto a name the component already uses.
  await assert.rejects(edit(id(comp.id), { propertyDefinitions: { Label: { name: "Icon" } } }), /already has a property named "Icon"/);
  // A name that isn't there and isn't being declared.
  await assert.rejects(edit(id(comp.id), { propertyDefinitions: { Nope: null } }), /this component has no property "Nope"/);
  // The definition words reach a COMPONENT, not one of its layers or an instance.
  await assert.rejects(edit(id(icon.id), { propertyDefinitions: { Icon: null } }), /`propertyDefinitions` is not a RECTANGLE word/);
  await assert.rejects(edit(id(inst.id), { propertyDefinitions: { Icon: null } }), /`propertyDefinitions` is not an? INSTANCE word/);

  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(JSON.stringify(comp.componentPropertyDefinitions), definitions);
  assert.equal(label.componentPropertyReferences.characters, fullName(comp, "Label"));
  assert.ok(trailing.componentPropertyReferences.slotContentId);
});

test("a variant's properties live on the SET, and the refusal points there", async () => {
  const small = await component(frame({ width: 96, height: 32, fill: "#111111" }), { name: "Button" });
  const large = await component(frame({ width: 128, height: 44, fill: "#111111" }), { name: "Button" });
  const set = await variants(
    [{ component: small.node, variant: { Size: "Small" } }, { component: large.node, variant: { Size: "Large" } }],
    { name: "Button" },
  );
  const setNode = await figma.getNodeByIdAsync(set.id);
  const variant = setNode.children[0];
  const before = figma.undoLog.length;
  await assert.rejects(
    edit(id(variant.id), { propertyDefinitions: { Label: { type: "text", defaultValue: "Go" } } }),
    /is a VARIANT, and a set's properties live on the SET/,
  );
  assert.deepEqual(figma.undoLog.slice(before), []);
  // On the SET itself it lands, and the axis it already has is not a definition anyone can change.
  await edit(id(set.id), { propertyDefinitions: { Label: { type: "text", defaultValue: "Go" } } });
  assert.equal(setNode.componentPropertyDefinitions[fullName(setNode, "Label")].defaultValue, "Go");
  await assert.rejects(edit(id(set.id), { propertyDefinitions: { Size: null } }), /is a VARIANT axis, and a set's axes ARE its member components' names/);
});

// One slot property on a SET, one frame in EACH variant: a binding lives per variant, so "a slot is
// one hole" is counted inside the variant, never across the set.
test("a set's slot needs its own frame in every variant, and each variant's is its only one", async () => {
  const small = await component(frame({ width: 96, height: 32, fill: "#111111" }), { name: "Button" });
  const large = await component(frame({ width: 128, height: 44, fill: "#111111" }), { name: "Button" });
  const set = await variants(
    [{ component: small.node, variant: { Size: "Small" } }, { component: large.node, variant: { Size: "Large" } }],
    { name: "Button" },
  );
  const setNode = await figma.getNodeByIdAsync(set.id);
  const [a, b] = setNode.children;
  const slotFrame = () => frame({ name: "Trailing", width: 20, height: 20, componentPropertyReferences: { slot: "Trailing" } });
  // Into the first variant the insert MINTS the set's slot property; into the second it binds that
  // same property, which is what makes the set's slot whole.
  await append(id(a.id), slotFrame());
  await append(id(b.id), slotFrame());
  const trailing = fullName(setNode, "Trailing");
  const frameA = a.findOne((n: { name: string }) => n.name === "Trailing");
  const frameB = b.findOne((n: { name: string }) => n.name === "Trailing");
  assert.equal(frameA.componentPropertyReferences.slotContentId, trailing);
  assert.equal(frameB.componentPropertyReferences.slotContentId, trailing);
  // The other variant's frame is no help to this one: unbinding leaves THIS variant with a slot
  // property and nowhere to put an instance's content.
  await assert.rejects(
    edit(id(frameA.id), { componentPropertyReferences: { slot: null } }),
    /this is the only frame in .* bound to slot property "Trailing"/,
  );
  // And within one variant it is still one hole.
  await assert.rejects(append(id(a.id), slotFrame()), /slot property "Trailing" already has its frame/);
});

test("every binding refusal names the cause and writes nothing", async () => {
  const { comp, icon, label, trailing, inst } = await chipComponent();
  const plain = await render(frame({ key: "outside", width: 10, height: 10 }));
  const before = figma.undoLog.length;

  // Outside every component there is no property to point at.
  await assert.rejects(edit("outside", { componentPropertyReferences: { visible: "Icon" } }), /is not inside a component/);
  // Inside an INSTANCE the binding belongs to the definition.
  const liveLabel = inst.findOne((n: { name: string }) => n.name === "Label");
  await assert.rejects(
    edit(id(liveLabel.id), { componentPropertyReferences: { text: "Label" } }),
    /is inside component instance .* A binding belongs to the DEFINITION/s,
  );
  // Per-type field legality, exactly as at construction — read off the LIVE node's type.
  await assert.rejects(
    edit(id(label.id), { componentPropertyReferences: { slot: "Trailing" } }),
    /`slot` is not one of a TEXT's binding fields \(visible, text\)/,
  );
  // A field drives one property TYPE.
  await assert.rejects(
    edit(id(icon.id), { componentPropertyReferences: { visible: "Label" } }),
    /`visible` is driven by a boolean property, and "Label" is "text"/,
  );
  // An unknown name lists the component's own.
  await assert.rejects(edit(id(icon.id), { componentPropertyReferences: { visible: "Nope" } }), /this component has no property "Nope"/);
  // A slot with no frame has nowhere to put an instance's content — delete the property instead.
  await assert.rejects(
    edit(id(trailing.id), { componentPropertyReferences: { slot: null } }),
    /this is the only frame in .* bound to slot property "Trailing"/,
  );

  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(label.componentPropertyReferences.characters, fullName(comp, "Label"));
  assert.equal(icon.componentPropertyReferences.visible, fullName(comp, "Icon"));
  assert.equal(plain.node.id && (await figma.getNodeByIdAsync(plain.node.id)).componentPropertyReferences, undefined);
});

test("every bound-insert refusal names the cause and writes nothing", async () => {
  const { comp, trailing } = await chipComponent();
  const plain = await render(frame({ key: "outside", width: 100, height: 100 }));
  const before = figma.undoLog.length;

  // The standing refusal, unchanged everywhere but inside a component.
  await assert.rejects(
    append("outside", text("Hi", { componentPropertyReferences: { text: "Label" } })),
    /`componentPropertyReferences` binds a node to a component property, and nothing here declares one/s,
  );
  // A non-slot binding names a property that must already exist.
  await assert.rejects(
    append(id(comp.id), text("Hi", { componentPropertyReferences: { text: "Nope" } })),
    /this component has no property "Nope"/,
  );
  // A slot is one hole, whether the second claim comes from the document or from this same spec.
  await assert.rejects(
    append(id(comp.id), frame({ width: 10, height: 10, componentPropertyReferences: { slot: "Trailing" } })),
    /slot property "Trailing" already has its frame/,
  );
  await assert.rejects(
    append(id(comp.id), frame({ layout: { mode: "row" } }, [
      frame({ width: 10, height: 10, componentPropertyReferences: { slot: "Twin" } }),
      frame({ width: 10, height: 10, componentPropertyReferences: { slot: "Twin" } }),
    ])),
    /two frames in this spec claim slot "Twin"/i,
  );

  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(comp.children.length, 3);
  assert.equal((await figma.getNodeByIdAsync(plain.node.id)).children.length, 0);
  assert.ok(trailing.componentPropertyReferences.slotContentId);
});

test("a spec insert into a COMPONENT_SET is refused — its children are its variants", async () => {
  const small = await component(frame({ width: 96, height: 32, fill: "#111111" }), { name: "Button" });
  const large = await component(frame({ width: 128, height: 44, fill: "#111111" }), { name: "Button" });
  const set = await variants(
    [{ component: small.node, variant: { Size: "Small" } }, { component: large.node, variant: { Size: "Large" } }],
    { name: "Button" },
  );
  const setNode = await figma.getNodeByIdAsync(set.id);
  const before = figma.undoLog.length;
  await assert.rejects(append(id(set.id), rect({ width: 10, height: 10 })), /is a COMPONENT_SET, and a set's children are its VARIANTS/);
  assert.deepEqual(figma.undoLog.slice(before), []);
  assert.equal(setNode.children.length, 2);
});
