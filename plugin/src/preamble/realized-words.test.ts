/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// A verb's authored words are verified once its last write has landed, the awaited style link
// included: a word something else undid in that wait rolls the whole call back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock, seedStyle } from "../../harness/figma-mock.mjs";
import * as flcm from "./runtime.js";

function setup() {
  const figma = createFigmaMock();
  (globalThis as any).__flcmHost = { runCancellation: () => null, whenCancelled: () => new Promise(() => {}), isRunFinished: () => false };
  seedStyle({ type: "PAINT", name: "Brand/Primary", paints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1 }] });
  return figma;
}

// The link lands as asked, and a write landing in its await (a human's, say) undoes the opacity.
function undoOpacityDuringStyleLink(node: any): () => void {
  const proto = Object.getPrototypeOf(node);
  const link = proto.setFillStyleIdAsync;
  proto.setFillStyleIdAsync = async function (this: any, id: string) {
    await link.call(this, id);
    this.opacity = 0.2;
  };
  return () => { proto.setFillStyleIdAsync = link; };
}

const UNREALIZED_OPACITY = /didn't realize 1 of its words, so it rolled back.*opacity: asked 0\.5, ended 0\.2/s;

test("edit: an authored word undone during the style link rolls the call back, earlier calls kept", async () => {
  const figma = setup();
  const other = await flcm.render({ type: "FRAME", width: 10, height: 10 });
  const target = await flcm.render({ type: "FRAME", width: 10, height: 10 });
  await flcm.edit(other.id, { name: "Kept" });
  const restore = undoOpacityDuringStyleLink(await figma.getNodeByIdAsync(target.id));
  try {
    figma.undoLog.length = 0;
    let handle: unknown;
    await assert.rejects(async () => { handle = await flcm.edit(target.id, { fill: { style: "Brand/Primary" }, opacity: 0.5 }); }, UNREALIZED_OPACITY);
    assert.equal(handle, undefined);
    assert.deepEqual(figma.undoLog, ["commit", "commit", "trigger"]);
    assert.equal((await figma.getNodeByIdAsync(other.id)).name, "Kept");
  } finally {
    restore();
  }
});

test("clone: the copy's authored words are verified on the copy", async () => {
  const figma = setup();
  const source = await flcm.render({ type: "FRAME", width: 10, height: 10 });
  const restore = undoOpacityDuringStyleLink(await figma.getNodeByIdAsync(source.id));
  try {
    figma.undoLog.length = 0;
    await assert.rejects(flcm.clone(source.id, { fill: { style: "Brand/Primary" }, opacity: 0.5 }), UNREALIZED_OPACITY);
    // The mock's triggerUndo reverts nothing, so the rollback shows as the pop of this call's step.
    assert.deepEqual(figma.undoLog, ["commit", "commit", "trigger"]);
  } finally {
    restore();
  }
});

// ---- geometry and inheritance one call reaches: each word lands as asked in either batch order ----

const live = (figma: any, handle: { id?: string }) => figma.getNodeByIdAsync(handle.id!) as Promise<any>;
const named = (root: any, name: string) => root.findOne((n: any) => n.name === name);
const bothOrders = <T>(entries: readonly T[]): T[][] => [[...entries], [...entries].reverse()];

// A free Card holding a right-pinned and a stretched child; `under` nests it in a grandparent it stretches with.
async function constrainedCard(figma: any, under: boolean) {
  const card = {
    type: "FRAME", name: "Card", width: 320, height: 200, ...(under ? { left: 0, constraints: { x: "stretch" } } : {}),
    children: [
      { type: "RECTANGLE", name: "Pinned", left: 280, top: 0, width: 20, height: 20, constraints: { x: "right" } },
      { type: "RECTANGLE", name: "Wide", left: 10, top: 40, width: 300, height: 20, constraints: { x: "stretch" } },
    ],
  };
  const root = await live(figma, await flcm.render((under ? { type: "FRAME", name: "Grand", width: 640, height: 400, children: [card] } : card) as never));
  return { root, card: under ? named(root, "Card") : root, pinned: named(root, "Pinned"), wide: named(root, "Wide") };
}

