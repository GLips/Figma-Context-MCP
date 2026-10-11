/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock, seedVariables, seedStyle } from "../../harness/figma-mock.mjs";
import * as flcm from "./runtime.js";

function setup() {
  const figma = createFigmaMock();
  (globalThis as any).__flcmHost = { registerRead: () => {}, isRunCancelled: () => false, isRunFinished: () => false };
  return figma;
}

const BRAND_RED = { r: 1, g: 0, b: 0 };

test("fill and padding bind by name and by id", async () => {
  const figma = setup();
  const { "color/primary": primary, "space/md": md } = seedVariables({
    collection: "Brand",
    variables: [
      { name: "color/primary", type: "COLOR", values: { Default: { ...BRAND_RED, a: 1 } } },
      { name: "space/md", type: "FLOAT", values: { Default: 12 } },
    ],
  });
  const handle = await flcm.render({
    type: "FRAME",
    fill: { variable: "color/primary" },
    layout: { mode: "row", padding: { top: { variable: { id: md.id } }, right: 4, bottom: 4, left: { variable: "space/md" } } },
  });
  const node = await figma.getNodeByIdAsync(handle.id);
  assert.equal(node.fills[0].boundVariables.color.id, primary.id);
  assert.deepEqual(node.fills[0].color, BRAND_RED);
  assert.equal(node.boundVariables.paddingTop.id, md.id);
  assert.equal(node.boundVariables.paddingLeft.id, md.id);
  assert.equal(node.paddingTop, 12);
  assert.equal(node.paddingRight, 4);
  assert.equal(node.boundVariables.paddingRight, undefined);
});

test("an unknown or ambiguous name lists candidates and writes nothing", async () => {
  const figma = setup();
  const light = seedVariables({ collection: "Light", variables: [{ name: "color/primary", type: "COLOR", values: { Default: { r: 0, g: 0, b: 0, a: 1 } } }] });
  const dark = seedVariables({ collection: "Dark", variables: [{ name: "color/primary", type: "COLOR", values: { Default: { r: 1, g: 1, b: 1, a: 1 } } }] });
  const before = figma.currentPage.children.length;

  await assert.rejects(flcm.render({ type: "FRAME", fill: { variable: "color/primary" } }), (err: Error) => {
    assert.match(err.message, /2 COLOR variables are named "color\/primary"/);
    assert.ok(err.message.includes('collection "Light", id ' + light["color/primary"].id));
    assert.ok(err.message.includes('collection "Dark", id ' + dark["color/primary"].id));
    return true;
  });
  await assert.rejects(flcm.render({ type: "FRAME", fill: { variable: "color/primery" } }), /no COLOR variable is named "color\/primery".*Nearest: "color\/primary"/);

  assert.equal(figma.currentPage.children.length, before);
  assert.deepEqual(figma.undoLog, []);
});

test("a style link lands after apply, and a failing one rolls the verb back", async () => {
  const figma = setup();
  const paint = seedStyle({ type: "PAINT", name: "Brand/Primary", paints: [{ type: "SOLID", color: BRAND_RED, opacity: 1 }] });
  const heading = seedStyle({
    type: "TEXT", name: "Heading/L", fontName: { family: "Inter", style: "Bold" }, fontSize: 32,
    lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 }, paragraphSpacing: 0, paragraphIndent: 0,
    listSpacing: 0, textCase: "ORIGINAL", textDecoration: "NONE",
  });
  const text = await flcm.render({ type: "TEXT", text: "Hi", fill: { style: "Brand/Primary" }, textStyle: { style: heading.id, textAlign: "center" } });
  const live = await figma.getNodeByIdAsync(text.id);
  assert.equal(live.fillStyleId, paint.id);
  assert.equal(live.textStyleId, heading.id);
  assert.equal(live.fontSize, 32);
  assert.equal(live.textAlignHorizontal, "CENTER");

  await assert.rejects(
    flcm.render({ type: "TEXT", text: "Hi", textStyle: { style: "Heading/L", fontSize: 12 } }),
    /a text style sets fontSize itself/,
  );

  // createComponentFromNode replaces the root frame; its queued link must follow to the component.
  const component = await flcm.component({ type: "FRAME", width: 10, height: 10, fill: { style: "Brand/Primary" } });
  assert.equal((await figma.getNodeByIdAsync(component.id)).fillStyleId, paint.id);

  const proto = Object.getPrototypeOf(live);
  const setFillStyleIdAsync = proto.setFillStyleIdAsync;
  proto.setFillStyleIdAsync = async () => { throw new Error("style link refused"); };
  try {
    figma.undoLog.length = 0;
    await assert.rejects(flcm.render({ type: "FRAME", fill: { style: "Brand/Primary" } }), /style link refused/);
    assert.deepEqual(figma.undoLog.slice(-2), ["commit", "trigger"]);
  } finally {
    proto.setFillStyleIdAsync = setFillStyleIdAsync;
  }
});

