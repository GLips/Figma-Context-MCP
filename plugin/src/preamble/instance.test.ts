import { specNode } from "../../harness/spec-node.js";
// INSTANCE — stamp a component. What must not regress silently: the compiler is document-blind and
// presence-preserving (nothing the node doesn't name becomes a root override), a `get` result spreads
// straight in, component properties resolve by bare name and pick the variant as a whole
// combination, overrides land on the sublayer the component-relative path names, and every
// refusal fires with zero writes naming the component's own vocabulary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { id, get } from "./flcm.js";
import { render } from "./render.js";
import { append } from "./structure.js";

// A "Chip" component: a row with a bound label, a bound icon, and a plain body — the three sublayer
// kinds an instance touches (a TEXT property, a BOOLEAN property, an override target).
async function chipComponent() {
  const figma = createFigmaMock();
  const built = await render({
    type: "FRAME",
    key: "chip",
    fill: "#0000ff",
    layout: { mode: "row", gap: 4, padding: 8 },
    children: [
      { type: "RECTANGLE", key: "icon", width: 12, height: 12, fill: "#ffffff" },
      { type: "TEXT", text: "Label", key: "label", textStyle: { fontSize: 12 } },
    ],
  });
  const comp = figma.createComponentFromNode(
    await figma.getNodeByIdAsync(specNode(built, "chip").id),
  );
  comp.name = "Chip";
  const label = await figma.getNodeByIdAsync(specNode(built, "label").id);
  const icon = await figma.getNodeByIdAsync(specNode(built, "icon").id);
  const labelProp = comp.addComponentProperty("Label", "TEXT", "Label");
  const iconProp = comp.addComponentProperty("Icon", "BOOLEAN", true);
  label.componentPropertyReferences = { characters: labelProp };
  icon.componentPropertyReferences = { visible: iconProp };
  return { figma, comp, label, icon, labelProp, iconProp };
}

test("an instance is presence-preserving: only named words become root overrides", async () => {
  const { figma, comp } = await chipComponent();
  const out = await render({
    type: "INSTANCE",
    componentId: comp.id,
    key: "one",
    name: "First chip",
    opacity: 0.5,
  });
  const inst = await figma.getNodeByIdAsync(out.id);
  assert.equal(inst.type, "INSTANCE");
  assert.equal(inst.mainComponent, comp);
  assert.equal(inst.name, "First chip");
  assert.equal(inst.opacity, 0.5);
  // The component's own values survive — no frame creation default was written over them.
  assert.equal(inst.layoutMode, "HORIZONTAL");
  assert.equal(inst.itemSpacing, 4);
  assert.deepEqual(inst.fills[0].color, { r: 0, g: 0, b: 1 });
  assert.equal(inst.clipsContent, comp.clipsContent);
  assert.equal(specNode(out, "one").id, inst.id);
});

test("component properties resolve by bare name and land through the bindings", async () => {
  const { figma, comp, labelProp, iconProp } = await chipComponent();
  const out = await render({
    type: "INSTANCE",
    componentId: comp.id,
    componentProperties: { Label: "Save", Icon: false },
  });
  const inst = await figma.getNodeByIdAsync(out.id);
  assert.equal(inst.componentProperties[labelProp].value, "Save");
  assert.equal(inst.componentProperties[iconProp].value, false);
  assert.equal(inst.children[1].characters, "Save");
  assert.equal(inst.children[0].visible, false);
});

