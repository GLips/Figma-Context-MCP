/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunRegistry } from "./run-registry.js";

const label = { kind: "code" as const, intent: "Test run", session: null };
const registry = () => createRunRegistry({ onQueueChange: () => {} });

test("a cancel names its cause, the first cause sticks, and settlement releases all tracking", () => {
  const runs = registry();
  const ref = { connKey: 1, id: "run" };
  runs.enqueue(ref, label);
  runs.cancelConnection(1, "revoked");
  assert.equal(runs.recordCancellation(1, "run").disposition, "never-executed");
  assert.equal(runs.cancellation(ref), "revoked");
  runs.settle(ref);
  assert.equal(runs.recordCancellation(1, "run").disposition, "unknown");
  assert.equal(runs.cancellation(ref), null);
});

test("old settlement cannot erase replacement tracking with the same request id", () => {
  const runs = registry();
  const old = { connKey: 1, id: "same" };
  const next = { connKey: 2, id: "same" };
  const other = { connKey: 3, id: "same" };
  runs.enqueue(old, label); runs.cancelConnection(1, "disconnected");
  runs.enqueue(next, label); runs.enqueue(other, label);
  assert.equal(runs.cancellation(old), "disconnected");
  assert.equal(runs.cancellation(next), null);
  runs.settle(old); runs.cancelConnection(2, "disconnected");
  assert.equal(runs.cancellation(next), "disconnected");
  assert.equal(runs.cancellation(other), null);
});

test("a pending call is settled only by its own run's token, once, and never by a late settle on a later run", () => {
  const runs = registry();
  const first = { connKey: 1, id: "first" };
  const second = { connKey: 1, id: "second" };
  runs.enqueue(first, label); runs.markRunning(first);
  const font = runs.callStarted(first, "figma.loadFontAsync");
  const bad = runs.callStarted(first, "figma.no such call" as "figma.x");
  assert.equal(runs.activity(first, Date.now()).pendingCount, 2);
  assert.deepEqual(runs.activity(first, Date.now()).pending.map((call) => call.operation), ["figma.loadFontAsync"]);
  runs.callSettled(first, bad); runs.callSettled(first, bad);
  assert.equal(runs.activity(first, Date.now()).callsSettled, 1);
  runs.settle(first);
  runs.enqueue(second, label); runs.markRunning(second);
  const edit = runs.callStarted(second, "flcm.edit");
  runs.callSettled(first, edit); runs.callSettled(second, font);
  const { callsSettled, pending, pendingCount } = runs.activity(second, Date.now());
  assert.deepEqual([callsSettled, pending.map((call) => call.operation), pendingCount], [0, ["flcm.edit"], 1]);
});
