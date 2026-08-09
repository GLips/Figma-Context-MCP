// flcm.fromRead — the read↔write seam closed. These drive the WHOLE loop over the mock (author →
// render → get → fromRead → render) rather than hand-writing read specs, because the point of the verb
// is that what `get` actually emits re-authors: a hand-written fixture would pin what I believe the read
// shape is. Two concerns: a real subtree round-trips with its styling intact, and everything the read
// shape carries that flcm has no word for fails LOUD by name instead of vanishing from the copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, text, rect, render, get, id, effects } from "./flcm.js";
import { append } from "./structure.js";
import { fromRead } from "./normalize-read.js";
import type { SimplifiedNode } from "~/core/index.js";

// The read shape is agent-facing data; a test spec is a partial of it, so the casts here stand in for
// the fields a real `get` would also carry.
const spec = (o: object): SimplifiedNode => o as SimplifiedNode;

test("a read subtree round-trips: get → fromRead → render reproduces styling, layout and children", async () => {
  createFigmaMock();
  await render(
    frame({ key: "card", width: 200, height: 120, fill: "#FF0000", borderRadius: 8, layout: { mode: "row", gap: 8, padding: { x: 16, y: 12 } } }, [
      rect({ width: 40, height: 40, fill: "#00FF00" }),
      text("Hello **world**", { textStyle: { fontSize: 18, textTransform: "uppercase" } }),
    ]),
  );
  const read = await get("card");

  const out = await render(fromRead(read));
  const copy = await figma.getNodeByIdAsync(out.root.id);
  // The read root's size is "contextual" (a top-level node's FIXED is an artifact) with the real number
  // parked in designedWidth — the rebuild has to land on the size that was READ, or a paste is a resize.
  assert.equal(copy.width, 200);
  assert.equal(copy.height, 120);
  assert.deepEqual(copy.fills[0].color, { r: 1, g: 0, b: 0 });
  assert.equal(copy.cornerRadius, 8);
  assert.equal(copy.layoutMode, "HORIZONTAL");
  assert.equal(copy.itemSpacing, 8);
  assert.deepEqual([copy.paddingTop, copy.paddingRight], [12, 16]); // the CSS shorthand decoded back to edges
  assert.equal(copy.children.length, 2);
  assert.equal(copy.children[0].type, "RECTANGLE");
  const copiedText = copy.children[1];
  assert.equal(copiedText.type, "TEXT");
  assert.equal(copiedText.characters, "Hello world");
  assert.equal(copiedText.fontSize, 18);
  assert.equal(copiedText.textCase, "UPPER");
  // The copy is a NEW node, and key-free by construction (the read shape carries no flcm/key).
  assert.notEqual(copy.id, read.id);
});

test("append takes a fromRead spec as a COPY, and still refuses the bare read spec", async () => {
  createFigmaMock();
  await render(frame({ key: "src", width: 60, height: 60, fill: "#0000FF" }));
  const dest = await render(frame({ key: "dest", width: 300, height: 300 }));
  const read = await get("src");

  const placed = await append("dest", fromRead(read));
  const destNode = await figma.getNodeByIdAsync(dest.root.id);
  assert.equal(destNode.children.length, 1);
  // A COPY, not a move: the node that was read is still where it was.
  const original = await figma.getNodeByIdAsync(read.id);
  assert.notEqual(original.parent.id, destNode.id);
  assert.equal("root" in placed, true);

  // The bare spec stays refused — and the refusal now names the verb that makes the intent explicit.
  await assert.rejects(append("dest", read as never), /flcm\.fromRead\(spec\)/);
});

test("a spread-and-modified read spec is the paste-with-modifications path", async () => {
  createFigmaMock();
  await render(frame({ key: "src", width: 100, height: 50, fill: "#123456" }));
  const read = await get("src");

  const out = await render(fromRead(spec({ ...read, width: 320, name: "Wide copy" })));
  const copy = await figma.getNodeByIdAsync(out.root.id);
  assert.equal(copy.width, 320);
  assert.equal(copy.name, "Wide copy");
  // Read the copy back through the same pipeline: the paint survived the rebuild unchanged.
  assert.deepEqual((await get(id(out.root.id))).fills, ["#123456"]);
});