test("an override lands on the sublayer its component-relative path names", async () => {
  const { figma, comp, label, icon } = await chipComponent();
  const out = await render({
    type: "INSTANCE",
    componentId: comp.id,
    overrides: {
      [label.id]: { text: "Hi", textStyle: { fontSize: 20 } },
      [icon.id]: { fill: "#ff0000" },
    },
  });
  const inst = await figma.getNodeByIdAsync(out.id);
  const liveLabel = await figma.getNodeByIdAsync("I" + inst.id + ";" + label.id);
  assert.equal(liveLabel.characters, "Hi");
  assert.equal(liveLabel.fontSize, 20);
  const liveIcon = await figma.getNodeByIdAsync("I" + inst.id + ";" + icon.id);
  assert.deepEqual(liveIcon.fills[0].color, { r: 1, g: 0, b: 0 });
  // The definition is untouched: an override is the instance's alone.
  assert.equal(label.characters, "Label");
  assert.deepEqual(icon.fills[0].color, { r: 1, g: 1, b: 1 });
});

test("an override is planned at the seal: a definition retyped during the font load refuses with zero writes", async () => {
  const { figma, comp, label } = await chipComponent();
  const before = [...figma.undoLog];
  // The override's text delta loads the label's font as the definition carries it. The font load
  // is a suspension point the user has the document open across: standing in for that user, the
  // load retypes the definition to a family this run never loaded, before it resolves.
  const loadFontAsync = figma.loadFontAsync;
  figma.loadFontAsync = (font: unknown) => {
    label.fontName = { family: "Roboto", style: "Regular" };
    return loadFontAsync.call(figma, font);
  };
  try {
    await assert.rejects(
      render({ type: "INSTANCE", componentId: comp.id, overrides: { [label.id]: { text: "Hi" } } }),
      /changed to Roboto Regular while this call was loading fonts and images/,
    );
  } finally {
    figma.loadFontAsync = loadFontAsync;
  }
  assert.deepEqual(figma.undoLog, before);
  assert.equal(figma.currentPage.children.length, 1); // the component alone — nothing was built
});

test("dropping a read instance's id creates independent copies with its overrides", async () => {
  const { figma, comp, label } = await chipComponent();
  const first = await render({
    type: "INSTANCE",
    componentId: comp.id,
    name: "Original",
    componentProperties: { Label: "Go" },
    overrides: { [label.id]: { fill: "#00ff00" } },
  });
  const { node: read } = await get(id(first.id));
  assert.equal(read.type, "INSTANCE");
  assert.equal(read.componentId, comp.id);

  delete read.id;
  const copy = await render({ ...read, name: "Copy" });
  const inst = await figma.getNodeByIdAsync(copy.id);
  assert.equal(inst.name, "Copy");
  assert.equal(inst.mainComponent, comp);
  assert.equal(inst.children[1].characters, "Go");
  assert.deepEqual((await figma.getNodeByIdAsync("I" + inst.id + ";" + label.id)).fills[0].color, {
    r: 0,
    g: 1,
    b: 0,
  });

  const rebuilt = await render(read);
  assert.equal((await figma.getNodeByIdAsync(rebuilt.id)).mainComponent, comp);
});

test("an instance places like any node — as a child of a rendered frame and through append", async () => {
  const { figma, comp } = await chipComponent();
  const out = await render({
    type: "FRAME",
    key: "row",
    width: 300,
    height: 60,
    layout: { mode: "row" },
    children: [
      { type: "INSTANCE", componentId: comp.id, key: "a" },
      { type: "RECTANGLE", width: 10, height: 10 },
    ],
  });
  const row = await figma.getNodeByIdAsync(specNode(out, "row").id);
  assert.deepEqual(
    row.children.map((c: any) => c.type),
    ["INSTANCE", "RECTANGLE"],
  );
  await append("row", { type: "INSTANCE", componentId: comp.id, key: "b", width: "fill" });
  assert.equal(row.children[2].type, "INSTANCE");
  assert.equal(row.children[2].layoutGrow, 1);
});

