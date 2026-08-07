// The trusted server-side image byte sources — the trust boundary in the write path. The Figma
// sandbox holds manifest allowedDomains:["none"] and can reach nothing, so agent-authored `flcm.image(src)`
// fills are inert until this module loads, validates, and downscales the bytes; the bridge answers the
// sandbox's mid-run IMAGES_REQUEST with them (see image-requests.ts). Two sources feed one processing
// pipeline: an http(s) url through the guarded fetch (SSRF ranges, byte cap, redirect re-guarding), or a
// LOCAL FILE PATH through the asset-root guard (readLocalImage). Because the model — via the untrusted
// plugin — picks the source, every guard here defends against a hostile one; "read a file the plugin
// names" is an arbitrary-file-read primitive unless the root check holds.
//
// Ported in spirit from production figma-mcp (downloadAndProcessImage/jimp), but the guard is net-new:
// figma-mcp only ever fetches from Figma's own trusted CDN, so it has no SSRF/type defense to port. jimp is
// the shared piece — the modular @jimp/* build, downscaling to Figma's 4096px createImage cap.
import { lookup } from "node:dns/promises";
import { realpath, stat, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import { Agent, fetch, type Response } from "undici";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import jpeg from "@jimp/js-jpeg";
import gif from "@jimp/js-gif";
import * as resize from "@jimp/plugin-resize";
import ipaddr from "ipaddr.js";

const Jimp = createJimp({ formats: [png, jpeg, gif], plugins: [resize.methods] });

// The guard validates addresses with the LOCAL resolver, so this fetch must dial direct. Server startup
// may install a global proxy dispatcher for Figma API traffic (src/server.ts), and a proxy does its own
// DNS — a split-horizon hostname could validate as public here yet resolve private at the proxy, walking
// the request past every range check. Pinning a plain Agent keeps "what we validate is what gets dialed"
// true regardless of proxy config (and matches the pre-dissolution bridge process, which never proxied).
// Cost: in a mandatory-egress-proxy environment flcm.image goes direct and may fail loudly — acceptable;
// routing it through a proxy would need equivalent validation at the proxy's egress, which we can't do.
const directDispatcher = new Agent();

// Figma's createImage rejects any dimension over 4096px, so downscale the longest side to fit before the
// bytes ever leave the server — also the mitigation for the multi-MB-base64-over-loopback bridge-timeout risk.
const MAX_DIMENSION = 4096;
// Pre-downscale byte cap. Generous enough for a real photo, small enough that a hostile url can't stream us
// out of memory. Enforced by streaming, not by trusting the (spoofable, often-absent) Content-Length header.
const MAX_BYTES = 12 * 1024 * 1024;
// Decoded-pixel cap, enforced from the image HEADER before jimp decodes anything. MAX_BYTES bounds the
// COMPRESSED wire size but not the raster footprint: a highly compressible ~0.25MB PNG can declare 8000×8000
// and decode to ~244MB (RGBA), a decompression bomb that OOMs the trusted server well under the byte cap. So
// we read width×height from the header and reject over this budget (~30MP ≈ 120MB decoded) BEFORE decode —
// generous enough for a real high-res photo, small enough to defang the bomb.
const MAX_PIXELS = 30_000_000;
const FETCH_TIMEOUT_MS = 10_000;
// A redirect re-resolves DNS on a host we haven't validated, so we follow manually and re-guard every hop
// rather than let fetch chase a 302 into a private range. Bounded so a redirect loop can't spin forever.
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
// (an exotic/truncated variant); the caller treats null as "can't pre-check" and lets jimp attempt it. PNG
// and GIF carry dimensions at fixed offsets, so those — the compressible-bomb formats — are always covered.
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

// Resolve the host and reject if ANY resolved address is non-public — a hostname with even one private A
// record is refused. Uses the same OS resolver (getaddrinfo) fetch/undici will use, so what we validate is
// what gets dialed. A literal-IP host resolves to itself here, so this doubles as the direct-IP guard.
//
// Residual gap (documented, not closed): DNS rebinding — a host that answers public here and private on
// fetch's own re-resolution. Closing it needs pinning the connection to the validated IP (a custom undici
// dispatcher); out of scope for v1, where the redirect re-guard below covers the common bypass.
async function assertPublicHost(hostname: string): Promise<void> {
  // URL.hostname wraps an IPv6 literal in brackets ("[2606:...]"), which dns.lookup rejects as ENOTFOUND —
  // strip them so a public IPv6-literal url resolves (and its address hits isBlockedAddress) instead of
  // failing closed for every v6 literal.
  const host = hostname.replace(/^\[|\]$/g, "");
  const records = await lookup(host, { all: true });
  if (records.length === 0) throw new Error(`could not resolve host "${host}"`);
  for (const { address } of records) {
    if (isBlockedAddress(address)) {
      throw new Error(
        `host "${host}" resolves to a blocked (private/loopback/link-local) address ${address}`,
      );
    }
  }
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
// Content-Length still can't stream us past MAX_BYTES.
async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error(`image is ${declared} bytes, over the ${MAX_BYTES}-byte cap`);
  }
  if (!res.body) throw new Error("image response had no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`image exceeds the ${MAX_BYTES}-byte cap`);
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
async function guardedFetch(rawUrl: string): Promise<Uint8Array> {
  let target = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = parseHttpUrl(target);
    await assertPublicHost(url.hostname);
    const res = await fetch(url, {
      dispatcher: directDispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
export async function processImageBytes(bytes: Uint8Array): Promise<string> {
  const type = detectImageType(bytes);
  if (!type) throw new Error("payload is not a PNG, JPEG, or GIF (magic-byte check failed)");

  // Reject a decompression bomb from its header before jimp allocates the raster (see MAX_PIXELS).
  const dims = headerDimensions(bytes, type);
  if (dims && dims.width * dims.height > MAX_PIXELS) {
    throw new Error(
      `image is ${dims.width}×${dims.height} (${Math.round((dims.width * dims.height) / 1e6)}MP), over the ` +
        `${Math.round(MAX_PIXELS / 1e6)}MP decode cap`,
    );
  }

  const buffer = Buffer.from(bytes);
  const image = await Jimp.fromBuffer(buffer);
  const { width, height } = image;
  if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
    return buffer.toString("base64");
  }
  // Scale the longer side to the cap; jimp derives the other side to preserve aspect ratio. A downscaled GIF
  // flattens to its first frame — acceptable for an oversize animation, which is an exotic case.
  const resized =
    width >= height ? image.resize({ w: MAX_DIMENSION }) : image.resize({ h: MAX_DIMENSION });
  const encoded = await resized.getBuffer(type === "image/gif" ? "image/png" : type);
  return encoded.toString("base64");
}

/**
 * Fetch a single image url and return validated, downscaled base64 bytes ready for figma.createImage —
 * the whole trust boundary in one call. Throws (naming the url) on any failure: blocked range, oversize,
 * non-image payload, unreachable host. The caller surfaces that loud rather than rendering a blank fill.
 */
export async function fetchAndProcessImage(url: string): Promise<string> {
  try {
    return await processImageBytes(await guardedFetch(url));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`flcm.image could not load ${JSON.stringify(url)}: ${reason}`);
  }
}

// The scheme split for flcm.image sources, mirroring CSS url(): an http(s) url is fetched, anything else
// is a local file path served from the asset root. One classifier, imported by both the source dispatch
// (plugin-bridge/index.ts) and the cache-skip rule (image-requests.ts), so they can't disagree.
export function isLocalImageSource(source: string): boolean {
  return !/^https?:\/\//i.test(source);
}

// Open flags for a contained read. O_NOFOLLOW is the TOCTOU guard: we open the path realpath ALREADY
// resolved, so its final component is a real file by construction — if it has become a symlink between
// the check and the open, someone swapped it under us and the open fails instead of following the swap
// out of the root. O_NONBLOCK keeps a fifo/device swapped into the path from parking the open forever
// (the fstat below then rejects it). Both are POSIX-only constants; on Windows they read as undefined
// and fall back to 0, where the handle checks below remain the guard.
const CONTAINED_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Build the local-file byte source for one asset root — the filesystem twin of fetchAndProcessImage,
 * feeding the same processing pipeline. One reader per server (see plugin-bridge/index.ts).
 *
 * THE ROOT IS THE CONTROL, not the magic-byte check (plenty of real images hold secrets, and the bytes
 * land in a cloud-synced Figma document). The path arrives from the untrusted plugin, so this is an
 * arbitrary-file-read primitive unless contained: resolve against the root, then verify the resolved
 * REALPATH sits inside the root's realpath — post-resolution, which is what defeats both `../` traversal
 * and a symlink pointing out of the root (a pre-resolution string check catches neither). The reverse
 * channel's EXECUTE_CODE payload gate makes every path attributable to an approved run — defense in
 * depth, not a substitute for this check.
 *
 * The root is canonicalized ONCE and pinned for the process: re-resolving it per request would let a
 * root that is a symlink be retargeted mid-session, silently moving the authorization boundary the
 * operator chose at startup.
 *
 * Errors name the root explicitly: "./assets/logo.png" is ambiguous when the server's cwd differs from
 * the repo the agent is working in.
 */
export function createLocalImageReader(assetRoot: string): (source: string) => Promise<string> {
  // Cached only on success, so a root that doesn't exist yet at first use isn't a permanent verdict.
  let pinnedRoot: Promise<string> | null = null;
  const canonicalRoot = (): Promise<string> => {
    if (!pinnedRoot) {
      pinnedRoot = (async () => {
        const rootReal = await realpath(assetRoot);
        if (!(await stat(rootReal)).isDirectory()) {
          throw new Error(`the asset root (${assetRoot}) is not a directory`);
        }
        return rootReal;
      })().catch((err: unknown) => {
        pinnedRoot = null;
        throw err;
      });
    }
    return pinnedRoot;
  };

  return async function readLocalImage(source: string): Promise<string> {
    try {
      const rootReal = await canonicalRoot();
      let fileReal: string;
      try {
        fileReal = await realpath(resolvePath(rootReal, source));
      } catch (err) {
        // Only ENOENT/ENOTDIR genuinely mean "no such file" — reporting a permission or
        // name-too-long failure as a missing file sends the reader hunting for the wrong problem.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          throw new Error(`no such file under the asset root (${assetRoot})`);
        }
        throw new Error(`could not resolve that path under the asset root (${assetRoot}): ${code}`);
      }
      if (fileReal !== rootReal && !fileReal.startsWith(rootReal + pathSep)) {
        throw new Error(
          `the path resolves outside the asset root (${assetRoot}) — only files under that root can be ` +
            `placed. Start the server with --asset-root pointed at your project if the root is wrong.`,
        );
      }
      return await processImageBytes(await readContainedFile(fileReal, assetRoot));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`flcm.image could not load ${JSON.stringify(source)}: ${reason}`);
    }
  };
}

/**
 * Read an already-contained path through ONE handle: open, verify what we actually opened, then read
 * only from that descriptor. Checking a path and then re-opening it by name is three separate races —
 * the file can become a symlink, a fifo, or a different (larger) file between them — and every one of
 * those resolves the name again. A descriptor cannot be swapped, so the object we vet is the object
 * we read, and the byte cap binds the read itself instead of a size the file no longer has.
 *
 * Negative space: a directory component swapped for a symlink between realpath and open is NOT closed
 * here. Doing so needs openat/RESOLVE_BENEATH, which Node core does not expose portably, and it takes
 * a local writer racing us inside the root — a strictly smaller threat than the plugin-named path this
 * whole module exists to contain.
 */
async function readContainedFile(fileReal: string, assetRoot: string): Promise<Uint8Array> {
  const handle = await open(fileReal, CONTAINED_OPEN_FLAGS);
  try {
    // fstat, not stat: this describes the OPEN object, so a fifo/device/directory swapped into the
    // path after the containment check is refused here rather than read or blocked on.
    if (!(await handle.stat()).isFile()) {
      throw new Error(`the path is not a file (asset root: ${assetRoot})`);
    }
    // One cap-sized buffer, filled from the descriptor: a file that grew after the check can't make
    // us allocate past the cap, and the (cap + 1)th byte is what proves it was over.
    const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES) throw new Error(`file is over the ${MAX_BYTES}-byte cap`);
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}
