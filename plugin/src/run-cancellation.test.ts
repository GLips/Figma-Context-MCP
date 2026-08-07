// The run-cancellation registry (plan invariant 4's host half): record → refuse-once at dequeue,
// live visibility during execution, socket-close cancellation of accepted runs, and a port sweep
// that never clears an outstanding run's cancellation (the socket-blip zombie cases).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunCancellationRegistry } from "./run-cancellation.js";

test("a recorded cancellation refuses its run exactly once at dequeue", () => {
  const runs = createRunCancellationRegistry();
  runs.recordCancellation(9876, "req-1");
  assert.equal(runs.takeCancellation({ connKey: 9876, id: "req-1" }), true);
  assert.equal(runs.takeCancellation({ connKey: 9876, id: "req-1" }), false);
});

test("a cancellation arriving mid-execution is visible live and consumed at settle", () => {
  const runs = createRunCancellationRegistry();
  const ref = { connKey: 9876, id: "req-2" };
  runs.enqueue(ref);
  runs.recordCancellation(9876, "req-2");
  assert.equal(runs.isCancelled(ref), true);
  runs.settle(ref);
  assert.equal(runs.isCancelled(ref), false);
});

test("socket close cancels every outstanding run on that port, and only that port", () => {
  const runs = createRunCancellationRegistry();
  const queued = { connKey: 9876, id: "req-3" };
  const otherPort = { connKey: 9877, id: "req-3" };
  runs.enqueue(queued);
  runs.enqueue(otherPort);
  runs.cancelPort(9876);
  assert.equal(runs.isCancelled(queued), true);
  assert.equal(runs.isCancelled(otherPort), false);
});

test("the port sweep clears idle entries but never an outstanding run's — queued or executing", () => {
  const runs = createRunCancellationRegistry();
  const queued = { connKey: 9876, id: "req-4" };
  runs.enqueue(queued); // accepted, still waiting behind the write chain
  runs.recordCancellation(9876, "req-4"); // timed out while queued — must survive the blip
  runs.recordCancellation(9876, "req-5"); // idle (e.g. a timed-out handshake) — swept
  runs.recordCancellation(9877, "req-4"); // another port — untouched
  runs.sweepPort(9876);
  assert.equal(runs.isCancelled(queued), true);
  assert.equal(runs.isCancelled({ connKey: 9876, id: "req-5" }), false);
  assert.equal(runs.isCancelled({ connKey: 9877, id: "req-4" }), true);
});

test("colliding run ids on different ports never cross", () => {
  const runs = createRunCancellationRegistry();
  runs.recordCancellation(9876, "req-1");
  assert.equal(runs.isCancelled({ connKey: 9877, id: "req-1" }), false);
});
