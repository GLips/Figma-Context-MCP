/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Serves images.fetch over the private server channel: the sandbox's
// render() awaits ONE batched fetch per verb, and this module answers it from the guarded byte
// sources plus a session-lifetime URL→bytes cache, so repeated renders of the same remote asset
// never re-download. Local file paths and upload handles bypass the cache — see the miss loop below.
//
// These bounds live HERE, on the server, because the plugin is the untrusted half of this
// exchange: a compromised or stale plugin could ask for anything, so the url cap and the fetch
// concurrency are enforced where the fetching actually happens. They are PER-REQUEST bounds — the
// bridge separately caps how many requests one run may have in flight (bridge.ts
// MAX_INFLIGHT_SERVICES_PER_RUN), so neither alone bounds a whole run.
import type { CapabilityHandler, ChannelRunContext } from "./bridge.js";
import { CapabilityFailure } from "./channel-failure.js";
import { imageSourceKind, type ImageUploadStore } from "./image-intake.js";
import { fetchAndProcessImage } from "./images.js";
import { CLI_NAME } from "~/utils/cli-help.js";
import { limitConcurrency } from "~/utils/concurrency.js";

type ImagesRequestHandler = (
  urls: string[],
  run: ChannelRunContext,
  signal?: AbortSignal,
) => Promise<Record<string, string>>;

// Bound on distinct image urls one request may carry, and on how many fetch/decode concurrently —
// the pair caps peak server memory (each in-flight fetch holds a decoded raster) to
// FETCH_CONCURRENCY rasters regardless of how many the agent's code asks for.
export const MAX_IMAGES_PER_REQUEST = 64;
const FETCH_CONCURRENCY = 4;

// Cap on the cache's total base64 payload. Base64 is latin1, which V8 stores one byte per char, so
// string length is an honest byte proxy. 64 MiB holds a few dozen large processed rasters — enough
// that an iterate-on-one-design session never re-fetches, small enough that a long-lived server
// can't grow without bound.
const MAX_CACHE_CHARS = 64 * 1024 * 1024;

// Cap on ONE reply's total base64 payload. The url cap alone doesn't bound bytes — 64 urls at the
// per-image wire cap is around a GiB of base64 per request, and the plugin (untrusted) picks the
// urls. Checked during accumulation, cache hits included, so an over-budget request fails at the
// crossing entry instead of after building the whole reply.
const MAX_REPLY_CHARS = 64 * 1024 * 1024;

/**
 * Session-lifetime URL→base64 cache with LRU eviction under a byte cap. One instance lives for the
 * server process (constructed at bridge startup), deliberately not per-connection: the plugin
 * reconnects on every Figma reload, and the assets it renders don't change identity across that.
 */
export class ImageByteCache {
  private entries = new Map<string, string>();
  private totalChars = 0;

  constructor(private readonly maxTotalChars = MAX_CACHE_CHARS) {}

  get(url: string): string | undefined {
    const hit = this.entries.get(url);
    if (hit === undefined) return undefined;
    // LRU touch: Map iteration order is insertion order, so re-inserting moves this entry to the
    // "most recently used" end and eviction (which walks from the front) spares it longest.
    this.entries.delete(url);
    this.entries.set(url, hit);
    return hit;
  }

  set(url: string, base64: string): void {
    // An entry bigger than the whole cache would evict everything and still not fit — skip it
    // rather than thrash. The fetch already succeeded; only reuse is lost.
    if (base64.length > this.maxTotalChars) return;
    const prior = this.entries.get(url);
    if (prior !== undefined) {
      this.entries.delete(url);
      this.totalChars -= prior.length;
    }
    this.entries.set(url, base64);
    this.totalChars += base64.length;
    for (const [oldestUrl, oldestBytes] of this.entries) {
      if (this.totalChars <= this.maxTotalChars) break;
      this.entries.delete(oldestUrl);
      this.totalChars -= oldestBytes.length;
    }
  }
}

export interface ImagesRequestDeps {
  /**
   * The guarded server-side byte source, dispatched by scheme (plugin-bridge/index.ts): https urls
   * through fetchAndProcessImage (SSRF allowlist, byte caps), local paths through the run's readLocalImage
   * (asset-root containment), upload handles through the upload store (redeemable only by a run
   * submitted naming them). All return validated, downscaled base64.
   */
  fetchImage: (url: string, run: ChannelRunContext, signal?: AbortSignal) => Promise<string>;
  cache: ImageByteCache;
}

/**
 * Build the handler PluginBridge invokes for each inbound images.fetch request. Dedupes, enforces the
 * per-request cap, answers hits from the cache, and fetches misses with bounded concurrency. Any
 * single failure (blocked range, oversize, non-image, unreachable) rejects the whole request — the
 * plugin turns that into the run's error, so a blocked url never renders as a blank fill.
 */
