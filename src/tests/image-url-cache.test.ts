import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadAndProcessImage = vi.hoisted(() =>
  vi.fn(async (fileName: string, localPath: string) => ({
    filePath: `${localPath}/${fileName}`,
    originalDimensions: { width: 1, height: 1 },
    finalDimensions: { width: 1, height: 1 },
    wasCropped: false,
    processingLog: [],
  })),
);

vi.mock("~/utils/image-processing.js", () => ({
  downloadAndProcessImage,
}));

import { toDownloadImagesContent } from "~/mcp/tools/download-figma-images-tool.js";
import { downloadFigmaImages } from "~/services/download-figma-images.js";
import { FigmaService } from "~/services/figma.js";
import { ImageUrlCache } from "~/services/response-cache.js";

function caches(now: () => number, ttl = 60_000): ImageUrlCache {
  return new ImageUrlCache(ttl, now);
}

function service(apiKey: string) {
  const svc = new FigmaService({ figmaApiKey: apiKey, figmaOAuthToken: "", useOAuth: false });
  const fills = vi.spyOn(svc, "getImageFillUrls").mockResolvedValue({
    refA: "https://example.test/a.png",
  });
  const renders = vi
    .spyOn(svc, "getNodeRenderUrls")
    .mockImplementation(async (_fileKey, ids, format) => {
      const urls: Record<string, string> = {};
      for (const id of ids) urls[id] = `https://example.test/${format}/${id}`;
      return urls;
    });
  return { svc, fills, renders };
}

const fillInput = {
  fileKey: "abc",
  localPath: "/tmp/images",
  nodes: [{ nodeId: "1:2", imageRef: "refA", fileName: "a.png" }],
};

