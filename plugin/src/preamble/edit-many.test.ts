import { specNode } from "../../harness/spec-node.js";
// flcm.editMany — the atomic batch. What must not regress silently: the SET validates before any
// entry applies (a loop over `edit` can't do that, which is the whole reason this verb exists), a
// rejection names EVERY offender, the batch is one undo step, and cross-entry ordering is the
// applier's — a parent turned auto-layout settles before a child set to "fill", in either array
// order. The per-delta vocabulary is edit.test.ts's; only what the BATCH adds is asserted here.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { image } from "./flcm.js";
import { render } from "./render.js";
import { editMany } from "./edit-many.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

// A free-form card holding three keyed children — the shape a batch nudge is written against.
async function renderCard() {
  const out = await render({
    type: "FRAME",
    key: "card",
    width: 300,
    height: 200,
    children: [
      { type: "RECTANGLE", key: "a", width: 40, height: 40, fill: "#ff0000" },
      { type: "RECTANGLE", key: "b", width: 40, height: 40, fill: "#00ff00" },
      { type: "TEXT", text: "hello", key: "c" },
      { type: "TEXT", text: "world", key: "c2" },
    ],
  });
  const node = async (k: string) => figma.getNodeByIdAsync(specNode(out, k).id);
  return {
    out,
    card: await node("card"),
    a: await node("a"),
    b: await node("b"),
    c: await node("c"),
    c2: await node("c2"),
  };
}

test("a batch over three nodes applies in ONE call and ONE undo step, returning a handle per entry", async () => {
  const { a, b, c } = await renderCard();
  const undosBefore = figma.undoLog.length;
  const handles = await editMany([
    { id: a.id, fill: "#0000ff" },
    { id: b.id, opacity: 0.5 },
    { id: c.id, text: "goodbye" },
  ]);
  assert.deepEqual(a.fills[0].color, { r: 0, g: 0, b: 1 });
  assert.equal(b.opacity, 0.5);
  assert.equal(c.characters, "goodbye");
  // Entry order, not apply order — the handles line up with the array the agent wrote.
  assert.deepEqual(
    handles.map((h) => h.key),
    ["a", "b", "c"],
  );
  // One verb, one boundary: the entry seal plus the success commit, exactly as a single edit.
  assert.deepEqual(figma.undoLog.slice(undosBefore), ["commit", "commit"]);
});

test("one invalid delta mutates NOTHING, and the error names every failing entry by index", async () => {
  const { a, b, c, c2 } = await renderCard();
  const logBefore = [...figma.undoLog];
  await assert.rejects(
    editMany([
      { id: a.id, fill: "#0000ff" },
      { id: b.id, colour: "#0000ff" } as never,
      { id: c.id, wat: 1 } as never,
    ]),
    (err: Error) => {
      assert.match(err.message, /2 of 3 entries were rejected/);
      assert.match(err.message, /\[1\].*unknown prop "colour"/s);
      assert.match(err.message, /\[2\].*unknown prop "wat"/s);
      return true;
    },
  );
  // Per-TYPE legality aggregates the same way, a stage later (it needs the resolved nodes).
  await assert.rejects(
    editMany([
      { id: a.id, fill: "#0000ff" },
      { id: c.id, borderRadius: 4 },
      { id: c2.id, clip: true },
    ]),
    (err: Error) => {
      assert.match(err.message, /2 of 3 entries were rejected/);
      assert.match(err.message, /\[1\].*`borderRadius` is not a TEXT word/s);
      assert.match(err.message, /\[2\].*`clip` is not a TEXT word/s);
      return true;
    },
  );
  // Unresolvable ids aggregate the same way, from the stage before that.
  await assert.rejects(
    editMany([
      { id: "ghost", opacity: 0.5 },
      { id: a.id, opacity: 0.5 },
      { id: "phantom", opacity: 0.5 },
    ]),
    (err: Error) => {
      assert.match(err.message, /2 of 3 entries were rejected/);
      assert.match(err.message, /\[0\].*"ghost"/s);
      assert.match(err.message, /\[2\].*"phantom"/s);
      return true;
    },
  );
  // The valid entry beside the bad one never landed: the set is atomic, not each entry.
  assert.deepEqual(a.fills[0].color, { r: 1, g: 0, b: 0 });
  assert.equal(b.opacity, 1);
  assert.deepEqual(figma.undoLog, logBefore); // rejected before the seal: no rollback
});

