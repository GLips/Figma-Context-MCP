/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The mutation lock (plan invariant 4): mutating verbs serialize within a run — preparation
// included, so a queued verb's prepare and gate read the canvas AFTER the running verb's writes —
// a failed verb doesn't poison later ones, a cancelled run is refused at the lock before the next
// verb's first canvas write (and again after preparation's awaits, before the gate), a gate
// refusal leaves the undo stack exactly as a prepare refusal does, and the invariant-2 undo
// scaffold emits the exact call SEQUENCE the live contract needs (the mock records
// commitUndo/triggerUndo calls; their semantics are the live probe's to ground). The host normally
// passes its FlcmHost as the eval-wrapper parameter __flcmHost; these tests run in global scope, so
// they install it on globalThis instead (same free-identifier resolution — the pattern the harness
// uses too).
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { enterMutatingVerb, mutationQueueIdle, retargetReplacedNode } from "./mutation-lock.js";
import { recordObligations, type Obligation } from "./obligation.js";
import { ConcurrentEditError, FlcmError } from "./flcm-error.js";
import { committedVerbCount } from "./verb-error.js";
import { image } from "./value-sugar.js";
import { render } from "./structure.js";
import { RUN_INACTIVITY_DEADLINE_MS } from "../protocol.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

// One shared slot so a test can install both capabilities without the second clobbering the first,
// seeded COMPLETE: FlcmHost has no optional members, so the preamble is entitled to call either
// method on any host that exists. The seeds are the do-nothing answers — no images, never cancelled —
// and each helper below overrides only the one its tests exercise.
const hostSlot = (): Record<string, unknown> => {
  const g = globalThis as Record<string, unknown>;
  if (!g.__flcmHost) {
    g.__flcmHost = { callServer: async () => ({}), runCancellation: () => null, whenCancelled: () => new Promise(() => {}), isRunFinished: () => false, runStartedAt: Date.now() };
  }
  return g.__flcmHost as Record<string, unknown>;
};

const installCancelFlag = (check: () => boolean): void => {
  hostSlot().runCancellation = () => (check() ? "server" : null);
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__flcmHost;
});

const installImageChannel = (respond: () => Promise<Record<string, string>>): void => {
  hostSlot().callServer = respond;
};

const installRunFinished = (finished: () => boolean): void => {
  hostSlot().isRunFinished = finished;
};

const noPrep = async (): Promise<void> => undefined;
// The pass-through gate: these tests pin the scaffold, and a gate that decides nothing is the
// shape every non-document verb has.
const noGate = (): void => undefined;

test("verbs serialize WHOLE: a queued verb's preparation never starts before the running one finishes", async () => {
  const events: string[] = [];
  const slow = enterMutatingVerb(
    "render",
    async () => {
      events.push("a:prepare");
      await new Promise((r) => setTimeout(r, 20));
    },
    () => {
      events.push("a:gate");
    },
    () => {
      events.push("a:apply");
      return () => undefined;
    },
  );
  const queued = enterMutatingVerb(
    "render",
    async () => {
      events.push("b:prepare");
    },
    () => {
      events.push("b:gate");
    },
    () => {
      events.push("b:apply");
      return () => undefined;
    },
  );
  await Promise.all([slow, queued]);
  // b:prepare after a:apply is the serialization guarantee: a queued verb's prepare resolves its
  // targets and loads its resources against the canvas as the running verb leaves it.
  assert.deepEqual(events, ["a:prepare", "a:gate", "a:apply", "b:prepare", "b:gate", "b:apply"]);
});

test("a sibling of a rejected verb is still outstanding until the queue drains", async () => {
  const landed: string[] = [];
  let caught: string | null = null;
  try {
    await Promise.all([
      enterMutatingVerb("edit", async () => { throw new Error("Input must be a valid number"); }, noGate, () => () => undefined),
      // Its slot was reserved synchronously, but its prepare suspends the way a real render's font
      // and image loads do — so it cannot possibly have landed when the batch rejects.
      enterMutatingVerb(
        "render",
        async () => { await new Promise((r) => setTimeout(r, 5)); },
        noGate,
        () => { landed.push("survivor"); return () => undefined; },
      ),
    ]);
  } catch (err) {
    caught = (err as Error).message;
  }
  // The reply used to go out at exactly this point, over a canvas still about to change.
  assert.match(caught!, /valid number/);
  assert.deepEqual(landed, []);
  assert.equal(await mutationQueueIdle(), 1);
  assert.deepEqual(landed, ["survivor"]);
  // Idle on an empty queue is immediate and counts nothing.
  assert.equal(await mutationQueueIdle(), 0);
});

