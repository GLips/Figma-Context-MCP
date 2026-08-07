// The local-file half of the image trust boundary: readLocalImage's asset-root containment. The root
// check is THE control here — "read a file the plugin names" is an arbitrary-file-read primitive
// without it — so both escape shapes it must defeat (`../` traversal and a symlink pointing out of
// the root) are pinned against a real tmpdir. macOS's /tmp→/private/tmp symlink means these tests
// also exercise the root-realpath step for free.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { isLocalImageSource, readLocalImage } from "~/services/plugin-bridge/images.js";

const Jimp = createJimp({ formats: [png] });

async function makePng(width: number, height: number): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color: 0xff0000ff });
  return new Uint8Array(await image.getBuffer("image/png"));
}

test("isLocalImageSource: http(s) urls are remote, everything else is a local path", () => {
  assert.equal(isLocalImageSource("https://cdn.example.com/a.png"), false);
  assert.equal(isLocalImageSource("HTTP://cdn.example.com/a.png"), false);
  assert.equal(isLocalImageSource("assets/logo.png"), true);
  assert.equal(isLocalImageSource("./logo.png"), true);
  assert.equal(isLocalImageSource("/abs/path/logo.png"), true);
});

test("readLocalImage: a real png inside the root round-trips to base64", async () => {
  const root = await mkdtemp(join(tmpdir(), "flcm-assets-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "logo.png"), await makePng(4, 4));
    const b64 = await readLocalImage("assets/logo.png", root);
    assert.ok(b64.length > 0);
    assert.deepEqual(
      new Uint8Array(Buffer.from(b64, "base64").slice(0, 4)),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "returns png bytes",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readLocalImage: `../` traversal to a file outside the root is refused, naming the root", async () => {
  const outer = await mkdtemp(join(tmpdir(), "flcm-outer-"));
  try {
    const root = join(outer, "root");
    await mkdir(root);
    await writeFile(join(outer, "secret.png"), await makePng(4, 4));
    await assert.rejects(
      readLocalImage("../secret.png", root),
      (err: Error) => err.message.includes("outside the asset root") && err.message.includes(root),
    );
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("readLocalImage: a symlink inside the root pointing outside is refused, naming the root", async () => {
  const outer = await mkdtemp(join(tmpdir(), "flcm-outer-"));
  try {
    const root = join(outer, "root");
    await mkdir(root);
    await writeFile(join(outer, "secret.png"), await makePng(4, 4));
    await symlink(join(outer, "secret.png"), join(root, "innocent.png"));
    await assert.rejects(
      readLocalImage("innocent.png", root),
      (err: Error) => err.message.includes("outside the asset root") && err.message.includes(root),
    );
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("readLocalImage: a missing file fails naming the root, not a bare ENOENT", async () => {
  const root = await mkdtemp(join(tmpdir(), "flcm-assets-"));
  try {
    await assert.rejects(
      readLocalImage("nope.png", root),
      (err: Error) =>
        err.message.includes("no such file under the asset root") && err.message.includes(root),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
