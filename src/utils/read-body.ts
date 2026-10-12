import { tagError } from "./error-meta.js";

/**
 * What the readers need of a response. Structural so both the global fetch's Response and
 * undici's (the plugin bridge's direct-dial fetch) fit.
 */
type StreamedResponse = {
  headers: { get(name: string): string | null };
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
    cancel(): Promise<void>;
  } | null;
};

/**
 * Up to `maxBytes` of a body, and whether more followed. Stops reading, and cancels the stream,
 * as soon as the count passes the cap — so a body that lies about or omits its Content-Length
 * still can't be buffered past it.
 */
async function readBodyUpTo(
  response: StreamedResponse,
  maxBytes: number,
): Promise<{ bytes: Buffer; overflowed: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), overflowed: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) return { bytes: Buffer.concat(chunks), overflowed: false };
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), overflowed: true };
    }
  }
}

/**
 * Buffer a whole body, refusing it once it passes `maxBytes`. Content-Length only lets an honest
 * oversize response fail before any of it is read; the stream count is what binds.
 */
export async function readBodyWithLimit(
  response: StreamedResponse,
  maxBytes: number,
): Promise<Buffer> {
  const tooLarge = () =>
    tagError(new Error(`Response is larger than this server's ${formatBytes(maxBytes)} limit.`), {
      category: "size_limit",
    });
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    tooLarge();
  }
  const { bytes, overflowed } = await readBodyUpTo(response, maxBytes);
  if (overflowed) tooLarge();
  return bytes;
}

/** The first `maxBytes` of a body; the rest is cancelled unread. */
export async function readBodyPrefix(
  response: StreamedResponse,
  maxBytes: number,
): Promise<Buffer> {
  return (await readBodyUpTo(response, maxBytes)).bytes;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.round(bytes / 1024)} KB`;
}
