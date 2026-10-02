import type { GetFileResponse } from "@figma/rest-api-spec";
import { describe, expect, it, vi } from "vitest";
import { FigmaService } from "~/services/figma.js";
import { getFigmaData, type CachedFigmaData } from "~/services/get-figma-data.js";
import { formatCacheNotice, ResponseCache } from "~/services/response-cache.js";
import { toGetFigmaDataContent } from "~/mcp/tools/get-figma-data-tool.js";

const file = {
  name: "Test",
  lastModified: "2024-01-01",
  thumbnailUrl: "",
  version: "1",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [],
  },
  components: {},
  componentSets: {},
  schemaVersion: 0,
  styles: {},
} as unknown as GetFileResponse;

function service(apiKey: string) {
  const svc = new FigmaService({ figmaApiKey: apiKey, figmaOAuthToken: "", useOAuth: false });
  const spy = vi.spyOn(svc, "getRawFile").mockResolvedValue({ data: file, rawSize: 128 });
  return { svc, spy };
}

const input = { fileKey: "abc123" };

describe("formatCacheNotice", () => {
  it("states the age and the TTL in the largest whole units", () => {
    expect(formatCacheNotice(42_000, 300_000)).toContain("42s ago (TTL 5m)");
    expect(formatCacheNotice(125_000, 3_600_000)).toContain("2m 5s ago (TTL 1h)");
    expect(formatCacheNotice(500, 60_000)).toContain("under 1s ago");
  });
});

describe("ResponseCache", () => {
  it("drops the oldest entry once it is over its size cap", () => {
    const cache = new ResponseCache<string>(60_000, { maxEntries: 2, now: () => 0 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.value).toBe("2");
    expect(cache.get("c")?.value).toBe("3");
  });
});

describe("getFigmaData response cache", () => {
  it("reuses a successful response until the TTL expires", async () => {
    let now = 1_000;
    const cache = new ResponseCache<CachedFigmaData>(60_000, { now: () => now });
    const { svc, spy } = service("key-a");
    const onFetchStart = vi.fn();
    const onComplete = vi.fn();

    const first = await getFigmaData(svc, input, "json", { onFetchStart, onComplete }, cache);
    expect(first.cache).toBeUndefined();
    expect(spy).toHaveBeenCalledOnce();

    now = 30_000;
    const second = await getFigmaData(svc, input, "json", { onFetchStart, onComplete }, cache);
    expect(second.formatted).toBe(first.formatted);
    expect(second.cache).toEqual({ ageMs: 29_000, ttlMs: 60_000 });
    expect(spy).toHaveBeenCalledOnce();
    expect(onFetchStart).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete.mock.calls[1][0].cacheHit).toBe(true);
    expect(onComplete.mock.calls[1][0].cacheAgeMs).toBe(29_000);

    now = 61_000;
    await getFigmaData(svc, input, "json", {}, cache);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not share entries across credentials", async () => {
    const cache = new ResponseCache<CachedFigmaData>(60_000, { now: () => 0 });
    const a = service("key-a");
    const b = service("key-b");

    await getFigmaData(a.svc, input, "json", {}, cache);
    await getFigmaData(b.svc, input, "json", {}, cache);

    expect(a.spy).toHaveBeenCalledOnce();
    expect(b.spy).toHaveBeenCalledOnce();
  });

  it("does not store a failed fetch", async () => {
    const cache = new ResponseCache<CachedFigmaData>(60_000, { now: () => 0 });
    const { svc, spy } = service("key-a");
    spy.mockRejectedValueOnce(new Error("rate limited"));

    await expect(getFigmaData(svc, input, "json", {}, cache)).rejects.toThrow(/rate limited/);
    const result = await getFigmaData(svc, input, "json", {}, cache);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.cache).toBeUndefined();
  });

  it("leaves the design payload untouched and puts the age in its own block", async () => {
    let now = 0;
    const cache = new ResponseCache<CachedFigmaData>(60_000, { now: () => now });
    const { svc } = service("key-a");

    const fresh = await getFigmaData(svc, input, "json", {}, cache);
    now = 5_000;
    const cached = await getFigmaData(svc, input, "json", {}, cache);

    const content = toGetFigmaDataContent(cached);
    expect(content).toHaveLength(2);
    expect(content[0].text).toContain("5s ago");
    expect(content[1].text).toBe(fresh.formatted);
    expect(content[1].text.trimStart().startsWith("{")).toBe(true);
  });
});
