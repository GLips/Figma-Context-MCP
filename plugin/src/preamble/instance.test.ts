// flcm.instance — stamp a component. What must not regress silently: the constructor is inert and
// presence-preserving (nothing the spec doesn't name becomes a root override), a read spec spreads
// straight in, component properties resolve by bare name and pick the variant as a whole
// combination, overrides land on the sublayer the component-relative path names, and every
// refusal fires with zero writes naming the component's own vocabulary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, text, rect, instance, id, get } from "./flcm.js";
import { render } from "./render.js";
import { append } from "./structure.js";
import { fromRead } from "./from-read.js";

// A "Chip" component: a row with a bound label, a bound icon, and a plain body — the three sublayer
// kinds an instance touches (a TEXT property, a BOOLEAN property, an override target).
async function chipComponent() {
  const figma = createFigmaMock();
  const built = await render(
    frame({ key: "chip", fill: "#0000ff", layout: { mode: "row", gap: 4, padding: 8 } }, [
      rect({ key: "icon", width: 12, height: 12, fill: "#ffffff" }),
      text("Label", { key: "label", textStyle: { fontSize: 12 } }),
    ]),
  );
  const comp = figma.createComponentFromNode(await figma.getNodeByIdAsync(built.keyed.chip.id));
  comp.name = "Chip";
  const label = await figma.getNodeByIdAsync(built.keyed.label.id);
  const icon = await figma.getNodeByIdAsync(built.keyed.icon.id);
  const labelProp = comp.addComponentProperty("Label", "TEXT", "Label");
  const iconProp = comp.addComponentProperty("Icon", "BOOLEAN", true);
  label.componentPropertyReferences = { characters: labelProp };
  icon.componentPropertyReferences = { visible: iconProp };
  return { figma, comp, label, icon, labelProp, iconProp };
}

test("an instance is presence-preserving: only named words become root overrides", async () => {
  const { figma, comp } = await chipComponent();
  const out = await render(instance(comp.id, { key: "one", name: "First chip", opacity: 0.5 }));
  const inst = await figma.getNodeByIdAsync(out.node.id);
  assert.equal(inst.type, "INSTANCE");
  assert.equal(inst.mainComponent, comp);
  assert.equal(inst.name, "First chip");
  assert.equal(inst.opacity, 0.5);
  // The component's own values survive — no frame creation default was written over them.
  assert.equal(inst.layoutMode, "HORIZONTAL");
  assert.equal(inst.itemSpacing, 4);
  assert.deepEqual(inst.fills[0].color, { r: 0, g: 0, b: 1 });
  assert.equal(inst.clipsContent, comp.clipsContent);
  assert.equal(out.keyed.one.id, inst.id);
});

test("component properties resolve by bare name and land through the bindings", async () => {
  const { figma, comp, labelProp, iconProp } = await chipComponent();
  const out = await render(instance(comp.id, { componentProperties: { Label: "Save", Icon: false } }));
  const inst = await figma.getNodeByIdAsync(out.node.id);
  assert.equal(inst.componentProperties[labelProp].value, "Save");
  assert.equal(inst.componentProperties[iconProp].value, false);
  assert.equal(inst.children[1].characters, "Save");
  assert.equal(inst.children[0].visible, false);
});

test("an override lands on the sublayer its component-relative path names", async () => {
  const { figma, comp, label, icon } = await chipComponent();
  const out = await render(instance(comp.id, { overrides: { [label.id]: { text: "Hi", textStyle: { fontSize: 20 } }, [icon.id]: { fill: "#ff0000" } } }));
  const inst = await figma.getNodeByIdAsync(out.node.id);
  const liveLabel = await figma.getNodeByIdAsync("I" + inst.id + ";" + label.id);
  assert.equal(liveLabel.characters, "Hi");
  assert.equal(liveLabel.fontSize, 20);
  const liveIcon = await figma.getNodeByIdAsync("I" + inst.id + ";" + icon.id);
  assert.deepEqual(liveIcon.fills[0].color, { r: 1, g: 0, b: 0 });
  // The definition is untouched: an override is the instance's alone.
  assert.equal(label.characters, "Label");
  assert.deepEqual(icon.fills[0].color, { r: 1, g: 1, b: 1 });
});

test("a read spec spreads straight in, and fromRead rebuilds an instance", async () => {
  const { figma, comp, label } = await chipComponent();
  const first = await render(instance(comp.id, { name: "Original", componentProperties: { Label: "Go" }, overrides: { [label.id]: { fill: "#00ff00" } } }));
  const { node: spec } = await get(id(first.node.id));
  assert.equal(spec.type, "INSTANCE");
  assert.equal(spec.componentId, comp.id);

  const copy = await render(instance({ ...spec, name: "Copy" }));
  const inst = await figma.getNodeByIdAsync(copy.node.id);
  assert.equal(inst.name, "Copy");
  assert.equal(inst.mainComponent, comp);
  assert.equal(inst.children[1].characters, "Go");
  assert.deepEqual((await figma.getNodeByIdAsync("I" + inst.id + ";" + label.id)).fills[0].color, { r: 0, g: 1, b: 0 });

  const rebuilt = await render(fromRead(spec));
  assert.equal((await figma.getNodeByIdAsync(rebuilt.node.id)).mainComponent, comp);
});

