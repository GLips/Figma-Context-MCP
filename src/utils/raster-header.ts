/**
 * A raster's dimensions as its header declares them, without decoding: PNG's IHDR, GIF's logical
 * screen, JPEG's first start-of-frame. This is the decompression-bomb check — a small, highly
 * compressible file can declare a raster that decodes to hundreds of MB, so callers compare these
 * against a pixel budget before handing the bytes to a decoder. Undefined when the format isn't
 * one of the three or the header is truncated.
 */
export function readRasterDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && ascii(12, 16) === "IHDR") {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && ascii(0, 4) === "GIF8") {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) return jpegFrameSize(bytes, view);
  return undefined;
}

function jpegFrameSize(
  bytes: Uint8Array,
  view: DataView,
): { width: number; height: number } | undefined {
  let offset = 2; // past SOI
  while (offset + 9 <= bytes.length) {
    // Fill bytes (0xFF runs) and stray bytes between segments are legal; step over them.
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    // SOF0–SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but don't.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    // Standalone markers (SOI, EOI, RSTn, TEM) have no length field.
    const standalone =
      marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;
    offset += standalone ? 2 : 2 + view.getUint16(offset + 2);
  }
  return undefined;
}
