/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnnotationChangeLog } from "./annotation-changes.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a held ask answers once edits go quiet, one entry per node, and the next ask holds past them", async () => {
  const log = createAnnotationChangeLog({ epoch: "run-1", quietMs: 20 });
  const start = (await log.wait(null, 1_000)).cursor;

  const held = log.wait(start, 1_000);
  log.record("1:2");
  await tick(5);
  log.record("1:3");
  log.record("1:2");
  const answer = await held;
  assert.deepEqual(answer.nodeIds, ["1:3", "1:2"]);
  assert.equal(answer.restarted, false);

  const quiet = await log.wait(answer.cursor, 30);
  assert.deepEqual(quiet.nodeIds, []);
  assert.deepEqual(quiet.cursor, answer.cursor);
});

test("a cursor from an earlier plugin run reads this run's whole log at once, flagged restarted", async () => {
  const log = createAnnotationChangeLog({ epoch: "run-2" });
  log.record("4:5");
  const answer = await log.wait({ epoch: "run-1", seq: 99 }, 1_000);
  assert.deepEqual(answer.nodeIds, ["4:5"]);
  assert.equal(answer.restarted, true);
});

test("a cursor older than what the log still keeps is told some changes were dropped", async () => {
  const log = createAnnotationChangeLog({ epoch: "run-1", limit: 2 });
  const start = (await log.wait(null, 0)).cursor;
  for (const id of ["1:1", "1:2", "1:3"]) log.record(id);
  const answer = await log.wait(start, 0);
  assert.deepEqual(answer.nodeIds, ["1:2", "1:3"]);
  assert.equal(answer.overflowed, true);
  assert.equal((await log.wait(answer.cursor, 0)).overflowed, false);
});
