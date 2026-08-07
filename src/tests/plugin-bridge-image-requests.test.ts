// The mid-run image request server half (protocol 2): the session cache's byte-capped LRU and the
// request handler's cap/dedupe/cache behavior. These bounds are the memory-safety story for a
// long-lived local server, so they're pinned rather than trusted.
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  ImageByteCache,
  createImagesRequestHandler,
  MAX_IMAGES_PER_REQUEST,
} from "~/services/plugin-bridge/image-requests.js";

test("cache: a repeated url is served without a second fetch", async () => {
  // Real https urls — only remote sources are cached (a bare string classifies as a local path).
  const u1 = "https://cdn.example.com/u1.png";
  const u2 = "https://cdn.example.com/u2.png";
  const fetched: string[] = [];
  const handler = createImagesRequestHandler({
    cache: new ImageByteCache(),
    fetchImage: async (url) => {
      fetched.push(url);
      return `b64(${url})`;
    },
  });
  assert.deepEqual(await handler([u1]), { [u1]: `b64(${u1})` });
  assert.deepEqual(await handler([u1, u2]), { [u1]: `b64(${u1})`, [u2]: `b64(${u2})` });
  assert.deepEqual(fetched, [u1, u2], "u1 was fetched exactly once");
});

test("cache: a local file path is never cached — each request re-reads from disk", async () => {
  const fetched: string[] = [];
  const handler = createImagesRequestHandler({
    cache: new ImageByteCache(),
    fetchImage: async (url) => {
      fetched.push(url);
      return `b64(${url})`;
    },
  });
  await handler(["assets/logo.png"]);
  await handler(["assets/logo.png"]);
  assert.deepEqual(
    fetched,
    ["assets/logo.png", "assets/logo.png"],
    "a local path is read fresh on every request — a cached read would paint stale bytes after the user edits the file",
  );
});

test("cache: evicts least-recently-used entries once the byte cap is exceeded", () => {
  const cache = new ImageByteCache(10);
  cache.set("a", "aaaa"); // 4
  cache.set("b", "bbbb"); // 8
  cache.get("a"); // touch a → b is now the LRU
  cache.set("c", "cccc"); // 12 → evict b
  assert.equal(cache.get("b"), undefined, "the LRU entry was evicted");
  assert.equal(cache.get("a"), "aaaa", "the touched entry survived");
  assert.equal(cache.get("c"), "cccc");
});

test("cache: an entry larger than the whole cap is never stored (no thrash)", () => {
  const cache = new ImageByteCache(4);
  cache.set("small", "xx");
  cache.set("huge", "xxxxxxxx");
  assert.equal(cache.get("huge"), undefined);
  assert.equal(cache.get("small"), "xx", "the oversized entry evicted nothing");
});

test("handler: dedupes before counting against the per-request cap", async () => {
  const fetched: string[] = [];
  const handler = createImagesRequestHandler({
    cache: new ImageByteCache(),
    fetchImage: async (url) => {
      fetched.push(url);
      return "b";
    },
  });
  const sameUrlManyTimes = Array.from({ length: MAX_IMAGES_PER_REQUEST * 2 }, () => "u1");
  await handler(sameUrlManyTimes);
  assert.deepEqual(fetched, ["u1"], "duplicates collapse to one fetch and don't trip the cap");
});

test("handler: over the distinct-url cap fails loud naming the cap", async () => {
  const handler = createImagesRequestHandler({
    cache: new ImageByteCache(),
    fetchImage: async () => "b",
  });
  const urls = Array.from({ length: MAX_IMAGES_PER_REQUEST + 1 }, (_, i) => `u${i}`);
  await assert.rejects(handler(urls), new RegExp(`over the ${MAX_IMAGES_PER_REQUEST} cap`));
});

test("handler: after one fetch fails, workers claim no new urls (bounded tail work)", async () => {
  const fetched: string[] = [];
  const handler = createImagesRequestHandler({
    cache: new ImageByteCache(),
    fetchImage: async (url) => {
      fetched.push(url);
      if (url === "bad") throw new Error("boom");
      await new Promise((r) => setTimeout(r, 20));
      return "b";
    },
  });
  const urls = ["bad", ...Array.from({ length: 12 }, (_, i) => `u${i}`)];
  await assert.rejects(handler(urls), /boom/);
  // Only the fetches already in flight when "bad" failed may run — the concurrency width, not the
  // whole remaining list.
  assert.ok(fetched.length <= 4, `expected at most 4 started fetches, saw ${fetched.length}`);
});

test("handler: a reply exceeding the aggregate byte cap fails loud naming the budget", async () => {
  const handler = createImagesRequestHandler({
    cache: new ImageByteCache(),
    fetchImage: async () => "x".repeat(30 * 1024 * 1024),
  });
  await assert.rejects(handler(["u1", "u2", "u3"]), /total over 64MiB/);
});

test("handler: a single fetch failure rejects the whole request", async () => {
  const handler = createImagesRequestHandler({
    cache: new ImageByteCache(),
    fetchImage: async (url) => {
      if (url === "bad") throw new Error('flcm.image could not load "bad": blocked range');
      return "b";
    },
  });
  await assert.rejects(handler(["ok", "bad"]), /could not load "bad"/);
});