test("a parent turned auto-layout and a child set to fill succeed in EITHER array order", async () => {
  // A rect and a TEXT: only TEXT reaches a gate that reads PARENT facts, so a rect alone would
  // pass this test while the whole cross-entry validation class was broken.
  for (const child of ["a", "c"]) {
    for (const parentFirst of [true, false]) {
      figma = createFigmaMock();
      const nodes = await renderCard();
      const entries = [
        { id: nodes.card.id, layout: { mode: "row" as const, gap: 8 } },
        { id: (nodes as Record<string, any>)[child].id, height: "fill" as const },
      ];
      await editMany(parentFirst ? entries : [entries[1], entries[0]]);
      assert.equal(nodes.card.layoutMode, "HORIZONTAL");
      // The child's fill resolved against a parent that was already a row — the flow mark, not the
      // free-form cover path it would have taken had the entries applied in array order.
      assert.equal((nodes as Record<string, any>)[child].layoutAlign, "STRETCH");
    }
  }
});

// The other half of "order doesn't matter": the gates must answer from the canvas the batch is
// CREATING, in both directions. Refusing a legal batch is the visible failure; accepting an
// illegal one is the dangerous one, because these two rules exist precisely where Figma does not
// throw — it stores the mark and silently never honors it.
test("cross-entry layout legality is judged against the batch's own end state, not the pre-batch canvas", async () => {
  // (a) legal, and must not be refused: the parent gains a bounded width in the same batch that
  // gives its child a percent, so the hug-cycle the gate guards can never form.
  {
    const { card, a } = await renderCard();
    await editMany([
      { id: card.id, layout: { mode: "row" }, width: "hug" },
      { id: a.id, opacity: 0.5 },
    ]);
    assert.equal(card.layoutSizingHorizontal, "HUG");
    await editMany([
      { id: card.id, width: 400 },
      { id: a.id, width: "50%" },
    ]);
    assert.equal(a.width, 200);
  }
  // (b) illegal, and must be refused loud: the batch turns the parent free-form, so the TEXT's
  // height fill has no flow to fill and would silently not stick.
  {
    figma = createFigmaMock();
    const { card, c } = await renderCard();
    await editMany([
      { id: card.id, layout: { mode: "row" } },
      { id: c.id, height: "fill" },
    ]);
    assert.equal(c.layoutAlign, "STRETCH");
    await assert.rejects(
      editMany([
        { id: card.id, layout: { mode: "none" } },
        { id: c.id, height: "fill" },
      ]),
      /a TEXT can only fill its height as an in-flow child of an auto-layout parent/,
    );
  }
  // (c) illegal, and must be refused loud: the batch makes the parent hug the axis its child is
  // sizing by percent — the cycle assertPercentResolvable exists to name.
  {
    figma = createFigmaMock();
    const { card, a } = await renderCard();
    await editMany([{ id: card.id, layout: { mode: "row" }, width: 400 }]);
    await assert.rejects(
      editMany([
        { id: card.id, width: "hug" },
        { id: a.id, width: "50%" },
      ]),
      /is a cycle/,
    );
    assert.equal(a.width, 40); // nothing applied
  }
  // (d) the same cycle, spelled without the word "hug": turning auto-layout ON is itself a hug on
  // every axis the delta leaves unnamed (Figma's own AUTO default for the axis modes), so the live
  // reading — "a free-form frame hugs nothing" — is the wrong answer for the canvas being created.
  {
    figma = createFigmaMock();
    const { card, a } = await renderCard();
    await assert.rejects(
      editMany([
        { id: card.id, layout: { mode: "row" } },
        { id: a.id, width: "50%" },
      ]),
      /is a cycle/,
    );
    assert.equal(a.width, 40);
    // Naming the axis is the fix, and must still be accepted.
    await editMany([
      { id: card.id, layout: { mode: "row" }, width: 400 },
      { id: a.id, width: "50%" },
    ]);
    assert.equal(a.width, 200);
  }
  // (e) BOTH directions of (d) — the projection reads which axis each raw sizing mode governs, and
  // that mapping moves with the direction, so `column` must reject exactly as `row` does.
  {
    figma = createFigmaMock();
    const { card, a } = await renderCard();
    await assert.rejects(
      editMany([
        { id: card.id, layout: { mode: "column" } },
        { id: a.id, height: "50%" },
      ]),
      /is a cycle/,
    );
  }
  // (f) two levels: a parent saved from the hug only by the fill its GRANDparent gives it, in a
  // batch that re-aims the grandparent's flow. The direction write clears every child's flow mark,
  // so the parent's fill does not survive it — and the child's percent is a cycle after all.
  {
    figma = createFigmaMock();
    const out = await render({
      type: "FRAME",
      key: "outer",
      layout: { mode: "row" },
      width: 500,
      height: 300,
      children: [
        {
          type: "FRAME",
          key: "panel",
          layout: { mode: "row" },
          width: "fill",
          height: "fill",
          children: [{ type: "RECTANGLE", key: "kid", width: 40, height: 40 }],
        },
      ],
    });
    const kid = await figma.getNodeByIdAsync(specNode(out, "kid").id);
    const [outerId, panelId, kidId] = ["outer", "panel", "kid"].map((k) => specNode(out, k).id);
    // The fill DOES survive a flip of the panel alone — that must stay accepted.
    await editMany([
      { id: panelId, layout: { mode: "column" } },
      { id: kidId, width: "50%" },
    ]);
    assert.equal(kid.width, 250);
    await assert.rejects(
      editMany([
        { id: outerId, layout: { mode: "column" } },
        { id: panelId, layout: { mode: "column" } },
        { id: kidId, width: "50%" },
      ]),
      /is a cycle/,
    );
  }
});

