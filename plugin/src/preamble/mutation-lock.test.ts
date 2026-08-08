// The mutation lock (plan invariant 4): mutating verbs serialize within a run — preparation
// included, so a queued verb's gates read the canvas AFTER the running verb's writes — a failed
// verb doesn't poison later ones, a cancelled run is refused at the lock before the next verb's
// first canvas write (and again after preparation's awaits, before the seal), and the invariant-2
// undo scaffold emits the exact call SEQUENCE the live contract needs (the mock records
// commitUndo/triggerUndo calls; their semantics are the live probe's to ground). The host normally
// passes __flcmRunCancelled as an eval-wrapper parameter; these tests run in global scope, so they
// install it on globalThis (same free-identifier resolution — the pattern the harness uses for
// __flcmRequestImages).
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { enterMutatingVerb, committedVerbCount } from "./mutation-lock.js";
import { frame, image, rect, render, text } from "./flcm.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

const installCancelFlag = (check: () => boolean): void => {
  (globalThis as Record<string, unknown>).__flcmRunCancelled = check;
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__flcmRunCancelled;
  delete (globalThis as Record<string, unknown>).__flcmRequestImages;
});

const installImageChannel = (respond: () => Promise<Record<string, string>>): void => {
  (globalThis as Record<string, unknown>).__flcmRequestImages = respond;
};

const noPrep = async (): Promise<void> => undefined;

test("verbs serialize WHOLE: a queued verb's preparation never starts before the running one finishes", async () => {
  const events: string[] = [];
  const slow = enterMutatingVerb(
    "render",
    async () => {
      events.push("a:prepare");
      await new Promise((r) => setTimeout(r, 20));
    },
    () => {
      events.push("a:apply");
    },
  );
  const queued = enterMutatingVerb(
    "render",
    async () => {
      events.push("b:prepare");
    },
    () => {
      events.push("b:apply");
    },
  );
  await Promise.all([slow, queued]);
  // b:prepare after a:apply is THE freshness guarantee — the entry-time-staleness hole was a
  // queued verb validating against the canvas as it stood before the running verb's writes.
  assert.deepEqual(events, ["a:prepare", "a:apply", "b:prepare", "b:apply"]);
});

test("apply is synchronous BY TYPE: an async apply is a compile error, not a runtime surprise", () => {
  // Never invoked — this pins the SyncOnly<T> teeth via tsc (pnpm validate type-checks tests):
  // an async apply would return at its first await, letting the success commit run mid-writes.
  const rejectedByCompiler = () =>
    // @ts-expect-error — T infers to Promise<number>, which SyncOnly resolves to never
    enterMutatingVerb("edit", noPrep, async () => 42);
  void rejectedByCompiler;
});

test("a successful verb is one sealed step: entry seal, then success commit — no trigger", async () => {
  const before = committedVerbCount();
  assert.equal(await enterMutatingVerb("edit", noPrep, () => 42), 42);
  assert.deepEqual(figma.undoLog, ["commit", "commit"]);
  assert.equal(committedVerbCount(), before + 1);
});

test("a preparation reject leaves ZERO undo residue — no seal, no rollback, chain unpoisoned", async () => {
  const before = committedVerbCount();
  await assert.rejects(
    enterMutatingVerb(
      "edit",
      async () => {
        throw new Error("bad delta");
      },
      () => {
        throw new Error("apply must never run");
      },
    ),
    /bad delta/,
  );
  assert.deepEqual(figma.undoLog, []);
  assert.equal(committedVerbCount(), before);
  assert.equal(await enterMutatingVerb("edit", noPrep, () => "next"), "next");
});

