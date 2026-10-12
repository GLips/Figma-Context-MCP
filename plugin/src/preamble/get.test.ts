/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// flcm.get — full inspect through the ONE shared simplify core: the expanded canonical read shape
// (values inline, never a styles ref) for any node type. Parity of the shape itself is pinned by the
// REST↔scene harness (src/tests/parity/); these tests pin the live-path plumbing — resolve → adapt →
// simplify — over the figma mock, for the three node kinds the plan names (frame, text, instance).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { effects } from "./value-sugar.js";
import { id } from "./target.js";
import { get } from "./read.js";
import { render } from "./structure.js";

test("get on a frame returns the expanded canonical shape — values inline, children included", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    key: "card",
    width: 200,
    height: 100,
    fill: "#ff0000",
    layout: { mode: "row", gap: 8, padding: 12 },
    children: [{ type: "RECTANGLE", key: "chip", width: 40, height: 40, fill: "#00ff00" }],
  });

  const { node: read } = await get("card");
  assert.equal(read.type, "FRAME");
  // The live object, not a JSON round-trip: an unset layout word is ABSENT, not present-but-undefined,
  // because this exact object spreads into the compilers' closed-set gate.
  assert.deepEqual(read.layout, { mode: "row", padding: "12px", gap: "8px" });
  assert.deepEqual(read.fill, "#FF0000"); // the inline value — never a "fill_…" styles ref
  const chip = read.children?.[0];
  assert.equal(chip?.type, "RECTANGLE");
  assert.equal(chip?.width, 40);
  assert.deepEqual(chip?.fill, "#00FF00");
});

test("get on a text node reads back content and text style", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    key: "wrap",
    children: [
      { type: "TEXT", text: "Hello **world**", key: "greeting", textStyle: { fontSize: 16 } },
    ],
  });

  const { node: read } = await get("greeting");
  assert.equal(read.type, "TEXT");
  // The bold span reads back as markdown. The residual fontVariantName delta rides along because a
  // live segment always carries fontName.style ("Bold") and the adapter reports it faithfully —
  // whether real REST emits the same residual is on the plan's dogfood-verify list; a deliberate
  // change there updates this pin.
  assert.deepEqual(read.text, ["Hello ", ["**world**", { fontVariantName: "Bold" }]]);
  assert.ok(typeof read.textStyle === "object");
  assert.equal(read.textStyle.fontSize, 16);
  assert.equal(read.textStyle.fontFamily, "Inter");
  assert.equal(read.textStyle.fontWeight, 400);
});

// A component is named ONCE, in the envelope's `components` sidecar — its property definitions and its
// children live there, keyed by component id, which is the only place an off-tree definition could be
// named at all. This pins the plugin path end to end: the adapter reads the definitions off a live
// COMPONENT, the core lifts them into the sidecar `get` returns beside the node.
test("get on a component names it in the components sidecar, not on the node", async () => {
  const figma = createFigmaMock();
  const comp = figma.createComponent();
  comp.name = "Card";
  comp.componentPropertyDefinitions = {
    "Title#1:0": { type: "TEXT", defaultValue: "Product" },
    "Icon#1:1": { type: "INSTANCE_SWAP", defaultValue: "9:9", preferredValues: [] },
    "Content#1:2": { type: "SLOT", defaultValue: { guid: { sessionID: -1, localID: -1 } } },
  };
  figma.currentPage.appendChild(comp);

  const { node: read, components } = await get(id(comp.id));
  assert.equal(read.type, "COMPONENT");
  assert.deepEqual(components?.[comp.id], {
    type: "COMPONENT",
    name: "Card",
    propertyDefinitions: {
      Title: { type: "text" },
      Icon: { type: "instance_swap" },
      Content: { type: "slot" },
    },
  });
});

test("get on an instance carries an honest type and its componentId", async () => {
  const figma = createFigmaMock();
  const comp = figma.createComponent();
  comp.name = "Chip";
  figma.currentPage.appendChild(comp);
  const inst = comp.createInstance();

  const { node: read } = await get(id(inst.id));
  assert.equal(read.type, "INSTANCE");
  assert.equal(read.componentId, comp.id);
});

