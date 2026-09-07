// flcm.component / flcm.variants — MAKING a component. What must not regress silently: a spec is
// rendered exactly as flcm.render would render it and then promoted (layout, fill and keys intact,
// and the handle is the COMPONENT's, not the frame's), a live node is promoted where it stands,
// every property type lands with the right default and its binding actually drives an instance, a
// slot is a bound FRAME (never an invented 100×100 box), variants combine into a set an instance can
// select from — and every refusal fires with zero writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, text, instance } from "./flcm.js";
import { render } from "./render.js";
import { component, variants } from "./component.js";
import { append } from "./structure.js";
import { edit } from "./edit.js";

// A bare component to swap in — the value an `instance_swap` property points at.
function badgeComponent(figma: ReturnType<typeof createFigmaMock>, name: string) {
  const comp = figma.createComponent();
  comp.name = name;
  figma.currentPage.appendChild(comp);
  return comp;
}

// A "Chip" carrying one property of every type flcm can declare, each bound to the node it drives.
async function chipComponent() {
  const figma = createFigmaMock();
  const badge = badgeComponent(figma, "Badge A");
  const out = await component(
    frame({ key: "chip", fill: "#0000ff", layout: { mode: "row", gap: 4, padding: 8 } }, [
      rect({ key: "icon", width: 12, height: 12, fill: "#ffffff", componentPropertyReferences: { visible: "Icon" } }),
      text("Label", { key: "label", componentPropertyReferences: { text: "Label" } }),
      instance(badge.id, { key: "badge", componentPropertyReferences: { componentId: "Badge" } }),
      frame({ key: "trailing", width: 20, height: 20, componentPropertyReferences: { slot: "Trailing" } }),
    ]),
    {
      name: "Chip",
      description: "A compact labelled chip.",
      propertyDefinitions: {
        Icon: { type: "boolean" },
        Label: { type: "text" },
        Badge: { type: "instance_swap" },
        Trailing: { type: "slot" },
      },
    },
  );
  const comp = await figma.getNodeByIdAsync(out.node.id);
  return { figma, badge, out, comp };
}

test("a spec renders as render would, then becomes the COMPONENT the handle names", async () => {
  const { figma, out, comp } = await chipComponent();
  assert.equal(comp.type, "COMPONENT");
  assert.equal(comp.name, "Chip");
  assert.equal(comp.description, "A compact labelled chip.");
  // The body rendered exactly as flcm.render would have rendered it.
  assert.equal(comp.layoutMode, "HORIZONTAL");
  assert.equal(comp.itemSpacing, 4);
  assert.deepEqual(comp.fills[0].color, { r: 0, g: 0, b: 1 });
  assert.equal(comp.children.length, 4);
  // The COMPONENT is a NEW node, so the root's key had to ride across — `keyed` names the component
  // itself, not the frame that no longer exists.
  assert.equal(out.keyed.chip.id, comp.id);
  assert.equal(out.node.id, comp.id);
  assert.equal(out.keyed.label.id, comp.children[1].id);
  // The promoted frame is gone from the page; the component stands in its place.
  assert.deepEqual(figma.currentPage.children.map((c: any) => c.type), ["COMPONENT", "COMPONENT"]);
});

test("every property type lands with a derived default, and its binding drives an instance", async () => {
  const { figma, badge, comp } = await chipComponent();
  const definitions = comp.componentPropertyDefinitions;
  const full = (bare: string) => Object.keys(definitions).find((n) => n.split("#")[0] === bare)!;
  // Names are minted suffixed, like live; the defaults were derived from the bound nodes.
  assert.notEqual(full("Label"), "Label");
  assert.deepEqual(definitions[full("Icon")], { type: "BOOLEAN", defaultValue: true });
  assert.deepEqual(definitions[full("Label")], { type: "TEXT", defaultValue: "Label" });
  assert.deepEqual(definitions[full("Badge")], { type: "INSTANCE_SWAP", defaultValue: badge.id });
  assert.deepEqual(definitions[full("Trailing")], { type: "SLOT", defaultValue: "" });
  // The bindings themselves were written in Figma's WIRE spellings, against the suffixed names.
  assert.deepEqual(comp.children[0].componentPropertyReferences, { visible: full("Icon") });
  assert.deepEqual(comp.children[1].componentPropertyReferences, { characters: full("Label") });
  assert.deepEqual(comp.children[2].componentPropertyReferences, { mainComponent: full("Badge") });
  assert.deepEqual(comp.children[3].componentPropertyReferences, { slotContentId: full("Trailing") });

  // An instance of it: the bound frame reads back as a SLOT, and the properties drive their layers.
  const stamped = await render(instance(comp.id, { key: "chip1" }));
  const inst = await figma.getNodeByIdAsync(stamped.node.id);
  assert.equal(inst.children[3].type, "SLOT");
  assert.equal(inst.children[3].width, 20); // the bound frame's own layout, not an invented box
  assert.equal(inst.children[1].characters, "Label");

  const other = badgeComponent(figma, "Badge B");
  await edit(inst.id, { componentProperties: { Label: "Save", Icon: false, Badge: other.id } });
  assert.equal(inst.children[1].characters, "Save");
  assert.equal(inst.children[0].visible, false);
  assert.equal(inst.children[2].mainComponent, other);
});

