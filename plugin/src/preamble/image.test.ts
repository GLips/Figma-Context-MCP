// Images, sandbox side: flcm.image is a plain paint value; render() batches every image url into
// ONE deduped mid-run request (protocol 2), awaits the bytes, and resolves each paint to a plugin
// ImagePaint. The channel is FlcmHost.requestImages, off the host-installed __flcmHost — in the live
// plugin it's the parameter of the eval'd wrapper executeCode builds; here (plain import → module
// scope chains to global) we install it on globalThis, exactly as the dogfood harness does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { image, gradient as flcmGradient } from "./flcm.js";
import { render } from "./render.js";

createFigmaMock();

const B64 = Buffer.from("fake-image-bytes").toString("base64");

// Run `render` with a host image channel installed, recording each batch of urls it requests.
// Cleans the global up after so tests don't leak the channel into one another.
async function renderWithImages(
  tree: Parameters<typeof render>[0],
  respond: (urls: string[]) => Promise<Record<string, string>>,
): Promise<{ out: Awaited<ReturnType<typeof render>>; batches: string[][] }> {
  const batches: string[][] = [];
  const g = globalThis as { __flcmHost?: unknown };
  g.__flcmHost = { registerRead() {},
    requestImages: async (urls: string[]) => {
      batches.push(urls);
      return respond(urls);
    },
    isRunCancelled: () => false, isRunFinished: () => false,
  };
  try {
    return { out: await render(tree), batches };
  } finally {
    delete g.__flcmHost;
  }
}

const bytesFor = (urls: string[]) => Object.fromEntries(urls.map((u) => [u, B64]));

test("flcm.image builds an image WritePaint with FILL/placeholder defaults", () => {
  const paint = image("https://cdn.example.com/a.jpg");
  assert.deepEqual(paint, {
    kind: "image",
    url: "https://cdn.example.com/a.jpg",
    scaleMode: "FILL",
    placeholder: false,
  });
});

test("flcm.image carries scaleMode + placeholder overrides", () => {
  const paint = image("https://cdn.example.com/a.jpg", { scaleMode: "CROP", placeholder: true });
  assert.equal(paint.scaleMode, "CROP");
  assert.equal(paint.placeholder, true);
});

test("flcm.image rejects a non-string/empty url and a bad scaleMode (fail loud)", () => {
  assert.throws(() => image(42), /expected an image url or local file path/);
  assert.throws(() => image("   "), /expected an image url or local file path/);
  assert.throws(
    () => image("https://x/y.jpg", { scaleMode: "STRETCH" } as never),
    /scaleMode must be one of/,
  );
});

test("render issues ONE deduped image request per run, before creating any node", async () => {
  const shared = "https://cdn.example.com/photo.jpg";
  const other = "https://cdn.example.com/avatar.jpg";
  // `shared` appears twice (two rects) and `other` once — the single batch must dedupe to one entry
  // per url so the server never fetches the same url twice in a run.
  const tree = {
    type: "FRAME",
    layout: { mode: "column" },
    children: [
      { type: "RECTANGLE", width: 100, height: 100, fill: image(shared) },
      { type: "RECTANGLE", width: 100, height: 100, fill: image(shared) },
      { type: "ELLIPSE", width: 40, height: 40, fill: image(other) },
    ],
  };
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
    renderWithImages(
      {
        type: "RECTANGLE",
        width: 10,
        height: 10,
        fill: image("https://cdn.example.com/blocked.jpg"),
      },
      async () => {
        throw new Error(
          'flcm.image could not load "https://cdn.example.com/blocked.jpg": blocked range',
        );
      },
    ),
    /could not load/,
  );
  assert.equal(figma.currentPage.children.length, before, "a failed fetch created nothing");
});

test("render without a host fails loud naming what is missing", async () => {
  await assert.rejects(
    render({
      type: "RECTANGLE",
      width: 10,
      height: 10,
      fill: image("https://cdn.example.com/a.jpg"),
    }),
    /no host \(FlcmHost\)/,
  );
});

test("an image on a text run is collected for fetch and resolves through paintOf (no internal-error leak)", async () => {
  const url = "https://cdn.example.com/glyph.jpg";
  const runs = { type: "TEXT", text: [["hi", { color: image(url) }]], textStyle: { fontSize: 20 } };
  const { out, batches } = await renderWithImages(runs, bytesFor);
  assert.deepEqual(
    batches,
    [[url]],
    "a run-fill image reaches the batched request like any other paint site",
  );
  const node = await figma.getNodeByIdAsync(out.id);
  assert.equal(node._rangeFills[0].value[0].type, "IMAGE");
});

test("render resolves an image fill to an IMAGE paint and stamps placeholder pluginData", async () => {
  const url = "https://cdn.example.com/photo.jpg";
  const { out } = await renderWithImages(
    {
      type: "RECTANGLE",
      width: 200,
      height: 120,
      fill: image(url, { scaleMode: "CROP", placeholder: true }),
    },
    bytesFor,
  );
  const node = await figma.getNodeByIdAsync(out.id);
  assert.equal(node.fills.length, 1);
  assert.equal(node.fills[0].type, "IMAGE");
  assert.equal(node.fills[0].scaleMode, "CROP");
  assert.ok(node.fills[0].imageHash, "an image paint carries an imageHash from figma.createImage");
  assert.deepEqual(JSON.parse(node.getPluginData("flcm/image")), { url, placeholder: true });
});

