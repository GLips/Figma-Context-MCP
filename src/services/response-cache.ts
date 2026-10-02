import { formatCacheAge, formatDuration } from "~/utils/duration.js";

export type FigmaDataCacheKeyParts = {
  authFingerprint: string;
  fileKey: string;
  nodeId?: string;
  depth?: number;
  outputFormat: string;
};

/**
 * Identity for one successful `get_figma_data` response.
 *
 * `authFingerprint` is part of the key because HTTP mode accepts a token per
 * request, and two tokens can see different content for the same file. Depth
 * and output format change the payload itself, so they are part of the key too.
 */
export function figmaDataCacheKey(parts: FigmaDataCacheKeyParts): string {
  return JSON.stringify([
    parts.authFingerprint,
    parts.fileKey,
    parts.nodeId ?? null,
    parts.depth ?? null,
    parts.outputFormat,
  ]);
}

export function formatCacheNotice(ageMs: number, ttlMs: number): string {
  return `Note: cached Figma response from ${formatCacheAge(ageMs)} ago (TTL ${formatDuration(ttlMs)}). The file may have changed since this was fetched.`;
}

/**
 * Entry cap for caches whose values are large — a simplified design or a
 * whole-file fill map can each run to megabytes, and the TTL alone puts no
 * ceiling on how many distinct files a long-lived HTTP server is asked for.
 */
const DEFAULT_MAX_ENTRIES = 32;

/** Render URLs are one short string per node, so the cap can be far looser. */
const MAX_RENDER_URL_ENTRIES = 2048;

type Entry<T> = {
  value: T;
  storedAt: number;
};

/**
 * In-process TTL cache. Entries die with the server process, which is the
 * invalidation we want: a restart drops anything the TTL would have kept, and
 * a long-lived MCP process still serves repeat fetches across agent turns.
 *
 * Not written to disk. A file would keep design data after the process the
 * user thinks of as "the session" is gone, and the only freshness check Figma
 * offers costs another rate-limited request — so a persistent cache cannot
 * revalidate without giving up the rate-limit win.
 */
export class ResponseCache<T> {
  // Insertion order is storage order: `set` always re-inserts, and every entry
  // shares one TTL. So the first entry is both the oldest and the next to
  // expire, which is what lets `sweep` stop early and the size cap evict it.
  private readonly entries = new Map<string, Entry<T>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly ttlMs: number,
    { maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now }: ResponseCacheOptions = {},
  ) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get(key: string): { value: T; ageMs: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const ageMs = this.now() - entry.storedAt;
    if (ageMs >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return { value: entry.value, ageMs };
  }

  set(key: string, value: T): void {
    const now = this.now();
    this.sweep(now);
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: now });
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.scheduleSweep();
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.storedAt < this.ttlMs) break;
      this.entries.delete(key);
    }
  }

  /**
   * Without this, a burst of reads followed by silence would hold its payloads
   * until the next call, however long that takes. Unref'd so a pending sweep
   * never keeps the process alive.
   */
  private scheduleSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      this.sweep(this.now());
      if (this.entries.size > 0) this.scheduleSweep();
    }, this.ttlMs);
    this.sweepTimer.unref();
  }
}

export type ResponseCacheOptions = {
  maxEntries?: number;
  now?: () => number;
};

export type RenderVariant =
  | { format: "png"; pngScale: number }
  | {
      format: "svg";
      svgOptions: { outlineText: boolean; includeId: boolean; simplifyStroke: boolean };
    };

type UrlMap = Record<string, string>;

/**
 * Process-wide cache of the temporary URLs Figma hands out for image fills
 * and node renders. Those lookups are what the rate limit counts; the image
 * bytes behind the URLs are never stored and are downloaded on every call.
 */
export class ImageUrlCache {
  private readonly fills: ResponseCache<UrlMap>;
  private readonly renders: ResponseCache<string>;

  constructor(
    readonly ttlMs: number,
    now: () => number = Date.now,
  ) {
    this.fills = new ResponseCache(ttlMs, { now });
    this.renders = new ResponseCache(ttlMs, { now, maxEntries: MAX_RENDER_URL_ENTRIES });
  }