test("a derived instance_swap default is the variant the bound instance actually stamps", async () => {
  const figma = createFigmaMock();
  const small = await component(frame({ width: 10, height: 10 }), { name: "Icon" });
  const large = await component(frame({ width: 20, height: 20 }), { name: "Icon" });
  const set = await variants(
    [{ component: small.node, variant: { Size: "S" } }, { component: large.node, variant: { Size: "L" } }],
    { name: "Icon" },
  );
  const out = await component(
    frame({ width: 40, height: 40 }, [
      instance(set, { componentProperties: { Size: "L" }, componentPropertyReferences: { componentId: "Icon" } }),
    ]),
    { name: "Chip", propertyDefinitions: { Icon: { type: "instance_swap" } } },
  );
  const comp = await figma.getNodeByIdAsync(out.node.id);
  const definitions = comp.componentPropertyDefinitions;
  const full = Object.keys(definitions).find((n: string) => n.split("#")[0] === "Icon")!;
  // The set's DEFAULT variant is "Size=S"; the bound instance stamps "Size=L", and the derived
  // default is the component the node it was derived from actually points at.
  assert.equal(comp.children[0].mainComponent.name, "Size=L");
  assert.equal(definitions[full].defaultValue, comp.children[0].mainComponent.id);
});

test("a spec promoted onto an occupied page says so, exactly as render does", async () => {
  createFigmaMock();
  const said: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  try {
    await render(frame({ name: "first", width: 100, height: 100 }));
    await component(frame({ name: "second", width: 100, height: 100 }), { name: "Card" });
  } finally {
    console.log = log;
  }
  assert.match(said.join("\n"), /"second" at 0,0 \(100×100\) landed on top of 1 node/);
});

test("a live frame is promoted where it stands, keeping its keys", async () => {
  const figma = createFigmaMock();
  const built = await render(frame({ key: "card", name: "Card", width: 200, height: 100, fill: "#ff0000" }, [rect({ key: "dot", width: 8, height: 8 })]));
  const out = await component(built.keyed.card.id, { name: "Card", propertyDefinitions: { Muted: { type: "boolean", defaultValue: false } } });
  const comp = await figma.getNodeByIdAsync(out.node.id);
  assert.equal(comp.type, "COMPONENT");
  assert.equal(comp.name, "Card");
  assert.equal(comp.width, 200);
  assert.deepEqual(comp.fills[0].color, { r: 1, g: 0, b: 0 });
  // Both keys survive the conversion — the child's on the node itself, the root's on the new node.
  assert.equal(out.keyed.card.id, comp.id);
  assert.equal(out.keyed.dot.id, comp.children[0].id);
  const defaults = Object.values(comp.componentPropertyDefinitions) as { type: string; defaultValue: unknown }[];
  assert.deepEqual(defaults, [{ type: "BOOLEAN", defaultValue: false }]);
});

