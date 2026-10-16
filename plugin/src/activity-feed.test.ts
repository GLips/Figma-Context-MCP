/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_FEED_LIMIT, createActivityFeed } from "./activity-feed.js";

const noPromptLive = () => false;

test("the cap drops finished calls, never one still running, so its outcome still lands", () => {
  const feed = createActivityFeed(() => {});
  feed.arrived("long-run", "Build the page", "/project");
  feed.advance("long-run", "running", "maple-orbit-velvet-quarry");
  for (let i = 0; i < ACTIVITY_FEED_LIMIT + 3; i++) {
    feed.arrived(`refused-${i}`, "Try again", "/project");
    feed.advance(`refused-${i}`, "refused");
  }

  const shown = feed.entries(noPromptLive);
  assert.equal(shown.length, ACTIVITY_FEED_LIMIT);
  assert.equal(shown.at(-1)?.executionId, "long-run");

  feed.advance("long-run", "done");
  assert.equal(feed.entries(noPromptLive).find((entry) => entry.executionId === "long-run")?.outcome, "done");
});

test("a waiting call reads as not run once its prompt is gone, and waiting again when re-asked", () => {
  const feed = createActivityFeed(() => {});
  let live = true;
  feed.waiting("call", "Rename the layers", "/project");
  assert.equal(feed.entries(() => live)[0]?.outcome, "waiting");

  live = false;
  assert.equal(feed.entries(() => live)[0]?.outcome, "not-run");

  live = true;
  feed.waiting("call", "Rename the layers", "/project");
  assert.equal(feed.entries(() => live)[0]?.outcome, "waiting");
});
