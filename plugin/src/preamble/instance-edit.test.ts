// Editing a live INSTANCE — read words are write words, so `flcm.edit` is the whole surface: a
// frame's words on the root, `componentProperties` (variants included), `overrides` per sublayer,
// and `componentId` to swap. Plus `flcm.detach`, the one verb that ends an instance.
//
// What must not regress silently: the three component words reach ONLY an INSTANCE, a variant
// change completes the tuple from the variant the instance is on, an override compiles against the
// LIVE sublayer when the tree isn't moving and against the incoming component's definition when it
// is, the apply order inside one delta is swap → properties → root words → overrides, and every
// refusal fires with zero writes. Creation-side property/variant resolution is instance.test.ts's.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, text, instance, id } from "./flcm.js";
import { render } from "./render.js";
import { edit } from "./edit.js";
import { editMany } from "./edit-many.js";
import { detach } from "./instance.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

// A "Chip" component: a row with a bound label and a bound icon — a TEXT property, a BOOLEAN
// property, and two sublayers an override can reach.
async function chipComponent() {
  const built = await render(
    frame({ key: "chip", fill: "#0000ff", layout: { mode: "row", gap: 4, padding: 8 } }, [
      rect({ key: "icon", name: "Icon", width: 12, height: 12, fill: "#ffffff" }),
      text("Label", { key: "label", name: "Label", textStyle: { fontSize: 12 } }),
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
  const stamped = await render(instance(comp.id, { key: "live" }));
  return { comp, label, icon, labelProp, iconProp, inst: await figma.getNodeByIdAsync(stamped.node.id) };
}

// A two-axis variant set plus an instance of Size=Large, State=Default (variants[1]).
async function variantSet() {
  const variants = ["Size=Small, State=Default", "Size=Large, State=Default", "Size=Large, State=Hover"].map((name) => {
    const c = figma.createComponent();
    c.name = name;
    figma.currentPage.appendChild(c);
    return c;
  });
  const set = figma.combineAsVariants(variants, figma.currentPage);
  set.name = "Button";
  const stamped = await render(instance(variants[1].id));
  return { set, variants, inst: await figma.getNodeByIdAsync(stamped.node.id) };
}

test("a frame's words land on an instance's root, and the layout gate reads its LIVE mode", async () => {
  const { comp, inst } = await chipComponent();
  const handle = await edit(id(inst.id), { fill: "#ff0000", width: 200, name: "Chip A" });
  assert.deepEqual(inst.fills[0].color, { r: 1, g: 0, b: 0 });
  assert.equal(inst.width, 200);
  assert.equal(inst.name, "Chip A");
  assert.equal(handle.id, inst.id);
  // The component's own auto-layout survives a recolor, exactly as a frame's does.
  assert.equal(inst.layoutMode, "HORIZONTAL");
  await edit(id(inst.id), { layout: { gap: 12 } });
  assert.equal(inst.itemSpacing, 12);

  // The same word on an instance of a FREE-FORM component is refused by the live mode, not by type.
  const plainFrame = await render(frame({ key: "plain", width: 40, height: 40 }));
  const plain = figma.createComponentFromNode(await figma.getNodeByIdAsync(plainFrame.node.id));
  const stamped = await render(instance(plain.id));
  await assert.rejects(edit(id(stamped.node.id), { layout: { gap: 8 } }), /need an auto-layout \(row\/column\) container/);
  assert.equal(comp.itemSpacing, 4); // the component is untouched by any of it
});

test("componentProperties set a bound text and boolean on the live instance", async () => {
  const { inst, labelProp, iconProp } = await chipComponent();
  await edit(id(inst.id), { componentProperties: { Label: "Save", Icon: false } });
  assert.equal(inst.componentProperties[labelProp].value, "Save");
  assert.equal(inst.componentProperties[iconProp].value, false);
  assert.equal(inst.children[1].characters, "Save");
  assert.equal(inst.children[0].visible, false);
});

test("a variant change completes the tuple from the variant the instance is ON, keeping its id", async () => {
  const { variants, inst } = await variantSet();
  const before = inst.id;
  // Only State is named; Size=Large comes from the instance's current variant.
  const handle = await edit(id(inst.id), { componentProperties: { State: "Hover" } });
  assert.equal(inst.mainComponent, variants[2]);
  assert.equal(handle.id, before);
  // Back the other way, and a combination the set lacks names the ones it has — with nothing applied.
  await edit(id(inst.id), { componentProperties: { State: "Default" } });
  assert.equal(inst.mainComponent, variants[1]);
  await assert.rejects(
    edit(id(inst.id), { componentProperties: { Size: "Small", State: "Hover" } }),
    /has no variant Size=Small, State=Hover — its variants are "Size=Small, State=Default"/,
  );
  assert.equal(inst.mainComponent, variants[1]);
});

test("an override edits the LIVE sublayer — live wrap and all — and never the definition", async () => {
  const { label, inst } = await chipComponent();
  const liveLabelId = "I" + inst.id + ";" + label.id;
  await edit(id(inst.id), { overrides: { [label.id]: { text: "Hi", fill: "#00ff00" } } });
  const liveLabel = await figma.getNodeByIdAsync(liveLabelId);
  assert.equal(liveLabel.characters, "Hi");
  assert.deepEqual(liveLabel.fills[0].color, { r: 0, g: 1, b: 0 });
  assert.equal(label.characters, "Label"); // the component's own text is the instance's to override, not to change

  // The live-node compile is load-bearing, not an implementation detail: this sublayer has been
  // given a bounded width, so a clamp is realizable — the DEFINITION still hugs, and compiling
  // against it (as a create must) would reject the same delta.
  await edit(id(liveLabelId), { width: 60 });
  assert.equal(label.textAutoResize, "WIDTH_AND_HEIGHT");
  await edit(id(inst.id), { overrides: { [label.id]: { textStyle: { lineClamp: 2 } } } });
  assert.equal((await figma.getNodeByIdAsync(liveLabelId)).maxLines, 2);
});

test("componentId swaps the component; overrides in the same delta land on the NEW tree", async () => {
  const { inst } = await chipComponent();
  // A second component with a same-named "Label" sublayer — what Figma matches an override across.
  const builtB = await render(
    frame({ key: "b", left: 400, fill: "#00ff00", layout: { mode: "row", gap: 2, padding: 4 } }, [
      text("B", { key: "labelB", name: "Label", textStyle: { fontSize: 12 } }),
    ]),
  );
  const compB = figma.createComponentFromNode(await figma.getNodeByIdAsync(builtB.keyed.b.id));
  compB.name = "Chip B";
  const labelB = await figma.getNodeByIdAsync(builtB.keyed.labelB.id);

  const handle = await edit(id(inst.id), {
    componentId: compB.id,
    overrides: { [labelB.id]: { text: "Swapped", fill: "#ff0000" } },
    opacity: 0.5,
  });
  assert.equal(handle.id, inst.id); // the instance keeps its identity across a swap
  assert.equal(inst.mainComponent, compB);
  assert.equal(inst.opacity, 0.5); // the delta's own root word wins over what the swap brought
  const liveB = await figma.getNodeByIdAsync("I" + inst.id + ";" + labelB.id);
  assert.equal(liveB.characters, "Swapped");
  assert.deepEqual(liveB.fills[0].color, { r: 1, g: 0, b: 0 });
  assert.equal(labelB.characters, "B"); // compB's own definition is untouched

  // A path from the OUTGOING component is refused by name, with nothing applied.
  await assert.rejects(
    edit(id(inst.id), { componentId: compB.id, overrides: { "999:999": { fill: "#000" } } }),
    /"Chip B" \(id .*\) has no sublayer at that path/,
  );
});

test("the main component is proven at the seal: a swap during the font load refuses with zero writes", async () => {
  const { comp, label, inst } = await chipComponent();
  const builtB = await render(frame({ key: "b", left: 400, layout: { mode: "row" } }, [text("B", { key: "labelB", name: "Label" })]));
  const compB = figma.createComponentFromNode(await figma.getNodeByIdAsync(builtB.keyed.b.id));
  compB.name = "Chip B";
  const before = [...figma.undoLog];
  // The delta names the component the instance HAS, so prepare plans it as a no-op swap. The font
  // load is the suspension point; standing in for the user, it swaps the instance to Chip B. A
  // gate that trusted prepare's relationship would leave Chip B in place and report success.
  const loadFontAsync = figma.loadFontAsync;
  figma.loadFontAsync = (font: unknown) => {
    inst.swapComponent(compB);
    return loadFontAsync.call(figma, font);
  };
  try {
    await assert.rejects(
      edit(id(inst.id), { componentId: comp.id, overrides: { [label.id]: { text: "Hi" } } }),
      /the main component of INSTANCE .* changed while this call was resolving targets and loading resources \(it was COMPONENT "Chip"/,
    );
  } finally {
    figma.loadFontAsync = loadFontAsync;
  }
  assert.deepEqual(figma.undoLog, before);
  assert.equal(inst.mainComponent, compB); // the user's swap stands
});

test("the component words are INSTANCE-only — every other type rejects them by name", async () => {
  const out = await render(frame({ key: "card", width: 100, height: 100 }, [text("hi", { key: "t" })]));
  await assert.rejects(edit("card", { componentProperties: { Size: "Large" } }), /`componentProperties` is not a FRAME word/);
  await assert.rejects(edit("card", { overrides: { "1:2": { fill: "#000" } } }), /`overrides` is not a FRAME word/);
  await assert.rejects(edit("card", { componentId: "1:2" }), /`componentId` is not a FRAME word/);
  await assert.rejects(edit("t", { componentId: "1:2" }), /`componentId` is not a TEXT word/);
  assert.equal((await figma.getNodeByIdAsync(out.keyed.card.id)).width, 100);
});

test("every component-word refusal fires before the seal, with zero writes and zero undo residue", async () => {
  const { comp, inst } = await chipComponent();
  const plain = await render(rect({ width: 10, height: 10 }));
  const logBefore = [...figma.undoLog];
  await assert.rejects(edit(id(inst.id), { componentProperties: { Lable: "x" } }), /no property "Lable" — its properties are "Label", "Icon"/);
  await assert.rejects(edit(id(inst.id), { componentProperties: { Icon: "yes" } }), /is a boolean property — got "yes"/);
  await assert.rejects(edit(id(inst.id), { overrides: { "999:999": { fill: "#000" } } }), /has no sublayer at that path/);
  await assert.rejects(edit(id(inst.id), { componentId: 7 as never }), /the component to swap to must be a component's node id/);
  await assert.rejects(edit(id(inst.id), { componentId: plain.node.id }), /is not a component/);
  await assert.rejects(edit(id(inst.id), { componentId: id(inst.id) as never }), /is itself an instance, not a component/);
  // A nested instance's own component is out of an override's reach, and says where to go instead.
  assert.throws(
    () => instance(comp.id, { overrides: { "1:2": { componentId: "1:3" } } as never }),
    /`componentId` reaches a NESTED instance's own component/,
  );
  assert.deepEqual(figma.undoLog, logBefore);
  assert.equal(inst.mainComponent, comp);
  assert.equal(inst.children[1].characters, "Label");
});

test("editMany takes instance deltas, atomically, alongside ordinary ones", async () => {
  const { label, inst } = await chipComponent();
  const other = await render(rect({ key: "box", width: 10, height: 10 }));
  const undosBefore = figma.undoLog.length;
  await editMany([
    { target: id(inst.id), changes: { componentProperties: { Label: "Go" }, overrides: { [label.id]: { fill: "#00ff00" } }, opacity: 0.4 } },
    { target: "box", changes: { fill: "#ff0000" } },
  ]);
  assert.equal(inst.children[1].characters, "Go");
  assert.deepEqual((await figma.getNodeByIdAsync("I" + inst.id + ";" + label.id)).fills[0].color, { r: 0, g: 1, b: 0 });
  assert.equal(inst.opacity, 0.4);
  assert.deepEqual(figma.undoLog.slice(undosBefore), ["commit", "commit"]); // one undo step for the set

  // A bad component word rejects the whole batch, naming its entry — and the sibling never lands.
  const box = await figma.getNodeByIdAsync(other.node.id);
  await assert.rejects(
    editMany([
      { target: "box", changes: { fill: "#0000ff" } },
      { target: id(inst.id), changes: { componentProperties: { Nope: "x" } } },
    ]),
    /1 of 2 entries were rejected.*\[1\].*no property "Nope"/s,
  );
  assert.deepEqual(box.fills[0].color, { r: 1, g: 0, b: 0 });
});

test("detach hands back a NEW frame and leaves the instance node behind", async () => {
  const { inst } = await chipComponent();
  const parent = inst.parent;
  const at = parent.children.indexOf(inst);
  const handle = await detach(id(inst.id));
  assert.equal(handle.type, "FRAME");
  assert.notEqual(handle.id, inst.id);
  assert.equal(inst.removed, true);
  const detached = await figma.getNodeByIdAsync(handle.id);
  assert.equal(detached.parent, parent);
  assert.equal(parent.children[at], detached);
  assert.equal(detached.children.length, 2); // the component's subtree came with it, as plain layers
  assert.equal(detached.mainComponent, undefined);
  // Fresh geometry, like every other verb's handle.
  assert.equal(handle.width, detached.width);
});

test("detach refuses a NESTED instance, naming the outer one, and anything that isn't an instance", async () => {
  const { comp, inst } = await chipComponent();
  const outerFrame = await render(frame({ key: "outer", left: 400, width: 200, height: 60 }, [instance(comp.id, { key: "nested" })]));
  const outerComp = figma.createComponentFromNode(await figma.getNodeByIdAsync(outerFrame.keyed.outer.id));
  outerComp.name = "Panel";
  const stamped = await render(instance(outerComp.id));
  const outer = await figma.getNodeByIdAsync(stamped.node.id);
  const nested = outer.children[0];
  assert.equal(nested.type, "INSTANCE");
  await assert.rejects(detach(id(nested.id)), (err: Error) => {
    assert.match(err.message, /is nested inside instance "Panel"/);
    assert.match(err.message, /Detach "?i?[^"]*"? \(the whole outer instance becomes editable layers\)/);
    return true;
  });
  assert.equal(nested.removed, false);
  await assert.rejects(detach(id(comp.id)), /is not an instance.*detach an INSTANCE of it/s);
  await assert.rejects(detach("no-such-key"), /no live node|flcm/);
  // The whole outer instance detaches fine — the nested one comes along as an ordinary instance.
  const handle = await detach(id(outer.id));
  assert.equal(handle.type, "FRAME");
  assert.equal(inst.removed, false); // an unrelated instance is untouched
});

test("a NESTED instance takes the same words — its live ids carry exactly ONE leading `I`", async () => {
  const { comp, label } = await chipComponent();
  const outerFrame = await render(frame({ key: "outer", left: 400, width: 200, height: 60 }, [instance(comp.id, { key: "nested" })]));
  const outerComp = figma.createComponentFromNode(await figma.getNodeByIdAsync(outerFrame.keyed.outer.id));
  outerComp.name = "Panel";
  const stamped = await render(instance(outerComp.id));
  const outer = await figma.getNodeByIdAsync(stamped.node.id);
  const nested = outer.children[0];
  assert.equal(nested.type, "INSTANCE");
  assert.equal(nested.id.indexOf("II"), -1);
  // Figma spells a sublayer with one `I` however deep, so the nested instance's own id is already
  // the prefix — doubling it is what made every override on a nested instance unaddressable.
  await edit(id(nested.id), { overrides: { [label.id]: { text: "Deep", fill: "#00ff00" } } });
  const liveLabel = await figma.getNodeByIdAsync(nested.id + ";" + label.id);
  assert.equal(liveLabel.characters, "Deep");
  assert.deepEqual(liveLabel.fills[0].color, { r: 0, g: 1, b: 0 });
  // Its component link is readable too, so property values land on it like any other instance.
  await edit(id(nested.id), { componentProperties: { Icon: false } });
  assert.equal(nested.children[0].visible, false);
});

test("an empty component bag is refused rather than minting an undo step for zero writes", async () => {
  const { inst } = await chipComponent();
  const before = [...figma.undoLog];
  await assert.rejects(edit(id(inst.id), { componentProperties: {} }), /the delta compiled to nothing/);
  await assert.rejects(edit(id(inst.id), { overrides: {} }), /the delta compiled to nothing/);
  assert.deepEqual(figma.undoLog, before);
  // Riding beside a real word it is simply inert — the delta still has work to do.
  await edit(id(inst.id), { componentProperties: {}, opacity: 0.5 });
  assert.equal(inst.opacity, 0.5);
});

test("a swap and a layout word in one delta gate on the component the swap brings IN", async () => {
  const { inst } = await chipComponent(); // "Chip" is a row
  const builtFree = await render(frame({ key: "free", left: 400, width: 80, height: 30, fill: "#00ff00" }));
  const freeComp = figma.createComponentFromNode(await figma.getNodeByIdAsync(builtFree.keyed.free.id));
  freeComp.name = "Free";
  const builtRow = await render(frame({ key: "row", left: 600, layout: { mode: "row", gap: 2, padding: 2 } }, [rect({ width: 8, height: 8 })]));
  const rowComp = figma.createComponentFromNode(await figma.getNodeByIdAsync(builtRow.keyed.row.id));
  rowComp.name = "Row";

  // Swapping a free-form instance to a row MAKES the gap legal — the pre-swap mode must not refuse it.
  const stampedFree = await render(instance(freeComp.id));
  const freeInst = await figma.getNodeByIdAsync(stampedFree.node.id);
  await edit(id(freeInst.id), { componentId: rowComp.id, layout: { gap: 20 } });
  assert.equal(freeInst.layoutMode, "HORIZONTAL");
  assert.equal(freeInst.itemSpacing, 20);

  // The other direction: the swap makes the gap meaningless, so it rejects in the gate rather than
  // landing the swap and letting Figma refuse the write inside the sealed span.
  const before = [...figma.undoLog];
  await assert.rejects(
    edit(id(inst.id), { componentId: freeComp.id, layout: { gap: 20 } }),
    /need an auto-layout \(row\/column\) container/,
  );
  assert.deepEqual(figma.undoLog, before);
  assert.equal(inst.mainComponent.name, "Chip");
});

test("an override's live gate runs BEFORE the seal — a refusal costs zero writes, not a rollback", async () => {
  const built = await render(frame({ key: "panel", left: 400, width: 120, height: 60 }, [frame({ key: "inner", width: 40, height: 40 })]));
  const panel = figma.createComponentFromNode(await figma.getNodeByIdAsync(built.keyed.panel.id));
  panel.name = "Panel";
  const inner = await figma.getNodeByIdAsync(built.keyed.inner.id);
  const stamped = await render(instance(panel.id));
  const pinst = await figma.getNodeByIdAsync(stamped.node.id);
  const before = [...figma.undoLog];
  await assert.rejects(
    edit(id(pinst.id), { overrides: { [inner.id]: { layout: { gap: 8 } } } }),
    /need an auto-layout \(row\/column\) container/,
  );
  assert.deepEqual(figma.undoLog, before);
});

test("editMany refuses an entry aimed INSIDE an instance another entry re-points", async () => {
  const { label, inst } = await chipComponent();
  const builtB = await render(
    frame({ key: "b", left: 400, fill: "#00ff00", layout: { mode: "row", gap: 2, padding: 4 } }, [
      text("B", { key: "labelB", name: "Label", textStyle: { fontSize: 12 } }),
    ]),
  );
  const compB = figma.createComponentFromNode(await figma.getNodeByIdAsync(builtB.keyed.b.id));
  compB.name = "Chip B";
  const liveLabelId = "I" + inst.id + ";" + label.id;
  const before = [...figma.undoLog];
  await assert.rejects(
    editMany([
      { target: id(inst.id), changes: { componentId: compB.id } },
      { target: id(liveLabelId), changes: { fill: "#ff0000" } },
    ]),
    /\[1\].*entry \[0\] re-points.*`overrides`/s,
  );
  assert.deepEqual(figma.undoLog, before);
  assert.equal(inst.mainComponent.name, "Chip");
  assert.deepEqual((await figma.getNodeByIdAsync(liveLabelId)).fills[0].color, { r: 0, g: 0, b: 0 }); // the sibling never landed
});
