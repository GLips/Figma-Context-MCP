// The mutation lock (plan invariant 4): mutating verbs serialize within a run, a failed verb
// doesn't poison later ones, a cancelled run is refused at the lock before the next verb's first
// canvas write, and the invariant-2 undo scaffold emits the exact call SEQUENCE the live contract
// needs (the mock records commitUndo/triggerUndo calls; their semantics are the live probe's to
// ground). The host normally passes __flcmRunCancelled as an eval-wrapper parameter; these tests
// run in global scope, so they install it on globalThis (same free-identifier resolution — the
// pattern the harness uses for __flcmRequestImages).
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { enterMutatingVerb, committedVerbCount } from "./mutation-lock.js";
import { frame, render } from "./flcm.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

const installCancelFlag = (check: () => boolean): void => {
  (globalThis as Record<string, unknown>).__flcmRunCancelled = check;
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__flcmRunCancelled;
});

test("verbs serialize: a queued verb never starts before the running one finishes", async () => {
  const events: string[] = [];
  const slow = enterMutatingVerb("render", async () => {
    events.push("a:start");
    await new Promise((r) => setTimeout(r, 20));
    events.push("a:end");
  });
  const queued = enterMutatingVerb("render", async () => {
    events.push("b:start");
  });
  await Promise.all([slow, queued]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start"]);
});

test("a successful verb is one sealed step: entry seal, then success commit — no trigger", async () => {
  const before = committedVerbCount();
  assert.equal(await enterMutatingVerb("edit", async () => 42), 42);
  assert.deepEqual(figma.undoLog, ["commit", "commit"]);
  assert.equal(committedVerbCount(), before + 1);
});

test("a failed verb seals its partial writes and pops exactly that step (commit-then-undo)", async () => {
  const before = committedVerbCount();
  await assert.rejects(
    enterMutatingVerb("edit", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  // Entry seal, failure seal, then the pop — never a bare trigger over uncommitted writes
  // (triggerUndo reverts the last COMMITTED step; bare, it would eat the previous step too).
  assert.deepEqual(figma.undoLog, ["commit", "commit", "trigger"]);
  // A rolled-back verb never counts as committed — the pointer error reports only verbs that stand.
  assert.equal(committedVerbCount(), before);
  // And the chain isn't poisoned: the next verb runs.
  assert.equal(await enterMutatingVerb("edit", async () => "next"), "next");
});

test("a cancelled run is refused at the lock, before the verb body or any undo call", async () => {
  installCancelFlag(() => true);
  let ran = false;
  await assert.rejects(
    enterMutatingVerb("render", async () => {
      ran = true;
    }),
    /cancelled by the server/,
  );
  assert.equal(ran, false);
  // Refusal precedes the entry seal — a refused verb must not mint an empty undo step.
  assert.deepEqual(figma.undoLog, []);
});

test("cancellation arriving mid-verb lets it finish but refuses the queued next verb", async () => {
  let cancelled = false;
  installCancelFlag(() => cancelled);
  const first = enterMutatingVerb("render", async () => {
    await new Promise((r) => setTimeout(r, 10));
    cancelled = true;
    return "done";
  });
  const second = enterMutatingVerb("render", async () => "ran");
  assert.equal(await first, "done");
  await assert.rejects(second, /cancelled by the server/);
});

test("render enters the lock: a cancelled run creates no node", async () => {
  installCancelFlag(() => true);
  await assert.rejects(render(frame({ width: 10, height: 10 })), /cancelled by the server/);
  assert.equal(figma.currentPage.children.length, 0);
});
