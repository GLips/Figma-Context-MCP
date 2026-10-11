/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// flcm.designTokens — what's worth pinning is that a listed token's reference pastes straight into a
// write, that values come out in the read's spellings, and how far the listing reaches past the file's
// own tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock, seedVariables, seedStyle } from "../../harness/figma-mock.mjs";
import { warnings } from "./warnings.js";
import * as flcm from "./runtime.js";

function setup() {
  const figma = createFigmaMock();
  (globalThis as any).__flcmHost = { registerRead: () => {}, isRunCancelled: () => false, isRunFinished: () => false };
  return figma;
}

const GREEN = { r: 0x2d / 255, g: 0x40 / 255, b: 0x24 / 255 };

test("local tokens list in the read's spellings, and a listed reference binds when written", async () => {
  const figma = setup();
  const { "color/brand": brand, "space/md": md } = seedVariables({
    collection: "Brand",
    modes: ["Light", "Dark"],
    variables: [
      { name: "color/brand", type: "COLOR", values: { Light: { ...GREEN, a: 1 }, Dark: { r: 1, g: 1, b: 1, a: 0.5 } } },
      { name: "color/action", type: "COLOR", values: { Light: { alias: "color/brand" } } },
      { name: "space/md", type: "FLOAT", values: { Light: 12.000000476837158, Dark: 8 }, scopes: ["GAP", "WIDTH_HEIGHT"] },
    ],
  });
  const paint = seedStyle({ type: "PAINT", name: "Surface", paints: [{ type: "SOLID", color: GREEN, opacity: 1, visible: true, blendMode: "NORMAL" }] });
  seedStyle({
    type: "EFFECT", name: "Shadow/Card",
    effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, blendMode: "NORMAL" }],
  });
  const heading = seedStyle({
    type: "TEXT", name: "Heading/L", fontName: { family: "Inter", style: "Bold" }, fontSize: 32,
    lineHeight: { unit: "PIXELS", value: 40 }, letterSpacing: { unit: "PIXELS", value: 0 }, paragraphSpacing: 0, paragraphIndent: 0,
    listSpacing: 0, textCase: "ORIGINAL", textDecoration: "NONE",
  });

  const tokens = await flcm.designTokens();

  const brandRef = { variable: { id: brand.id, name: "color/brand" } };
  assert.deepEqual(tokens.variables, [
    { reference: brandRef, collection: "Brand", type: "COLOR", values: { Light: "#2D4024", Dark: "rgba(255, 255, 255, 0.5)" } },
    // An alias reads as the reference it points at, so the token structure shows through.
    { reference: { variable: { id: tokens.variables[1].reference.variable.id, name: "color/action" } }, collection: "Brand", type: "COLOR", values: { Light: brandRef, Dark: brandRef } },
    { reference: { variable: { id: md.id, name: "space/md" } }, collection: "Brand", type: "FLOAT", values: { Light: 12, Dark: 8 }, scopes: ["GAP", "WIDTH_HEIGHT"] },
  ]);
  assert.deepEqual(tokens.styles, [
    { reference: { style: { id: paint.key, name: "Surface" } }, type: "PAINT", value: "#2D4024" },
    { reference: { style: { id: tokens.styles[1].reference.style.id, name: "Shadow/Card" } }, type: "EFFECT", value: { boxShadow: "0px 4px 8px 0px rgba(0, 0, 0, 0.25)" } },
    { reference: { style: { id: heading.key, name: "Heading/L" } }, type: "TEXT", value: { fontFamily: "Inter", fontWeight: 700, fontSize: 32, fontVariantName: "Bold", lineHeight: "40px" } },
  ]);

  const [brandToken] = tokens.variables;
  const surface = tokens.styles[0], headingToken = tokens.styles[2];
  const frame = await flcm.render({ type: "FRAME", fill: brandToken.reference, stroke: surface.reference, layout: { mode: "row", gap: tokens.variables[2].reference } });
  const text = await flcm.render({ type: "TEXT", text: "Hi", textStyle: headingToken.reference });
  const liveFrame = await figma.getNodeByIdAsync(frame.id);
  assert.equal(liveFrame.fills[0].boundVariables.color.id, brand.id);
  assert.equal(liveFrame.strokeStyleId, paint.id);
  assert.equal(liveFrame.boundVariables.itemSpacing.id, md.id);
  assert.equal((await figma.getNodeByIdAsync(text.id)).textStyleId, heading.id);
});

