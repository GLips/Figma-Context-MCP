/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { resolveTarget } from "./target.js";
import { specNode } from "../../harness/spec-node.js";
// The structural verbs. What must not regress silently: an inserted node is attached BEFORE it is
// sized (so parent-dependent sizing actually resolves — the invariant-3 hazard), a live target is
// MOVED rather than copied and has its flow marks re-aimed at the new parent, legality is re-asked
// against the DESTINATION, and every rejection fires with zero writes. The undo scaffold's call
// sequence is pinned by mutation-lock.test.ts, not re-asserted here.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { image } from "./value-sugar.js";
import { render, append,
  prepend,
  insertBefore,
  insertAfter,
  remove,
  clone,
  measure,
  replace, } from "./runtime.js";
import { get } from "./read.js";
import { readKey } from "./identity.js";
import { FlcmError } from "./flcm-error.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

// A 300px-wide row with two keyed children, the shape most of these tests place into.
async function renderRow() {
  const out = await render({
    type: "FRAME",
    key: "row",
    width: 300,
    height: 100,
    layout: { mode: "row", gap: 10, padding: 5 },
    children: [
      { type: "RECTANGLE", key: "a", width: 40, height: 40 },
      { type: "RECTANGLE", key: "b", width: 40, height: 40 },
    ],
  });
  return figma.getNodeByIdAsync(specNode(out, "row").id);
}

const names = (node) => node.children.map((c) => c.name);

test("append builds a node into the destination and sizes it THERE — fill fills the live parent", async () => {
  const row = await renderRow();
  const out = await append("row", {
    type: "RECTANGLE",
    key: "filler",
    name: "filler",
    width: "fill",
    height: 20,
  });
  assert.deepEqual(names(row), ["RECTANGLE", "RECTANGLE", "filler"]);
  // The ordering hazard: sized before attaching, "fill" would have collapsed to the rect's own
  // intrinsic 100. The row is 300 wide with 5px padding either side.
  const filler = row.children[2];
  assert.equal(filler.layoutGrow, 1);
  assert.equal(filler.width, 290);
  // render's own return shape, plus the attach point with fresh geometry.
  assert.equal(out.id, filler.id);
  assert.equal(specNode(out, "filler").id, filler.id);
});

test("a percent size on an inserted node resolves against the live destination", async () => {
  await render({ type: "FRAME", key: "board", width: 200, height: 200 });
  const out = await append("board", { type: "RECTANGLE", name: "half", width: "50%", height: 20 });
  assert.equal((await measure(out)).width, 100);
});

test("prepend, insertBefore and insertAfter each land where their name says", async () => {
  const row = await renderRow();
  await prepend("row", { type: "RECTANGLE", name: "first" });
  await insertBefore("a", { type: "RECTANGLE", name: "before-a" });
  await insertAfter("b", { type: "RECTANGLE", name: "after-b" });
  assert.deepEqual(names(row), ["first", "before-a", "RECTANGLE", "RECTANGLE", "after-b"]);
});

test("placing a LIVE target moves it — including a reorder inside one parent", async () => {
  const row = await renderRow();
  const b = row.children[1];
  const out = await insertBefore("a", { id: (await resolveTarget("b")).id });
  assert.deepEqual(
    row.children.map((c) => c.id),
    [b.id, row.children[1].id],
  );
  assert.equal(out.id, b.id);
});

