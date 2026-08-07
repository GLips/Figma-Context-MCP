// The mutation lock (plan invariant 4): mutating verbs serialize within a run, a failed verb
// doesn't poison later ones, and a cancelled run is refused at the lock before the next verb's
// first canvas write. The host normally passes __flcmRunCancelled as an eval-wrapper parameter;
// these tests run in global scope, so they install it on globalThis (same free-identifier
// resolution — the pattern the harness uses for __flcmRequestImages).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { enterMutatingVerb } from "./mutation-lock.js";
import { frame, render } from "./flcm.js";

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

test("a failed verb rejects its own caller and later verbs still run", async () => {
  await assert.rejects(
    enterMutatingVerb("edit", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await enterMutatingVerb("edit", async () => 42), 42);
});

test("a cancelled run is refused at the lock, before the verb body runs", async () => {
  installCancelFlag(() => true);
  let ran = false;
  await assert.rejects(
    enterMutatingVerb("render", async () => {
      ran = true;
    }),
    /cancelled by the server/,
  );
  assert.equal(ran, false);
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
  const figma = createFigmaMock();
  installCancelFlag(() => true);
  await assert.rejects(render(frame({ width: 10, height: 10 })), /cancelled by the server/);
  assert.equal(figma.currentPage.children.length, 0);
});