test("a variant set: the combination is selected as a whole, and an impossible one names what exists", async () => {
  const figma = createFigmaMock();
  const variants = [
    "Size=Small, State=Default",
    "Size=Large, State=Default",
    "Size=Large, State=Hover",
  ].map((name) => {
    const c = figma.createComponent();
    c.name = name;
    figma.currentPage.appendChild(c);
    return c;
  });
  const set = figma.combineAsVariants(variants, figma.currentPage);
  set.name = "Button";

  // The set itself as the component: the default variant, nudged by one axis.
  const large = await render({
    type: "INSTANCE",
    componentId: set.id,
    componentProperties: { Size: "Large" },
  });
  assert.equal((await figma.getNodeByIdAsync(large.id)).mainComponent, variants[1]);
  // A variant as the component: its own axes complete the tuple.
  const hover = await render({
    type: "INSTANCE",
    componentId: variants[1].id,
    componentProperties: { State: "Hover" },
  });
  assert.equal((await figma.getNodeByIdAsync(hover.id)).mainComponent, variants[2]);
  // Small+Hover has no variant — the refusal lists the ones that exist, and nothing was created.
  const before = figma.currentPage.children.length;
  await assert.rejects(
    render({
      type: "INSTANCE",
      componentId: set.id,
      componentProperties: { Size: "Small", State: "Hover" },
    }),
    /no variant Size=Small, State=Hover — its variants are "Size=Small, State=Default"/,
  );
  await assert.rejects(
    render({ type: "INSTANCE", componentId: set.id, componentProperties: { Size: "Medium" } }),
    /"Medium" is not an option of variant axis "Size" — the options are "Small", "Large"/,
  );
  assert.equal(figma.currentPage.children.length, before);
});

test("refusals name the component's own vocabulary, with zero writes", async () => {
  const { figma, comp, label } = await chipComponent();
  const before = figma.currentPage.children.length;
  await assert.rejects(
    render({ type: "INSTANCE", componentId: comp.id, componentProperties: { Lable: "x" } }),
    /no property "Lable" — its properties are "Label", "Icon"/,
  );
  await assert.rejects(
    render({ type: "INSTANCE", componentId: comp.id, componentProperties: { Icon: "yes" } }),
    /is a boolean property — got "yes"/,
  );
  await assert.rejects(
    render({ type: "INSTANCE", componentId: comp.id, overrides: { "999:999": { fill: "#000" } } }),
    /"Chip" \(id .*\) has no sublayer at that path/,
  );
  // Not a component at all.
  const plain = await render({ type: "RECTANGLE", width: 10, height: 10 });
  await assert.rejects(render({ type: "INSTANCE", componentId: plain.id }), /is not a component/);
  const inst = await render({ type: "INSTANCE", componentId: comp.id });
  await assert.rejects(
    render({ type: "INSTANCE", componentId: inst.id }),
    /is itself an instance, not a component. Pass the component it comes from/,
  );
  // The override's null: a removal word where one exists, a loud refusal where none does.
  await assert.rejects(
    render({ type: "INSTANCE", componentId: comp.id, overrides: { [label.id]: { text: null } } }),
    /`text` is null\. .* no removal word for `text`/s,
  );
  assert.equal(figma.currentPage.children.length, before + 2);
});

test("render rejects instance shape errors before any component lookup", async () => {
  createFigmaMock();
  await assert.rejects(render({ type: "INSTANCE" }), /the component must be a component's node id/);
  await assert.rejects(
    render({ type: "INSTANCE", componentId: "1:2", fillz: "#000" } as never),
    /unknown prop "fillz" on INSTANCE/,
  );
  await assert.rejects(
    render({ type: "INSTANCE", componentId: "1:2", overrides: { "1:3": { colour: "#000" } } }),
    /unknown prop "colour" on INSTANCE.overrides\["1:3"\]/,
  );
  await assert.rejects(
    render({ type: "INSTANCE", componentId: "1:2", overrides: { "1:3": { x: 3 } } }),
    /position is not spelled with bare x\/y/,
  );
  await assert.rejects(
    render({ type: "INSTANCE", componentId: "1:2", componentProperties: { Label: null } } as never),
    /a property value is a string .* Got null/s,
  );
});