test("a moved node's fill is re-aimed at the new parent's axes, not left on the old one's", async () => {
  const out = await render({
    type: "FRAME",
    key: "page-root",
    width: 400,
    height: 400,
    children: [
      {
        type: "FRAME",
        key: "row",
        width: 300,
        height: 100,
        layout: { mode: "row" },
        children: [{ type: "RECTANGLE", key: "grower", width: "fill", height: 20 }],
      },
      { type: "FRAME", key: "col", width: 200, height: 300, layout: { mode: "column" } },
    ],
  });
  const grower = await figma.getNodeByIdAsync(specNode(out, "grower").id);
  const col = await figma.getNodeByIdAsync(specNode(out, "col").id);
  assert.equal(grower.layoutGrow, 1); // width-fill under a ROW = the primary axis
  const moved = await append("col", { id: (await resolveTarget("grower")).id });
  assert.equal(grower.parent.id, col.id);
  // Under a COLUMN the same width-fill is the COUNTER axis: the primary mark must be gone or the
  // rect would silently start filling the column's HEIGHT instead.
  assert.equal(grower.layoutGrow, 0);
  assert.equal(grower.layoutAlign, "STRETCH");
  assert.equal(grower.width, 200);
  // Cleared only after landing, the row's grow mark would have grown it down the column first.
  assert.equal(grower.height, 20);
});

// A fill-sized tile in an auto-layout column, beside a tall free-form staging frame and an
// auto-layout row of the same size.
async function renderTileAndStaging(tileHeight: number | "fill" = "fill") {
  const out = await render({
    type: "FRAME",
    key: "page-root",
    width: 1200,
    height: 2600,
    children: [
      {
        type: "FRAME",
        key: "col",
        width: 480,
        height: 400,
        layout: { mode: "column" },
        children: [{ type: "FRAME", key: "tile", width: "fill", height: tileHeight }],
      },
      { type: "FRAME", key: "staging", width: 900, height: 2600 },
      { type: "FRAME", key: "flow-staging", width: 900, height: 2600, layout: { mode: "row" } },
    ],
  });
  return { tile: await figma.getNodeByIdAsync(specNode(out, "tile").id), staging: await figma.getNodeByIdAsync(specNode(out, "staging").id) };
}

test("a fill carried from an auto-layout parent keeps its px size in a free-form frame — move, clone and pasted get", async () => {
  const { tile, staging } = await renderTileAndStaging();
  assert.deepEqual([tile.width, tile.height], [480, 400]);
  const copy = await figma.getNodeByIdAsync((await clone("tile", "staging")).id);
  assert.equal(copy.parent.id, staging.id);
  assert.deepEqual([copy.width, copy.height], [480, 400]);
  // An earlier call's output: projected for egress, so no readOnlySource rides along.
  const pasted = JSON.parse(JSON.stringify((await get("tile")).node, (key, value) => key === "readOnlySource" ? undefined : value));
  assert.equal(pasted.width, "fill");
  await append("staging", pasted);
  assert.equal(tile.parent.id, staging.id);
  assert.deepEqual([tile.width, tile.height], [480, 400]);
});

test("a fill written in the same call still covers the free-form destination", async () => {
  const { tile } = await renderTileAndStaging();
  const copy = await figma.getNodeByIdAsync((await clone("tile", { width: "fill" }, "staging")).id);
  assert.deepEqual([copy.width, copy.height], [900, 400]);
  // The tile already fills its column, so "fill" would restate it; covering the new parent is a change.
  await append("staging", { id: tile.id, height: "100%" });
  assert.deepEqual([tile.width, tile.height], [480, 2600]);
  // A fill typed over a pasted read's fixed axis is the author's, not the read's.
  const read = (await get(copy.id)).node;
  assert.equal(read.height, 400);
  await append("staging", { ...read, height: "fill" });
  assert.equal(copy.height, 2600);
});

test("a carried fill keeps its px when the same call takes the node out of an auto-layout destination's flow", async () => {
  // A fixed height, as live: the column's width-STRETCH would be the row's height-STRETCH on landing.
  const { tile } = await renderTileAndStaging(102);
  const out = { position: "absolute", left: 0, top: 0 } as const;
  const copy = await figma.getNodeByIdAsync((await clone("tile", out, "flow-staging")).id);
  assert.equal(copy.layoutPositioning, "ABSOLUTE");
  assert.deepEqual([copy.width, copy.height], [480, 102]);
  await append("flow-staging", { ...(await get("tile")).node, ...out });
  assert.equal(tile.layoutPositioning, "ABSOLUTE");
  assert.deepEqual([tile.width, tile.height], [480, 102]);
  // Written in the call, the same fill is a deliberate cover of the row's box.
  await append("flow-staging", { id: copy.id, height: "fill" });
  assert.deepEqual([copy.width, copy.height], [480, 2600]);
});