test("a runtime whose run has already replied refuses to write, and says so as a finished run", async () => {
  installRunFinished(() => true);
  let ran = false;
  await assert.rejects(
    enterMutatingVerb("render", async () => { ran = true; }, noGate, () => { ran = true; return () => undefined; }),
    /already finished and replied/,
  );
  assert.equal(ran, false);
  assert.deepEqual(figma.undoLog, []);
});

test("gate and apply are synchronous BY TYPE: an async one is a compile error, not a runtime surprise", () => {
  // Never invoked — this pins the SyncOnly<T> teeth via tsc (pnpm validate type-checks tests):
  // an async apply would return at its first await, letting the success commit run mid-writes;
  // an async gate would let the seal land on a decision not yet made.
  const rejectedByCompiler = () =>
    // @ts-expect-error — an async apply returns a Promise, never a result builder
    enterMutatingVerb("edit", noPrep, noGate, async () => () => 42);
  const asyncBuilderRejectedByCompiler = () =>
    // @ts-expect-error — T infers to Promise<number>, which SyncOnly resolves to never
    enterMutatingVerb("edit", noPrep, noGate, () => async () => 42);
  const gateRejectedByCompiler = () =>
    // @ts-expect-error — G infers to Promise<number>, which SyncOnly resolves to never
    enterMutatingVerb("edit", noPrep, async () => 42, () => () => 1);
  void rejectedByCompiler;
  void asyncBuilderRejectedByCompiler;
  void gateRejectedByCompiler;
});

test("a successful verb is one sealed step: entry seal, then success commit — no trigger", async () => {
  const before = committedVerbCount();
  assert.equal(await enterMutatingVerb("edit", noPrep, noGate, () => () => 42), 42);
  assert.deepEqual(figma.undoLog, ["commit", "commit"]);
  assert.equal(committedVerbCount(), before + 1);
});

test("every sealed step carries the stamp write, and a stamp that fails to write never triggers a rollback", async () => {
  const stamp = (): string => figma.root.getPluginData("flcm/undo-step");
  const first = stamp();
  await enterMutatingVerb("edit", noPrep, noGate, () => () => 1);
  const second = stamp();
  assert.notEqual(second, first);
  await enterMutatingVerb("edit", noPrep, noGate, () => () => 2);
  assert.notEqual(stamp(), second);
  // A stamp failure means the step is EMPTY of this verb's writes — a triggerUndo would pop the
  // previous verb's step, the one thing the stamp exists to prevent.
  const setPluginData = figma.root.setPluginData;
  figma.root.setPluginData = () => {
    throw new Error("root refused");
  };
  figma.undoLog.length = 0;
  await assert.rejects(
    enterMutatingVerb("edit", noPrep, noGate, () => {
      throw new Error("apply must never run");
    }),
    /root refused/,
  );
  assert.deepEqual(figma.undoLog, ["commit"]);
  figma.root.setPluginData = setPluginData;
});

test("a preparation reject leaves ZERO undo residue — no seal, no rollback, chain unpoisoned", async () => {
  const before = committedVerbCount();
  await assert.rejects(
    enterMutatingVerb(
      "edit",
      async () => {
        throw new Error("bad delta");
      },
      noGate,
      () => {
        throw new Error("apply must never run");
      },
    ),
    /bad delta/,
  );
  assert.deepEqual(figma.undoLog, []);
  assert.equal(committedVerbCount(), before);
  assert.equal(await enterMutatingVerb("edit", noPrep, noGate, () => () => "next"), "next");
});

test("a GATE refusal is a prepare refusal's twin: zero undo calls, no stamp, apply never runs", async () => {
  const before = committedVerbCount();
  const stamp = figma.root.getPluginData("flcm/undo-step");
  await assert.rejects(
    enterMutatingVerb(
      "edit",
      noPrep,
      () => {
        throw new Error("the parent is free-form now");
      },
      () => {
        throw new Error("apply must never run");
      },
    ),
    /free-form now/,
  );
  // The gate runs BEFORE the seal: a refusal there must not mint a step, and must not stamp —
  // a stamped-but-empty step would be exactly the residue the phase rule exists to prevent.
  assert.deepEqual(figma.undoLog, []);
  assert.equal(figma.root.getPluginData("flcm/undo-step"), stamp);
  assert.equal(committedVerbCount(), before);
  assert.equal(await enterMutatingVerb("edit", noPrep, noGate, () => () => "next"), "next");
});

