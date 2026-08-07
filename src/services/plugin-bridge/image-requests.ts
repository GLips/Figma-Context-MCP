// Serves the plugin's mid-run image requests (the protocol-2 reverse direction): the sandbox's
// render() awaits ONE batched fetch per verb, and this module answers it from the guarded fetch path
// plus a session-lifetime URL→bytes cache, so repeated renders of the same asset never re-download.
//
// These bounds live HERE, on the server, because the plugin is the untrusted half of this
// exchange: a compromised or stale plugin could ask for anything, so the url cap and the fetch
// concurrency are enforced where the fetching actually happens. They are PER-REQUEST bounds — the
// bridge separately caps how many requests one run may have in flight (bridge.ts
// MAX_INFLIGHT_IMAGE_SERVICES_PER_RUN), so neither alone bounds a whole run.

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
  /** The guarded server-side fetch (fetchAndProcessImage): SSRF allowlist, byte caps, type checks. */
  fetchImage: (url: string) => Promise<string>;
  cache: ImageByteCache;
}

/**
 * Build the handler PluginBridge invokes for each inbound IMAGES_REQUEST. Dedupes, enforces the
 * per-request cap, answers hits from the cache, and fetches misses with bounded concurrency. Any
 * single failure (blocked range, oversize, non-image, unreachable) rejects the whole request — the
 * plugin turns that into the run's error, so a blocked url never renders as a blank fill.
 */
export function createImagesRequestHandler(
  deps: ImagesRequestDeps,
): (urls: string[]) => Promise<Record<string, string>> {
  return async (urls) => {
    // The plugin dedupes before asking, but it is the untrusted side — dedupe again so the cap
    // below counts distinct urls no matter what was sent.
    const distinct = Array.from(new Set(urls));
    if (distinct.length > MAX_IMAGES_PER_REQUEST) {
      throw new Error(
        `flcm.image: ${distinct.length} distinct image urls requested at once, over the ` +
          `${MAX_IMAGES_PER_REQUEST} cap — split the build across calls.`,
      );
    }
    const bytes: Record<string, string> = {};
    let replyChars = 0;
    const addBytes = (url: string, base64: string): void => {
      bytes[url] = base64;
      replyChars += base64.length;
      if (replyChars > MAX_REPLY_CHARS) {
        throw new Error(
          `flcm.image: the requested images total over ${Math.round(MAX_REPLY_CHARS / (1024 * 1024))}MiB ` +
            `of encoded bytes in one request — use fewer or smaller images.`,
        );
      }
    };
    const misses: string[] = [];
    for (const url of distinct) {
      const hit = deps.cache.get(url);
      if (hit !== undefined) addBytes(url, hit);
      else misses.push(url);
    }
    await mapWithConcurrency(misses, FETCH_CONCURRENCY, async (url) => {
      const fetched = await deps.fetchImage(url);
      deps.cache.set(url, fetched);
      addBytes(url, fetched);
    });
    return bytes;
  };
}

// Run `fn` over `items` with at most `limit` in flight at once. `limit` workers pull from a shared
// cursor until the list is drained or any item FAILS: after a failure no new item is claimed, and
// the rejection surfaces only once every already-started item has settled. That late surfacing is
// load-bearing, not politeness — the bridge re-arms the run's inactivity deadline when the handler
// settles (serveImagesRequest), so "settled" must mean no fetch is still running on the run's
// behalf. Small local helper — no concurrency dep.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const failures: unknown[] = [];
  const worker = async (): Promise<void> => {
    while (failures.length === 0 && cursor < items.length) {
      try {
        await fn(items[cursor++]);
      } catch (err) {
        failures.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failures.length > 0) throw failures[0];
}