test("a carried fill moved from a flow into a grid fills its cell", async () => {
  const { tile } = await renderTileAndStaging(102);
  await render({ type: "FRAME", key: "grid", width: 400, height: 200, layout: { mode: "grid", gridTemplateColumns: "1fr 1fr" } });
  await append("grid", { id: tile.id });
  assert.equal(tile.layoutSizingHorizontal, "FILL");
  assert.equal(tile.width, 200);
});

test("legality is re-asked against the DESTINATION: a written fill can't land on the page, a carried one keeps its px", async () => {
  await render({
    type: "FRAME",
    key: "row",
    width: 300,
    height: 100,
    layout: { mode: "row" },
    children: [{ type: "RECTANGLE", key: "grower", width: "fill", height: 20 }],
  });
  const before = [...figma.undoLog];
  await assert.rejects(
    append(figma.currentPage.id, { type: "RECTANGLE", width: "fill", height: 20 }),
    /"fill" and "N%" resolve against a parent frame/,
  );
  assert.deepEqual(figma.undoLog, before); // the reject fired before any seal
  // A fill the node only carries from its row isn't a write: it keeps its px on the page.
  const grower = await figma.getNodeByIdAsync((await resolveTarget("grower")).id);
  await append(figma.currentPage.id, { id: grower.id });
  assert.equal(grower.parent.type, "PAGE");
  assert.deepEqual([grower.width, grower.height], [300, 20]);
});

test("the destination is read at the seal: an anchor moved during the image fetch is followed to its new parent", async () => {
  const out = await render({
    type: "FRAME",
    key: "board",
    width: 400,
    height: 400,
    children: [
      {
        type: "FRAME",
        key: "left",
        width: 200,
        height: 200,
        children: [{ type: "RECTANGLE", key: "anchor", width: 40, height: 40 }],
      },
      { type: "FRAME", key: "right", width: 200, height: 200 },
    ],
  });
  const left = await figma.getNodeByIdAsync(specNode(out, "left").id);
  const right = await figma.getNodeByIdAsync(specNode(out, "right").id);
  const anchor = await figma.getNodeByIdAsync(specNode(out, "anchor").id);
  // The image fetch is the run's suspension point; the user drags the anchor across it.
  const g = globalThis as { __flcmHost?: unknown };
  g.__flcmHost = {     callServer: async (_capability: string, urls: string[]) => {
      right.appendChild(anchor);
      return Object.fromEntries(urls.map((u) => [u, Buffer.from("bytes").toString("base64")]));
    },
    runCancellation: () => null, whenCancelled: () => new Promise(() => {}), isRunFinished: () => false,
  };
  try {
    await insertAfter("anchor", {
      type: "RECTANGLE",
      name: "beside",
      width: 20,
      height: 20,
      fill: image("https://cdn.example.com/a.jpg"),
    });
  } finally {
    delete g.__flcmHost;
  }
  assert.deepEqual(names(right), ["RECTANGLE", "beside"]);
  assert.deepEqual(names(left), []);
});

test("a source deleted while the destination resolved refuses at the seal — Figma would have cloned the corpse", async () => {
  const out = await render({
    type: "FRAME",
    key: "board",
    width: 400,
    height: 400,
    children: [
      { type: "RECTANGLE", key: "src", width: 40, height: 40 },
      { type: "FRAME", key: "dest", width: 200, height: 200 },
    ],
  });
  const src = await figma.getNodeByIdAsync(specNode(out, "src").id);
  const dest = await figma.getNodeByIdAsync(specNode(out, "dest").id);
  const before = [...figma.undoLog];
  // clone resolves its source, then its destination; the user deletes the source between the two.
  const getNodeByIdAsync = figma.getNodeByIdAsync;
  figma.getNodeByIdAsync = async (nodeId: string) => {
    if (nodeId === dest.id) src.remove();
    return getNodeByIdAsync.call(figma, nodeId);
  };
  try {
    await assert.rejects(
      clone(src.id, dest.id),
      (err: unknown) => err instanceof FlcmError && err.kind === "concurrent-edit" && err.call === "flcm.clone",
    );
  } finally {
    figma.getNodeByIdAsync = getNodeByIdAsync;
  }
  assert.deepEqual(names(dest), []);
  assert.deepEqual(figma.undoLog, before);
});