describe("image URL cache", () => {
  beforeEach(() => {
    downloadAndProcessImage.mockClear();
  });

  it("reuses fill URLs until the TTL and still downloads the bytes", async () => {
    let now = 1_000;
    const cache = caches(() => now);
    const { svc, fills } = service("key-a");
    const onComplete = vi.fn();

    const first = await downloadFigmaImages(svc, fillInput, { onComplete }, cache);
    expect(first.cache).toBeUndefined();
    expect(first.cacheHit).toBe(false);
    expect(fills).toHaveBeenCalledOnce();
    expect(downloadAndProcessImage).toHaveBeenCalledOnce();

    now = 20_000;
    downloadAndProcessImage.mockClear();
    const second = await downloadFigmaImages(svc, fillInput, { onComplete }, cache);
    expect(fills).toHaveBeenCalledOnce();
    expect(second.cache).toEqual({ ageMs: 19_000, ttlMs: 60_000 });
    expect(second.cacheHit).toBe(true);
    expect(downloadAndProcessImage).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[1][0].cacheHit).toBe(true);
    expect(onComplete.mock.calls[1][0].cacheAgeMs).toBe(19_000);

    now = 70_000;
    await downloadFigmaImages(svc, fillInput, {}, cache);
    expect(fills).toHaveBeenCalledTimes(2);
  });

  it("does not share fill URLs across credentials", async () => {
    const cache = caches(() => 0);
    const a = service("key-a");
    const b = service("key-b");

    await downloadFigmaImages(a.svc, fillInput, {}, cache);
    await downloadFigmaImages(b.svc, fillInput, {}, cache);

    expect(a.fills).toHaveBeenCalledOnce();
    expect(b.fills).toHaveBeenCalledOnce();
  });

  it("does not store a failed fill lookup", async () => {
    const cache = caches(() => 0);
    const { svc, fills } = service("key-a");
    fills.mockRejectedValueOnce(new Error("rate limited"));

    await expect(downloadFigmaImages(svc, fillInput, {}, cache)).rejects.toThrow(/rate limited/);
    const result = await downloadFigmaImages(svc, fillInput, {}, cache);

    expect(fills).toHaveBeenCalledTimes(2);
    expect(result.cache).toBeUndefined();
  });

  it("refetches the fill map when it lacks a requested ref", async () => {
    // An image added to the file after the map was cached must not be
    // silently skipped until the TTL runs out.
    const cache = caches(() => 0);
    const { svc, fills } = service("key-a");
    await downloadFigmaImages(svc, fillInput, {}, cache);

    fills.mockResolvedValue({
      refA: "https://example.test/a.png",
      refB: "https://example.test/b.png",
    });
    const second = await downloadFigmaImages(
      svc,
      {
        ...fillInput,
        nodes: [{ nodeId: "1:2", imageRef: "refB", fileName: "b.png" }],
      },
      {},
      cache,
    );

    expect(fills).toHaveBeenCalledTimes(2);
    expect(second.successCount).toBe(1);
    expect(second.cacheHit).toBe(false);
    expect(second.cache).toBeUndefined();
  });

  it("reuses render URLs per node, scale, and SVG flags", async () => {
    const cache = caches(() => 1_000);
    const { svc, renders } = service("key-a");
    const base = { fileKey: "abc", localPath: "/tmp/images", pngScale: 2 };

    await downloadFigmaImages(
      svc,
      {
        ...base,
        nodes: [
          { nodeId: "1:2", fileName: "a.png" },
          { nodeId: "3:4", fileName: "b.png" },
        ],
      },
      {},
      cache,
    );
    expect(renders).toHaveBeenCalledWith("abc", ["1:2", "3:4"], "png", { pngScale: 2 });

    renders.mockClear();
    downloadAndProcessImage.mockClear();
    const subset = await downloadFigmaImages(
      svc,
      { ...base, nodes: [{ nodeId: "1:2", fileName: "a.png" }] },
      {},
      cache,
    );
    expect(renders).not.toHaveBeenCalled();
    expect(subset.cacheHit).toBe(true);
    expect(downloadAndProcessImage).toHaveBeenCalledOnce();

    const partial = await downloadFigmaImages(
      svc,
      {
        ...base,
        nodes: [
          { nodeId: "1:2", fileName: "a.png" },
          { nodeId: "5:6", fileName: "c.png" },
        ],
      },
      {},
      cache,
    );
    expect(renders).toHaveBeenCalledWith("abc", ["5:6"], "png", { pngScale: 2 });
    expect(partial.cacheHit).toBe(false);
    expect(partial.cache?.ageMs).toBe(0);

    renders.mockRejectedValueOnce(new Error("rate limited"));
    await expect(
      downloadFigmaImages(
        svc,
        {
          ...base,
          nodes: [
            { nodeId: "1:2", fileName: "a.png" },
            { nodeId: "9:9", fileName: "d.png" },
          ],
        },
        {},
        cache,
      ),
    ).rejects.toThrow(/rate limited/);
    renders.mockClear();
    await downloadFigmaImages(
      svc,
      { ...base, nodes: [{ nodeId: "1:2", fileName: "a.png" }] },
      {},
      cache,
    );
    expect(renders).not.toHaveBeenCalled();

    await downloadFigmaImages(
      svc,
      { ...base, pngScale: 3, nodes: [{ nodeId: "1:2", fileName: "a.png" }] },
      {},
      cache,
    );
    expect(renders).toHaveBeenCalledWith("abc", ["1:2"], "png", { pngScale: 3 });

    renders.mockClear();
    await svc.downloadImages("abc", "/tmp/images", [{ nodeId: "1:2", fileName: "a.svg" }], {
      imageUrlCache: cache,
    });
    expect(renders).toHaveBeenCalledWith("abc", ["1:2"], "svg", {
      svgOptions: { outlineText: true, includeId: false, simplifyStroke: true },
    });
    await svc.downloadImages("abc", "/tmp/images", [{ nodeId: "1:2", fileName: "a.svg" }], {
      imageUrlCache: cache,
      svgOptions: { outlineText: false, includeId: false, simplifyStroke: true },
    });
    expect(renders).toHaveBeenCalledTimes(2);
  });
});

describe("toDownloadImagesContent", () => {
  it("puts the age note in its own block", () => {
    const content = toDownloadImagesContent("Downloaded 1 images", {
      ageMs: 5_000,
      ttlMs: 60_000,
    });
    expect(content).toHaveLength(2);
    expect(content[0].text).toContain("5s ago");
    expect(content[1].text).toBe("Downloaded 1 images");
  });
});
