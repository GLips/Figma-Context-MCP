// The mid-run image request server half (protocol 2): the session cache's byte-capped LRU and the
// request handler's cap/dedupe/cache behavior. These bounds are the memory-safety story for a
// long-lived local server, so they're pinned rather than trusted.
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  SessionImageCache,
  createImagesRequestHandler,
  MAX_IMAGES_PER_RUN,
} from "~/services/plugin-bridge/image-requests.js";

test("cache: a repeated url is served without a second fetch", async () => {
  const fetched: string[] = [];
  const handler = createImagesRequestHandler({
    cache: new SessionImageCache(),
    fetchImage: async (url) => {
      fetched.push(url);
      return `b64(${url})`;
    },
  });
  assert.deepEqual(await handler(["u1"]), { u1: "b64(u1)" });
  assert.deepEqual(await handler(["u1", "u2"]), { u1: "b64(u1)", u2: "b64(u2)" });
  assert.deepEqual(fetched, ["u1", "u2"], "u1 was fetched exactly once");
});

test("cache: evicts least-recently-used entries once the byte cap is exceeded", () => {
  const cache = new SessionImageCache(10);
  cache.set("a", "aaaa"); // 4
  cache.set("b", "bbbb"); // 8
  cache.get("a"); // touch a → b is now the LRU
  cache.set("c", "cccc"); // 12 → evict b
  assert.equal(cache.get("b"), undefined, "the LRU entry was evicted");
  assert.equal(cache.get("a"), "aaaa", "the touched entry survived");
  assert.equal(cache.get("c"), "cccc");
});

test("cache: an entry larger than the whole cap is never stored (no thrash)", () => {
  const cache = new SessionImageCache(4);
  cache.set("small", "xx");
  cache.set("huge", "xxxxxxxx");
  assert.equal(cache.get("huge"), undefined);
  assert.equal(cache.get("small"), "xx", "the oversized entry evicted nothing");
});

test("handler: dedupes before counting against the per-run cap", async () => {
  const fetched: string[] = [];
  const handler = createImagesRequestHandler({
    cache: new SessionImageCache(),
    fetchImage: async (url) => {
      fetched.push(url);
      return "b";
    },
  });
  const sameUrlManyTimes = Array.from({ length: MAX_IMAGES_PER_RUN * 2 }, () => "u1");
  await handler(sameUrlManyTimes);
  assert.deepEqual(fetched, ["u1"], "duplicates collapse to one fetch and don't trip the cap");
});

test("handler: over the distinct-url cap fails loud naming the cap", async () => {
  const handler = createImagesRequestHandler({
    cache: new SessionImageCache(),
    fetchImage: async () => "b",
  });
  const urls = Array.from({ length: MAX_IMAGES_PER_RUN + 1 }, (_, i) => `u${i}`);
  await assert.rejects(handler(urls), new RegExp(`over the ${MAX_IMAGES_PER_RUN} cap`));
});

test("handler: a single fetch failure rejects the whole request", async () => {
  const handler = createImagesRequestHandler({
    cache: new SessionImageCache(),
    fetchImage: async (url) => {
      if (url === "bad") throw new Error('flcm.image could not load "bad": blocked range');
      return "b";
    },
  });
  await assert.rejects(handler(["ok", "bad"]), /could not load "bad"/);
});