// Beyond-CSS effects round-trip: what flcm.effects({...}) authors reads back as the same object form
// (ADR-0002). This drives the whole plugin read path — the adapter's beyond-CSS decode + the core's
// object-form emission — over the live-ish mock, complementing the core unit pins in src/tests/effects.test.ts.
test("get reads beyond-CSS effects back as the flcm.effects object form", async () => {
  createFigmaMock();
  await render({
    type: "RECTANGLE",
    key: "pane",
    width: 100,
    height: 100,
    effects: effects({ glass: true, noise: true, texture: true, progressiveBlur: 24, progressiveBackgroundBlur: 30 }),
  });

  const { node: read } = await get("pane");
  const fx = read.effects;
  // Expanded read: effects is the inline object, never a "effect_…" styles ref (also narrows the type).
  if (typeof fx !== "object")
    throw new Error(`expected an inline effects object, got ${JSON.stringify(fx)}`);
  assert.deepEqual(fx.glass, {
    lightIntensity: 0.5,
    lightAngle: 130,
    refraction: 0.25,
    depth: 12,
    dispersion: 0.08,
    radius: 4,
  });
  assert.deepEqual(fx.noise, {
    type: "monotone",
    color: "rgba(0, 0, 0, 0.4)",
    noiseSize: 1,
    density: 0.2,
  });
  assert.deepEqual(fx.texture, { noiseSize: 3, radius: 6, clipToShape: true });
  assert.deepEqual(fx.progressiveBlur, {
    startRadius: 0,
    endRadius: 24,
    startOffset: { x: 0, y: 0 },
    endOffset: { x: 0, y: 1 },
  });
  // The two progressive kinds read back under their own words — a shared word re-authors one as the other.
  assert.deepEqual(fx.progressiveBackgroundBlur, {
    startRadius: 0,
    endRadius: 30,
    startOffset: { x: 0, y: 0 },
    endOffset: { x: 0, y: 1 },
  });
  // A progressive blur is not a plain CSS blur — it must not also surface as `filter`/`backdropFilter`.
  assert.equal(fx.filter, undefined);
  assert.equal(fx.backdropFilter, undefined);
});

// Figma stores effects bottom-first (live: the LAST of two offset shadows paints on top); the read
// speaks CSS, top-first. A get → copy must land the original storage order back.
test("get reads effects top-first and a copy restores Figma's storage order", async () => {
  const figma = createFigmaMock();
  const original = await render({ type: "FRAME", key: "src", width: 50, height: 50 });
  const shadow = (type: string, r: number) => ({
    type,
    color: { r, g: 0, b: 0, a: 1 },
    offset: { x: 0, y: 4 },
    radius: 8,
    spread: 0,
    visible: true,
    blendMode: "NORMAL",
  });
  const stored = [
    { type: "BACKGROUND_BLUR", radius: 32, visible: true },
    shadow("DROP_SHADOW", 1),
    shadow("INNER_SHADOW", 0),
    shadow("DROP_SHADOW", 0),
  ];
  (await figma.getNodeByIdAsync(original.id)).effects = stored;

  const { node: read } = await get("src");
  assert.deepEqual(read.effects, {
    boxShadow:
      "0px 4px 8px 0px rgba(0, 0, 0, 1), inset 0px 4px 8px 0px rgba(0, 0, 0, 1), 0px 4px 8px 0px rgba(255, 0, 0, 1)",
    backdropFilter: "blur(16px)",
  });

  const copy = await render({ type: "FRAME", width: 50, height: 50, effects: read.effects });
  const copied = (await figma.getNodeByIdAsync(copy.id)).effects;
  assert.deepEqual(
    copied.map((e: any) => [e.type, e.color?.r]),
    stored.map((e: any) => [e.type, e.color?.r]),
  );
});

test("get returns hidden targets with their visibility", async () => {
  const figma = createFigmaMock();
  const out = await render({ type: "FRAME", key: "ghost", width: 10, height: 10 });
  (await figma.getNodeByIdAsync(out.id)).visible = false;

  const { node } = await get("ghost");
  assert.equal(node.id, out.id);
  assert.equal(node.visible, false);
});

// A-7: a nested node must read the same whether targeted or reached through its parent.
test("get on a nested node keeps the sizing and position it has as a child; a page-level root stays contextual", async () => {
  createFigmaMock();
  const grid = { mode: "grid", gridTemplateColumns: "60px 60px", gridTemplateRows: "40px 40px" } as const;
  await render({
    type: "FRAME",
    key: "screen",
    width: 402,
    height: 800,
    children: [
      { type: "RECTANGLE", key: "scrim", width: 402, height: 94, left: 0, top: 120 },
      { type: "FRAME", key: "row", width: 300, height: 60, layout: { mode: "row" }, children: [{ type: "RECTANGLE", key: "grow", width: "fill", height: 20 }] },
      // Alone, the first cell would read as a packed grid; the sibling leaves cells empty, so
      // placement is explicit and only readable against it.
      { type: "FRAME", key: "grid", width: 120, height: 80, layout: grid, children: [
        { type: "RECTANGLE", key: "cell", width: 10, height: 10, layout: { gridColumn: "1", gridRow: "1" } },
        { type: "RECTANGLE", width: 10, height: 10, layout: { gridColumn: "2", gridRow: "2" } },
      ] },
    ],
  });
  const screen = (await get("screen")).node;
  const throughParent = (id: string) => {
    const find = (n: any): any => n.id === id ? n : n.children?.map(find).find(Boolean);
    return find(screen);
  };
  for (const key of ["scrim", "grow", "cell"]) {
    const { readOnlySource: _a, ...targeted } = (await get(key)).node as any;
    const { readOnlySource: _b, ...child } = throughParent(targeted.id);
    assert.deepEqual(targeted, child, key);
  }
  const scrim = (await get("scrim")).node;
  assert.deepEqual([scrim.width, scrim.left, scrim.top], [402, 0, 120]);
  assert.deepEqual((await get("cell")).node.layout, { gridColumn: "1", gridRow: "1" });
  assert.deepEqual([screen.width, screen.designedWidth], ["contextual", "402px"]);
  assert.equal(screen.left, undefined);
});