test("flcm.variants folds components into a set an instance selects from", async () => {
  const figma = createFigmaMock();
  const make = async (label: string) =>
    (await component(frame({ width: 80, height: 24 }, [text(label)]), { name: label })).node.id;
  const small = await make("Small");
  const large = await make("Large");
  const largeHover = await make("Large hover");

  const set = await variants(
    [
      { component: small, variant: { Size: "Small", State: "Default" } },
      { component: large, variant: { State: "Default", Size: "Large" } }, // axis ORDER is free
      { component: largeHover, variant: { Size: "Large", State: "Hover" } },
    ],
    { name: "Button", description: "The button." },
  );
  const live = await figma.getNodeByIdAsync(set.id);
  assert.equal(live.type, "COMPONENT_SET");
  assert.equal(live.name, "Button");
  assert.equal(live.description, "The button.");
  // The members were renamed into Figma's axis grammar, in the FIRST entry's key order, and the set
  // took the first member's slot on the page.
  assert.deepEqual(live.children.map((c: any) => c.name), ["Size=Small, State=Default", "Size=Large, State=Default", "Size=Large, State=Hover"]);
  assert.equal(figma.currentPage.children.indexOf(live), 0);
  assert.deepEqual(Object.keys(live.componentPropertyDefinitions), ["Size", "State"]);

  // The set is now an flcm.instance target, and the combination selects a member as a whole.
  const out = await render(instance(set.id, { componentProperties: { Size: "Large", State: "Hover" } }));
  assert.equal((await figma.getNodeByIdAsync(out.node.id)).mainComponent, live.children[2]);
});

