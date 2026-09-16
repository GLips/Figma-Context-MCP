import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunCancellationRegistry } from "./run-cancellation.js";

test("cancel refuses a queued run once and releases all tracking on settlement", () => {
  const runs = createRunCancellationRegistry();
  const ref = { connKey: 1, id: "run" };
  runs.enqueue(ref);
  assert.equal(runs.recordCancellation(1, "run"), "never-executed");
  assert.equal(runs.isCancelled(ref), true);
  assert.equal(runs.takeCancellation(ref), true);
  assert.equal(runs.takeCancellation(ref), false);
  runs.settle(ref);
  assert.equal(runs.recordCancellation(1, "run"), "unknown");
  assert.equal(runs.isCancelled(ref), false);
});

test("the cancel answer names the phase the run had actually reached", () => {
  const runs = createRunCancellationRegistry();
  const ref = { connKey: 1, id: "run" };
  assert.equal(runs.recordCancellation(1, "never-seen"), "unknown");
  runs.enqueue(ref);
  runs.markRunning(ref);
  assert.equal(runs.recordCancellation(1, "run"), "was-running");
  // Answering a cancel does not consume it: the mutation lock reads this to refuse the next verb.
  assert.equal(runs.isCancelled(ref), true);
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
