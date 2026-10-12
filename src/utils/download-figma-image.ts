import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { tagError } from "~/utils/error-meta.js";
import { isWithin } from "~/utils/local-path.js";

// Covers the whole transfer, body included — a stalled S3 download must fail the item rather
// than hang the tool call. Generous because large PNG exports at high scale are slow to stream.
const IMAGE_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Download a Figma image URL to `localPath/fileName`. Resolves to the full path written; a
 * failed download leaves no partial file behind.
 */
export async function downloadFigmaImage(
  fileName: string,
  localPath: string,
  imageUrl: string,
): Promise<string> {
  const fullPath = path.resolve(path.join(localPath, fileName));
  if (!isWithin(localPath, fullPath)) {
    tagError(new Error(`File path escapes target directory: ${fileName}`), {
      category: "invalid_input",
    });
  }
  await mkdir(localPath, { recursive: true });

  const response = await fetch(imageUrl, {
    signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    tagError(
      new Error(`Failed to download image: HTTP ${response.status} ${response.statusText}`),
      {
        category: "image_download",
        http_status: response.status,
      },
    );
  }

  try {
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      createWriteStream(fullPath),
    );
  } catch (error) {
    await rm(fullPath, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    tagError(new Error(`Failed to download image: ${message}`, { cause: error }), {
      category: "image_download",
    });
  }
  return fullPath;
}
