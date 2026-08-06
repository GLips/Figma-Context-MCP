// Wire serialization: a live node collapses (and is rejected on the return path), but every handle / read
// POJO must round-trip WHOLE — no shape-collapse, no depth/array truncation. This is the Phase-1 contract
// that lets the read verbs return deep canonical shapes across the bridge intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeSerialize, guardReturnValue, looksLikeNode } from "./serialize.js";

// A live node is anything carrying id + type + `removed` (present on every BaseNode). We fake the SHAPE the
// discriminator keys on — serialize.ts never touches figma.*, so a POJO with these fields IS a "live node".
const liveNode = { id: "12:34", type: "FRAME", name: "Card", removed: false, characters: "x", parent: {} };

test("a live node collapses to { id, name, type } — its huge/circular internals never serialize", () => {
  assert.deepEqual(safeSerialize(liveNode), { id: "12:34", name: "Card", type: "FRAME" });
});

test("looksLikeNode fires on a live node but not on a handle/read POJO (id+type but no `removed`)", () => {
  assert.equal(looksLikeNode(liveNode), true);
  assert.equal(looksLikeNode({ id: "1:2", type: "FRAME", name: "x" }), false);
  assert.equal(looksLikeNode({ foo: 1 }), false);
});

test("a render Handle round-trips WHOLE — geometry and key survive (the old id+type collapse dropped them)", () => {
  const handle = { id: "1:2", type: "TEXT", name: "Title", key: "title", text: "Hi", width: 100, height: 20, left: 0, top: 0 };
  assert.deepEqual(safeSerialize(handle), handle);
});

test("a slim-handle-shaped POJO round-trips whole", () => {
  const slim = { id: "1:2", type: "FRAME", name: "Row", width: "fill", height: 44, layout: { mode: "row" }, childCount: 3 };
  assert.deepEqual(safeSerialize(slim), slim);
});

test("a deep full read-shape POJO round-trips whole — no depth truncation", () => {
  // A nested frame tree well past the old depth-4 cap.
  let node: Record<string, unknown> = { id: "leaf", type: "TEXT", name: "deep", characters: "end" };
  for (let i = 0; i < 30; i++) {
    node = { id: `f${i}`, type: "FRAME", name: `frame-${i}`, layout: { mode: "column", padding: { top: i } }, children: [node] };
  }
  assert.deepEqual(safeSerialize(node), node);
});

test("a long array round-trips whole — no 100-element truncation", () => {
  const arr = Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, type: "RECTANGLE", name: `r${i}` }));
  const out = safeSerialize(arr) as unknown[];
  assert.equal(out.length, 250);
  assert.deepEqual(out[249], arr[249]);
});

test("a cyclic structure terminates at the backstop instead of overflowing the stack", () => {
  const a: Record<string, unknown> = { name: "cycle" };
  a.self = a;
  // No throw, no overflow — the deep chain bottoms out in the depth backstop sentinel.
  assert.doesNotThrow(() => safeSerialize(a));
});

test("guardReturnValue rejects a returned live node, naming its path and the id fix", () => {
  assert.throws(() => guardReturnValue({ ok: true, node: liveNode }), /live Figma node.*\.node.*return node\.id/s);
});

test("guardReturnValue passes a pure read POJO through (no `removed` anywhere)", () => {
  assert.doesNotThrow(() => guardReturnValue({ id: "1:2", type: "FRAME", name: "x", children: [{ id: "3:4", type: "TEXT", name: "y" }] }));
});
