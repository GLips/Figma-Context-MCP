import { specNode } from "../../harness/spec-node.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { id } from "./flcm.js";
import { render } from "./render.js";
import { edit } from "./edit.js";
import { append, prepend } from "./structure.js";
import { component } from "./component.js";
import { find, findOne, get, resolveTarget } from "./read.js";
import { recordPromotionAlias } from "./promotion-aliases.js";

test("aliases normalize compilers and edits without changing canonical output", async () => {
  const figma = createFigmaMock();
  const built = await render({
    type: "FRAME",
    clipsContent: true,
    clip: true,
    children: [{ type: "TEXT", text: "Copy", fontSize: 24, textStyle: { fontSize: 24 } }],
  });
  const node = await figma.getNodeByIdAsync(built.id);
  assert.equal(node.clipsContent, true);
  assert.equal(node.children[0].fontSize, 24);
  await edit(node.id, { clipsContent: false });
  await edit(node.children[0].id, { fontSize: 32 });
  assert.equal(node.clipsContent, false);
  assert.equal(node.children[0].fontSize, 32);
  await assert.rejects(
    render({ type: "FRAME", clip: false, clipsContent: true }),
    /conflicting clipsContent and clip/,
  );
  await assert.rejects(
    render({ type: "TEXT", text: "x", fontSize: 12, textStyle: { fontSize: 13 } }),
    /conflicting fontSize and textStyle.fontSize/,
  );
  await assert.rejects(edit(node.id, { fontSize: 12 }), /fontSize is not supported/);
});

test("regex searches preserve flags and caller lastIndex, strings remain literal", async () => {
  createFigmaMock();
  await render({
    type: "FRAME",
    children: [
      { type: "TEXT", text: "a", name: "Copy" },
      { type: "TEXT", text: "b", name: "copy" },
      { type: "RECTANGLE", name: "/Copy/" },
    ],
  });
  const pattern = /copy/gi;
  pattern.lastIndex = 2;
  assert.equal((await find({ name: pattern })).length, 3);
  assert.equal((await find({ name: pattern })).length, 3);
  assert.equal(pattern.lastIndex, 2);
  assert.equal((await find({ name: new RegExp("^Copy$", "y") })).length, 1);
  assert.equal((await find({ name: "/Copy/" })).length, 1);
  assert.equal((await find({ name: "" })).length, (await find()).length);
  assert.equal((await findOne({ name: /^Copy$/ })).name, "Copy");
  assert.equal((await find({ name: /copy/i }, (n) => n.type === "TEXT")).length, 2);
  await assert.rejects(find({ name: 12 as never }), /name must be a string.*RegExp/);
});

test("insertion inherits selected component layout; non-auto controls reject before writes", async () => {
  const figma = createFigmaMock();
  const comp = await component({
    type: "FRAME",
    layout: { mode: "row" },
    children: [{ type: "TEXT", text: "label" }],
  });
  const parent = await render({ type: "FRAME" });
  for (const insert of [append, prepend]) {
    const result = await insert(parent.id, {
      type: "INSTANCE",
      componentId: comp.id,
      layout: { gap: 9, padding: 4 },
    });
    const node = await figma.getNodeByIdAsync(result.id);
    assert.equal(node.itemSpacing, 9);
  }
  const plain = await component({ type: "FRAME" });
  const node = await figma.getNodeByIdAsync(parent.id);
  const count = node.children.length;
  await assert.rejects(
    append(parent.id, { type: "INSTANCE", componentId: plain.id, layout: { gap: 9 } }),
    /need an auto-layout/,
  );
  assert.equal(node.children.length, count);
});

test("baseline authors and edits rows and rejects columns before writes", async () => {
  const figma = createFigmaMock();
  const result = await render({
    type: "FRAME",
    layout: { mode: "row", alignItems: "baseline" },
    children: [
      { type: "TEXT", text: "small", fontSize: 12 },
      { type: "TEXT", text: "large", fontSize: 24 },
      { type: "RECTANGLE", width: 10, height: 10 },
    ],
  });
  const node = await figma.getNodeByIdAsync(result.id);
  assert.equal(node.counterAxisAlignItems, "BASELINE");
  assert.equal((await get(node.id)).node.layout?.alignItems, "baseline");
  await edit(node.id, { layout: { alignItems: "stretch" } });
  await edit(node.id, { layout: { alignItems: "baseline" } });
  assert.equal(node.counterAxisAlignItems, "BASELINE");
  await assert.rejects(
    edit(node.id, { layout: { mode: "column", alignItems: "baseline" } }),
    /baseline.*requires/,
  );
  assert.equal(node.layoutMode, "HORIZONTAL");
  await assert.rejects(
    render({ type: "FRAME", layout: { mode: "column", alignItems: "baseline" } }),
    /baseline.*requires/,
  );
});

