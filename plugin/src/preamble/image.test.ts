// Images (Phase 3, sandbox side): flcm.image is an inert paint value; the render path resolves it to a
// plugin ImagePaint from bytes the server injects on globalThis, and persists a placeholder flag on the
// node. The server fetch + re-execute loop is Phase 3.2 — here we drive the sandbox half directly against
// the in-memory figma mock (which models createImage/base64Decode) and by setting the injection global.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { image, rect, ellipse, frame, text, render } from "./flcm.js";

createFigmaMock();

// Run `render` with image bytes injected the way the server will (globalThis.__flcmImageBytes, url→base64),
// cleaning the global up after so tests don't leak the injection into one another.
async function renderWithBytes(tree, bytes) {
  globalThis.__flcmImageBytes = bytes;
  try {
    return await render(tree);
  } finally {
    delete globalThis.__flcmImageBytes;
  }
}

const B64 = Buffer.from("fake-image-bytes").toString("base64");

test("flcm.image builds an inert image PaintSpec with FILL/placeholder defaults", () => {
  const spec = image("https://cdn.example.com/a.jpg");
  assert.deepEqual(spec, { kind: "image", url: "https://cdn.example.com/a.jpg", scaleMode: "FILL", placeholder: false });
});

test("flcm.image carries scaleMode + placeholder overrides", () => {
  const spec = image("https://cdn.example.com/a.jpg", { scaleMode: "CROP", placeholder: true });
  assert.equal(spec.scaleMode, "CROP");
  assert.equal(spec.placeholder, true);
});

test("flcm.image rejects a non-string/empty url and a bad scaleMode (fail loud)", () => {
  assert.throws(() => image(42), /expected an image url string/);
  assert.throws(() => image("   "), /expected an image url string/);
  assert.throws(() => image("https://x/y.jpg", { scaleMode: "STRETCH" } as never), /scaleMode must be one of/);
});

test("render signals imagesNeeded — deduped across the tree — before creating any node", async () => {
  const shared = "https://cdn.example.com/photo.jpg";
  const other = "https://cdn.example.com/avatar.jpg";
  // `shared` appears twice (two rects) and `other` once — the signal must dedupe to one entry per url so the
  // server never fetches the same url twice.
  const tree = frame({ layout: { mode: "column" } }, [
    rect({ width: 100, height: 100, fill: image(shared) }),
    rect({ width: 100, height: 100, fill: image(shared) }),
    ellipse({ width: 40, height: 40, fill: image(other) }),
  ]);
  // Nothing is created before the throw — assert the page's child count is unchanged across the render (the
  // mock's page accumulates across tests, so compare to the pre-render count rather than to zero).
  const before = figma.currentPage.children.length;
  await assert.rejects(
    render(tree),
    (err: Error & { __flcmImagesNeeded?: string[] }) => {
      assert.deepEqual([...(err.__flcmImagesNeeded ?? [])].sort(), [other, shared]);
      assert.equal(figma.currentPage.children.length, before);
      return true;
    },
  );
});

test("an image on a text run is collected for fetch and resolves through paintOf (no internal-error leak)", async () => {
  const url = "https://cdn.example.com/glyph.jpg";
  const runs = () => text([["hi", { color: image(url) }]], { textStyle: { fontSize: 20 } });
  // Collected for fetch: a run-fill image reaches the imagesNeeded signal like any other paint site.
  await assert.rejects(render(runs()), (err: Error & { __flcmImagesNeeded?: string[] }) => {
    assert.deepEqual(err.__flcmImagesNeeded, [url]);
    return true;
  });
  // Resolves: with bytes present the run fill becomes an IMAGE paint, not the "reached toFigmaPaint" throw.
  const out = await renderWithBytes(runs(), { [url]: B64 });
  const node = await figma.getNodeByIdAsync(out.root.id);
  assert.equal(node._rangeFills[0].value[0].type, "IMAGE");
});

test("render resolves an image fill to an IMAGE paint and stamps placeholder pluginData", async () => {
  const url = "https://cdn.example.com/photo.jpg";
  const out = await renderWithBytes(rect({ width: 200, height: 120, fill: image(url, { scaleMode: "CROP", placeholder: true }) }), { [url]: B64 });
  const node = await figma.getNodeByIdAsync(out.root.id);
  assert.equal(node.fills.length, 1);
  assert.equal(node.fills[0].type, "IMAGE");
  assert.equal(node.fills[0].scaleMode, "CROP");
  assert.ok(node.fills[0].imageHash, "an image paint carries an imageHash from figma.createImage");
  assert.deepEqual(JSON.parse(node.getPluginData("flcm/image")), { url, placeholder: true });
});

test("a real (non-placeholder) image still records its src for read-back", async () => {
  const url = "https://cdn.example.com/avatar.jpg";
  const out = await renderWithBytes(ellipse({ width: 48, height: 48, fill: image(url) }), { [url]: B64 });
  const node = await figma.getNodeByIdAsync(out.root.id);
  assert.deepEqual(JSON.parse(node.getPluginData("flcm/image")), { url, placeholder: false });
});