test("an instance places like any node — as a child of a rendered frame and through append", async () => {
  const { figma, comp } = await chipComponent();
  const out = await render(frame({ key: "row", width: 300, height: 60, layout: { mode: "row" } }, [instance(comp.id, { key: "a" }), rect({ width: 10, height: 10 })]));
  const row = await figma.getNodeByIdAsync(out.keyed.row.id);
  assert.deepEqual(row.children.map((c: any) => c.type), ["INSTANCE", "RECTANGLE"]);
  await append("row", instance(comp.id, { key: "b", width: "fill" }));
  assert.equal(row.children[2].type, "INSTANCE");
  assert.equal(row.children[2].layoutGrow, 1);
});

test("a variant set: the combination is selected as a whole, and an impossible one names what exists", async () => {
  const figma = createFigmaMock();
  const variants = ["Size=Small, State=Default", "Size=Large, State=Default", "Size=Large, State=Hover"].map((name) => {
    const c = figma.createComponent();
    c.name = name;
    figma.currentPage.appendChild(c);
    return c;
  });
  const set = figma.combineAsVariants(variants, figma.currentPage);
  set.name = "Button";

  // The set itself as the component: the default variant, nudged by one axis.
  const large = await render(instance(set.id, { componentProperties: { Size: "Large" } }));
  assert.equal((await figma.getNodeByIdAsync(large.node.id)).mainComponent, variants[1]);
  // A variant as the component: its own axes complete the tuple.
  const hover = await render(instance(variants[1].id, { componentProperties: { State: "Hover" } }));
  assert.equal((await figma.getNodeByIdAsync(hover.node.id)).mainComponent, variants[2]);
  // Small+Hover has no variant — the refusal lists the ones that exist, and nothing was created.
  const before = figma.currentPage.children.length;
  await assert.rejects(render(instance(set.id, { componentProperties: { Size: "Small", State: "Hover" } })), /no variant Size=Small, State=Hover — its variants are "Size=Small, State=Default"/);
  await assert.rejects(render(instance(set.id, { componentProperties: { Size: "Medium" } })), /"Medium" is not an option of variant axis "Size" — the options are "Small", "Large"/);
  assert.equal(figma.currentPage.children.length, before);
});

test("refusals name the component's own vocabulary, with zero writes", async () => {
  const { figma, comp, label } = await chipComponent();
  const before = figma.currentPage.children.length;
  await assert.rejects(render(instance(comp.id, { componentProperties: { Lable: "x" } })), /no property "Lable" — its properties are "Label", "Icon"/);
  await assert.rejects(render(instance(comp.id, { componentProperties: { Icon: "yes" } })), /is a boolean property — got "yes"/);
  await assert.rejects(render(instance(comp.id, { overrides: { "999:999": { fill: "#000" } } })), /"Chip" \(id .*\) has no sublayer at that path/);
  // Not a component at all.
  const plain = await render(rect({ width: 10, height: 10 }));
  await assert.rejects(render(instance(plain.node.id)), /is not a component/);
  const inst = await render(instance(comp.id));
  await assert.rejects(render(instance(inst.node.id)), /is itself an instance, not a component. Pass the component it comes from/);
  // The override's null: a removal word where one exists, a loud refusal where none does.
  await assert.rejects(render(instance(comp.id, { overrides: { [label.id]: { text: null } } })), /`text` is null\. .* no removal word for `text`/s);
  assert.equal(figma.currentPage.children.length, before + 2);
});

test("the constructor is inert and document-blind: shape errors fire before any component lookup", () => {
  createFigmaMock();
  assert.throws(() => instance(undefined as never), /the component must be a component's node id/);
  assert.throws(() => instance("1:2", { componentId: "1:3" } as never), /two components for one instance/);
  assert.throws(() => instance({ componentId: "1:2" } as never, {}), /not both/);
  assert.throws(() => instance("1:2", { fillz: "#000" } as never), /unknown prop "fillz" on flcm.instance/);
  assert.throws(() => instance("1:2", { overrides: { "1:3": { colour: "#000" } } }), /unknown prop "colour" on flcm.instance.overrides\["1:3"\]/);
  assert.throws(() => instance("1:2", { overrides: { "1:3": { x: 3 } } }), /position is not spelled with bare x\/y/);
  assert.throws(() => instance("1:2", { componentProperties: { Label: null } } as never), /a property value is a string .* Got null/s);
  // Well-formed: inert, sealed, and the raw component words ride the node for prepare to resolve.
  const wn = instance("1:2", { componentProperties: { Label: "x" }, overrides: { "1:3": { fill: "#fff" } }, width: 100 });
  assert.equal(wn.type, "INSTANCE");
  assert.equal(wn.component, "1:2");
  assert.ok(Object.isFrozen(wn));
  assert.equal(wn.layout?.mode, undefined);
});