test("a failed APPLY seals its partial writes and pops exactly that step (commit-then-undo)", async () => {
  const before = committedVerbCount();
  await assert.rejects(
    enterMutatingVerb("edit", noPrep, () => {
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
  assert.equal(await enterMutatingVerb("edit", noPrep, () => "next"), "next");
});

test("a cancelled run is refused at the lock, before preparation or any undo call", async () => {
  installCancelFlag(() => true);
  let ran = false;
  await assert.rejects(
    enterMutatingVerb(
      "render",
      async () => {
        ran = true;
      },
      () => {
        ran = true;
      },
    ),
    /cancelled by the server/,
  );
  assert.equal(ran, false);
  // Refusal precedes the entry seal — a refused verb must not mint an empty undo step.
  assert.deepEqual(figma.undoLog, []);
});

test("cancellation arriving DURING preparation refuses before the seal — no zombie apply", async () => {
  let cancelled = false;
  installCancelFlag(() => cancelled);
  let applied = false;
  await assert.rejects(
    enterMutatingVerb(
      "edit",
      async () => {
        // The font/image awaits are the run's long suspension points — this models a CANCEL
        // landing exactly there.
        await new Promise((r) => setTimeout(r, 5));
        cancelled = true;
      },
      () => {
        applied = true;
      },
    ),
    /cancelled by the server/,
  );
  assert.equal(applied, false);
  assert.deepEqual(figma.undoLog, []);
});

test("cancellation arriving mid-apply lets it finish but refuses the queued next verb", async () => {
  let cancelled = false;
  installCancelFlag(() => cancelled);
  // apply is synchronous by type (the sealed span cannot suspend), so "mid-apply" is a flag set
  // inside it: the running verb completes and commits, the queued one is refused at its turn.
  const first = enterMutatingVerb("render", noPrep, () => {
    cancelled = true;
    return "done";
  });
  const second = enterMutatingVerb("render", noPrep, () => "ran");
  assert.equal(await first, "done");
  await assert.rejects(second, /cancelled by the server/);
});

test("render enters the lock: a cancelled run creates no node", async () => {
  installCancelFlag(() => true);
  await assert.rejects(render(frame({ width: 10, height: 10 })), /cancelled by the server/);
  assert.equal(figma.currentPage.children.length, 0);
});

// The next three pin render's hand-rolled settle-both (prepare loads images and fonts
// concurrently; no Promise.allSettled below the QuickJS lib floor): both loads get their
// rejection handler BEFORE either is awaited, the EARLIEST failure is the one reported, and a
// rejection reason of `undefined` still counts as failure — every path exits prepare, so the
// canvas and the undo stack stay untouched.

const treeWithFontsAndImage = () =>
  frame({ layout: { mode: "column" } }, [
    text("hi"),
    rect({ width: 10, height: 10, fill: image("https://cdn.example.com/a.jpg") }),
  ]);

test("a font failure while images are still pending wins as the FIRST failure", async () => {
  figma.listAvailableFontsAsync = () => Promise.reject(new Error("font index down"));
  installImageChannel(
    () => new Promise((_, reject) => setTimeout(() => reject(new Error("image late")), 20)),
  );
  // Reporting "image late" here would mean the font handler attached only after the image await
  // settled — the shape that also leaves an early font rejection transiently unhandled.
  await assert.rejects(render(treeWithFontsAndImage()), /font index down/);
  assert.deepEqual(figma.undoLog, []);
  assert.equal(figma.currentPage.children.length, 0);
});

test("an image failure while fonts are still pending rejects with zero undo residue", async () => {
  figma.listAvailableFontsAsync = () => new Promise((resolve) => setTimeout(() => resolve([]), 20));
  installImageChannel(() => Promise.reject(new Error("image blocked")));
  await assert.rejects(render(treeWithFontsAndImage()), /image blocked/);
  assert.deepEqual(figma.undoLog, []);
  assert.equal(figma.currentPage.children.length, 0);
});

test("a resource load rejecting with `undefined` still fails prepare — never a sealed apply over missing bytes", async () => {
  installImageChannel(() => Promise.reject(undefined));
  await assert.rejects(
    render(rect({ width: 10, height: 10, fill: image("https://cdn.example.com/a.jpg") })),
    (err: unknown) => err === undefined,
  );
  // A sentinel-based settle would read this as success and fail INSIDE the sealed apply span:
  // undoLog would show commit/commit/trigger instead of staying empty.
  assert.deepEqual(figma.undoLog, []);
  assert.equal(figma.currentPage.children.length, 0);
});