test("what a component call refuses, with zero writes", async () => {
  const { figma, comp } = await chipComponent();
  const before = figma.currentPage.children.length;
  const body = () => frame({ width: 10, height: 10 }, [text("Hi", { componentPropertyReferences: { text: "Label" } })]);

  // A variant axis is the SET's to mint, not a component's to declare.
  await assert.rejects(
    component(frame({ width: 10, height: 10 }), { propertyDefinitions: { Size: { type: "variant" } as never } }),
    /a variant axis is not declared on a component — the axes come from the SET.*flcm\.variants/s,
  );
  // A binding naming a property this call doesn't declare, and one whose type doesn't match.
  await assert.rejects(component(body(), { propertyDefinitions: { Caption: { type: "text" } } }), /names property "Label", which this call doesn't declare — its propertyDefinitions are "Caption"/);
  await assert.rejects(component(body(), { propertyDefinitions: { Label: { type: "boolean", defaultValue: true } } }), /`componentPropertyReferences\.text` drives a text property, and "Label" is declared "boolean"/);
  // A slot nobody binds would leave an unpositioned box in the component.
  await assert.rejects(component(frame({ width: 10, height: 10 }), { propertyDefinitions: { Trailing: { type: "slot" } } }), /no frame is bound to it/);
  await assert.rejects(
    component(frame({ width: 10, height: 10 }, [frame({ componentPropertyReferences: { slot: "T" } }), frame({ componentPropertyReferences: { slot: "T" } })]), { propertyDefinitions: { T: { type: "slot" } } }),
    /2 frames are bound to slot property "T", and a slot is one hole/,
  );
  // A property nothing binds and nothing defaults has no value to invent.
  await assert.rejects(component(frame({ width: 10, height: 10 }), { propertyDefinitions: { Label: { type: "text" } } }), /no `defaultValue`, and nothing in this call binds "Label"/);
  // The subject itself.
  await assert.rejects(component(comp.id), /is already a component — there is nothing to promote/);
  const stamped = await render(instance(comp.id));
  await assert.rejects(component(stamped.node.id), /Figma would WRAP it in a new component/);
  await assert.rejects(component(stamped.node.id + ";" + comp.children[1].id), /no live node|has no sublayer|is inside component instance/);
  // A component's own sublayer: live's createComponentFromNode throws on it, so flcm names it first.
  await assert.rejects(component(comp.children[0].id), /is inside component "Chip".*createComponentFromNode throws/s);
  // The SPEC form gates its root the same way — a leaf root would be wrapped, not converted, and
  // the root's key would land on the wrapper rather than the node the author keyed.
  await assert.rejects(component(text("Hi", { key: "t" })), /the spec's root is a TEXT, and a component's root is a frame/);
  await assert.rejects(component(instance(comp.id)), /the spec's root is an flcm\.instance.*WRAP/s);
  // A slot and a default-less property both need the spec form, and the target form says so rather
  // than naming a constructor word the call has no spec to carry.
  const plain = (await render(frame({ key: "plain", width: 10, height: 10 }))).node.id;
  await assert.rejects(component(plain, { propertyDefinitions: { T: { type: "slot" } } }), /slot property "T" needs the SPEC form/);
  await assert.rejects(component(plain, { propertyDefinitions: { Label: { type: "text" } } }), /promoting a live node binds nothing to this property/);
  assert.equal(figma.currentPage.children.length, before + 2); // only the instance and the plain frame landed
});

test("what a variants call refuses, with zero writes", async () => {
  const figma = createFigmaMock();
  const make = async (name: string) => (await component(frame({ width: 10, height: 10 }), { name })).node.id;
  const a = await make("A");
  const b = await make("B");
  const plain = (await render(frame({ key: "plain", width: 10, height: 10 }))).node.id;
  const before = figma.currentPage.children.length;

  await assert.rejects(variants([{ component: a, variant: { Size: "Small" } }] as never, {} as never), /options\.name is required/);
  await assert.rejects(
    variants([{ component: a, variant: { Size: "Small" } }, { component: b, variant: { State: "Hover" } }], { name: "X" }),
    /every entry names the SAME axes.*first entry names "Size".*missing "Size".*adds "State"/s,
  );
  await assert.rejects(
    variants([{ component: a, variant: { Size: "Small" } }, { component: b, variant: { Size: "Small" } }], { name: "X" }),
    /entries\[0\] and entries\[1\] are both "Size=Small" — every combination in a set is unique/,
  );
  await assert.rejects(variants([{ component: a, variant: { Size: "Sm, Lg" } }], { name: "X" }), /can't contain "=" or ","/);
  await assert.rejects(variants([{ component: plain, variant: { Size: "Small" } }], { name: "X" }), /is not a component\. Make it one first: flcm\.component\(target\)/);
  assert.equal(figma.currentPage.children.length, before);

  // The slot the set takes is counted among the SURVIVORS: the entries name B first, and B's own
  // page index (1) is a slot that no longer exists once A and B have both left the page.
  const keeper = (await render(frame({ key: "keeper", width: 10, height: 10 }))).node.id;
  const set = await variants([{ component: b, variant: { Size: "L" } }, { component: a, variant: { Size: "S" } }], { name: "Button" });
  assert.deepEqual(figma.currentPage.children.map((c: any) => c.id), [set.id, plain, keeper]);

  // Combined once, a component belongs to that set — a second call names the set it is in.
  await assert.rejects(variants([{ component: a, variant: { Size: "Small" } }], { name: "Other" }), /is already a variant of set "Button"/);
});

test("a binding means nothing outside flcm.component — every other verb refuses it by name", async () => {
  const figma = createFigmaMock();
  const bound = () => frame({ width: 10, height: 10 }, [text("Hi", { componentPropertyReferences: { text: "Label" } })]);
  await assert.rejects(render(bound()), /flcm\.render: `componentPropertyReferences`.*only means something inside flcm\.component/s);
  await render(frame({ key: "host", width: 100, height: 100 }));
  await assert.rejects(append("host", bound()), /flcm\.append: `componentPropertyReferences`.*only means something inside flcm\.component/s);
  // Under edit it isn't a word at all.
  await assert.rejects(edit("host", { componentPropertyReferences: { visible: "Icon" } } as never), /unknown prop "componentPropertyReferences" on flcm\.edit/);
  assert.equal(figma.currentPage.children.length, 1);
});

test("the binding bag is judged at construction: shape, and which fields THIS node can bind", () => {
  createFigmaMock();
  assert.throws(() => text("Hi", { componentPropertyReferences: { slot: "T" } }), /`slot` is not one of flcm\.text's binding fields \(visible, text\) — `slot` marks the FRAME that IS the slot/);
  assert.throws(() => frame({ componentPropertyReferences: { text: "Label" } }), /`text` is not one of flcm\.frame's binding fields \(visible, slot\) — `text` drives a TEXT node's content/);
  assert.throws(() => rect({ componentPropertyReferences: { visible: 3 } as never }), /a binding names the component property that drives this field/);
  assert.throws(() => rect({ componentPropertyReferences: "Icon" as never }), /must be an object naming which component property drives which field/);
  // Well-formed: inert, sealed, and the raw bag rides the node for the verb's prepare to resolve.
  const wn = rect({ componentPropertyReferences: { visible: "Icon" } });
  assert.deepEqual(wn.componentPropertyReferences, { visible: "Icon" });
  assert.ok(Object.isFrozen(wn));
});
