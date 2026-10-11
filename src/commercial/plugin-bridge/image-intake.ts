/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Image intake: bytes a caller already holds become a short-lived upload handle that flcm.image
// accepts in place of a path. This exists so the server never has to open a path the caller names
// outside the asset root — the caller's side reads the file and hands over bytes instead. Every
// front door (the HTTP upload endpoint the CLI talks to, and any later one such as a plugin file
// picker) goes through this one module for validation, limits and handle issuing.
//
// Handles are capabilities, not names: 256 random bits, held only as a sha256 digest, with no route
// that lists or searches them. Holding one is still not enough to redeem it — the run asking must
// have been SUBMITTED naming it (ChannelRunContext.uploadHandles), which the untrusted plugin can't
// forge, so a plugin that saw a handle in one run's code can't replay it in another run.
import { createHash, randomBytes } from "node:crypto";
import { MAX_IMAGE_BYTES, processImageBytes } from "./images.js";

const HANDLE_PREFIX = "flcm-upload:";
// 32 random bytes in unpadded base64url is exactly 43 characters; the lookarounds keep a longer
// run of token characters from yielding a handle-shaped substring.
const HANDLE_IN_CODE = /(?<![A-Za-z0-9_-])flcm-upload:[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

// Long enough to write and iterate on the script that places the image, short enough that a handle
// leaked into a log or transcript goes dead the same afternoon. Fixed, not sliding: re-uploading is
// one command.
export const UPLOAD_TTL_MS = 30 * 60 * 1000;
// The store holds processed base64, which a downscale can make larger than the upload. These bound
// the server's resident memory for uploads no matter how many arrive.
const MAX_STORED_CHARS = 128 * 1024 * 1024;
const MAX_STORED_HANDLES = 64;
// Decode is the expensive step (a raster per upload), so cap how many run at once.
const MAX_CONCURRENT_INTAKES = 4;

/** Refusals carry the HTTP status a front door should answer with; the message is for the caller. */
export class ImageIntakeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 429 | 507,
  ) {
    super(message);
    this.name = "ImageIntakeError";
  }
}

/**
 * The scheme split for flcm.image sources: an http(s) url is fetched, an upload handle is served from
 * this store, and anything else is a local path under the asset root. One classifier, imported by both
 * the source dispatch (plugin-bridge/index.ts) and the cache-skip rule (image-requests.ts), so they
 * can't disagree. Negative space: a local file literally named `flcm-upload:…` is unreachable by path.
 */
export function imageSourceKind(source: string): "url" | "upload" | "path" {
  if (/^https?:\/\//i.test(source)) return "url";
  return source.startsWith(HANDLE_PREFIX) ? "upload" : "path";
}

/**
 * The handles a script names literally. Computed from the code the trusted caller submitted, never
 * from what the plugin later asks for — that difference is what binds a handle to a run. A handle
 * assembled at runtime (concatenation, a variable built from parts) is deliberately not seen.
 */
export function uploadHandlesNamedIn(code: string): ReadonlySet<string> {
  return new Set(code.match(HANDLE_IN_CODE) ?? []);
}

interface StoredUpload {
  base64: string;
  expiresAt: number;
}

export interface IssuedUpload {
  handle: string;
  expiresAt: number;
}

/**
 * Drain a byte stream under a hard cap, refusing the moment it is crossed — so a sender that lies
 * about or omits its length still can't make us buffer past the cap.
 */
export async function readCappedStream(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.byteLength;
    if (total > maxBytes) throw tooLarge(maxBytes);
    parts.push(chunk);
  }
  return Buffer.concat(parts, total);
}

export function tooLarge(maxBytes: number = MAX_IMAGE_BYTES): ImageIntakeError {
  return new ImageIntakeError(`the image is over the ${maxBytes}-byte upload cap`, 413);
}

/** One per server process, shared by every upload front door and the images capability. */
export class ImageUploadStore {
  private readonly uploads = new Map<string, StoredUpload>();
  private storedChars = 0;
  private intakesInFlight = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Validate and decode an upload, then issue its handle. The stream is read under the byte cap and
   * the bytes go through the same pipeline as every other image source (magic bytes, header pixel cap,
   * decode, downscale), so a handle only ever names bytes flcm.image could have loaded anyway.
   */
  async intake(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<IssuedUpload> {
    if (this.intakesInFlight >= MAX_CONCURRENT_INTAKES) {
      throw new ImageIntakeError(
        `${MAX_CONCURRENT_INTAKES} uploads are already in progress; retry when one finishes`,
        429,
      );
    }
    this.intakesInFlight++;
    try {
      const bytes = await readCappedStream(chunks);
      let base64: string;
      try {
        base64 = await processImageBytes(bytes);
      } catch (err) {
        throw new ImageIntakeError(err instanceof Error ? err.message : String(err), 400);
      }
      return this.issue(base64);
    } finally {
      this.intakesInFlight--;
    }
  }

  /**
   * The processed bytes behind a handle, for a run that was submitted naming it. One message for
   * unknown and expired alike: which one it was tells a caller nothing it can act on beyond
   * "upload again", and a distinction would let a guesser tell a real-but-stale handle from noise.
   */
  redeem(handle: string, authorized: ReadonlySet<string>): string {
    if (!authorized.has(handle)) {
      throw new Error(
        "this run's script does not name that upload handle, so it can't use it. Write the handle " +
          "into the script literally, as the upload command printed it",
      );
    }
    this.pruneExpired();
    const stored = this.uploads.get(digest(handle));
    if (!stored) {
      throw new Error(
        "the upload handle is unknown or has expired (handles last 30 minutes, on the server that " +
          "issued them). Upload the file again for a fresh handle",
      );
    }
    return stored.base64;
  }

  private issue(base64: string): IssuedUpload {
    this.pruneExpired();
    if (
      this.uploads.size >= MAX_STORED_HANDLES ||
      this.storedChars + base64.length > MAX_STORED_CHARS
    ) {
      // Refuse rather than evict: evicting would silently break a handle a script already names.
      throw new ImageIntakeError(
        "the server's upload storage is full; older uploads expire 30 minutes after they were made",
        507,
      );
    }
    const handle = HANDLE_PREFIX + randomBytes(32).toString("base64url");
    const expiresAt = this.now() + UPLOAD_TTL_MS;
    this.uploads.set(digest(handle), { base64, expiresAt });
    this.storedChars += base64.length;
    return { handle, expiresAt };
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, stored] of this.uploads) {
      if (stored.expiresAt > now) continue;
      this.uploads.delete(key);
      this.storedChars -= stored.base64.length;
    }
  }
}

function digest(handle: string): string {
  return createHash("sha256").update(handle).digest("hex");
}
