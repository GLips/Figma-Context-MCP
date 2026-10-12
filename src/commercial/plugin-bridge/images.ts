/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The trusted server-side image byte sources — the trust boundary in the write path. The Figma
// sandbox holds manifest allowedDomains:["none"] and can reach nothing, so agent-authored `flcm.image(src)`
// fills are inert until this module loads, validates, and downscales the bytes; the bridge answers the
// sandbox's mid-run CHANNEL_REQUEST with them (see image-requests.ts). Three sources feed one processing
// pipeline: an http(s) url through the guarded fetch (SSRF ranges, byte cap, redirect re-guarding), a
// LOCAL FILE PATH through readLocalImage, whose asset-root containment lives in contained-file.ts, and an
// upload handle, whose bytes went through processImageBytes at intake (image-intake.ts).
// Because the model — via the untrusted plugin — picks the source, every guard on both paths defends
// against a hostile one; "read a file the plugin names" is an arbitrary-file-read primitive unless the
// root check holds.
//
// Ported in spirit from production figma-mcp (downloadAndProcessImage/jimp), but the guard is net-new:
// figma-mcp only ever fetches from Figma's own trusted CDN, so it has no SSRF/type defense to port. jimp is
// the shared piece — the modular @jimp/* build, downscaling to Figma's 4096px createImage cap.
import { lookup } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch, type Response } from "undici";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import jpeg from "@jimp/js-jpeg";
import gif from "@jimp/js-gif";
import * as resize from "@jimp/plugin-resize";
import ipaddr from "ipaddr.js";
import { CLI_NAME } from "~/utils/cli-help.js";
import { OutsideAssetRootError, type ContainedFileReader } from "./contained-file.js";

const Jimp = createJimp({ formats: [png, jpeg, gif], plugins: [resize.methods] });

// Figma's createImage rejects any dimension over 4096px, so downscale the longest side to fit before the
// bytes ever leave the server — also the mitigation for the multi-MB-base64-over-loopback bridge-timeout risk.
const MAX_DIMENSION = 4096;
// Pre-downscale byte cap. Generous enough for a real photo, small enough that a hostile url can't stream us
// out of memory. Enforced by streaming, not by trusting the (spoofable, often-absent) Content-Length header.
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
// Decoded-pixel cap, enforced from the image HEADER before jimp decodes anything. MAX_IMAGE_BYTES bounds the
// COMPRESSED wire size but not the raster footprint: a highly compressible ~0.25MB PNG can declare 8000×8000
// and decode to ~244MB (RGBA), a decompression bomb that OOMs the trusted server well under the byte cap. So
// we read width×height from the header and reject over this budget (~30MP ≈ 120MB decoded) BEFORE decode —
// generous enough for a real high-res photo, small enough to defang the bomb.
const MAX_PIXELS = 30_000_000;
const FETCH_TIMEOUT_MS = 10_000;
// Redirects are followed manually so every hop gets the literal-IP check and a fresh validated dial.
// Bounded so a redirect loop can't spin forever.
const MAX_REDIRECTS = 3;

type ImageType = "image/png" | "image/jpeg" | "image/gif";

// Verify the payload is really a raster we support by its leading magic bytes — never by the url extension
// or a server-supplied Content-Type, both attacker-controlled. A url that 200s with an HTML error page or a
// disguised payload fails here instead of reaching figma.createImage as garbage.
function detectImageType(bytes: Uint8Array): ImageType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  return null;
}

// Read the declared pixel dimensions straight from the image header — cheap, and it runs BEFORE the full
// decode that a decompression bomb weaponizes (see MAX_PIXELS). Returns null when the header can't be read
// (an exotic/truncated variant), which the caller refuses: an image we can't size is one we can't bound.
function headerDimensions(
  bytes: Uint8Array,
  type: ImageType,
): { width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png") {
    // IHDR is always the first chunk after the 8-byte signature: [4 len][4 "IHDR"][4 width][4 height].
    if (bytes.length < 24) return null;
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (type === "image/gif") {
    // Logical Screen Descriptor follows the 6-byte header: canvas width/height as uint16 little-endian.
    if (bytes.length < 10) return null;
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  // JPEG: walk marker segments to the first Start-Of-Frame, which carries the dimensions.
  let offset = 2; // skip the SOI marker (FFD8)
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    // Any marker may be preceded by 0xFF fill bytes; step one byte so the last FF pairs with the marker.
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // SOF0..SOF15 hold [FF][marker][2 len][1 precision][2 height][2 width] — except DHT/JPG/DAC (C4/C8/CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: dv.getUint16(offset + 5), width: dv.getUint16(offset + 7) };
    }
    // Standalone markers (SOI/EOI/RSTn/TEM) carry no length payload — step over the 2 marker bytes.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      offset += 2;
      continue;
    }
    offset += 2 + dv.getUint16(offset + 2); // every other segment has a 2-byte big-endian length
  }
  return null;
}