test("an ancestor resize and its descendants' requested geometry land as asked, in either batch order", async () => {
  for (const under of [false, true]) {
    for (const order of [0, 1]) {
      const figma = setup();
      const { root, card, pinned, wide } = await constrainedCard(figma, under);
      const entries = [{ id: root.id, width: under ? 800 : 400 }, { id: pinned.id, left: 280 }, { id: wide.id, width: 300 }];
      figma.undoLog.length = 0;
      await flcm.editMany(bothOrders(entries)[order] as never);
      assert.equal(root.width, under ? 800 : 400);
      if (under) assert.equal(card.width, 480);
      assert.equal(pinned.x, 280);
      assert.equal(wide.width, 300);
      assert.deepEqual(figma.undoLog, ["commit", "commit"]);
    }
  }
  // A hugging row grown by one entry's child moves its right-pinned absolute child, which another entry places.
  for (const entries of bothOrders(["Grow", "Mark"])) {
    const figma = setup();
    const row = await live(figma, await flcm.render({
      type: "FRAME", name: "Row", layout: { mode: "row" },
      children: [
        { type: "RECTANGLE", name: "Grow", width: 100, height: 20 },
        { type: "RECTANGLE", name: "Mark", position: "absolute", left: 80, top: 0, width: 10, height: 10, constraints: { x: "right" } },
      ],
    } as never));
    const words: Record<string, object> = { Grow: { width: 200 }, Mark: { left: 80 } };
    await flcm.editMany(entries.map((name) => ({ id: named(row, name).id, ...words[name] })) as never);
    assert.equal(row.width, 200);
    assert.equal(named(row, "Mark").x, 80);
  }
});

test("a size one entry changes moves another axis through a wrapping row or an aspect lock, in either batch order", async () => {
  // A wider first tile pushes the second onto a new line, and the hugging row grows the bottom-pinned mark down.
  for (const order of [0, 1]) {
    const figma = setup();
    const row = await live(figma, await flcm.render({
      type: "FRAME", name: "Row", width: 200, layout: { mode: "row", wrap: true },
      children: [
        { type: "RECTANGLE", name: "A", width: 100, height: 20 },
        { type: "RECTANGLE", name: "B", width: 100, height: 20 },
        { type: "RECTANGLE", name: "Mark", position: "absolute", left: 0, top: 10, width: 10, height: 10, constraints: { y: "bottom" } },
      ],
    } as never));
    const mark = named(row, "Mark");
    await flcm.editMany(bothOrders([{ id: named(row, "A").id, width: 150 }, { id: mark.id, top: 10 }])[order] as never);
    assert.equal(row.height, 40);
    assert.equal(mark.y, 10);
  }
  // A wider Card stretches its locked Img, which grows taller and moves its bottom-pinned Dot down.
  for (const order of [0, 1]) {
    const figma = setup();
    const card = await live(figma, await flcm.render({
      type: "FRAME", name: "Card", width: 320, height: 400,
      children: [{
        type: "FRAME", name: "Img", left: 10, top: 10, width: 300, height: 150, aspectRatio: 2, constraints: { x: "stretch" },
        children: [{ type: "RECTANGLE", name: "Dot", left: 0, top: 140, width: 10, height: 10, constraints: { y: "bottom" } }],
      }],
    } as never));
    const dot = named(card, "Dot");
    await flcm.editMany(bothOrders([{ id: card.id, width: 420 }, { id: dot.id, top: 100 }])[order] as never);
    assert.equal(named(card, "Img").height, 200);
    assert.equal(dot.y, 100);
  }
});

test("percent and aspect sizing settle before the geometry that depends on them", async () => {
  for (const order of [0, 1]) {
    const figma = setup();
    const grand = await live(figma, await flcm.render({
      type: "FRAME", name: "Grand", width: 640, height: 400,
      children: [{
        type: "FRAME", name: "Card", left: 0, top: 0, width: 320, height: 160, aspectRatio: 2,
        children: [{ type: "RECTANGLE", name: "Wide", left: 10, top: 10, width: 300, height: 20, constraints: { x: "stretch" } }],
      }],
    } as never));
    const card = named(grand, "Card");
    const wide = named(grand, "Wide");
    // The ratio already holds when the call starts; the percent width breaks it mid-call, and it is still owed.
    const entries = [{ id: card.id, width: "62.5%", aspectRatio: 2 }, { id: wide.id, width: 280 }];
    await flcm.editMany(bothOrders(entries)[order] as never);
    assert.equal(card.width, 400);
    assert.equal(card.height, 200);
    assert.deepEqual(card.targetAspectRatio, { x: 400, y: 200 });
    assert.equal(wide.width, 280);
  }
});