export function createImagesRequestHandler(deps: ImagesRequestDeps): ImagesRequestHandler {
  return async (urls, run, signal) => {
    signal?.throwIfAborted();
    // The plugin dedupes before asking, but it is the untrusted side — dedupe again so the cap
    // below counts distinct urls no matter what was sent.
    const distinct = Array.from(new Set(urls));
    if (distinct.length > MAX_IMAGES_PER_REQUEST) {
      throw new CapabilityFailure(
        "authoring",
        `this call uses ${distinct.length} distinct images, over the ${MAX_IMAGES_PER_REQUEST} one ` +
          "call can load. Split the build across calls.",
      );
    }
    // Null-prototype: the keys are attacker-chosen source strings, and local paths made ordinary
    // filenames into keys. `bytes["__proto__"] = b64` on a plain object silently sets nothing, so a
    // file legitimately named __proto__ would vanish from the reply.
    const bytes: Record<string, string> = Object.create(null) as Record<string, string>;
    let replyChars = 0;
    const addBytes = (url: string, base64: string): void => {
      bytes[url] = base64;
      replyChars += base64.length;
      if (replyChars > MAX_REPLY_CHARS) {
        throw new CapabilityFailure(
          "authoring",
          `this call's images total over ${Math.round(MAX_REPLY_CHARS / (1024 * 1024))}MiB once ` +
            "encoded, more than one call can load. Use fewer or smaller images, or split the build across calls.",
        );
      }
    };
    const misses: string[] = [];
    for (const url of distinct) {
      // Only urls are cached. A local file goes stale the moment the user tweaks it between renders,
      // so a cached read would silently paint the old bytes. An upload handle must be re-checked
      // against each run's grant, which a source-keyed cache hit would skip.
      const hit = imageSourceKind(url) === "url" ? deps.cache.get(url) : undefined;
      if (hit !== undefined) addBytes(url, hit);
      else misses.push(url);
    }
    await mapWithConcurrency(
      misses,
      FETCH_CONCURRENCY,
      async (url) => {
        const fetched = await deps.fetchImage(url, run, signal);
        signal?.throwIfAborted();
        if (imageSourceKind(url) === "url") deps.cache.set(url, fetched);
        addBytes(url, fetched);
      },
      signal,
    );
    return bytes;
  };
}

// Run `fn` over `items` with at most `limit` in flight at once. After any item FAILS no new item
// starts, and the rejection surfaces only once every already-started item has settled. That late
// surfacing is load-bearing, not politeness — the bridge re-arms the run's inactivity deadline when
// the handler settles (serveChannelRequest), so "settled" must mean no fetch is still running on
// the run's behalf.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const runJob = limitConcurrency(limit);
  let failure: { error: unknown } | undefined;
  await Promise.all(
    items.map((item) =>
      runJob(async () => {
        if (failure) return;
        try {
          signal?.throwIfAborted();
          await fn(item);
        } catch (error) {
          failure ??= { error };
        }
      }),
    ),
  );
  if (failure) throw failure.error;
}

/**
 * The flcm.image source dispatch: urls through the guarded fetch, paths through the run's contained read,
 * upload handles through the store under the run's grant. `uploads` is null for a runtime that takes
 * no uploads (CLI execute), whose store could only ever answer "unknown".
 */
export function createImageSourceFetcher({
  uploads,
}: {
  uploads: { store: ImageUploadStore; port: () => number | null } | null;
}): ImagesRequestDeps["fetchImage"] {
  return async (source, run, signal) => {
    const kind = imageSourceKind(source);
    if (kind === "url") return fetchAndProcessImage(source, signal);
    if (kind === "path") {
      if (!run.readLocalImage)
        throw new CapabilityFailure(
          "authoring",
          `the image ${JSON.stringify(source)} is a local file path, and this run may not read ` +
            "local files. Pass an https url instead.",
        );
      return run.readLocalImage(source, signal);
    }
    if (!uploads) {
      throw new CapabilityFailure(
        "authoring",
        "an upload handle only works on the MCP server that issued it, not in an execute run. " +
          "Pass the file's path instead, with --asset-root set to a directory that holds it.",
      );
    }
    try {
      return uploads.store.redeem(source, run.uploadHandles);
    } catch (err) {
      const port = uploads.port();
      // Several servers can run in one project, and the upload command can't tell which one is the
      // agent's; naming this server's port makes the retry certain instead of a guess.
      const retry =
        port === null
          ? ""
          : `. This server takes uploads on port ${port}; if the handle came from another server, ` +
            `run \`npx ${CLI_NAME} upload <file> --port ${port}\` for one this server can use`;
      throw new CapabilityFailure(
        "authoring",
        `the upload handle could not be used: ${(err as Error).message}${retry}.`,
      );
    }
  };
}

/** Parse image inputs at the capability boundary, away from the uninterpreted channel. */
export function createImagesCapability(deps: ImagesRequestDeps): CapabilityHandler {
  const fetchImages = createImagesRequestHandler(deps);
  return (payload, { signal, run }) =>
    fetchImages(
      Array.isArray(payload) ? payload.filter((url): url is string => typeof url === "string") : [],
      run,
      signal,
    );
}