// True for any address the sandbox has no business reaching through us: loopback, private (RFC1918), CGNAT,
// link-local, unique-local, multicast, reserved, unspecified — everything that isn't a public unicast host.
// An allowlist (block all but "unicast") is the safe default: a new reserved range is blocked by omission,
// never allowed by an out-of-date blocklist. IPv4-mapped IPv6 (::ffff:10.0.0.1) is unwrapped so it can't
// smuggle a private v4 past the v6 check.
export function isBlockedAddress(ip: string): boolean {
  const addr = ipaddr.parse(ip);
  if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) {
    return addr.toIPv4Address().range() !== "unicast";
  }
  return addr.range() !== "unicast";
}

function blockedAddressError(host: string, address: string): Error {
  return new Error(
    `host "${host}" resolves to a blocked (private/loopback/link-local) address ${address}`,
  );
}

// The socket's own DNS resolution, validated: every address the host resolves to must be public, and
// the socket dials only from that validated set. Validating inside the dial, rather than in a separate
// lookup beforehand, is what defeats DNS rebinding — there is no second resolution for a host to answer
// differently. A hostname with even one private record is refused outright.
const lookupPublicAddress: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const blocked = addresses.find(({ address }) => isBlockedAddress(address));
    if (blocked) return callback(blockedAddressError(hostname, blocked.address), "");
    if (addresses.length === 0)
      return callback(new Error(`could not resolve host "${hostname}"`), "");
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

// Dials direct, never through a proxy. Server startup may install a global proxy dispatcher for Figma
// API traffic (src/server.ts), and a proxy does its own DNS, out of reach of the lookup above. Cost: in a
// mandatory-egress-proxy environment flcm.image fails loudly; routing it through a proxy would need
// equivalent validation at the proxy's egress, which we can't do.
const directDispatcher = new Agent({ connect: { lookup: lookupPublicAddress } });

// A literal-IP host never reaches a lookup function (the socket dials it as written), so it is checked
// here. URL.hostname wraps an IPv6 literal in brackets, stripped before classifying it.
function assertPublicLiteralHost(hostname: string): void {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host)) throw blockedAddressError(host, host);
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a valid url: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `unsupported url scheme "${url.protocol}" — only http/https images are fetched`,
    );
  }
  return url;
}