test("a destination dragged to a page this call never loaded refuses before the seal", async () => {
  const out = await render({
    type: "FRAME",
    key: "board",
    width: 400,
    height: 400,
    children: [{ type: "RECTANGLE", key: "anchor", width: 40, height: 40 }],
  });
  const anchor = await figma.getNodeByIdAsync(specNode(out, "anchor").id);
  const before = [...figma.undoLog];
  const g = globalThis as { __flcmHost?: unknown };
  g.__flcmHost = {     callServer: async (_capability: string, urls: string[]) => {
      figma.createPage().appendChild(anchor); // under dynamic-page that page's child list is unreadable until loaded
      return Object.fromEntries(urls.map((u) => [u, Buffer.from("bytes").toString("base64")]));
    },
    runCancellation: () => null, whenCancelled: () => new Promise(() => {}), isRunFinished: () => false,
  };
  try {
    await assert.rejects(
      insertAfter("anchor", {
        type: "RECTANGLE",
        width: 20,
        height: 20,
        fill: image("https://cdn.example.com/a.jpg"),
      }),
      (err: unknown) => err instanceof FlcmError && err.kind === "concurrent-edit" && /"Page 2"/.test(err.reason),
    );
  } finally {
    delete g.__flcmHost;
  }
  assert.deepEqual(figma.undoLog, before);
});

test("prepare rejects a non-container destination, a cycle, and a hand-built node — with zero writes", async () => {
  const out = await render({
    type: "FRAME",
    key: "row",
    width: 300,
    height: 100,
    children: [
      { type: "RECTANGLE", key: "a", width: 40, height: 40 },
      { type: "FRAME", key: "inner", width: 40, height: 40 },
    ],
  });
  const row = await figma.getNodeByIdAsync(specNode(out, "row").id);
  const before = [...figma.undoLog];
  await assert.rejects(append("a", { type: "RECTANGLE" }), /holds no children/);
  await assert.rejects(
    append("row", { id: (await resolveTarget("row")).id }),
    /can't be placed inside itself/,
  );
  await assert.rejects(
    append("inner", { id: (await resolveTarget("row")).id }),
    /its own descendant/,
  );
  await assert.rejects(
    append("row", { type: "FRAME", children: [{ type: "RECTANGLE", fills: [] }] } as never),
    /children\[0\].*fills/,
  );
  await assert.rejects(append("row", [] as never), /must be a node spec object/);
  assert.deepEqual(names(row), ["RECTANGLE", "Frame"]);
  assert.deepEqual(figma.undoLog, before);
});

test("remove deletes the subtree and reports the id plus the reflowed parent", async () => {
  const out = await render({
    type: "FRAME",
    key: "row",
    layout: { mode: "row", gap: 10 },
    children: [
      { type: "RECTANGLE", key: "a", width: 40, height: 40 },
      { type: "RECTANGLE", key: "b", width: 40, height: 40 },
    ],
  });
  const row = await figma.getNodeByIdAsync(specNode(out, "row").id);
  const a = await figma.getNodeByIdAsync(specNode(out, "a").id);
  assert.equal(row.width, 90); // 40 + 10 gap + 40, hugged
  const gone = await remove("a");
  assert.equal(gone.removedId, a.id);
  assert.equal(a.removed, true);
  assert.deepEqual(
    row.children.map((c) => c.id),
    [specNode(out, "b").id],
  );
  // Why remove reports the parent at all: a hug parent reflows the moment a child leaves.
  assert.equal(gone.from.width, 40);
});