test("promotion IDs resolve durable chains, prioritize live originals, and detect cycles", async () => {
  const figma = createFigmaMock();
  const built = await render({ type: "FRAME" });
  const promoted = await component(built.id);
  assert.equal((await get(id(built.id))).node.id, promoted.id);
  recordPromotionAlias("old", built.id);
  assert.equal((await resolveTarget(id("old"))).id, promoted.id);
  recordPromotionAlias(promoted.id, "missing");
  assert.equal((await resolveTarget(id(promoted.id))).id, promoted.id);
  recordPromotionAlias("cycle-a", "cycle-b");
  recordPromotionAlias("cycle-b", "cycle-a");
  await assert.rejects(resolveTarget(id("cycle-a")), /cycle/);
  recordPromotionAlias("missing-old", "missing-new");
  await assert.rejects(resolveTarget(id("missing-old")), /no live node/);
  assert.ok(figma.root.getPluginData("flcm/promotion-aliases"));
  const metadata = figma.root.getPluginData("flcm/promotion-aliases");
  const candidate = await render({ type: "FRAME" });
  const create = figma.createComponentFromNode;
  figma.createComponentFromNode = () => {
    throw new Error("promotion test failure");
  };
  await assert.rejects(component(candidate.id), /promotion test failure/);
  figma.createComponentFromNode = create;
  assert.equal(figma.root.getPluginData("flcm/promotion-aliases"), metadata);

  createFigmaMock();
  await assert.rejects(resolveTarget(id("old")), /no live node/);
});

test("selected variants and slot content inherit resolved auto layout", async () => {
  const figma = createFigmaMock();
  const { variants } = await import("./component.js");
  const row = await component({ type: "FRAME", layout: { mode: "row" } });
  const plain = await component({ type: "FRAME" });
  const set = await variants(
    [
      { component: row.id, variant: { Mode: "Row" } },
      { component: plain.id, variant: { Mode: "Plain" } },
    ],
    { name: "Modes" },
  );
  const changing = await render({
    type: "INSTANCE",
    componentId: set.id,
    componentProperties: { Mode: "Plain" },
  });
  await edit(changing.id, {
    componentProperties: { Mode: "Row" },
    layout: { alignItems: "baseline" },
  });
  assert.equal((await figma.getNodeByIdAsync(changing.id)).counterAxisAlignItems, "BASELINE");
  await assert.rejects(
    edit(changing.id, {
      componentProperties: { Mode: "Plain" },
      layout: { alignItems: "baseline" },
    }),
    /baseline.*requires/,
  );
  const holder = await component(
    {
      type: "FRAME",
      children: [{ type: "FRAME", key: "slot", componentPropertyReferences: { slot: "Body" } }],
    },
    { propertyDefinitions: { Body: { type: "slot" } } },
  );
  const content = () => ({
    type: "INSTANCE",
    componentId: set.id,
    componentProperties: { Mode: "Row" },
    layout: { gap: 8, alignItems: "baseline" },
  });
  const out = await render({
    type: "INSTANCE",
    componentId: holder.id,
    overrides: { [specNode(holder, "slot").id]: { children: [content()] } },
  });
  const live = await figma.getNodeByIdAsync(out.id);
  assert.equal(live.children[0].children[0].counterAxisAlignItems, "BASELINE");
  await edit(live.id, { overrides: { [specNode(holder, "slot").id]: { children: [content()] } } });
  assert.equal(live.children[0].children[0].itemSpacing, 8);
  const count = live.children[0].children.length;
  await assert.rejects(
    append(live.children[0].id, {
      type: "INSTANCE",
      componentId: set.id,
      componentProperties: { Mode: "Plain" },
      layout: { gap: 8 },
    }),
    /need an auto-layout/,
  );
  assert.equal(live.children[0].children.length, count);
});

test("shipped factory supports RegExp input and promotion aliases across separate evaluations", async () => {
  const figma = createFigmaMock();
  const { buildSandboxPreamble } = await import("./index.mjs");
  const { createContext, runInContext } = await import("node:vm");
  const preamble = await buildSandboxPreamble();
  const context = createContext({ figma, console });
  const install = () =>
    runInContext("var flcm = (" + preamble + "\n)({isRunCancelled: () => false});", context);
  install();
  await runInContext(
    '(async () => { var built = await flcm.render({type:"FRAME", name:"Copy"}); globalThis.oldId = built.id; globalThis.newId = (await flcm.component(oldId)).id; })()',
    context,
  );
  install();
  const result = await runInContext(
    '(async () => { const re = /copy/gi; re.lastIndex = 99; return [(await flcm.find({name:re})).length, (await flcm.find({name:new RegExp("copy", "i")})).length, re.lastIndex, (await flcm.get(flcm.id(oldId))).node.id === newId]; })()',
    context,
  );
  assert.deepEqual(Array.from(result), [1, 1, 99, true]);
});