test("a read written back unchanged keeps its bindings", async () => {
  const figma = setup();
  const { "color/primary": primary, "space/md": md } = seedVariables({
    variables: [
      { name: "color/primary", type: "COLOR", values: { Default: { ...BRAND_RED, a: 1 } } },
      { name: "space/md", type: "FLOAT", values: { Default: 12 } },
    ],
  });
  // A second color/primary makes that name ambiguous, so the read has to keep the bound one's id.
  seedVariables({ collection: "Alt", variables: [{ name: "color/primary", type: "COLOR", values: { Default: { r: 0, g: 0, b: 1, a: 1 } } }] });
  const brand = seedStyle({ type: "PAINT", name: "Brand/Primary", paints: [{ type: "SOLID", color: BRAND_RED, opacity: 1 }] });
  const heading = seedStyle({
    type: "TEXT", name: "Heading/L", fontName: { family: "Inter", style: "Bold" }, fontSize: 32,
    lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 }, paragraphSpacing: 0, paragraphIndent: 0,
    listSpacing: 0, textCase: "ORIGINAL", textDecoration: "NONE",
  });
  const parent = await flcm.render({
    type: "FRAME", width: { variable: "space/md" }, height: 100,
    children: [
      { type: "FRAME", key: "chip", width: 40, height: 40, fill: { variable: primary.id }, layout: { mode: "row", padding: { variable: "space/md" } } },
      { type: "RECTANGLE", key: "swatch", width: 10, height: 10, fill: { style: "Brand/Primary" } },
      { type: "TEXT", key: "title", text: "Hi", textStyle: { style: "Heading/L", textAlign: "center" } },
    ],
  });
  const { node } = await flcm.get(parent);
  // A token is named alone when its name binds it, else by id too; every reference carries its
  // literal, which the write ignores.
  const [chipRead, swatchRead, titleRead] = (node as any).children;
  assert.deepEqual(chipRead.fill, { variable: { id: primary.id, name: "color/primary" }, value: "#FF0000" });
  assert.deepEqual(chipRead.layout.padding, { variable: "space/md", value: 12 });
  assert.deepEqual(swatchRead.fill, { style: "Brand/Primary", value: "#FF0000" });
  assert.equal(titleRead.textStyle.style, "Heading/L");
  assert.deepEqual(titleRead.textStyle.value, { fontFamily: "Inter", fontWeight: 700, fontSize: 32, fontVariantName: "Bold" });
  await flcm.render(node);
  const root = await figma.getNodeByIdAsync(parent.id);
  const [chip, swatch, title] = root.children;
  assert.equal(root.boundVariables.width.id, md.id);
  assert.equal(chip.fills[0].boundVariables.color.id, primary.id);
  assert.equal(chip.boundVariables.paddingTop.id, md.id);
  assert.equal(swatch.fillStyleId, brand.id);
  assert.equal(title.textStyleId, heading.id);
  assert.equal(title.textAlignHorizontal, "CENTER");

  await assert.rejects(
    flcm.render({ type: "TEXT", text: "Hi", textStyle: { value: { fontSize: 32 } } }),
    /`value` is what a read's text `style` resolves to/,
  );
});

test("an edit to a literal drops the binding it replaces, uniform words included", async () => {
  const figma = setup();
  seedVariables({
    variables: [
      { name: "t", type: "FLOAT", values: { Default: 2 } },
      { name: "font/size", type: "FLOAT", values: { Default: 18 } },
    ],
  });
  const t = { variable: "t" };
  const frame = await flcm.render({
    type: "FRAME", width: 40, height: 40, stroke: "#000000",
    borderRadius: { topLeft: t, topRight: 2, bottomRight: 2, bottomLeft: 2 },
    strokeWidth: { top: t, right: 1, bottom: 1, left: 1 },
  });
  const text = await flcm.render({ type: "TEXT", text: ["Hi ", ["there", { fontSize: { variable: "font/size" } }]] });
  await flcm.edit(frame, { borderRadius: 3, strokeWidth: 1 });
  await flcm.edit(text, { text: ["Hi ", ["there", { fontSize: 18 }]] });

  const liveFrame = await figma.getNodeByIdAsync(frame.id);
  assert.equal(liveFrame.boundVariables.topLeftRadius, undefined);
  assert.equal(liveFrame.boundVariables.strokeTopWeight, undefined);
  const { node } = await flcm.get(text);
  assert.deepEqual((node as any).text, ["Hi ", ["there", { fontSize: 18 }]]);
});

test("an unbound run at its bound neighbour's value reads unbound", async () => {
  setup();
  seedVariables({ variables: [{ name: "font/size", type: "FLOAT", values: { Default: 16 } }] });
  const text = await flcm.render({ type: "TEXT", text: [["Hello ", { fontSize: { variable: "font/size" } }], ["world", { fontSize: 16 }]] });
  const { node } = await flcm.get(text);
  assert.deepEqual((node as any).text, ["Hello ", ["world", { fontSize: 16 }]]);
});