test("clone duplicates an INSTANCE-bearing subtree and strips every flcm/key from the copy", async () => {
  // A component instance is the case a REBUILD can't reproduce — the reason clone exists.
  const src = await render({
    type: "FRAME",
    key: "badge",
    width: 60,
    height: 60,
    children: [{ type: "RECTANGLE", width: 20, height: 20 }],
  });
  const component = figma.createComponentFromNode(
    await figma.getNodeByIdAsync(specNode(src, "badge").id),
  );
  const out = await render({
    type: "FRAME",
    key: "card",
    width: 200,
    height: 200,
    children: [{ type: "TEXT", text: "Hi", key: "title" }],
  });
  const card = await figma.getNodeByIdAsync(specNode(out, "card").id);
  card.appendChild(component.createInstance());
  const tray = await render({ type: "FRAME", key: "tray", width: 300, height: 300 });

  const copied = await clone("card", "tray");
  const copy = await figma.getNodeByIdAsync(copied.id);
  assert.equal(copy.parent.id, specNode(tray, "tray").id);
  // Faithful: the same children in the same order, the instance still an instance of the same main.
  assert.deepEqual(
    copy.children.map((c) => c.type),
    ["TEXT", "INSTANCE"],
  );
  assert.equal(copy.children[0].characters, "Hi");
  assert.equal(copy.children[1].mainComponent.id, component.id);
  // Key-less, all the way down — a copied key would mint a second node at the same address.
  const keysUnder = (n) => [readKey(n), ...(n.children || []).flatMap(keysUnder)];
  assert.deepEqual(keysUnder(copy).filter(Boolean), []);
  // …and so the originals' keys still resolve, each to exactly one node (resolveTarget throws on a clash).
  assert.equal((await get("card")).node.id, card.id);
  assert.equal((await get("title")).node.id, specNode(out, "title").id);
});

test("an instance's CHILD LIST is closed, but the instance itself is an ordinary node", async () => {
  const out = await render({
    type: "FRAME",
    key: "src",
    width: 60,
    height: 60,
    children: [{ type: "FRAME", key: "slot", width: 20, height: 20 }],
  });
  const src = await figma.getNodeByIdAsync(specNode(out, "src").id);
  const component = figma.createComponentFromNode(src);
  const instance = component.createInstance();
  instance.name = "Card instance";
  const dest = await render({ type: "FRAME", key: "dest", width: 100, height: 100 });
  await assert.rejects(
    append(instance.id, { type: "RECTANGLE" }),
    (err: unknown) => err instanceof FlcmError && err.kind === "figma" && err.node?.id === instance.id &&
      /^this is an instance, and Figma won't let a plugin change an instance's child list/.test(err.reason),
  );
  await assert.rejects(
    append(instance.children[0].id, { type: "RECTANGLE" }),
    (err: unknown) => err instanceof FlcmError && err.kind === "figma" && err.node?.id === instance.children[0].id &&
      /inside INSTANCE "Card instance"/.test(err.reason),
  );
  await assert.rejects(
    append("dest", { id: instance.children[0].id }),
    (err: unknown) => err instanceof FlcmError && err.kind === "figma" && err.node?.id === instance.children[0].id &&
      /won't let a plugin move an instance's sublayer/.test(err.reason),
  );
  // …and the other half of the rule: Figma freezes an instance's CHILDREN, not the instance, which
  // is a normal child of its own parent. Moving and deleting one are everyday operations.
  await append("dest", { id: (await resolveTarget(instance.id)).id });
  assert.equal(instance.parent.id, specNode(dest, "dest").id);
  const second = component.createInstance();
  const gone = await remove(second.id);
  assert.equal(gone.removedId, second.id);
});

test("clone with no parent lands the copy on the original's own coordinates", async () => {
  const out = await render({
    type: "FRAME",
    key: "board",
    width: 400,
    height: 400,
    children: [{ type: "RECTANGLE", key: "chip", width: 40, height: 40, left: 30, top: 50 }],
  });
  const copied = await clone("chip");
  const copy = await figma.getNodeByIdAsync(copied.id);
  assert.equal(copy.parent.id, specNode(out, "board").id); // no parent named ⇒ the original's own
  // Faithful means faithful: in a free-form parent the copy sits exactly on top of the original.
  assert.deepEqual([copy.x, copy.y], [30, 50]);
});

