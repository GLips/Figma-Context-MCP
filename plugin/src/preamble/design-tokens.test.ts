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
  (globalThis as any).__flcmHost = { runCancellation: () => null, whenCancelled: () => new Promise(() => {}), isRunFinished: () => false };
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

  // Each name is the only one of its kind here, so a reference is the name alone.
  const brandRef = { variable: "color/brand" };
  assert.deepEqual(tokens.variables, [
    { reference: brandRef, collection: "Brand", type: "COLOR", values: { Light: "#2D4024", Dark: "rgba(255, 255, 255, 0.5)" } },
    // An alias reads as the reference it points at, so the token structure shows through.
    { reference: { variable: "color/action" }, collection: "Brand", type: "COLOR", values: { Light: brandRef, Dark: brandRef } },
    { reference: { variable: "space/md" }, collection: "Brand", type: "FLOAT", values: { Light: 12, Dark: 8 }, scopes: ["GAP", "WIDTH_HEIGHT"] },
  ]);
  assert.deepEqual(tokens.styles, [
    { reference: { style: "Surface" }, type: "PAINT", value: "#2D4024" },
    { reference: { style: "Shadow/Card" }, type: "EFFECT", value: { boxShadow: "0px 4px 8px 0px rgba(0, 0, 0, 0.25)" } },
    { reference: { style: "Heading/L" }, type: "TEXT", value: { fontFamily: "Inter", fontWeight: 700, fontSize: 32, fontVariantName: "Bold", lineHeight: "40px" } },
  ]);
  assert.deepEqual(tokens.used, { collections: [], styles: [] });

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

test("library tokens the file uses are counted and load on request; an enabled library loads by name; each binds", async () => {
  const figma = setup();
  const usedStyle = seedStyle({ type: "PAINT", name: "DS/Surface", remote: true, paints: [{ type: "SOLID", color: GREEN, opacity: 1, visible: true }] });
  seedStyle({ type: "PAINT", name: "DS/Unused", remote: true, paints: [{ type: "SOLID", color: GREEN, opacity: 1, visible: true }] });
  // A local style of the same name wins a name lookup, so the library one has to keep its id.
  seedStyle({ type: "PAINT", name: "DS/Surface", paints: [{ type: "SOLID", color: GREEN, opacity: 1, visible: true }] });
  const { "ds/accent": accent, "ds/gap": gap } = seedVariables({
    library: "Design System", collection: "DS Colors", variables: [
      { name: "ds/accent", type: "COLOR", values: { Default: { r: 1, g: 0, b: 0, a: 1 } } },
      { name: "ds/gap", type: "FLOAT", values: { Default: 8 } },
    ],
  });
  const { "locked/red": lockedRed } = seedVariables({ library: "Locked", collection: "Locked Colors", variables: [{ name: "locked/red", type: "COLOR", values: { Default: { r: 1, g: 0, b: 0, a: 1 } } }] });
  // A library the user can't open costs only its own variables, with a warning naming it.
  const listCollection = figma.teamLibrary.getVariablesInLibraryCollectionAsync;
  figma.teamLibrary.getVariablesInLibraryCollectionAsync = async (key: string) => {
    if ((await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()).find((c: any) => c.key === key).libraryName === "Locked") throw new Error("no access");
    return listCollection(key);
  };
  const before = warnings.records.length;
  await flcm.render({ type: "FRAME", fill: { variable: accent.id }, stroke: { variable: lockedRed.id } });
  // Used on a page that isn't current: the count reads the whole file.
  const other = figma.createPage();
  const rect = figma.createRectangle();
  other.appendChild(rect);
  await rect.setFillStyleIdAsync(usedStyle.id);

  const tokens = await flcm.designTokens();

  assert.deepEqual(tokens.variables, []);
  assert.deepEqual(tokens.styles.map((s) => s.reference), [{ style: "DS/Surface" }]);
  assert.deepEqual(tokens.used, {
    collections: [{ name: "DS Colors", library: "Design System", variables: 1 }, { name: "Locked Colors", variables: 1 }],
    styles: [{ type: "PAINT", styles: 1 }],
  });
  assert.deepEqual(tokens.libraries, [{ name: "Design System", collections: [{ name: "DS Colors", variables: 2 }] }]);
  assert.match(warnings.records.slice(before).map((r) => r.message).join("\n"), /could not be read and are left out: "Locked \/ Locked Colors"/);

  const used = await flcm.designTokens({ used: true });
  // A name reached only through what a page uses keeps its id: another page could use a different
  // token of that name. ds/accent is in an enabled library, so its name reaches it from any page.
  assert.deepEqual(used.variables.map((v) => v.reference), [{ variable: "ds/accent" }, { variable: { id: lockedRed.id, name: "locked/red" } }]);
  assert.deepEqual(used.variables[0], { reference: { variable: "ds/accent" }, collection: "DS Colors", library: "Design System", type: "COLOR", values: { Default: "#FF0000" }, remote: true });
  assert.deepEqual(used.styles.map((s) => s.reference), [{ style: { id: usedStyle.key, name: "DS/Surface" } }]);
  const swatch = await flcm.render({ type: "RECTANGLE", width: 10, height: 10, fill: used.styles[0].reference });
  assert.equal((await figma.getNodeByIdAsync(swatch.id)).fillStyleId, usedStyle.id);
  assert.deepEqual((await flcm.designTokens({ used: true, type: "PAINT" })).variables, []);
  await assert.rejects(flcm.designTokens({ used: true, collection: "Spacing" }), /collections it uses: "DS Colors"/);

  const floats = await flcm.designTokens({ library: "Design System", type: "FLOAT" });
  assert.deepEqual(floats.variables, [{ reference: { variable: "ds/gap" }, collection: "DS Colors", library: "Design System", type: "FLOAT", values: { Default: 8 }, remote: true }]);
  const row = await flcm.render({ type: "FRAME", layout: { mode: "row", gap: floats.variables[0].reference } });
  assert.equal((await figma.getNodeByIdAsync(row.id)).boundVariables.itemSpacing.id, gap.id);

  await assert.rejects(flcm.designTokens({ library: "Design Sys" }), /no enabled library with variables is named "Design Sys"\. Pass one of the enabled libraries: "Design System"\./);
  await assert.rejects(flcm.designTokens({ library: "Design System", collection: "Spacing" }), /has no collection named "Spacing"\. Pass one of its collections: "DS Colors"/);
});

