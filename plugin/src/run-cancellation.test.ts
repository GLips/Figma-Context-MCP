import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunCancellationRegistry } from "./run-cancellation.js";

test("cancel refuses a queued run once and releases all tracking on settlement", () => {
  const runs = createRunCancellationRegistry();
  const ref = { connKey: 1, id: "run" };
  runs.enqueue(ref); runs.recordCancellation(1, "run");
  assert.equal(runs.isCancelled(ref), true);
  assert.equal(runs.takeCancellation(ref), true);
  assert.equal(runs.takeCancellation(ref), false);
  runs.settle(ref);
  runs.recordCancellation(1, "run");
  assert.equal(runs.isCancelled(ref), false);
});

test("old settlement cannot erase replacement tracking with the same request id", () => {
  const runs = createRunCancellationRegistry();
  const old = { connKey: 1, id: "same" };
  const next = { connKey: 2, id: "same" };
  const other = { connKey: 3, id: "same" };
  runs.enqueue(old); runs.cancelConnection(1);
  runs.enqueue(next); runs.enqueue(other);
  assert.equal(runs.isCancelled(old), true);
  assert.equal(runs.isCancelled(next), false);
  runs.settle(old); runs.cancelConnection(2);
  assert.equal(runs.isCancelled(next), true);
  assert.equal(runs.isCancelled(other), false);
});