test("measure returns parent-relative numeric geometry without mutation", async () => {
  const out = await render({
    type: "FRAME",
    width: 400,
    height: 200,
    left: 100,
    top: 70,
    children: [{ type: "RECTANGLE", key: "measured", width: 42, height: 23, left: 18, top: 9 }],
  });
  assert.deepEqual(await measure("measured"), { x: 18, y: 9, width: 42, height: 23 });
  assert.deepEqual(await measure(out), { x: 100, y: 70, width: 400, height: 200 });
});

test("clone root overrides fix geometry before destination fill settlement and apply styles", async () => {
  await render({
    type: "FRAME",
    key: "source",
    width: 200,
    height: 100,
    layout: { mode: "row" },
    children: [{ type: "RECTANGLE", key: "copy", width: "fill", height: 30, fill: "#ff0000" }],
  });
  await render({
    type: "FRAME",
    key: "destination",
    width: 500,
    height: 100,
    layout: { mode: "row" },
  });
  const out = await clone(
    "copy",
    { width: 70, height: 40, fill: "#00ff00", opacity: 0.5 },
    "destination",
  );
  const copy = await figma.getNodeByIdAsync(out.id);
  assert.equal(copy.width, 70);
  assert.equal(copy.height, 40);
  assert.equal(copy.layoutGrow, 0);
  assert.equal(copy.opacity, 0.5);
  assert.equal(copy.fills[0].color.g, 1);
  const original = await figma.getNodeByIdAsync((await get("copy")).node.id);
  assert.equal(original.fills[0].color.r, 1);
});

test("clone validates malformed overrides before making any copy", async () => {
  const row = await renderRow();
  const before = row.children.map((n) => n.id);
  await assert.rejects(clone("a", { width: "nonsense" }), /width|length|size/i);
  assert.deepEqual(
    row.children.map((n) => n.id),
    before,
  );
});

test("replace preserves index and parent-relative constraints with explicit sizing precedence", async () => {
  const parent = await render({
    type: "FRAME",
    key: "replace-parent",
    width: 400,
    height: 300,
    children: [
      { type: "RECTANGLE", key: "before", width: 10, height: 10 },
      {
        type: "RECTANGLE",
        key: "old",
        width: 90,
        height: 60,
        left: 23,
        top: 37,
        constraints: { x: "right", y: "bottom" },
      },
      { type: "RECTANGLE", key: "after", width: 10, height: 10 },
    ],
  });
  const old = (await get("old")).node.id;
  const out = await replace("old", {
    type: "RECTANGLE",
    name: "replacement",
    width: 120,
    fill: "#00ff00",
  });
  const node = await figma.getNodeByIdAsync(out.id);
  const host = await figma.getNodeByIdAsync(parent.id);
  assert.equal(host.children[1].id, node.id);
  assert.equal(node.width, 120);
  assert.equal(node.height, 60);
  assert.equal(node.x, 23);
  assert.equal(node.y, 37);
  assert.deepEqual(node.constraints, { horizontal: "MAX", vertical: "MAX" });
  assert.equal((await figma.getNodeByIdAsync(old)).removed, true);
});

test("replace keeps fill and rejects incompatible inherited hug before writes", async () => {
  await render({
    type: "FRAME",
    key: "replace-row",
    width: 300,
    height: 100,
    layout: { mode: "row" },
    children: [{ type: "RECTANGLE", key: "old-fill", width: "fill", height: 40 }],
  });
  const out = await replace("old-fill", { type: "RECTANGLE", fill: "#00ff00" });
  const node = await figma.getNodeByIdAsync(out.id);
  assert.equal(node.width, 300);
  assert.equal(node.height, 40);
  assert.equal(node.layoutGrow, 1);
  await render({
    type: "FRAME",
    key: "hug-old",
    layout: { mode: "row" },
    children: [{ type: "RECTANGLE", width: 50, height: 20 }],
  });
  await assert.rejects(replace("hug-old", { type: "RECTANGLE" }), /hug/i);
  assert.equal((await get("hug-old")).node.type, "FRAME");
});