// A main component's Box and the same layer in an instance of it.
async function inheritedBox(figma: any) {
  const main = await live(figma, await flcm.component({
    type: "FRAME", name: "Tile", width: 100, height: 100,
    children: [{ type: "RECTANGLE", name: "Box", left: 10, top: 10, width: 40, height: 40, fill: "#0000ff" }],
  } as never));
  const inst = await live(figma, await flcm.render({ type: "INSTANCE", componentId: main.id, left: 300 } as never));
  return { mainBox: named(main, "Box"), instanceBox: named(inst, "Box") };
}

test("a definition edit and an instance restating its old value both land, in either order", async () => {
  for (const order of [0, 1]) {
    const figma = setup();
    const { mainBox, instanceBox } = await inheritedBox(figma);
    const entries = [{ id: mainBox.id, fill: "#ff0000" }, { id: instanceBox.id, fill: "#0000ff" }];
    await flcm.editMany(bothOrders(entries)[order] as never);
    assert.deepEqual(mainBox.fills[0].color, { r: 1, g: 0, b: 0 });
    assert.deepEqual(instanceBox.fills[0].color, { r: 0, g: 0, b: 1 });
  }
  // A word the instance may not write, which the definition's edit makes hold: through the layer's
  // own id or the instance's override, in either order.
  for (const words of [{ left: 20 }, { width: 60 }]) {
    for (const route of ["sublayer", "override"] as const) {
      for (const order of [0, 1]) {
        const figma = setup();
        const { mainBox, instanceBox } = await inheritedBox(figma);
        const restated = route === "sublayer" ? { id: instanceBox.id, ...words } : { id: instanceBox.parent.id, overrides: { [mainBox.id]: words } };
        await flcm.editMany(bothOrders([{ id: mainBox.id, ...words }, restated])[order] as never);
        for (const [word, value] of Object.entries(words)) {
          const measure = word === "left" ? "x" : word;
          assert.equal(mainBox[measure], value, route + " " + word);
          assert.equal(instanceBox[measure], value, route + " " + word);
        }
      }
    }
  }
  // The same dependency where the instance may not write the word: its layer follows the definition's move.
  for (const order of [0, 1]) {
    const figma = setup();
    const { mainBox, instanceBox } = await inheritedBox(figma);
    figma.undoLog.length = 0;
    const entries = [{ id: mainBox.id, left: 20 }, { id: instanceBox.id, left: 10 }];
    await assert.rejects(flcm.editMany(bothOrders(entries)[order] as never), /didn't realize 1 of its words.*left: asked 10, ended 20.*\(instance\.transform\)/s);
    assert.deepEqual(figma.undoLog, ["commit", "commit", "trigger"]);
  }
});

// ---- the same dependencies through every route that edits a live layer ----

// A free Grand holding Card, whose stretched Wide follows Card's width; and a hugging Row whose
// right-pinned absolute Mark follows the row's width, which its Grow child decides.
async function dependentLayers(figma: any) {
  const grand = await live(figma, await flcm.render({
    type: "FRAME", name: "Grand", width: 640, height: 400,
    children: [{
      type: "FRAME", name: "Card", left: 0, top: 0, width: 320, height: 160,
      children: [{ type: "RECTANGLE", name: "Wide", left: 10, top: 10, width: 300, height: 20, constraints: { x: "stretch" } }],
    }],
  } as never));
  const row = await live(figma, await flcm.render({
    type: "FRAME", name: "Row", left: 0, top: 500, layout: { mode: "row" },
    children: [
      { type: "RECTANGLE", name: "Grow", width: 100, height: 20 },
      { type: "RECTANGLE", name: "Mark", position: "absolute", left: 80, top: 0, width: 10, height: 10, constraints: { x: "right" } },
    ],
  } as never));
  return { grand, card: named(grand, "Card"), wide: named(grand, "Wide"), row, grow: named(row, "Grow"), mark: named(row, "Mark") };
}

test("live-id trees and instance overrides order dependent words like editMany", async () => {
  for (const verb of ["render", "replace"] as const) {
    for (const order of [0, 1]) {
      const figma = setup();
      const { grand, card, wide, row, grow, mark } = await dependentLayers(figma);
      // Each tree restates a page root by its live id, so it lands where it stands.
      const land = (root: any, children: object[]) => {
        const spec = { id: root.id, children } as never;
        return verb === "render" ? flcm.render(spec) : flcm.replace(root.id, spec);
      };
      figma.undoLog.length = 0;
      // The percent settles after the children land, and stretches the child the tree sized.
      await land(grand, [{ id: card.id, width: "62.5%", children: [{ id: wide.id, width: 280 }] }]);
      assert.equal(card.width, 400, verb);
      assert.equal(wide.width, 280, verb);
      // A later sibling grows the hugging row, which moves the pinned mark the tree placed first.
      await land(row, bothOrders([{ id: mark.id, left: 80 }, { id: grow.id, width: 200 }])[order]);
      assert.equal(row.width, 200, verb);
      assert.equal(mark.x, 80, verb);
      assert.deepEqual(figma.undoLog, ["commit", "commit", "commit", "commit"]);
    }
  }
  for (const order of [0, 1]) {
    const figma = setup();
    const { mainBox, instanceBox } = await inheritedBox(figma);
    const entries = [{ id: mainBox.id, fill: "#ff0000" }, { id: instanceBox.parent.id, overrides: { [mainBox.id]: { fill: "#0000ff" } } }];
    await flcm.editMany(bothOrders(entries)[order] as never);
    assert.deepEqual(mainBox.fills[0].color, { r: 1, g: 0, b: 0 });
    assert.deepEqual(instanceBox.fills[0].color, { r: 0, g: 0, b: 1 });
  }
  // Through a nested instance too: Tile's Box reaches the instance by way of Pair's own Tile instance.
  for (const order of [0, 1]) {
    const figma = setup();
    const tile = await flcm.component({ type: "FRAME", name: "Tile", width: 100, height: 100, children: [{ type: "RECTANGLE", name: "Box", width: 40, height: 40, fill: "#0000ff" }] } as never);
    const pair = await flcm.component({ type: "FRAME", name: "Pair", width: 200, height: 200, children: [{ type: "INSTANCE", componentId: tile.id }] } as never);
    const inst = await flcm.render({ type: "INSTANCE", componentId: pair.id } as never);
    const holder = await flcm.render({ type: "FRAME", name: "Holder", width: 800, height: 400, children: [{ id: tile.id }, { id: pair.id }, { id: inst.id }] } as never);
    const mainBox = named(await live(figma, tile), "Box");
    const instanceBox = named(await live(figma, inst), "Box");
    const path = instanceBox.id.slice(("I" + inst.id + ";").length);
    const children = [{ id: inst.id, overrides: { [path]: { fill: "#0000ff" } } }, { id: pair.id }, { id: tile.id, children: [{ id: mainBox.id, fill: "#ff0000" }] }];
    await flcm.render({ id: holder.id, children: bothOrders(children)[order] } as never);
    assert.deepEqual(mainBox.fills[0].color, { r: 1, g: 0, b: 0 });
    assert.deepEqual(named(await live(figma, inst), "Box").fills[0].color, { r: 0, g: 0, b: 1 });
  }
  // Inherited slot content moved into another slot of its instance lands as Figma's copy, under an
  // id of its own (scene-access.ts); its words land on the copy, and the copy's id comes back.
  const figma = setup();
  const tile = await flcm.component({ type: "FRAME", name: "Tile", width: 40, height: 40 });
  const slot = (name: string) => ({ type: "FRAME", name, width: 100, height: 100, componentPropertyReferences: { slot: name } });
  const host = await flcm.component(
    { type: "FRAME", name: "Host", width: 300, height: 300, children: [slot("Source"), slot("Destination")] } as never,
    { propertyDefinitions: { Source: { type: "slot" }, Destination: { type: "slot" } } },
  );
  const filled = { type: "INSTANCE", componentId: host.id, overrides: { [host.children![0].id!]: { children: [{ type: "INSTANCE", componentId: tile.id }] } } };
  const enclosing = await flcm.component({ type: "FRAME", name: "Enclosing", width: 400, height: 400, children: [filled] } as never);
  const outer = await live(figma, await flcm.render({ type: "INSTANCE", componentId: enclosing.id, left: 500 } as never));
  const [source, destination] = outer.children[0].children;
  const original = source.children[0];
  const append = destination.appendChild;
  destination.appendChild = (node: any) => {
    if (node !== original) return append.call(destination, node);
    const copy = node.clone();
    node.remove();
    append.call(destination, copy);
  };
  const moved = await flcm.append(destination.id, { id: original.id, opacity: 0.5 } as never);
  assert.equal(source.children.length, 0);
  assert.equal(moved.id, destination.children[0].id);
  assert.notEqual(moved.id, original.id);
  assert.equal(destination.children[0].opacity, 0.5);
});

// ---- a word someone else changes while the call loads is refused, not overwritten ----

test("a restated word that changes while the call loads fonts is refused, keeping the new value", async () => {
  for (const verb of ["edit", "editMany", "render"] as const) {
    const figma = setup();
    const text = await live(figma, await flcm.render({ type: "TEXT", text: "Hi", fill: "#ff0000" } as never));
    const load = figma.loadFontAsync;
    // A human recolours the text while the call waits on a font the run hasn't loaded yet.
    figma.loadFontAsync = (font: unknown) => { text.fills = [{ type: "SOLID", color: { r: 0, g: 1, b: 0 }, opacity: 1 }]; return load.call(figma, font); };
    const words = { fill: "#ff0000", textStyle: { fontWeight: 700 } };
    const run = verb === "edit" ? flcm.edit(text.id, words as never) : verb === "editMany" ? flcm.editMany([{ id: text.id, ...words }] as never) : flcm.render({ id: text.id, ...words } as never);
    await assert.rejects(run, (err: Error) => {
      assert.match(err.message, /fill changed while this call was loading fonts and images \(it was "#ff0000", now "#00FF00"\)/, verb);
      // A batch names the entry once, and asks for a fresh read rather than a fix.
      if (verb === "editMany") assert.match(err.message, /Read those layers again and re-run it\.\n {2}\[0\] TEXT/);
      return true;
    });
    assert.deepEqual(text.fills[0].color, { r: 0, g: 1, b: 0 }, verb);
  }
});

test("an override and the same sublayer by its own id asking different values are refused with zero writes", async () => {
  const figma = setup();
  const { mainBox, instanceBox } = await inheritedBox(figma);
  figma.undoLog.length = 0;
  await assert.rejects(
    flcm.editMany([{ id: instanceBox.parent.id, overrides: { [mainBox.id]: { fill: "#ff0000" } } }, { id: instanceBox.id, fill: "#00ff00" }] as never),
    /\[0\] overrides\["[^"]+"\]\.fill and \[1\] fill both state RECTANGLE "Box".*'s fill \("#ff0000" vs "#00ff00"\); state it once/,
  );
  assert.deepEqual(figma.undoLog, []);
  assert.deepEqual(instanceBox.fills[0].color, { r: 0, g: 0, b: 1 });
});

test("a moved node's restated fill is owed as the px it carries into a free-form frame", async () => {
  for (const undo of [false, true]) {
    const figma = setup();
    const column = await live(figma, await flcm.render({
      type: "FRAME", name: "Column", width: 480, height: 400, layout: { mode: "column" },
      children: [{ type: "FRAME", name: "Tile", width: "fill", height: 100 }],
    } as never));
    const staging = await live(figma, await flcm.render({ type: "FRAME", name: "Staging", left: 600, width: 900, height: 900 } as never));
    const tile = named(column, "Tile");
    const restore = undo ? (() => {
      const proto = Object.getPrototypeOf(tile);
      const link = proto.setFillStyleIdAsync;
      proto.setFillStyleIdAsync = async function (this: any, id: string) { await link.call(this, id); this.resize(300, this.height); };
      return () => { proto.setFillStyleIdAsync = link; };
    })() : () => {};
    try {
      const move = flcm.append(staging.id, { id: tile.id, width: "fill", fill: { style: "Brand/Primary" } } as never);
      if (!undo) {
        await move;
        assert.equal(tile.parent, staging);
        assert.equal(tile.width, 480);
      } else {
        await assert.rejects(move, /width: asked "fill", ended 300/);
      }
    } finally {
      restore();
    }
  }
});
