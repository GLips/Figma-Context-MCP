/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Pasting a read back with only its root id deleted moves the children instead of copying them.
// What must not regress: the agent hears about it in the same run, and the legitimate ways to put
// live nodes under a new node (wrapping in place, replace) stay quiet.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import * as flcm from "./runtime.js";
import { warnings } from "./warnings.js";
import { beginMovedOutDiagnostics, recordLiveMoveIntoNewNode, finishMovedOutDiagnostics } from "./moved-out-diagnostics.js";

const movedWarnings = () => warnings.summary().filter((line) => line.includes("Moved "));

beforeEach(() => {
  createFigmaMock();
  warnings.discardFrom(0);
});

async function renderCard(name: string) {
  return flcm.render({
    type: "FRAME",
    name,
    width: 200,
    height: 100,
    layout: { mode: "column" },
    children: [
      { type: "TEXT", name: "Title", text: "Title" },
      { type: "TEXT", name: "Body", text: "Body" },
    ],
  });
}

test("get, delete the root id, render elsewhere: warns that the source was emptied", async () => {
  const card = await renderCard("Card");
  const destination = await flcm.render({ type: "FRAME", name: "Elsewhere", width: 400, height: 400 });
  const { node } = await flcm.get(card);
  const { id, ...copy } = node;
  const result = await flcm.append(destination, copy);
  assert.equal(result.children![0].id, card.children![0].id);
  assert.deepEqual(movedWarnings(), [
    "[warn] Moved 2 nodes out of \"Card\" (id " + JSON.stringify(card.id) + ") into new \"Card\" (id " + JSON.stringify(result.id) +
      "); the source is now empty. If you intended a copy, restore the moved nodes and use flcm.clone.",
  ]);
});

test("a source split across new containers is counted once and not called empty while it keeps a child", async () => {
  const card = await renderCard("Card");
  const [title, body] = card.children!;
  await flcm.render({
    type: "FRAME",
    name: "Pair",
    width: 400,
    height: 400,
    children: [
      { type: "FRAME", name: "A", width: 100, height: 100, children: [{ id: title.id }] },
      { type: "FRAME", name: "B", width: 100, height: 100, children: [{ id: body.id }] },
    ],
  });
  assert.deepEqual(movedWarnings(), [
    "[warn] Moved 2 nodes out of \"Card\" (id " + JSON.stringify(card.id) + ") into 2 new containers; the source is now empty. If you intended a copy, restore the moved nodes and use flcm.clone.",
  ]);
  warnings.discardFrom(0);
  const other = await renderCard("Other");
  await flcm.render({ type: "FRAME", name: "One", width: 100, height: 100, children: [{ id: other.children![0].id }] });
  assert.match(movedWarnings()[0], /Moved 1 node out of "Other" .* into new "One" \(id "[^"]+"\)\. If you intended/);
});

test("wrapping in place, replace, and moves into existing nodes don't warn", async () => {
  const card = await renderCard("Card");
  const [title, body] = card.children!;
  // Wrap in place: the new frame lands in Card, so both stay inside their old parent.
  await flcm.replace(title.id!, { type: "FRAME", name: "Wrap", layout: { mode: "column" }, children: [{ id: title.id }, { id: body.id }] });
  // replace's target is removed by the same verb, so emptying it is the point.
  const old = await renderCard("Old");
  await flcm.replace(old.id!, { type: "FRAME", name: "New", children: old.children!.map(({ id }) => ({ id })) });
  // An explicit move into an existing node.
  const other = await renderCard("Other");
  await flcm.append(card.id!, { id: other.children![0].id });
  assert.deepEqual(movedWarnings(), []);
});

test("live content placed into a new instance's slot by an edit warns", async () => {
  const component = await flcm.component(
    {
      type: "FRAME",
      width: 240,
      height: 200,
      children: [{ type: "FRAME", width: 200, height: 100, componentPropertyReferences: { slot: "Body" }, children: [] }],
    },
    { propertyDefinitions: { Body: { type: "slot" } } },
  );
  const path = component.children![0].id!;
  const host = await flcm.render({ type: "INSTANCE", componentId: component.id });
  const card = await renderCard("Card");
  await flcm.edit(host.id!, {
    overrides: { [path]: { children: [{ type: "INSTANCE", componentId: component.id, overrides: { [path]: { children: [{ id: card.children![0].id }] } } }] } },
  });
  assert.equal(movedWarnings().length, 1);
  assert.match(movedWarnings()[0], /^\[warn\] Moved 1 node out of "Card" .* into new /);
});

// The mock has no groups; Figma deletes a GROUP once its last child leaves, so its source reads removed.
test("a source Figma deleted because the move emptied it still warns", () => {
  const page = { id: "0:1", type: "PAGE", removed: false, parent: null };
  const group = { id: "1:1", name: "Group", type: "GROUP", removed: false, parent: page, children: [] };
  const into = { id: "2:1", name: "Card", type: "FRAME", removed: false, parent: page, children: [] };
  const node = { id: "1:2", name: "Title", type: "TEXT", removed: false, parent: into };
  beginMovedOutDiagnostics();
  recordLiveMoveIntoNewNode(node, group, into);
  Object.assign(group, { removed: true, parent: null });
  finishMovedOutDiagnostics("render");
  assert.deepEqual(movedWarnings(), [
    "[warn] Moved 1 node out of \"Group\" (id \"1:1\") into new \"Card\" (id \"2:1\"); Figma deleted the emptied source. If you intended a copy, restore the moved nodes and use flcm.clone.",
  ]);
});

// The new node a component call moves live nodes into is the frame createComponentFromNode then
// replaces; live throws on every read of it, so the warning must name the component.
test("a component built around live nodes names the component they moved into", async () => {
  const card = await renderCard("Card");
  const [title] = card.children!;
  const made = await flcm.component({ type: "FRAME", name: "Header", children: [{ id: title.id }] }, { name: "Header" });
  assert.deepEqual(movedWarnings(), [
    "[warn] Moved 1 node out of \"Card\" (id " + JSON.stringify(card.id) + ") into new \"Header\" (id " + JSON.stringify(made.id) +
      "). If you intended a copy, restore the moved nodes and use flcm.clone.",
  ]);
  assert.equal(warnings.summary().filter((line) => line.includes("could not inspect")).length, 0);
});