test("library tokens: the default call lists used library styles and catalogs libraries; a library loads by name and binds", async () => {
  const figma = setup();
  const usedStyle = seedStyle({ type: "PAINT", name: "DS/Surface", remote: true, paints: [{ type: "SOLID", color: GREEN, opacity: 1, visible: true }] });
  seedStyle({ type: "PAINT", name: "DS/Unused", remote: true, paints: [{ type: "SOLID", color: GREEN, opacity: 1, visible: true }] });
  const { "ds/accent": accent } = seedVariables({
    library: "Design System", collection: "DS Colors", variables: [
      { name: "ds/accent", type: "COLOR", values: { Default: { r: 1, g: 0, b: 0, a: 1 } } },
      { name: "ds/gap", type: "FLOAT", values: { Default: 8 } },
    ],
  });
  seedVariables({ library: "Locked", collection: "Locked Colors", variables: [{ name: "locked/red", type: "COLOR", values: { Default: { r: 1, g: 0, b: 0, a: 1 } } }] });
  // A library the user can't open costs only its own variables, with a warning naming it.
  const listCollection = figma.teamLibrary.getVariablesInLibraryCollectionAsync;
  figma.teamLibrary.getVariablesInLibraryCollectionAsync = async (key: string) => {
    if ((await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()).find((c: any) => c.key === key).libraryName === "Locked") throw new Error("no access");
    return listCollection(key);
  };
  const before = warnings.records.length;
  // Used on a page that isn't current: the listing reads the whole file.
  const other = figma.createPage();
  const rect = figma.createRectangle();
  other.appendChild(rect);
  await rect.setFillStyleIdAsync(usedStyle.id);

  const tokens = await flcm.designTokens();

  // Nothing in the file uses ds/accent, so the default call counts it instead of importing it.
  assert.deepEqual(tokens.variables, []);
  assert.deepEqual(tokens.styles.map((s) => [s.reference.style.name, s.remote]), [["DS/Surface", true]]);
  assert.deepEqual(tokens.libraries, [{ name: "Design System", collections: [{ name: "DS Colors", variables: 2 }] }]);
  assert.match(warnings.records.slice(before).map((r) => r.message).join("\n"), /could not be read and are left out: "Locked \/ Locked Colors"/);

  const colors = await flcm.designTokens({ library: "Design System", type: "COLOR" });
  assert.deepEqual(colors.variables, [
    { reference: { variable: { id: accent.id, name: "ds/accent" } }, collection: "DS Colors", type: "COLOR", values: { Default: "#FF0000" }, remote: true },
  ]);
  const frame = await flcm.render({ type: "FRAME", fill: colors.variables[0].reference });
  assert.equal((await figma.getNodeByIdAsync(frame.id)).fills[0].boundVariables.color.id, accent.id);

  await assert.rejects(flcm.designTokens({ library: "Design Sys" }), /no enabled library with variables is named "Design Sys"\. Enabled: "Design System", "Locked"/);
  await assert.rejects(flcm.designTokens({ library: "Design System", collection: "Spacing" }), /has no collection named "Spacing"\. Its collections: "DS Colors"/);
});

test("without the teamlibrary permission, the file's own tokens still list and a warning says what's missing", async () => {
  const figma = setup();
  seedVariables({ collection: "Brand", variables: [{ name: "color/brand", type: "COLOR", values: { Default: { ...GREEN, a: 1 } } }] });
  seedVariables({ library: "Design System", collection: "DS Colors", variables: [{ name: "ds/accent", type: "COLOR", values: { Default: { r: 1, g: 0, b: 0, a: 1 } } }] });
  // Live Figma's refusal on a plugin imported before the manifest granted the permission.
  Object.defineProperty(figma, "teamLibrary", { get() { throw new Error('in get_teamLibrary: "teamlibrary" permission not specified in manifest.json.'); } });
  const before = warnings.records.length;

  const tokens = await flcm.designTokens();

  assert.deepEqual(tokens.variables.map((v) => v.reference.variable.name), ["color/brand"]);
  assert.match(warnings.records.slice(before).map((r) => r.message).join("\n"), /lacks the teamlibrary permission\. Re-import the plugin/);
});