test("every MEASUREMENT waits for every write: an anchored ancestor centers on the size its descendant ends at", async () => {
  const out = await render({
    type: "FRAME",
    key: "card",
    width: 300,
    height: 200,
    children: [
      {
        type: "FRAME",
        key: "panel",
        layout: { mode: "row" },
        width: "hug",
        height: "hug",
        left: 0,
        top: 0,
        children: [{ type: "TEXT", text: "x", key: "label" }],
      },
    ],
  });
  const panel = await figma.getNodeByIdAsync(specNode(out, "panel").id);
  // The panel HUGS, so the other entry's content change resizes it — and the anchor is measured
  // against that size. Applied ancestor-first with no deferred measure pass, the center is computed
  // from the pre-growth width and the panel ends up visibly off-center, with no error.
  await editMany([
    { id: panel.id, left: "50%", anchor: { x: "center" } },
    { id: specNode(out, "label").id, text: "this is a much longer label" },
  ]);
  assert.ok(panel.width > 100, "the descendant edit grew the hugging panel");
  assert.equal(panel.x + panel.width / 2, 150); // dead center of the 300-wide card
});

test("a refusal names the identity the node had BEFORE the batch's first write, not after its rename", async () => {
  const { a } = await renderCard();
  const out = await render({
    type: "FRAME",
    key: "shell",
    width: 300,
    height: 300,
    children: [{ type: "FRAME", key: "host", width: 10, height: 10, children: [] }],
  });
  const host = await figma.getNodeByIdAsync(specNode(out, "host").id);
  // The rename lands in the write pass; the refusal comes from the position pass after it. The
  // error must still point at the node the agent named, because the rollback erases the new name.
  Object.defineProperty(host, "x", {
    set: () => {
      throw new Error("in set_x: Cannot write to node");
    },
    get: () => 0,
    configurable: true,
  });
  await assert.rejects(
    editMany([
      { id: a.id, opacity: 0.5 },
      { id: host.id, name: "Renamed", left: "50%" },
    ]),
    (err: Error) => {
      assert.match(err.message, /key "host"/);
      assert.doesNotMatch(err.message, /Renamed/); // the name the rollback is about to erase
      return true;
    },
  );
});

test("a node deleted during the resource round trip refuses the whole batch — no write to a detached node", async () => {
  const { a, b } = await renderCard();
  const logBefore = [...figma.undoLog];
  // The image fetch is the batch's suspension point; standing in for the user, the channel deletes
  // one entry's target before handing the bytes back. Figma keeps accepting writes to a removed
  // node, so nothing downstream would notice — it would just paint an object off the canvas.
  const g = globalThis as { __flcmHost?: unknown };
  g.__flcmHost = { registerRead() {},
    callServer: async (_capability: string, urls: string[]) => {
      a.remove();
      return Object.fromEntries(urls.map((u) => [u, Buffer.from("bytes").toString("base64")]));
    },
    isRunCancelled: () => false, isRunFinished: () => false,
  };
  try {
    await assert.rejects(
      editMany([
        { id: a.id, fill: image("https://cdn.example.com/a.jpg") },
        { id: b.id, opacity: 0.5 },
      ]),
      /\[0\].*was deleted while this call was resolving targets and loading resources/s,
    );
  } finally {
    delete g.__flcmHost;
  }
  assert.equal(b.opacity, 1); // the surviving entry never landed either — the set is atomic
  assert.deepEqual(figma.undoLog, logBefore);
});

