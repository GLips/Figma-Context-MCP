import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureLibrary, captureLive, parseFigmaUrl } from "../src/server/captures.js";
import { createApp } from "../src/server/app.js";
test("capture persists exact bytes and safe metadata, never the request token or unsafe query", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capture-test-"));
  try {
    const lib = new CaptureLibrary(dir),
      token = "private-token-sentinel";
    const raw =
      '{ "name":"Design", "version":"42", "nodes": { "1:2": {"document":{"id":"1:2"}} } }\n';
    const capture = await captureLive(
      lib,
      { name: "Design", url: `https://www.figma.com/design/abc/Name?node-id=1-2&token=${token}` },
      { apiKey: token },
      async (url, init) => {
        assert.equal(String(url), "https://api.figma.com/v1/files/abc/nodes?ids=1%3A2");
        assert.equal(new Headers(init?.headers).get("X-Figma-Token"), token);
        assert.equal(init?.redirect, "error");
        return new Response(raw);
      },
    );
    assert.equal((await lib.raw(capture.id)).toString(), raw);
    assert.ok(!JSON.stringify(capture).includes(token));
    assert.ok(!(await readFile(join(dir, capture.id, "metadata.json"), "utf8")).includes(token));
    assert.equal((await lib.list()).length, 1);
    await lib.remove(capture.id);
    assert.equal((await lib.list()).length, 0);
    await assert.rejects(lib.raw("../../etc/passwd"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("refuses non-Figma hosts and keeps credentials out of upstream errors", async () => {
  for (const url of [
    "http://figma.com/design/abc",
    "https://figma.com.evil.test/design/abc",
    "https://token@figma.com/design/abc",
    "https://figma.com:999/design/abc",
  ])
    assert.throws(() => parseFigmaUrl(url));
  await assert.rejects(
    captureLive(
      new CaptureLibrary("unused"),
      { name: "x", url: "https://figma.com/file/abc" },
      { apiKey: "secret" },
      async () => {
        throw new Error("secret");
      },
    ),
    /Check connectivity/,
  );
});
test("HTTP boundary rejects foreign origins, rebinding hosts, and credential input", async () => {
  const origin = "http://127.0.0.1:4317";
  const app = createApp({ root: "/unused", dataDir: "/unused", origin, credentials: {} });
  assert.equal(
    (await app.request(`${origin}/api/captures`, { headers: { Origin: "https://evil.test" } }))
      .status,
    403,
  );
  assert.equal(
    (await app.request(`${origin}/api/captures`, { headers: { Host: "evil.test:4317" } })).status,
    403,
  );
  assert.equal((await app.request(`${origin}/api/sample`, { method: "POST" })).status, 403);
  const res = await app.request(`${origin}/api/captures`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x", url: "https://figma.com/file/abc", token: "secret" }),
  });
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes("secret"));
});
test("branch URLs capture the branch key rather than the parent file", () => {
  const source = parseFigmaUrl(
    "https://www.figma.com/design/parent/branch/branchKey/Design?node-id=1-2",
  );
  assert.equal(source.fileKey, "branchKey");
  assert.equal(source.endpoint, "https://api.figma.com/v1/files/branchKey/nodes?ids=1%3A2");
});
