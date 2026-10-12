/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunCancellationRegistry } from "./run-cancellation.js";

test("a cancel names its cause, the first cause sticks, and settlement releases all tracking", () => {
  const runs = createRunCancellationRegistry();
  const ref = { connKey: 1, id: "run" };
  runs.enqueue(ref);
  runs.cancelConnection(1, "revoked");
  assert.equal(runs.recordCancellation(1, "run"), "never-executed");
  assert.equal(runs.cancellation(ref), "revoked");
  runs.settle(ref);
  assert.equal(runs.recordCancellation(1, "run"), "unknown");
  assert.equal(runs.cancellation(ref), null);
});

test("the cancel answer names the phase the run had actually reached", () => {
  const runs = createRunCancellationRegistry();
  const ref = { connKey: 1, id: "run" };
  assert.equal(runs.recordCancellation(1, "never-seen"), "unknown");
  runs.enqueue(ref);
  runs.markRunning(ref);
  assert.equal(runs.recordCancellation(1, "run"), "was-running");
  // Answering a cancel does not consume it: the mutation lock reads this to refuse the next verb.
  assert.equal(runs.cancellation(ref), "server");
});

test("old settlement cannot erase replacement tracking with the same request id", () => {
  const runs = createRunCancellationRegistry();
  const old = { connKey: 1, id: "same" };
  const next = { connKey: 2, id: "same" };
  const other = { connKey: 3, id: "same" };
  runs.enqueue(old); runs.cancelConnection(1, "disconnected");
  runs.enqueue(next); runs.enqueue(other);
  assert.equal(runs.cancellation(old), "disconnected");
  assert.equal(runs.cancellation(next), null);
  runs.settle(old); runs.cancelConnection(2, "disconnected");
  assert.equal(runs.cancellation(next), "disconnected");
  assert.equal(runs.cancellation(other), null);
});
