/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// flcm.page — the document verbs. What's worth pinning is the REFUSALS: these exist because the raw
// path (createPage then `figma.currentPage = page`) throws half-way and leaves an orphan, so a page
// verb that quietly created or switched to the wrong thing would be worse than no verb at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { pageCurrent, pageNew, pageUse } from "./page.js";

test("page.new creates the page without switching, and says where the agent still is", async () => {
  createFigmaMock();

  const made = await pageNew("pricing");
  assert.equal(made.created.name, "pricing");
  // Not switched: Figma can hold a switch to a fresh page for minutes, so new leaves navigation to use.
  assert.equal(figma.currentPage.name, "Page 1");
  assert.deepEqual(made.currentPage, { id: "0:1", name: "Page 1" });
  assert.match(made.note, /in the background\. The current page is still "Page 1"/);
  assert.ok(made.note.includes(`flcm.append(${JSON.stringify(made.created.id)}, spec)`), made.note);
  assert.deepEqual(
    (await pageCurrent()).pages.map((p) => p.name),
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
  await pageUse("pricing");
  assert.equal(figma.currentPage.name, "pricing");
  await pageUse("Page 1");
  assert.equal(figma.currentPage.name, "Page 1");

  // By id as well as by name — an id is the unambiguous address when names repeat.
  const back = await pageUse(made.created.id);
  assert.equal(back.page.name, "pricing");

  await assert.rejects(pageUse("checkout"), /no page with id or name "checkout"/);
  // A miss lists what IS there, so a half-remembered name self-corrects in one round trip.
  await assert.rejects(pageUse("checkout"), /"Page 1", "pricing"/);
  assert.equal((await pageCurrent()).pages.length, 2);
});
