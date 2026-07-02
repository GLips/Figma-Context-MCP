// The server-side image trust boundary (Phase 3.2). The full guardedFetch needs the network, but its two
// load-bearing guards are testable off-network: isBlockedAddress (SSRF range classification — the whole
// point of the guard) against literal IPs, and processImageBytes (magic-byte type check + 4096px downscale)
// against jimp-built buffers. A regression in either is exactly the silent-hole class the guard exists to
// stop, so both earn a test. The DNS/redirect/streaming plumbing around them is verified by hand + review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { isBlockedAddress, processImageBytes } from "./images.js";

const Jimp = createJimp({ formats: [png] });

async function makePng(width: number, height: number): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color: 0xff0000ff });
  return new Uint8Array(await image.getBuffer("image/png"));
}

test("isBlockedAddress blocks loopback, private, link-local, CGNAT, and v4-mapped-v6 — allows public", () => {
  // Blocked: every non-public unicast range an SSRF would target.
  for (const ip of [
    "127.0.0.1", // loopback
    "10.0.0.1", // private A
    "172.16.5.4", // private B
    "192.168.1.1", // private C
    "169.254.10.10", // link-local
    "100.64.0.1", // carrier-grade NAT
    "0.0.0.0", // unspecified
    "::1", // v6 loopback
    "fe80::1", // v6 link-local
    "fc00::1", // v6 unique-local
    "::ffff:10.0.0.1", // private v4 smuggled as v4-mapped v6
  ]) {
    assert.equal(isBlockedAddress(ip), true, `expected ${ip} blocked`);
  }
  // Allowed: real public hosts (a CDN, a DNS resolver, a v6 unicast).
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, `expected ${ip} allowed`);
  }
});

test("processImageBytes rejects a non-image payload by magic bytes", async () => {
  await assert.rejects(() => processImageBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /magic-byte check failed/);
  // An HTML error page served with a 200 must not pass as an image.
  await assert.rejects(() => processImageBytes(new TextEncoder().encode("<!DOCTYPE html><html>...")), /not a PNG/);
});

test("processImageBytes passes an in-bounds image through byte-for-byte", async () => {
  const bytes = await makePng(64, 48);
  const b64 = await processImageBytes(bytes);
  assert.equal(b64, Buffer.from(bytes).toString("base64"), "in-bounds image should not be re-encoded");
});

test("processImageBytes downscales an oversize image's longest side to the 4096 cap", async () => {
  // 5000x2000 → longest side clamped to 4096, aspect ratio preserved.
  const b64 = await processImageBytes(await makePng(5000, 2000));
  const out = await Jimp.fromBuffer(Buffer.from(b64, "base64"));
  assert.equal(out.width, 4096);
  assert.equal(out.height, Math.round(2000 * (4096 / 5000)));
});

test("processImageBytes rejects a decompression bomb by header dimensions before decoding", async () => {
  // A tiny compressed PNG that DECLARES 8000×8000 (64MP, over the 30MP cap). We don't decode a real 64MP
  // raster — we forge a valid 8-byte signature + IHDR width/height and assert the header check fires first.
  const bomb = new Uint8Array(24);
  bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
  new DataView(bomb.buffer).setUint32(16, 8000); // IHDR width
  new DataView(bomb.buffer).setUint32(20, 8000); // IHDR height
  await assert.rejects(() => processImageBytes(bomb), /over the 30MP decode cap/);
});
