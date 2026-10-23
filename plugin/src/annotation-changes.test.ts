/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnnotationChangeLog } from "./annotation-changes.js";
import type { AnnotationCursor } from "./protocol.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quietLog = (epoch: string, limit?: number) =>
  createAnnotationChangeLog({ epoch, limit, onSettled: () => {} });

test("says the log moved once edits go quiet, and a read from before reads each node once", async () => {
  const notices: AnnotationCursor[] = [];
  const log = createAnnotationChangeLog({ epoch: "run-1", quietMs: 20, onSettled: (cursor) => notices.push(cursor) });
  const start = log.slice(null).cursor;

  log.record("1:2");
  await tick(5);
  log.record("1:3");
  log.record("1:2");
  await tick(40);
  assert.deepEqual(notices, [{ epoch: "run-1", seq: 3 }]);

  const read = log.slice(start);
  assert.deepEqual(read.nodeIds, ["1:3", "1:2"]);
  assert.deepEqual(read.cursor, notices[0]);
  assert.deepEqual(log.slice(read.cursor).nodeIds, []);
});

test("a cursor from an earlier plugin run reads this run's whole log, flagged restarted", () => {
  const log = quietLog("run-2");
  log.record("4:5");
  const read = log.slice({ epoch: "run-1", seq: 99 });
  assert.deepEqual(read.nodeIds, ["4:5"]);
  assert.equal(read.restarted, true);
});

test("a cursor older than what the log still keeps is told some changes were dropped", () => {
  const log = quietLog("run-1", 2);
  const start = log.slice(null).cursor;
  for (const id of ["1:1", "1:2", "1:3"]) log.record(id);
  const read = log.slice(start);
  assert.deepEqual(read.nodeIds, ["1:2", "1:3"]);
  assert.equal(read.overflowed, true);
  assert.equal(log.slice(read.cursor).overflowed, false);
});