test("failures from DIFFERENT stages report together — the batch is one round trip, including its rejection", async () => {
  const { a, b, c } = await renderCard();
  await assert.rejects(
    editMany([
      { id: a.id, colour: "#fff" } as never, // document-blind: unknown word
      { id: "ghost", opacity: 0.5 }, // resolve: no such node
      { id: c.id, borderRadius: 4 }, // compile: not a TEXT word
      { id: b.id, opacity: 0.5 }, // fine
    ]),
    (err: Error) => {
      assert.match(err.message, /3 of 4 entries were rejected/);
      assert.match(err.message, /\[0\].*unknown prop "colour"/s);
      assert.match(err.message, /\[1\].*"ghost"/s);
      assert.match(err.message, /\[2\].*`borderRadius` is not a TEXT word/s);
      return true;
    },
  );
});

test("two entries naming the same node reject as ambiguous — never last-wins", async () => {
  const { a } = await renderCard();
  await assert.rejects(
    editMany([
      { id: a.id, opacity: 0.5 },
      { id: a.id, opacity: 0.9 },
    ]),
    /resolves to the same node as entry \[0\]/,
  );
  assert.equal(a.opacity, 1);
});

test("the batch shape itself fails loud: not an array, empty, a non-entry item, no id, an empty delta, an unknown word", async () => {
  const { a } = await renderCard();
  await assert.rejects(editMany({ a: { opacity: 1 } } as never), /the first argument is an array/);
  await assert.rejects(editMany([]), /entries array is empty/);
  await assert.rejects(editMany(["a"] as never), /each entry is an object/);
  await assert.rejects(editMany([{ opacity: 1 }] as never), /an entry needs an `id`/);
  await assert.rejects(editMany([{ id: a.id }]), /changes object is empty/);
  await assert.rejects(editMany([{ id: a.id, opacity: 1, when: 1 }] as never), /unknown prop "when"/);
});

// The one near-miss worth naming: every other verb takes a positional target, so an agent reaching
// for a batch reaches for `target` — and "unknown prop" would say nothing about where the node goes.
test("an entry spelled with `target` is refused by name, pointing at `id`", async () => {
  const { a } = await renderCard();
  await assert.rejects(
    editMany([{ target: a.id, changes: { opacity: 0.5 } }] as never),
    /names its node with `id`, not `target`/,
  );
  assert.equal(a.opacity, 1);
});

// A batch is usually one generated list, so its mistake is usually one mistake repeated.
test("entries that fail the same way report as one counted, indexed line", async () => {
  const { a, b, c } = await renderCard();
  await assert.rejects(
    editMany([
      { id: a.id, colour: "#fff" },
      { id: b.id, opacity: 0.5 },
      { id: c.id, colour: "#fff" },
    ] as never),
    (err: Error) => {
      assert.match(err.message, /2 of 3 entries were rejected/);
      assert.match(err.message, /\n {2}2 entries \(0, 2\): .*unknown prop "colour"/);
      return true;
    },
  );
});

// What this proves is the BOUNDARY, not the revert: the mock records commit/undo calls without
// replaying them, so "entry 0's fill is gone" is Figma's job and only a live run can confirm it
// (it's on the plan's live checklist). What's checkable here is that the batch's writes are sealed
// as ONE step and that one step is popped — a per-entry boundary would leave entry 0's commit
// stranded outside the undo.
test("a mid-apply Figma refusal seals the WHOLE batch as one step, pops it, and names the failing entry", async () => {
  const { a, b } = await renderCard();
  // Stand in for a Figma refusal on the second entry's write, after the first has landed.
  const refuse = () => {
    throw new Error("in set_opacity: Cannot write to node");
  };
  Object.defineProperty(b, "opacity", { set: refuse, get: () => 1, configurable: true });
  await assert.rejects(
    editMany([
      { id: a.id, fill: "#0000ff" },
      { id: b.id, opacity: 0.5 },
    ]),
    /flcm\.editMany \(entry 1\): Figma refused a write on/,
  );
  // commit-then-undo: the batch's own writes are sealed and popped as one step (invariant 2).
  assert.deepEqual(figma.undoLog.slice(-3), ["commit", "commit", "trigger"]);
});