// Drain the body with a hard cap, aborting the moment we cross it — so a url that lies about (or omits) its
// Content-Length still can't stream us past MAX_IMAGE_BYTES.
async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error(`image is ${declared} bytes, over the ${MAX_IMAGE_BYTES}-byte cap`);
  }
  if (!res.body) throw new Error("image response had no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error(`image exceeds the ${MAX_IMAGE_BYTES}-byte cap`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Guarded fetch: validate the url + host, follow redirects manually re-guarding each hop, and cap the read.
async function guardedFetch(rawUrl: string, signal?: AbortSignal): Promise<Uint8Array> {
  let target = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    signal?.throwIfAborted();
    const url = parseHttpUrl(target);
    assertPublicLiteralHost(url.hostname);
    const res = await fetch(url, {
      dispatcher: directDispatcher,
      redirect: "manual",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
        : AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch((err: unknown) => {
      // undici reports every connection failure as a bare "fetch failed" with the reason as `cause`;
      // surface the reason, which is what names a blocked host.
      throw err instanceof TypeError && err.cause instanceof Error ? err.cause : err;
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`redirect (${res.status}) with no Location header`);
      await res.body?.cancel();
      target = new URL(location, url).toString(); // re-guarded on the next loop iteration
      continue;
    }
    if (!res.ok) throw new Error(`fetch failed with status ${res.status}`);
    return await readCapped(res);
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

// Validate the payload type by magic bytes and downscale to the 4096px cap. Only re-encodes when a downscale
// actually happens — an in-bounds image passes through byte-for-byte, preserving its format (and a GIF's
// animation, which a jimp round-trip would flatten). Split from the fetch so it's unit-testable off-network.
export async function processImageBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const type = detectImageType(bytes);
  if (!type) throw new Error("payload is not a PNG, JPEG, or GIF (magic-byte check failed)");

  // Reject a decompression bomb from its header before jimp allocates the raster (see MAX_PIXELS).
  const dims = headerDimensions(bytes, type);
  // A zero side means "size declared later" (a JPEG SOF height of 0 defers to a DNL marker), so the cap
  // can't vouch for the decode — refuse it like a header we couldn't read.
  if (!dims || dims.width === 0 || dims.height === 0) {
    throw new Error("could not read the image's dimensions from its header");
  }
  if (dims.width * dims.height > MAX_PIXELS) {
    throw new Error(
      `image is ${dims.width}×${dims.height} (${Math.round((dims.width * dims.height) / 1e6)}MP), over the ` +
        `${Math.round(MAX_PIXELS / 1e6)}MP decode cap`,
    );
  }

  const buffer = Buffer.from(bytes);
  const image = await Jimp.fromBuffer(buffer);
  signal?.throwIfAborted();
  const { width, height } = image;
  if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
    return buffer.toString("base64");
  }
  // Scale the longer side to the cap; jimp derives the other side to preserve aspect ratio. A downscaled GIF
  // flattens to its first frame — acceptable for an oversize animation, which is an exotic case.
  const resized =
    width >= height ? image.resize({ w: MAX_DIMENSION }) : image.resize({ h: MAX_DIMENSION });
  const encoded = await resized.getBuffer(type === "image/gif" ? "image/png" : type);
  signal?.throwIfAborted();
  return encoded.toString("base64");
}

/**
 * Fetch a single image url and return validated, downscaled base64 bytes ready for figma.createImage —
 * the whole trust boundary in one call. Throws (naming the url) on any failure: blocked range, oversize,
 * non-image payload, unreachable host. The caller surfaces that loud rather than rendering a blank fill.
 */
export async function fetchAndProcessImage(url: string, signal?: AbortSignal): Promise<string> {
  try {
    return await processImageBytes(await guardedFetch(url, signal), signal);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`flcm.image could not load ${JSON.stringify(url)}: ${reason}`);
  }
}

/**
 * The local-file byte source — the filesystem twin of fetchAndProcessImage, feeding the same processing
 * pipeline. The path arrives from the untrusted plugin, so containment under the asset root
 * (contained-file.ts) is the control, not the magic-byte check: plenty of real images hold secrets, and
 * the bytes land in a cloud-synced Figma document. The reverse channel's EXECUTE_CODE payload gate makes
 * every path attributable to an approved run — defense in depth, not a substitute for containment.
 */
export function createLocalImageReader(
  readContained: ContainedFileReader,
  { uploadsAccepted }: { uploadsAccepted: boolean },
): (source: string, signal?: AbortSignal) => Promise<string> {
  // Only a runtime that holds uploads can send the agent to the upload command; a CLI execute run
  // reads its own --asset-root, which the agent chose on the command line.
  const outOfRootRemedy = uploadsAccepted
    ? `With shell access, run \`npx ${CLI_NAME} upload <file>\`, which reads the file on your side ` +
      "and prints a handle to pass to flcm.image in its place. If the root itself is wrong, report " +
      "it to the user: the server's --asset-root sets it"
    : "Move the file under the asset root, or rerun execute with --asset-root set to a directory " +
      "that holds it";
  return async function readLocalImage(source: string, signal?: AbortSignal): Promise<string> {
    try {
      return await processImageBytes(
        await readContained(source, { maxBytes: MAX_IMAGE_BYTES, signal }),
        signal,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const rootAdvice = err instanceof OutsideAssetRootError ? `. ${outOfRootRemedy}` : "";
      throw new Error(
        `flcm.image could not load ${JSON.stringify(source)}: ${reason}${rootAdvice}`,
      );
    }
  };
}
