/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Wire serialization: a live node — the object Figma itself holds at its id — collapses when logged and is
// rejected on the return path, but every handle / read POJO / agent object must round-trip WHOLE, whatever
// its fields: no shape-collapse, no depth/array truncation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeForWire, snapshotForWire, resolveWireSnapshot, type IsFigmaNode } from "./serialize.js";
import type { FlcmError } from "./preamble/flcm-error.js";

// A live node is a Figma class instance; this stands in for FrameNode. Figma (faked at its boundary)
// owns exactly the instances in `document`, by id.
class FrameNode {
  removed = false;
  constructor(readonly id: string, public name: string) {}
  get type() { return "FRAME"; }
  parent: unknown = { children: [this] };
}
function figmaHolding(...nodes: FrameNode[]): { isFigmaNode: IsFigmaNode; asked: string[] } {
  const asked: string[] = [];
  const document = new Map(nodes.map(node => [node.id, node]));
  return { asked, isFigmaNode: async (value) => { asked.push(value.id); return document.get(value.id) === value; } };
}
// As Figma leaves the frame createComponentFromNode replaced: every read but `id` and `removed` throws.
function destroyed(node: FrameNode): FrameNode {
  node.removed = true;
  for (const key of ["name", "type", "parent"]) {
    Object.defineProperty(node, key, { get() { throw new Error(`in get_${key}: The node with id "${node.id}" does not exist`); } });
  }
  return node;
}
const card = new FrameNode("12:34", "Card");

test("a plain object shaped like a node is the agent's data: it round-trips whole and Figma is never asked", async () => {
  const figma = figmaHolding(card);
  const value = { id: "12:34", type: "FRAME", removed: true, name: "x", parent: { id: "0:1" } };
  assert.deepEqual(await serializeForWire(value, figma.isFigmaNode, "result"), value);
  assert.deepEqual(figma.asked, []);
});

test("a returned node is refused, naming its path and the id fix, and Figma is asked about it once", async () => {
  const figma = figmaHolding(card);
  await assert.rejects(
    serializeForWire({ ok: true, nodes: [{ node: card }] }, figma.isFigmaNode, "result"),
    (err: FlcmError) =>
      err.path === "return value.nodes[0].node" && err.node?.id === "12:34" && err.node?.type === "FRAME" &&
      /live Figma node.*return node\.id/s.test(err.reason),
  );
  assert.deepEqual(figma.asked, ["12:34"]);
});

test("a removed node is named by its id alone, refused when returned and { id, removed } when logged", async () => {
  const gone = destroyed(new FrameNode("5:6", "Gone"));
  const figma = figmaHolding(gone);
  await assert.rejects(
    serializeForWire([gone], figma.isFigmaNode, "result"),
    (err: FlcmError) => err.path === "return value[0]" && err.node?.id === "5:6" && /live Figma node/.test(err.reason),
  );
  assert.deepEqual(await serializeForWire([gone], figma.isFigmaNode, "console"), [{ id: "5:6", removed: true }]);
});

test("a node removed after it was logged reports the identity it had when logged", async () => {
  const live = new FrameNode("7:8", "Before");
  const holding = figmaHolding(live);
  const snapshot = snapshotForWire([live], holding.isFigmaNode);
  live.name = "After";
  live.removed = true;
  assert.deepEqual(await resolveWireSnapshot(snapshot, "console"), [{ id: "7:8", name: "Before", type: "FRAME" }]);
});

test("with several nodes returned, the refusal names the first in path order, whichever Figma answers first", async () => {
  const first = new FrameNode("1:1", "First");
  const second = new FrameNode("2:2", "Second");
  const slowFirst: IsFigmaNode = (value) => new Promise(resolve => setTimeout(() => resolve(true), value.id === "1:1" ? 20 : 0));
  await assert.rejects(serializeForWire({ a: first, b: [second] }, slowFirst, "result"), (err: FlcmError) => err.node?.id === "1:1");
});

test("an object referenced twice is asked about once, as is one inside a disowned look-alike", async () => {
  const lookAlike = new FrameNode("3:3", "Copy");
  const inner = new FrameNode("4:4", "Inner");
  inner.parent = null;
  lookAlike.parent = { inner, again: inner };
  const figma = figmaHolding();
  await serializeForWire([lookAlike, lookAlike, inner], figma.isFigmaNode, "console");
  assert.deepEqual(figma.asked.sort(), ["3:3", "4:4"]);
});

test("a look-alike instance Figma doesn't hold at its id passes and serializes as its own fields", async () => {
  const lookAlike = new FrameNode("12:34", "Copy");
  const figma = figmaHolding(card);
  const out = await serializeForWire({ lookAlike: Object.assign(lookAlike, { parent: null }) }, figma.isFigmaNode, "result");
  assert.deepEqual(out, { lookAlike: { removed: false, id: "12:34", name: "Copy", parent: null } });
});

test("a logged node collapses to { id, name, type }, while the plain data beside it is kept as it was logged", async () => {
  const meta = { step: 1 };
  const snapshot = snapshotForWire([card, meta], figmaHolding(card).isFigmaNode);
  meta.step = 2;
  assert.deepEqual(await resolveWireSnapshot(snapshot, "console"), [{ id: "12:34", name: "Card", type: "FRAME" }, { step: 1 }]);
});

test("a deep full read-shape POJO and a long array round-trip whole — no truncation", async () => {
  const { isFigmaNode } = figmaHolding();
  let node: Record<string, unknown> = { id: "leaf", type: "TEXT", name: "deep", characters: "end" };
  for (let i = 0; i < 230; i++) {
    node = { id: `f${i}`, type: "FRAME", name: `frame-${i}`, layout: { mode: "column", padding: { top: i } }, children: [node] };
  }
  assert.deepEqual(await serializeForWire(node, isFigmaNode, "result"), node);
  const arr = Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, type: "RECTANGLE", name: `r${i}` }));
  assert.deepEqual(await serializeForWire(arr, isFigmaNode, "result"), arr);
});

test("cycles fail loudly, through plain data or an object Figma disowns, while shared references stay complete", async () => {
  const { isFigmaNode } = figmaHolding();
  const a: Record<string, unknown> = { name: "cycle" };
  a.self = a;
  assert.throws(() => snapshotForWire(a, isFigmaNode), /contains itself \(a cycle\)/);
  const lookAlike = new FrameNode("1:2", "Loop");
  lookAlike.parent = { child: lookAlike };
  await assert.rejects(serializeForWire([lookAlike], isFigmaNode, "result"), /contains itself \(a cycle\)/);
  const shared = { fill: "#FFF" };
  assert.deepEqual(await serializeForWire([shared, shared], isFigmaNode, "result"), [shared, shared]);
});
