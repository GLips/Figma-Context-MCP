import { test } from "node:test";
import assert from "node:assert/strict";
import { captureScreenshot, contextualBounds } from "./screenshot-capture.js";

function fixture(exporter: () => Promise<Uint8Array> = async () => new Uint8Array([1])) {
  const page = { type: "PAGE", parent: null };
  let created = 0;
  const slice = { removed: false, name: "", x: 0, y: 0, width: 0, height: 0,
    resize(w: number, h: number) { this.width = w; this.height = h; },
    remove() { this.removed = true; }, exportAsync: exporter };
  Object.assign(globalThis, { figma: { currentPage: page, createSlice() { created++; return slice; } } });
  const node = { type: "FRAME", id: "1", parent: page, absoluteBoundingBox: { x: 100, y: 200, width: 300, height: 100 }, exportAsync: exporter } as unknown as BaseNode;
  return { node, page, slice, count: () => created };
}

test("provisional margins use proportional min/max bounds and explicit zero", () => {
  assert.deepEqual(contextualBounds({ x: 0, y: 0, width: 10, height: 20 }), { x: -24, y: -24, width: 58, height: 68 });
  assert.equal(contextualBounds({ x: 0, y: 0, width: 500, height: 20 }).x, -50);
  assert.equal(contextualBounds({ x: 0, y: 0, width: 5000, height: 20 }).x, -160);
  assert.equal(contextualBounds({ x: 0, y: 0, width: 500, height: 20 }, 0).width, 500);
  assert.throws(() => contextualBounds({ x: 0, y: 0, width: 500, height: 20 }, Infinity), /finite/);
});

test("isolated export remains unchanged; contextual capture cleans its region", async () => {
  const f = fixture();
  await captureScreenshot(f.node, {});
  assert.equal(f.count(), 0);
  const bytes = await captureScreenshot(f.node, { context: true, margin: 20 });
  assert.deepEqual(bytes, new Uint8Array([1]));
  assert.deepEqual([f.slice.x, f.slice.y, f.slice.width, f.slice.height], [80, 180, 340, 140]);
  assert.equal(f.slice.removed, true);
});

test("cleanup runs after export rejection, resize failure and mid-export cancellation", async () => {
  const failed = fixture(async () => { throw Error("export failed"); });
  await assert.rejects(captureScreenshot(failed.node, { context: true }), /export failed/);
  assert.equal(failed.slice.removed, true);
  const resized = fixture();
  resized.slice.resize = () => { throw Error("resize failed"); };
  await assert.rejects(captureScreenshot(resized.node, { context: true }), /resize failed/);
  assert.equal(resized.slice.removed, true);
  let cancelled = false;
  const mid = fixture(async () => { cancelled = true; return new Uint8Array([1]); });
  await assert.rejects(captureScreenshot(mid.node, { context: true }, () => cancelled), /cancelled/);
  assert.equal(mid.slice.removed, true);
});

test("invalid context and queued cancellation create no slice", async () => {
  const f = fixture();
  await assert.rejects(captureScreenshot(f.node, { margin: 4 }), /requires context/);
  await assert.rejects(captureScreenshot(f.node, { context: true }, () => true), /cancelled/);
  await assert.rejects(captureScreenshot(f.page as unknown as BaseNode, { context: true }), /scene node/);
  assert.equal(f.count(), 0);
});