test("replace removal failure stays inside one rollback boundary", async () => {
  await render({ type: "RECTANGLE", key: "replacement-failure", width: 20, height: 30 });
  const target = await figma.getNodeByIdAsync((await get("replacement-failure")).node.id);
  target.remove = () => {
    throw new Error("injected remove failure");
  };
  figma.undoLog.length = 0;
  await assert.rejects(
    replace("replacement-failure", { type: "RECTANGLE", width: 30 }),
    (err: unknown) => err instanceof FlcmError && err.kind === "figma" && err.call === "flcm.replace" && err.node?.id === target.id &&
      /Figma refused a change to this layer: "injected remove failure"/.test(err.reason) && /Nothing from this call was kept/.test(err.message),
  );
  assert.deepEqual(figma.undoLog, ["commit", "commit", "trigger"]);
});

test("a JS engine error mid-call is flcm's bug, not Figma refusing", async () => {
  await render({ type: "RECTANGLE", key: "engine-failure", width: 20, height: 30 });
  const target = await figma.getNodeByIdAsync((await get("engine-failure")).node.id);
  // Figma refuses with a plain Error; a TypeError only comes from code calling something wrongly.
  target.remove = () => {
    throw new TypeError("not a function");
  };
  await assert.rejects(
    replace("engine-failure", { type: "RECTANGLE", width: 30 }),
    (err: unknown) => err instanceof FlcmError && err.kind === "internal" && !/Figma refused/.test(err.message) &&
      /bug in flcm/.test(err.message) && /Nothing from this call was kept/.test(err.message),
  );
});

test("an explicitly undefined or null anchor, clone destination or spec id refuses with zero writes instead of defaulting", async () => {
  const row = await renderRow();
  const pageChildren = figma.currentPage.children.length;
  // Each would otherwise fall back to a default the agent never named: the current page, or beside the original.
  for (const missing of [undefined, null]) {
    await assert.rejects(append(missing, { type: "RECTANGLE", width: 10, height: 10 }), /flcm\.append: parent is (undefined|null)/);
    await assert.rejects(insertAfter(missing, { type: "RECTANGLE", width: 10, height: 10 }), /flcm\.insertAfter: sibling is (undefined|null)/);
    await assert.rejects(clone("a", missing), /flcm\.clone: the second argument \(props or parent\) is (undefined|null)/);
    await assert.rejects(clone("a", { left: 0 }, missing), /flcm\.clone: parent is (undefined|null)/);
    await assert.rejects(render({ id: missing, type: "FRAME", width: 10, height: 10 }), /spec\.id: must be a non-empty live node id — got (undefined|null)/);
  }
  assert.equal(figma.currentPage.children.length, pageChildren);
  assert.equal(row.children.length, 2);
  // Nullish props beside a named parent is "no edits", not a missing target.
  await clone("a", undefined, "row");
  assert.equal(row.children.length, 3);
});

test("replace that wraps its target with earlier siblings lands where they were", async () => {
  const row = await render({
    type: "FRAME",
    width: 400,
    height: 100,
    layout: { mode: "row" },
    children: ["A", "S", "O", "T"].map((name) => ({ type: "RECTANGLE", name, width: 10, height: 10 })),
  });
  const [, s, o] = row.children!;
  const wrap = await replace(o.id!, { type: "FRAME", name: "Wrap", children: [{ id: s.id }, { id: o.id }] });
  const host = await figma.getNodeByIdAsync(row.id);
  assert.deepEqual(host.children.map((n: any) => n.name), ["A", "Wrap", "T"]);
  assert.deepEqual((await figma.getNodeByIdAsync(wrap.id)).children.map((n: any) => n.name), ["S", "O"]);
});
