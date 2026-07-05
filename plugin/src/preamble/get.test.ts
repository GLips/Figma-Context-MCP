// flcm.get — full inspect through the ONE shared simplify core: the expanded canonical read shape
// (values inline, never a styles ref) for any node type. Parity of the shape itself is pinned by the
// REST↔scene harness (src/tests/parity/); these tests pin the live-path plumbing — resolve → adapt →
// simplify — over the figma mock, for the three node kinds the plan names (frame, text, instance).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, text, rect, render, id, get } from "./flcm.js";

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

test("get on a hidden node fails loud instead of returning nothing", async () => {
  const figma = createFigmaMock();
  const out = await render(frame({ key: "ghost", width: 10, height: 10 }));
  figma.getNodeById(out.root.id).visible = false;

  await assert.rejects(get("ghost"), /hidden/);
});