test("a real (non-placeholder) image still records its src for read-back", async () => {
  const url = "https://cdn.example.com/avatar.jpg";
  const { out } = await renderWithImages(
    { type: "ELLIPSE", width: 48, height: 48, fill: image(url) },
    bytesFor,
  );
  const node = await figma.getNodeByIdAsync(out.id);
  assert.deepEqual(JSON.parse(node.getPluginData("flcm/image")), { url, placeholder: false });
});

// ---- Read-form image fills (Phase 5.2). A `get` result names an image by the imageHash already in
// the document, so rebuilding it needs no server round trip and no url the agent never had. ----

test("a read-form image fill paints from the live hash — no fetch, no channel needed", async () => {
  // No __flcmHost installed: reaching the fetch at all would fail loud, which is the point.
  const out = await render({
    type: "RECTANGLE",
    width: 200,
    height: 120,
    fill: { type: "IMAGE", imageRef: "abc123hash", scaleMode: "FILL" },
  });
  const node = await figma.getNodeByIdAsync(out.id);
  assert.deepEqual(node.fills[0], { type: "IMAGE", scaleMode: "FILL", imageHash: "abc123hash" });
  // Nothing to record: the read shape carries no source url, and a stale one would name the wrong asset.
  assert.equal(node.getPluginData("flcm/image"), "");
});

test("a TILE read fill keeps its repeat scale; STRETCH and a ref-less fill fail loud", async () => {
  const tiled = await render({
    type: "RECTANGLE",
    fill: { type: "IMAGE", imageRef: "tile1", scaleMode: "TILE", scalingFactor: 0.5 },
  });
  assert.equal((await figma.getNodeByIdAsync(tiled.id)).fills[0].scalingFactor, 0.5);
  // STRETCH is the read spelling of the plugin's CROP, whose crop lives in a transform matrix the
  // read shape never surfaces — reproducing it would silently un-crop the image.
  await assert.rejects(
    render({ type: "RECTANGLE", fill: { type: "IMAGE", imageRef: "x", scaleMode: "STRETCH" } }),
    /cropped image fill .* flcm\.clone/s,
  );
  // A null imageRef (an asset living in a file you don't own) leaves nothing to point at.
  await assert.rejects(
    render({ type: "RECTANGLE", fill: { type: "IMAGE", scaleMode: "FILL" } }),
    /no imageRef/,
  );
  // An animated GIF carries BOTH refs, and its imageRef is only the static snapshot frame — the one
  // path that looks like it works is exactly the one that drops the animation.
  await assert.rejects(
    render({
      type: "RECTANGLE",
      fill: { type: "IMAGE", imageRef: "frame1", gifRef: "gif1", scaleMode: "FILL" },
    }),
    /animated GIF fill.*flcm\.clone/s,
  );
});

test("a paint slot takes an array — the stack, top first — and reverses it into Figma's order", async () => {
  const out = await render({ type: "RECTANGLE", fill: ["#112233"] });
  assert.equal((await figma.getNodeByIdAsync(out.id)).fills.length, 1);
  // An empty array is the read spelling of "no paint" — same as "none".
  const bare = await render({ type: "RECTANGLE", fill: [] });
  assert.deepEqual((await figma.getNodeByIdAsync(bare.id)).fills, []);
  // THE order contract: authored index 0 paints on top, and Figma stores the top paint LAST. A read
  // emits the same top-first order, so what `get` returns pastes straight back.
  const stacked = await render({
    type: "RECTANGLE",
    fill: ["linear-gradient(#fff, #000)", "#112233"],
  });
  const fills = (await figma.getNodeByIdAsync(stacked.id)).fills;
  assert.equal(fills.length, 2);
  assert.equal(fills[0].type, "SOLID", "the last authored entry is the bottom paint");
  assert.equal(fills[1].type, "GRADIENT_LINEAR", "the first authored entry paints on top");
  // A bad entry is named by its AUTHORED index, not by where it lands in Figma's storage order.
  await assert.rejects(render({ type: "RECTANGLE", fill: ["#000", 42] }), /fill\[1\] must be a color string/);
});

test("a scrim over a photo keeps the photo's provenance, wherever it sits in the stack", async () => {
  const url = "https://cdn.example.com/hero.jpg";
  const { out, batches } = await renderWithImages(
    {
      type: "RECTANGLE",
      width: 390,
      height: 260,
      fill: [flcmGradient({ stops: ["rgba(0,0,0,0)", "rgba(0,0,0,0.65)"], angle: 180 }), image(url)],
    },
    bytesFor,
  );
  assert.deepEqual(batches, [[url]], "every paint in the stack is a fetch site, not just entry 0");
  const node = await figma.getNodeByIdAsync(out.id);
  assert.equal(node.fills[0].type, "IMAGE", "the photo is the bottom paint");
  assert.equal(node.fills[1].type, "GRADIENT_LINEAR", "the scrim paints over it");
  // The image is entry 1 of the authored stack; provenance follows the image, not the index.
  assert.deepEqual(JSON.parse(node.getPluginData("flcm/image")), { url, placeholder: false });
});