  /**
   * Scope the cache to one credential and file for the length of one download
   * call. HTTP mode accepts a token per request, and two tokens must not see
   * each other's URLs.
   */
  lookup(authFingerprint: string, fileKey: string): ImageUrlLookup {
    return new ImageUrlLookup(this.fills, this.renders, authFingerprint, fileKey);
  }
}

/** One download call's view of the cache, and a record of how much of it was reused. */
export class ImageUrlLookup {
  private figmaRequests = 0;
  private oldestReusedMs: number | undefined;

  constructor(
    private readonly fills: ResponseCache<UrlMap>,
    private readonly renders: ResponseCache<string>,
    private readonly authFingerprint: string,
    private readonly fileKey: string,
  ) {}

  /**
   * `GET /files/:key/images` returns every fill in the file, so the entry is
   * that whole map. A cached map that lacks a requested ref is treated as a
   * miss: refs come from `get_figma_data`, so an unknown one almost always
   * means an image was added after the map was stored, and trusting the map
   * would silently skip that image until the TTL ran out.
   */
  async fillUrls(refs: string[], fetchUrls: () => Promise<UrlMap>): Promise<UrlMap> {
    const key = JSON.stringify([this.authFingerprint, this.fileKey]);
    const hit = this.fills.get(key);
    if (hit && refs.every((ref) => hit.value[ref])) {
      this.noteReuse(hit.ageMs);
      return hit.value;
    }
    this.figmaRequests++;
    const urls = await fetchUrls();
    this.fills.set(key, urls);
    return urls;
  }

  /**
   * Per node, not per batch: a later call for a subset of an earlier batch
   * should still hit, so only the ids that missed are sent to Figma. Ids the
   * response omits stay uncached and are retried next time.
   */
  async renderUrls(
    nodeIds: string[],
    variant: RenderVariant,
    fetchUrls: (missingIds: string[]) => Promise<UrlMap>,
  ): Promise<UrlMap> {
    const urls: UrlMap = {};
    const missing: string[] = [];
    for (const id of nodeIds) {
      const hit = this.renders.get(this.renderKey(id, variant));
      if (hit) {
        urls[id] = hit.value;
        this.noteReuse(hit.ageMs);
      } else {
        missing.push(id);
      }
    }
    if (missing.length === 0) return urls;

    this.figmaRequests++;
    const fetched = await fetchUrls(missing);
    for (const [id, url] of Object.entries(fetched)) {
      if (!url) continue;
      urls[id] = url;
      this.renders.set(this.renderKey(id, variant), url);
    }
    return urls;
  }

  /**
   * `cacheHit` means the call made no Figma URL request at all. `cache` is set
   * whenever any URL was reused, so a mixed batch still tells the caller that
   * some of its URLs are old; the age is that of the oldest one.
   */
  summary(): { cacheHit: boolean; cache?: { ageMs: number; ttlMs: number } } {
    if (this.oldestReusedMs === undefined) return { cacheHit: false };
    return {
      cacheHit: this.figmaRequests === 0,
      cache: { ageMs: this.oldestReusedMs, ttlMs: this.fills.ttlMs },
    };
  }

  private noteReuse(ageMs: number): void {
    this.oldestReusedMs = Math.max(this.oldestReusedMs ?? 0, ageMs);
  }

  // Scale and SVG flags change what the URL points at, so they are part of the
  // key. Spelled out field by field so property order in a caller's
  // `svgOptions` cannot split one variant across two entries.
  private renderKey(nodeId: string, variant: RenderVariant): string {
    const variantKey =
      variant.format === "png"
        ? ["png", variant.pngScale]
        : [
            "svg",
            variant.svgOptions.outlineText,
            variant.svgOptions.includeId,
            variant.svgOptions.simplifyStroke,
          ];
    return JSON.stringify([this.authFingerprint, this.fileKey, nodeId, ...variantKey]);
  }
}