test("a type with no authored form fails loud by name, pointing at flcm.clone", async () => {
  const figmaMock = createFigmaMock();
  const comp = figmaMock.createComponent();
  comp.name = "Chip";
  figmaMock.currentPage.appendChild(comp);
  const instance = comp.createInstance();
  const read = await get(id(instance.id));

  assert.throws(() => fromRead(read), /INSTANCE nodes have no authored form .* flcm\.clone\(target, parent\)/s);
  // The flattened vector form has no path data to rebuild from — same disposition, its own reason.
  assert.throws(() => fromRead(spec({ type: "IMAGE-SVG" })), /IMAGE-SVG .* no path data or markup/s);
  assert.throws(() => fromRead(spec({ type: "GROUP" })), /GROUP nodes have no authored form/);
});

test("real state flcm can't author fails by name; derived fields drop silently", async () => {
  createFigmaMock();
  // Refused: each carries state a rebuilt node would silently not have.
  assert.throws(() => fromRead(spec({ type: "RECTANGLE", strokeAlign: "outside" })), /`strokeAlign` has no authored form/);
  assert.throws(() => fromRead(spec({ type: "RECTANGLE", strokeDashes: [4, 4] })), /`strokeDashes` has no authored form/);
  assert.throws(() => fromRead(spec({ type: "FRAME", componentId: "1:2" })), /`componentId` has no authored form/);
  // A compressed read is a different mistake from a malformed value, so it gets its own message.
  assert.throws(() => fromRead(spec({ type: "RECTANGLE", fills: "fill_a1b2c3d4" })), /styles-table REFERENCE .* COMPRESSED read/s);
  assert.throws(() => fromRead(spec({ type: "FRAME", template: "EL-abcd1234" })), /COMPRESSED read/);
  // A word that IS in the read shape but not on this node's type names the type, not "unknown prop".
  assert.throws(() => fromRead(spec({ type: "TEXT", effects: { boxShadow: "0 1px 2px #000" } })), /this TEXT carries `effects`/);
  // Derived: boldWeight is the weight `**` stands for, already implied by the runs it annotates.
  assert.doesNotThrow(() => fromRead(spec({ type: "TEXT", text: "hi", boldWeight: 700 })));
  // A genuinely unknown field still throws — tolerating the derived leaves didn't open the set.
  assert.throws(() => fromRead(spec({ type: "RECTANGLE", fillz: ["#FFF"] })), /unknown read field `fillz`/);
});

test("layout words flcm has no vocabulary for fail loud; a grid names itself", async () => {
  createFigmaMock();
  assert.throws(
    () => fromRead(spec({ type: "FRAME", layout: { mode: "grid", gridTemplateColumns: "1fr 1fr" } })),
    /gridTemplateColumns has no authored form/,
  );
  assert.throws(() => fromRead(spec({ type: "FRAME", layout: { mode: "grid" } })), /cannot author a GRID container/);
  assert.throws(() => fromRead(spec({ type: "FRAME", layout: { mode: "row", wrap: true } })), /layout\.wrap has no authored form/);
  // flcm has one gap and one radius — the multi-value CSS forms are state, not something to average.
  assert.throws(() => fromRead(spec({ type: "FRAME", layout: { mode: "row", gap: "8px 12px" } })), /flcm authors one gap/);
  assert.throws(() => fromRead(spec({ type: "RECTANGLE", borderRadius: "8px 8px 0px 0px" })), /one uniform corner radius/);
});

test("beyond-CSS and CSS effects arrive in ONE read bag, and both halves land", async () => {
  createFigmaMock();
  await render(rect({ key: "pane", width: 80, height: 80, effects: effects({ shadow: { y: 4, blur: 8 }, glass: true }) }));
  const read = await get("pane");
  // The read value carries both vocabularies at once — the shape a "which kind is this?" router rejects.
  const fx = read.effects as Record<string, unknown>;
  assert.ok(fx.boxShadow && fx.glass);

  const out = await render(fromRead(read));
  const copy = await figma.getNodeByIdAsync(out.root.id);
  assert.deepEqual(
    copy.effects.map((e: { type: string }) => e.type).sort(),
    ["DROP_SHADOW", "GLASS"],
  );
});