test("a failed APPLY seals its partial writes and pops exactly that step (commit-then-undo)", async () => {
  const before = committedVerbCount();
  await assert.rejects(
    enterMutatingVerb("edit", noPrep, noGate, () => {
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
  assert.equal(await enterMutatingVerb("edit", noPrep, noGate, () => () => "next"), "next");
});

// The lock-level half of the finalizer contract; the verbs' own obligations are pinned through them.
const opacityObligation = (node: SceneNode, literal: number): Obligation => ({
  kind: "opacity", request: { literal }, target: { node }, source: { subject: "flcm.edit", path: "opacity" },
  writePoint: "appearance", carries: [{ prop: "opacity" }], writability: "writable", concessions: [],
});

test("a word that didn't land fails before the style links are awaited, so nothing can join the step it rolls back", async () => {
  const node = figma.createRectangle();
  figma.currentPage.appendChild(node);
  await enterMutatingVerb("edit", noPrep, noGate, () => { node.name = "Kept"; return () => undefined; });
  let linked = false;
  node.setFillStyleIdAsync = async () => { linked = true; };
  let built = false;
  await assert.rejects(
    enterMutatingVerb("edit", noPrep, () => recordObligations([opacityObligation(node, 0.5)]), (_gated, span) => {
      node.opacity = 0.5;
      span.styleLinks.push({ node, slot: "fill", styleId: "S:brand", styleName: "Brand" });
      // A later write in the same call undoes the word.
      node.opacity = 0.2;
      return () => { built = true; return "handle"; };
    }),
    // Nothing explains the miss but flcm's own write order, so it is flcm's bug.
    (err: unknown) => err instanceof FlcmError && err.kind === "internal" && /didn't come out as written.*opacity: asked 0\.5, ended 0\.2/s.test(err.message),
  );
  assert.equal(linked, false);
  assert.equal(built, false);
  // The earlier verb's step is sealed before this one's; the trigger pops only this call's writes.
  assert.deepEqual(figma.undoLog, ["commit", "commit", "commit", "commit", "trigger"]);
  assert.equal(node.name, "Kept");
});

test("a link that fails after an edit joined the call's undo step names the link and says the call's writes remain", async () => {
  const node = figma.createRectangle();
  node.name = "Card";
  figma.currentPage.appendChild(node);
  node.setFillStyleIdAsync = async () => {
    figma.undoStepMerged = true;
    throw new Error("style not found");
  };
  await assert.rejects(
    enterMutatingVerb("edit", noPrep, noGate, (_gated, span) => {
      node.opacity = 0.5;
      span.styleLinks.push({ node, slot: "fill", styleId: "S:brand", styleName: "Brand" });
      return () => undefined;
    }),
    (err: unknown) =>
      err instanceof ConcurrentEditError &&
      err.keptOnCanvas &&
      /this call failed \(RECTANGLE "Card" \(id "[^"]+"\): Figma refused to link the fill style "Brand" \(id "S:brand"\): style not found.*changes are still on the canvas/s.test(err.message) &&
      !err.message.includes("Nothing from this call was kept"),
  );
});

test("an obligation follows a node the call replaced, as every per-call accumulator does", async () => {
  const frame = figma.createFrame();
  figma.currentPage.appendChild(frame);
  const result = await enterMutatingVerb("component", noPrep, () => recordObligations([opacityObligation(frame, 0.5)]), (_gated, span) => {
    frame.opacity = 0.5;
    const comp = figma.createComponentFromNode(frame);
    retargetReplacedNode(span, frame, comp);
    return () => comp.opacity;
  });
  assert.equal(result, 0.5);
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
      noGate,
      () => {
        ran = true;
        return () => undefined;
      },
    ),
    /the server cancelled this run/,
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
      noGate,
      () => {
        applied = true;
        return () => undefined;
      },
    ),
    /the server cancelled this run/,
  );
  assert.equal(applied, false);
  assert.deepEqual(figma.undoLog, []);
});

test("cancellation arriving mid-apply lets it finish but refuses the queued next verb", async () => {
  let cancelled = false;
  installCancelFlag(() => cancelled);
  // apply is synchronous by type (the sealed span cannot suspend), so "mid-apply" is a flag set
  // inside it: the running verb completes and commits, the queued one is refused at its turn.
  const first = enterMutatingVerb("render", noPrep, noGate, () => {
    cancelled = true;
    return () => "done";
  });
  const second = enterMutatingVerb("render", noPrep, noGate, () => () => "ran");
  assert.equal(await first, "done");
  await assert.rejects(second, /the server cancelled this run/);
});

test("render enters the lock: a cancelled run creates no node", async () => {
  installCancelFlag(() => true);
  await assert.rejects(render({ type: "FRAME", width: 10, height: 10 }), /the server cancelled this run/);
  assert.equal(figma.currentPage.children.length, 0);
});

// A run that held the thread past the server's deadline reaches the lock with its CANCEL still
// queued behind it — the host flag is false, and the run's own clock is what refuses (runbook §8b).
test("a run that held the thread past the server's deadline is refused before its CANCEL dispatches", async (t) => {
  hostSlot();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(RUN_INACTIVITY_DEADLINE_MS);
  await assert.rejects(render({ type: "FRAME", width: 10, height: 10 }), /past the server's inactivity deadline/);
  assert.equal(figma.currentPage.children.length, 0);
});

test("time the server spends on a call never counts toward the deadline", async (t) => {
  // Started in the past so the clock ends near real time: the module's clock is shared state, and a
  // future contact time would mask the other test's expiry if they ever ran in the other order.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() - RUN_INACTIVITY_DEADLINE_MS * 2 });
  installImageChannel(async () => {
    t.mock.timers.tick(RUN_INACTIVITY_DEADLINE_MS * 2);
    return { "https://cdn.example.com/a.jpg": "AAAA" };
  });
  await render({ type: "RECTANGLE", width: 10, height: 10, fill: image("https://cdn.example.com/a.jpg") });
  assert.equal(figma.currentPage.children.length, 1);
});

// The next three pin render's hand-rolled settle-both (prepare loads images and fonts
// concurrently; no Promise.allSettled below the QuickJS lib floor): both loads get their
// rejection handler BEFORE either is awaited, the EARLIEST failure is the one reported, and a
// rejection reason of `undefined` still counts as failure — every path exits prepare, so the
// canvas and the undo stack stay untouched.

const treeWithFontsAndImage = () => ({
  type: "FRAME",
  layout: { mode: "column" },
  children: [
    { type: "TEXT", text: "hi" },
    { type: "RECTANGLE", width: 10, height: 10, fill: image("https://cdn.example.com/a.jpg") },
  ],
});

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
  // Figma's own loads can reject with nothing; the server channel can't (host.ts serverCall).
  figma.listAvailableFontsAsync = () => Promise.reject(undefined);
  installImageChannel(() => new Promise((resolve) => setTimeout(() => resolve({ "https://cdn.example.com/a.jpg": "AAAA" }), 20)));
  await assert.rejects(
    render(treeWithFontsAndImage()),
    // Nothing to quote, but still a failure the agent can see, and Figma's.
    (err: unknown) => err instanceof FlcmError && err.kind === "figma" && err.reason.includes("without saying why"),
  );
  // A sentinel-based settle would read this as success and fail INSIDE the sealed apply span:
  // undoLog would show commit/commit/trigger instead of staying empty.
  assert.deepEqual(figma.undoLog, []);
  assert.equal(figma.currentPage.children.length, 0);
});

test("a failing verb names the call and what was kept, and its stack points only at the caller", async () => {
  const flcm = await import("./runtime.js");
  await flcm.render({ type: "RECTANGLE", width: 10, height: 10 });
  const out = await flcm.render({ type: "RECTANGLE", width: 10, height: 10 });
  // Two at least, so the count is plural however many earlier tests committed.
  const kept = committedVerbCount();
  await assert.rejects(flcm.edit(out, { opacity: "bad" } as never), (err: unknown) => {
    assert(err instanceof FlcmError);
    assert.equal(err.call, "flcm.edit");
    assert.match(err.message, /^flcm\.edit: /);
    assert(err.message.endsWith("Nothing from this call was kept; the " + kept + " calls before it that changed the file were kept."));
    // flcm's own frames are cut; what's left is the line that called the verb.
    assert.match(err.stack ?? "", /mutation-lock\.test\.ts/);
    assert.doesNotMatch(err.stack ?? "", /preamble\/(?!mutation-lock\.test)[\w-]+\.ts/);
    return true;
  });
});
