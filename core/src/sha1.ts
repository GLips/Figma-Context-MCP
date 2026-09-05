/**
 * Pure-JS SHA-1 (hex) over a string's UTF-8 bytes — byte-identical to
 * `createHash("sha1").update(s).digest("hex")`.
 *
 * Exists so the compression pass (content-addressed style/element ids) carries
 * no `node:crypto` dependency: the core graph must bundle under
 * `platform:'neutral'` for the plugin's QuickJS sandbox (Invariant 4), and even
 * an import on a path the expanded mode never calls would still bundle. UTF-8
 * encoding is hand-rolled rather than via TextEncoder because QuickJS doesn't
 * guarantee that global either.
 *
 * SHA-1 is used for dedup ids, not security — collision resistance at the
 * "content-addressed cache key" level is all that's required (and the truncated
 * ids already carry their own collision guards at the call sites).
 */
export function sha1Hex(input: string): string {
  const bytes = utf8Encode(input);
  const byteLength = bytes.length;

  // Message padding: append 0x80, zero-fill to 56 mod 64, then the 64-bit
  // big-endian bit length.
  const paddedLength = (((byteLength + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[byteLength] = 0x80;
  const bitLength = byteLength * 8;
  // JS bitwise ops are 32-bit; split the length manually. Lengths beyond
  // 2^53 bits can't occur (strings are far smaller), so float division is exact.
  const hi = Math.floor(bitLength / 0x100000000);
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, hi);
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return hex32(h0) + hex32(h1) + hex32(h2) + hex32(h3) + hex32(h4);
}

function hex32(n: number): string {
  return n.toString(16).padStart(8, "0");
}

/** UTF-8 encode a JS string (WTF-16), matching TextEncoder: lone surrogates → U+FFFD. */
function utf8Encode(input: string): Uint8Array {
  // Worst case 3 bytes per UTF-16 code unit (astral pairs: 2 units → 4 bytes).
  const out = new Uint8Array(input.length * 3);
  let len = 0;
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd; // unpaired surrogate

    if (code < 0x80) {
      out[len++] = code;
    } else if (code < 0x800) {
      out[len++] = 0xc0 | (code >> 6);
      out[len++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[len++] = 0xe0 | (code >> 12);
      out[len++] = 0x80 | ((code >> 6) & 0x3f);
      out[len++] = 0x80 | (code & 0x3f);
    } else {
      out[len++] = 0xf0 | (code >> 18);
      out[len++] = 0x80 | ((code >> 12) & 0x3f);
      out[len++] = 0x80 | ((code >> 6) & 0x3f);
      out[len++] = 0x80 | (code & 0x3f);
    }
  }
  return out.subarray(0, len);
}
