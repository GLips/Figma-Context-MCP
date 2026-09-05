// The local-file half of the image trust boundary: the asset-root containment and the contained
// read. The root check is THE control here — "read a file the plugin names" is an arbitrary-file-read
// primitive without it — so both escape shapes it must defeat (`../` traversal and a symlink pointing
// out of the root) are pinned against a real tmpdir, as are the read's own refusals (non-file objects,
// oversize). macOS's /tmp→/private/tmp symlink means these tests also exercise the root-realpath step
// for free.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { isLocalImageSource, createLocalImageReader } from "~/services/plugin-bridge/images.js";

const Jimp = createJimp({ formats: [png] });

async function makePng(width: number, height: number): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color: 0xff0000ff });
  return new Uint8Array(await image.getBuffer("image/png"));
}

/** Run `body` against a fresh tmp root, cleaning up whatever it created. */
async function withRoot(body: (root: string, outer: string) => Promise<void>): Promise<void> {
  const outer = await mkdtemp(join(tmpdir(), "flcm-assets-"));
  const root = join(outer, "root");
  await mkdir(root);
  try {
    await body(root, outer);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
}

const refusesOutsideRoot = (root: string) => (err: Error) =>
  err.message.includes("outside the asset root") && err.message.includes(root);

test("isLocalImageSource: http(s) urls are remote, everything else is a local path", () => {
  assert.equal(isLocalImageSource("https://cdn.example.com/a.png"), false);
  assert.equal(isLocalImageSource("HTTP://cdn.example.com/a.png"), false);
  assert.equal(isLocalImageSource("assets/logo.png"), true);
  assert.equal(isLocalImageSource("./logo.png"), true);
  assert.equal(isLocalImageSource("/abs/path/logo.png"), true);
});

test("a real png inside the root round-trips to base64", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "logo.png"), await makePng(4, 4));
    const b64 = await createLocalImageReader(root)("assets/logo.png");
    assert.deepEqual(
      new Uint8Array(Buffer.from(b64, "base64").subarray(0, 4)),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "returns png bytes",
    );
  });
});

test("`../` traversal to a file outside the root is refused, naming the root", async () => {
  await withRoot(async (root, outer) => {
    await writeFile(join(outer, "secret.png"), await makePng(4, 4));
    await assert.rejects(createLocalImageReader(root)("../secret.png"), refusesOutsideRoot(root));
  });
});

test("an absolute path outside the root is refused (path.resolve keeps it absolute)", async () => {
  await withRoot(async (root, outer) => {
    const secret = join(outer, "secret.png");
    await writeFile(secret, await makePng(4, 4));
    await assert.rejects(createLocalImageReader(root)(secret), refusesOutsideRoot(root));
  });
});

test("a symlink inside the root pointing outside is refused, naming the root", async () => {
  await withRoot(async (root, outer) => {
    await writeFile(join(outer, "secret.png"), await makePng(4, 4));
    await symlink(join(outer, "secret.png"), join(root, "innocent.png"));
    await assert.rejects(createLocalImageReader(root)("innocent.png"), refusesOutsideRoot(root));
  });
});

test("a symlink inside the root pointing back inside it still resolves", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "real.png"), await makePng(4, 4));
    await symlink(join(root, "real.png"), join(root, "alias.png"));
    const b64 = await createLocalImageReader(root)("alias.png");
    assert.ok(b64.length > 0, "a contained symlink is a legitimate asset, not an escape");
  });
});

test("a directory is refused by the open handle's own stat, not by a path check", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "assets"));
    await assert.rejects(createLocalImageReader(root)("assets"), /is not a file/);
  });
});

test("a file over the byte cap is refused by the bounded read", async () => {
  await withRoot(async (root) => {
    // 13MiB of zeros — past MAX_BYTES (12MiB), so the read stops at the cap-sized buffer and the
    // (cap + 1)th byte is what proves it was over. Never reaches the decoder.
    await writeFile(join(root, "huge.png"), Buffer.alloc(13 * 1024 * 1024));
    await assert.rejects(createLocalImageReader(root)("huge.png"), /over the \d+-byte cap/);
  });
});

test("a missing file fails naming the root, not a bare ENOENT", async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      createLocalImageReader(root)("nope.png"),
      (err: Error) =>
        err.message.includes("no such file under the asset root") && err.message.includes(root),
    );
  });
});

test("the canonical root is pinned once, so retargeting a root symlink can't move the boundary", async () => {
  await withRoot(async (outerRoot, outer) => {
    const realA = join(outer, "a");
    const realB = join(outer, "b");
    await mkdir(realA);
    await mkdir(realB);
    await writeFile(join(realA, "logo.png"), await makePng(4, 4));
    await writeFile(join(realB, "logo.png"), await makePng(8, 8));
    const rootLink = join(outerRoot, "link");
    await symlink(realA, rootLink);

    const read = createLocalImageReader(rootLink);
    await read("logo.png"); // pins realA as the boundary

    // Retarget the root at b/ and remove a/'s copy: if the root were re-resolved per request, this
    // read would now succeed out of b/. Pinned, it looks in a/ and finds nothing.
    await rm(join(realA, "logo.png"));
    await rm(rootLink);
    await symlink(realB, rootLink);
    await assert.rejects(read("logo.png"), /no such file under the asset root/);
  });
});
