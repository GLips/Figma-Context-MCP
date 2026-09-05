// flcm.page — the document verbs. What's worth pinning is the REFUSALS: these exist because the raw
// path (createPage then `figma.currentPage = page`) throws half-way and leaves an orphan, so a page
// verb that quietly created or switched to the wrong thing would be worse than no verb at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { pageCurrent, pageNew, pageUse } from "./page.js";

test("page.new creates, switches, and reports the file it landed in", async () => {
  createFigmaMock();

  const info = await pageNew("pricing");
  assert.equal(info.page.name, "pricing");
  assert.equal(info.fileName, "Untitled");
  // Switched — a render issued next lands here, which is the entire point of the verb.
  assert.equal(figma.currentPage.name, "pricing");
  assert.deepEqual(
    info.pages.map((p) => p.name),
    ["Page 1", "pricing"],
  );
});

test("page.new refuses a name the file already uses, and creates nothing", async () => {
  createFigmaMock();
  await pageNew("pricing");

  await assert.rejects(pageNew("pricing"), /already has a page named "pricing"/);
  // The refusal is worth nothing if a twin got minted anyway — a retried call must not split the
  // work across two same-named pages.
  const { pages } = await pageCurrent();
  assert.equal(pages.filter((p) => p.name === "pricing").length, 1);
});

test("page.use switches to an existing page and never creates one", async () => {
  createFigmaMock();
  const made = await pageNew("pricing");
  await pageUse("Page 1");
  assert.equal(figma.currentPage.name, "Page 1");

  // By id as well as by name — an id is the unambiguous address when names repeat.
  const back = await pageUse(made.page.id);
  assert.equal(back.page.name, "pricing");

  await assert.rejects(pageUse("checkout"), /no page with id or name "checkout"/);
  // A miss lists what IS there, so a half-remembered name self-corrects in one round trip.
  await assert.rejects(pageUse("checkout"), /"Page 1", "pricing"/);
  assert.equal((await pageCurrent()).pages.length, 2);
});
