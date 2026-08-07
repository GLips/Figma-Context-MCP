// Images, sandbox side: flcm.image is an inert paint value; render() batches every image url into
// ONE deduped mid-run request (protocol 2), awaits the bytes, and resolves each spec to a plugin
// ImagePaint. The channel is the host-installed __flcmRequestImages free identifier — in the live
// plugin it's the parameter of the eval'd wrapper executeCode builds; here (plain import → module
// scope chains to global) we install it on globalThis, exactly as the dogfood harness does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { image, rect, ellipse, frame, text, render } from "./flcm.js";

createFigmaMock();

const B64 = Buffer.from("fake-image-bytes").toString("base64");

// Run `render` with a host image channel installed, recording each batch of urls it requests.
// Cleans the global up after so tests don't leak the channel into one another.
async function renderWithImages(
  tree: Parameters<typeof render>[0],
  respond: (urls: string[]) => Promise<Record<string, string>>,
): Promise<{ out: Awaited<ReturnType<typeof render>>; batches: string[][] }> {
  const batches: string[][] = [];
  const g = globalThis as { __flcmRequestImages?: unknown };
  g.__flcmRequestImages = async (urls: string[]) => {
    batches.push(urls);
    return respond(urls);
  };
  try {
    return { out: await render(tree), batches };
  } finally {
    delete g.__flcmRequestImages;
  }
}

const bytesFor = (urls: string[]) => Object.fromEntries(urls.map((u) => [u, B64]));

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

test("render issues ONE deduped image request per run, before creating any node", async () => {
  const shared = "https://cdn.example.com/photo.jpg";
  const other = "https://cdn.example.com/avatar.jpg";
  // `shared` appears twice (two rects) and `other` once — the single batch must dedupe to one entry
  // per url so the server never fetches the same url twice in a run.
  const tree = frame({ layout: { mode: "column" } }, [
    rect({ width: 100, height: 100, fill: image(shared) }),
    rect({ width: 100, height: 100, fill: image(shared) }),
    ellipse({ width: 40, height: 40, fill: image(other) }),
  ]);
  const before = figma.currentPage.children.length;
  let childrenAtFetch = -1;
  const { batches } = await renderWithImages(tree, async (urls) => {
    // The await happens BEFORE any node exists — a fetch failure must leave zero canvas writes.
    childrenAtFetch = figma.currentPage.children.length;
    return bytesFor(urls);
  });
  assert.equal(batches.length, 1, "exactly one image request per render");
  assert.deepEqual([...batches[0]].sort(), [other, shared]);
  assert.equal(childrenAtFetch, before, "no node was created before the image bytes resolved");
});

test("a failed image fetch rejects the render with zero canvas writes", async () => {
  const before = figma.currentPage.children.length;
  await assert.rejects(
    renderWithImages(rect({ width: 10, height: 10, fill: image("https://cdn.example.com/blocked.jpg") }), async () => {
      throw new Error('flcm.image could not load "https://cdn.example.com/blocked.jpg": blocked range');
    }),
    /could not load/,
  );
  assert.equal(figma.currentPage.children.length, before, "a failed fetch created nothing");
});

test("render without a host image channel fails loud naming the channel", async () => {
  await assert.rejects(
    render(rect({ width: 10, height: 10, fill: image("https://cdn.example.com/a.jpg") })),
    /no image channel \(__flcmRequestImages\)/,
  );
});

test("an image on a text run is collected for fetch and resolves through paintOf (no internal-error leak)", async () => {
  const url = "https://cdn.example.com/glyph.jpg";
  const runs = text([["hi", { color: image(url) }]], { textStyle: { fontSize: 20 } });
  const { out, batches } = await renderWithImages(runs, bytesFor);
  assert.deepEqual(batches, [[url]], "a run-fill image reaches the batched request like any other paint site");
  const node = await figma.getNodeByIdAsync(out.root.id);
  assert.equal(node._rangeFills[0].value[0].type, "IMAGE");
});

test("render resolves an image fill to an IMAGE paint and stamps placeholder pluginData", async () => {
  const url = "https://cdn.example.com/photo.jpg";
  const { out } = await renderWithImages(
    rect({ width: 200, height: 120, fill: image(url, { scaleMode: "CROP", placeholder: true }) }),
    bytesFor,
  );
  const node = await figma.getNodeByIdAsync(out.root.id);
  assert.equal(node.fills.length, 1);
  assert.equal(node.fills[0].type, "IMAGE");
  assert.equal(node.fills[0].scaleMode, "CROP");
  assert.ok(node.fills[0].imageHash, "an image paint carries an imageHash from figma.createImage");
  assert.deepEqual(JSON.parse(node.getPluginData("flcm/image")), { url, placeholder: true });
});

test("a real (non-placeholder) image still records its src for read-back", async () => {
  const url = "https://cdn.example.com/avatar.jpg";
  const { out } = await renderWithImages(ellipse({ width: 48, height: 48, fill: image(url) }), bytesFor);
  const node = await figma.getNodeByIdAsync(out.root.id);
  assert.deepEqual(JSON.parse(node.getPluginData("flcm/image")), { url, placeholder: false });
});
