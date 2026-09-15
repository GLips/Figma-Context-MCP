// Screenshot target resolution: the whole-page default must fire ONLY when no target was passed —
// never as a fallback from a key that matched nothing or several nodes. A silent page capture standing
// in for a failed lookup is the exact bug this surface exists to close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../harness/figma-mock.mjs";

import { render } from "./preamble/render.js";
import { resolveScreenshotTarget } from "./screenshot-target.js";

test("resolves by nodeId, by key, and falls back to the page only with no target", async () => {
  createFigmaMock();
  const out = await render({
    type: "FRAME",
    key: "root",
    children: [{ type: "RECTANGLE", key: "card", width: 40, height: 40 }],
  });

  assert.equal(
    (await resolveScreenshotTarget({ nodeId: out.children![0].id })).id,
    out.children![0].id,
  );
  assert.equal((await resolveScreenshotTarget({ key: "card" })).id, out.children![0].id);
  assert.equal((await resolveScreenshotTarget({})).id, figma.currentPage.id);
});

test("an unmatched key throws naming the key, rather than capturing the page", async () => {
  createFigmaMock();
  await render({ type: "FRAME", key: "root" });

  await assert.rejects(() => resolveScreenshotTarget({ key: "nope" }), /flcm key "nope"/);
});

test("a duplicated key throws naming the count, rather than picking one", async () => {
  createFigmaMock();
  // Two renders stamping the same key models what a user duplicating a node does: pluginData copies.
  await render({ type: "FRAME", key: "card" });
  await render({ type: "FRAME", key: "card" });

  await assert.rejects(
    () => resolveScreenshotTarget({ key: "card" }),
    /2 nodes .* flcm key "card"/,
  );
});
