// flcm.get — full inspect through the ONE shared simplify core: the expanded canonical read shape
// (values inline, never a styles ref) for any node type. Parity of the shape itself is pinned by the
// REST↔scene harness (src/tests/parity/); these tests pin the live-path plumbing — resolve → adapt →
// simplify — over the figma mock, for the three node kinds the plan names (frame, text, instance).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, text, rect, render, id, get, effects } from "./flcm.js";

test("get on a frame returns the expanded canonical shape — values inline, children included", async () => {
  createFigmaMock();
  await render(
    frame(
      { key: "card", width: 200, height: 100, fill: "#ff0000", layout: { mode: "row", gap: 8, padding: 12 } },
      [rect({ key: "chip", width: 40, height: 40, fill: "#00ff00" })],
    ),
  );

  const spec = await get("card");
  assert.equal(spec.type, "FRAME");
  // JSON round-trip: the core leaves unset layout fields as present-but-undefined keys, which the
  // egress serialization drops — compare the shape an agent's returned value actually carries.
  assert.deepEqual(JSON.parse(JSON.stringify(spec.layout)), { mode: "row", padding: "12px", gap: "8px" });
  assert.deepEqual(spec.fills, ["#FF0000"]); // the inline value — never a "fill_…" styles ref
  const chip = spec.children?.[0];
  assert.equal(chip?.type, "RECTANGLE");
  assert.equal(chip?.width, 40);
  assert.deepEqual(chip?.fills, ["#00FF00"]);
});

test("get on a text node reads back content and text style", async () => {
  createFigmaMock();
  await render(
    frame({ key: "wrap" }, [text("Hello **world**", { key: "greeting", textStyle: { fontSize: 16 } })]),
  );

  const spec = await get("greeting");
  assert.equal(spec.type, "TEXT");
  // The bold span reads back as markdown. The residual fontVariantName delta rides along because a
  // live segment always carries fontName.style ("Bold") and the adapter reports it faithfully —
  // whether real REST emits the same residual is on the plan's dogfood-verify list; a deliberate
  // change there updates this pin.
  assert.deepEqual(spec.text, ["Hello ", ["**world**", { fontVariantName: "Bold" }]]);
  assert.ok(typeof spec.textStyle === "object");
  assert.equal(spec.textStyle.fontSize, 16);
  assert.equal(spec.textStyle.fontFamily, "Inter");
  assert.equal(spec.textStyle.fontWeight, 400);
});

test("get on an instance carries an honest type and its componentId", async () => {
  const figma = createFigmaMock();
  const comp = figma.createComponent();
  comp.name = "Chip";
  figma.currentPage.appendChild(comp);
  const inst = comp.createInstance();

  const spec = await get(id(inst.id));
  assert.equal(spec.type, "INSTANCE");
  assert.equal(spec.componentId, comp.id);
});

// Beyond-CSS effects round-trip: what flcm.effects({...}) authors reads back as the same object form
// (ADR-0002). This drives the whole plugin read path — the adapter's beyond-CSS decode + the core's
// object-form emission — over the live-ish mock, complementing the core unit pins in src/tests/effects.test.ts.
test("get reads beyond-CSS effects back as the flcm.effects object form", async () => {
  createFigmaMock();
  await render(
    rect({
      key: "pane",
      width: 100,
      height: 100,
      effects: effects({ glass: true, noise: true, texture: true, progressiveBlur: 24 }),
    }),
  );

  const spec = await get("pane");
  const fx = spec.effects;
  // Expanded read: effects is the inline object, never a "effect_…" styles ref (also narrows the type).
  if (typeof fx !== "object") throw new Error(`expected an inline effects object, got ${JSON.stringify(fx)}`);
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
  // A progressive blur is not a plain CSS blur — it must not also surface as `filter`.
  assert.equal(fx.filter, undefined);
});

test("get on a hidden node fails loud instead of returning nothing", async () => {
  const figma = createFigmaMock();
  const out = await render(frame({ key: "ghost", width: 10, height: 10 }));
  (await figma.getNodeByIdAsync(out.root.id)).visible = false;

  await assert.rejects(get("ghost"), /hidden/);
});
