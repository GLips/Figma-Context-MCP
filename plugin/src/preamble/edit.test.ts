// flcm.edit — the mutate verb. What must not regress silently: a delta applies exactly its fields
// through the shared appliers (the header's named hazard — riding a constructor would inject
// layout.mode "none" and turn a recolor into an auto-layout kill), validation rejects with ZERO
// writes, legality is per node type (create's own word sets), and a Figma refusal surfaces as a
// pointer error carrying the target's identity. The undo scaffold's call sequence is pinned by
// mutation-lock.test.ts, not re-asserted here.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, line, text, render, image, id } from "./flcm.js";
import { edit } from "./edit.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

async function renderKeyedRowFrame() {
  const out = await render(
    frame({ key: "card", fill: "#0000ff", layout: { mode: "row", gap: 16, padding: 8 } }, [rect({ key: "box", width: 40, height: 40 })]),
  );
  return figma.getNodeByIdAsync(out.keyed.card.id);
}

test("a recolor is a recolor: fill and opacity change, the frame's auto-layout survives", async () => {
  const node = await renderKeyedRowFrame();
  const handle = await edit("card", { fill: "#ff0000", opacity: 0.5 });
  assert.deepEqual(node.fills[0].color, { r: 1, g: 0, b: 0 });
  assert.equal(node.opacity, 0.5);
  // The hazard the module header names: a constructor-routed delta would write layoutMode "NONE".
  assert.equal(node.layoutMode, "HORIZONTAL");
  assert.equal(node.itemSpacing, 16);
  // The returned handle is the node's updated identity + live geometry, same as a find hit.
  assert.equal(handle.id, node.id);
  assert.equal(handle.key, "card");
});

test("visible, locked, and name — scene words — land on the live node", async () => {
  const node = await renderKeyedRowFrame();
  await edit("card", { visible: false, locked: true, name: "hidden card" });
  assert.equal(node.visible, false);
  assert.equal(node.locked, true);
  assert.equal(node.name, "hidden card");
});

test("vocabulary rejections happen before any write: unknown prop, key, bare x/y, empty delta", async () => {
  const node = await renderKeyedRowFrame();
  const logBefore = [...figma.undoLog];
  await assert.rejects(edit("card", { wat: 1 } as never), /unknown prop "wat" on flcm\.edit/);
  await assert.rejects(edit("card", { key: "rekeyed" } as never), /`key` is not editable/);
  await assert.rejects(edit("card", { x: 10 } as never), /use `left`\/`top`/);
  await assert.rejects(edit("card", {}), /empty/);
  // A mistyped scalar rejects the WHOLE delta — the valid fill beside it must not land as a
  // partial write (QuickJS has no type checking, so this is the runtime's only line of defense).
  await assert.rejects(edit("card", { fill: "#ff0000", opacity: "bad" } as never), /`opacity` must be a number/);
  // Named words whose values are all null/undefined compile to nothing — same hazard as {}.
  await assert.rejects(edit("card", { fill: undefined }), /compiled to nothing/);
  // All rejected in prepare, before the entry seal: no undo activity, node untouched.
  assert.deepEqual(figma.undoLog, logBefore);
  assert.deepEqual(node.fills[0].color, { r: 0, g: 0, b: 1 });
});

test("legality is per node type: a LINE takes no fill, exactly as flcm.line does", async () => {
  const out = await render(frame({ width: 100, height: 100 }, [line({ key: "rule", width: 80 })]));
  await assert.rejects(edit("rule", { fill: "#ff0000" }), /`fill` is not a LINE word/);
  const node = await figma.getNodeByIdAsync(out.keyed.rule.id);
  await edit("rule", { stroke: "#ff0000" });
  assert.deepEqual(node.strokes[0].color, { r: 1, g: 0, b: 0 });
});

test("a non-createable node type takes only the shared words, and the error names both", async () => {
  const component = figma.createComponent();
  await assert.rejects(edit(id(component.id), { fill: "#ff0000" }), /`fill` is not a COMPONENT word/);
  const handle = await edit(id(component.id), { name: "renamed", visible: false });
  assert.equal(component.name, "renamed");
  assert.equal(component.visible, false);
  assert.equal(handle.id, component.id);
  // SLICE has no blend mixin at all — opacity would be an undo step that changed nothing.
  const slice = figma.createSlice();
  await assert.rejects(edit(id(slice.id), { opacity: 0.5 }), /`opacity` is not a SLICE word/);
});

test("an image fill in a delta fetches bytes through the host channel and stamps flcm/image", async () => {
  const node = await renderKeyedRowFrame();
  const url = "https://cdn.example.com/a.jpg";
  const g = globalThis as { __flcmHost?: unknown };
  g.__flcmHost = {
    requestImages: async (urls: string[]) =>
      Object.fromEntries(urls.map((u) => [u, Buffer.from("fake-image-bytes").toString("base64")])),
    isRunCancelled: () => false,
  };
  try {
    await edit("card", { fill: image(url) });
  } finally {
    delete g.__flcmHost;
  }
  assert.equal(node.fills[0].type, "IMAGE");
  assert.equal(JSON.parse(node.getPluginData("flcm/image")).url, url);
  // Replacing the image with a solid must wipe the provenance — a stale url would claim the
  // solid paint came from an image.
  await edit("card", { fill: "#00ff00" });
  assert.equal(node.getPluginData("flcm/image"), "");
});

test('"none" is the removal word: fill/stroke/effects clear with a real write, not a skip', async () => {
  const out = await render(
    frame({ width: 100, height: 100 }, [
      rect({ key: "box", width: 40, height: 40, fill: "#0000ff", stroke: "#000000", effects: { shadow: { blur: 4 } } }),
    ]),
  );
  const node = await figma.getNodeByIdAsync(out.keyed.box.id);
  assert.equal(node.fills.length, 1);
  assert.equal(node.effects.length, 1);
  await edit("box", { fill: "none", stroke: "none", effects: "none" });
  assert.deepEqual(node.fills, []);
  assert.deepEqual(node.strokes, []);
  assert.deepEqual(node.effects, []);
});

test('clearing an image fill with "none" wipes the flcm/image provenance too', async () => {
  const node = await renderKeyedRowFrame();
  const g = globalThis as { __flcmHost?: unknown };
  g.__flcmHost = {
    requestImages: async (urls: string[]) =>
      Object.fromEntries(urls.map((u) => [u, Buffer.from("fake-image-bytes").toString("base64")])),
    isRunCancelled: () => false,
  };
  try {
    await edit("card", { fill: image("https://cdn.example.com/b.jpg") });
  } finally {
    delete g.__flcmHost;
  }
  assert.notEqual(node.getPluginData("flcm/image"), "");
  await edit("card", { fill: "none" });
  assert.deepEqual(node.fills, []);
  assert.equal(node.getPluginData("flcm/image"), "");
});

test('fill→fixed/hug is a real inverse: the flow marks fill installed are cleared, not shadowed', async () => {
  const out = await render(
    frame({ key: "row", width: 300, height: 100, layout: { mode: "row" } }, [
      rect({ key: "grow", width: "fill", height: 40 }),
      rect({ key: "tall", width: 40, height: "fill" }),
    ]),
  );
  const grow = await figma.getNodeByIdAsync(out.keyed.grow.id);
  const tall = await figma.getNodeByIdAsync(out.keyed.tall.id);
  assert.equal(grow.layoutGrow, 1);
  assert.equal(tall.layoutAlign, "STRETCH");
  await edit("grow", { width: 80 });
  assert.equal(grow.layoutGrow, 0);
  assert.equal(grow.width, 80);
  await edit("tall", { height: 40 });
  assert.equal(tall.layoutAlign, "INHERIT");
});

test('position:"none" returns an absolute child to flow; pin deltas preserve the unnamed axis', async () => {
  const out = await render(
    frame({ key: "host", width: 200, height: 200, layout: { mode: "row" } }, [
      rect({ key: "badge", width: 20, height: 20, left: 10, top: 10 }),
    ]),
  );
  const badge = await figma.getNodeByIdAsync(out.keyed.badge.id);
  assert.equal(badge.layoutPositioning, "ABSOLUTE");
  await edit("badge", { pin: { x: "right" } });
  assert.equal(badge.constraints.horizontal, "MAX");
  await edit("badge", { pin: { y: "bottom" } });
  // The unnamed x axis keeps MAX — applyConstraints' both-axes write would have reset it to MIN.
  assert.deepEqual(badge.constraints, { horizontal: "MAX", vertical: "MAX" });
  await edit("badge", { pin: "none" });
  assert.deepEqual(badge.constraints, { horizontal: "MIN", vertical: "MIN" });
  await edit("badge", { position: "none" });
  assert.equal(badge.layoutPositioning, "AUTO");
});

test("a percent size resolves immediately against the live parent; the hug cycle rejects with zero writes", async () => {
  const out = await render(
    frame({ key: "fixed", width: 200, height: 100 }, [rect({ key: "half", width: 40, height: 40 })]),
  );
  const half = await figma.getNodeByIdAsync(out.keyed.half.id);
  await edit("half", { width: "50%" });
  assert.equal(half.width, 100);
  // The one percent a runtime read can't break: in-flow % child of a hugging auto parent.
  const hug = await render(frame({ key: "hugrow", layout: { mode: "row" } }, [rect({ key: "kid", width: 40, height: 40 })]));
  const kid = await figma.getNodeByIdAsync(hug.keyed.kid.id);
  await assert.rejects(edit("kid", { width: "25%" }), /cycle/);
  assert.equal(kid.width, 40);
});

test('container ripples: alignItems:"stretch" walks the live children, a non-stretch write clears, a direction flip clears stranded marks', async () => {
  const out = await render(
    frame({ key: "row", width: 300, height: 120, layout: { mode: "row" } }, [
      rect({ key: "a", width: 40, height: 40 }),
      rect({ key: "b", width: 40, height: 40 }),
    ]),
  );
  const row = await figma.getNodeByIdAsync(out.keyed.row.id);
  const a = await figma.getNodeByIdAsync(out.keyed.a.id);
  await edit("row", { layout: { alignItems: "stretch" } });
  assert.equal(a.layoutAlign, "STRETCH");
  await edit("row", { layout: { alignItems: "flex-start" } });
  assert.equal(a.layoutAlign, "INHERIT");
  // Re-stretch, then flip direction: the stranded marks are cleared by the mode applier.
  await edit("row", { layout: { alignItems: "stretch" } });
  assert.equal(a.layoutAlign, "STRETCH");
  await edit("row", { layout: { mode: "column" } });
  assert.equal(row.layoutMode, "VERTICAL");
  assert.equal(a.layoutAlign, "INHERIT");
  // And a gap-only delta lands without touching the mode (the recolor≠layout-kill discipline).
  await edit("row", { layout: { gap: 24 } });
  assert.equal(row.itemSpacing, 24);
  assert.equal(row.layoutMode, "VERTICAL");
});

test("left/top are presence-preserving per axis: `left` alone moves x and leaves the live y alone", async () => {
  const out = await render(
    frame({ key: "host", width: 200, height: 200, layout: { mode: "row" } }, [
      rect({ key: "badge", width: 20, height: 20, left: 10, top: 10 }),
    ]),
  );
  const badge = await figma.getNodeByIdAsync(out.keyed.badge.id);
  await edit("badge", { left: 50 });
  assert.equal(badge.x, 50);
  assert.equal(badge.y, 10);
});

test("a percent on an ALREADY-absolute child of a hugging parent is legal — out of flow, no cycle", async () => {
  const out = await render(
    frame({ key: "hugrow", layout: { mode: "row" } }, [
      rect({ key: "kid", width: 40, height: 40 }),
      rect({ key: "badge", width: 20, height: 20, left: 0, top: 0 }),
    ]),
  );
  const row = await figma.getNodeByIdAsync(out.keyed.hugrow.id);
  const badge = await figma.getNodeByIdAsync(out.keyed.badge.id);
  // The delta names no `left`/`top` — the guard must thread the LIVE positioning, not assume in-flow.
  await edit("badge", { width: "50%" });
  assert.equal(badge.width, row.width / 2);
});

test("parent-relative words against a PAGE parent reject loud: a page has no bounded size", async () => {
  await render(frame({ key: "top", width: 200, height: 100 }));
  await assert.rejects(edit("top", { width: "50%" }), /page has no bounded size/);
  await assert.rejects(edit("top", { width: "fill" }), /page has no bounded size/);
});

test('"hug" on a node with nothing to measure rejects; naming mode in the same delta legalizes it', async () => {
  const out = await render(
    frame({ key: "wrap", width: 200, height: 200 }, [
      rect({ key: "box", width: 40, height: 40 }),
      frame({ key: "inner", width: 100, height: 100 }),
    ]),
  );
  await assert.rejects(edit("box", { width: "hug" }), /"hug" sizes to content/);
  await assert.rejects(edit("inner", { width: "hug" }), /"hug" sizes to content/);
  const inner = await figma.getNodeByIdAsync(out.keyed.inner.id);
  await edit("inner", { width: "hug", layout: { mode: "row" } });
  assert.equal(inner.layoutMode, "HORIZONTAL");
  assert.equal(inner.primaryAxisSizingMode, "AUTO");
});

test("a direction change clears BOTH flow marks — layoutGrow too, and NONE→row does not resurrect them", async () => {
  const out = await render(
    frame({ key: "row", width: 300, height: 100, layout: { mode: "row" } }, [
      rect({ key: "grow", width: "fill", height: 40 }),
    ]),
  );
  const grow = await figma.getNodeByIdAsync(out.keyed.grow.id);
  assert.equal(grow.layoutGrow, 1);
  await edit("row", { layout: { mode: "column" } });
  assert.equal(grow.layoutGrow, 0);
  // Park at NONE with a fresh mark (Figma keeps the child property; only the flip cleanup touches
  // it), then re-enter a direction: the stale grow must not come back to life.
  await edit("grow", { width: "fill" }); // column: width is the counter axis → STRETCH…
  await edit("row", { layout: { mode: "row" } });
  assert.equal(grow.layoutAlign, "INHERIT"); // …and the flip cleared it
  await edit("grow", { width: "fill" }); // row: layoutGrow = 1 again
  await edit("row", { layout: { mode: "none" } });
  assert.equal(grow.layoutGrow, 1); // parked, not cleared — NONE is not a direction
  await edit("row", { layout: { mode: "row" } });
  assert.equal(grow.layoutGrow, 0); // NONE→row establishes a direction: no resurrection
});

test("a LINE's `width` is a fixed size: a sizing intent or a mistyped value names the line rule", async () => {
  await render(frame({ width: 100, height: 100 }, [line({ key: "rule", width: 80 })]));
  await assert.rejects(edit("rule", { width: "fill" }), /a LINE's width is its length, a fixed size/);
  await assert.rejects(edit("rule", { width: "80" } as never), /`width` on a LINE must be a number/);
});

test("a TEXT size delta preloads the node's font before the mutating span", async () => {
  const out = await render(frame({ width: 300, height: 100 }, [text("hello", { key: "label" })]));
  const label = await figma.getNodeByIdAsync(out.keyed.label.id);
  figma.fontLoads.length = 0;
  await edit("label", { width: 120 });
  assert.deepEqual(figma.fontLoads, [{ family: "Inter", style: "Regular" }]);
  assert.equal(label.textAutoResize, "HEIGHT");
  assert.equal(label.width, 120);
  // A non-size delta on the same node loads nothing — the preload is for the resize handshake only.
  figma.fontLoads.length = 0;
  await edit("label", { opacity: 0.5 });
  assert.deepEqual(figma.fontLoads, []);
});

test("a percent resolves against a hug-mode parent whose axis is realized from above (FILL) — no false cycle", async () => {
  // The inner row's height is hug-MODE (counterAxisSizingMode AUTO) but effectively FILL: its own
  // parent stretches it. The guard must read the EFFECTIVE sizing, not the internal axis mode.
  const out = await render(
    frame({ key: "outer", width: 300, height: 200, layout: { mode: "row" } }, [
      frame({ key: "inner", width: 100, height: "fill", layout: { mode: "row" } }, [
        rect({ key: "kid", width: 40, height: 40 }),
      ]),
    ]),
  );
  const inner = await figma.getNodeByIdAsync(out.keyed.inner.id);
  const kid = await figma.getNodeByIdAsync(out.keyed.kid.id);
  await edit("kid", { height: "50%" });
  assert.equal(kid.height, inner.height / 2);
});

test("an anchored absolute edit is idempotent, and an anchor axis without its coordinate rejects", async () => {
  const out = await render(
    frame({ key: "host", width: 200, height: 200, layout: { mode: "row" } }, [
      rect({ key: "badge", width: 20, height: 20, left: 10, top: 10 }),
    ]),
  );
  const badge = await figma.getNodeByIdAsync(out.keyed.badge.id);
  await edit("badge", { left: 100, anchor: { x: "center" } });
  assert.equal(badge.x, 90);
  await edit("badge", { left: 100, anchor: { x: "center" } });
  assert.equal(badge.x, 90); // re-apply converges — no drift off the live coordinate
  assert.equal(badge.y, 10); // the unnamed axis never moved
  await assert.rejects(edit("badge", { anchor: { x: "center" } } as never), /name `left` alongside/);
});

test("un-filling while going absolute clears the mark; a direction flip clears marks parked on absolute children", async () => {
  const out = await render(
    frame({ key: "row", width: 300, height: 100, layout: { mode: "row" } }, [
      rect({ key: "grow", width: "fill", height: 40 }),
      rect({ key: "tall", width: 40, height: 40 }),
    ]),
  );
  const grow = await figma.getNodeByIdAsync(out.keyed.grow.id);
  assert.equal(grow.layoutGrow, 1);
  // The delta both lifts the node out of flow AND replaces the filled width — the mark must not
  // survive parked on the absolute node, or position:"none" later resurrects the fill.
  await edit("grow", { left: 0, top: 0, width: 80 });
  assert.equal(grow.layoutGrow, 0);
  await edit("grow", { position: "none" });
  assert.equal(grow.layoutGrow, 0);
  // A mark parked by absolute ALONE is cleared when the container changes direction — rejoining
  // the flow later must not fill along an axis the mark never meant.
  const tall = await figma.getNodeByIdAsync(out.keyed.tall.id);
  await edit("tall", { width: "fill" });
  assert.equal(tall.layoutGrow, 1);
  await edit("tall", { left: 0, top: 0 });
  assert.equal(tall.layoutGrow, 1); // parked, positioning is ABSOLUTE
  await edit("row", { layout: { mode: "column" } });
  assert.equal(tall.layoutGrow, 0);
});

test("a TEXT's own height is not an edit word: fixed and hug reject loud; width still lands", async () => {
  const out = await render(frame({ width: 300, height: 100 }, [text("hello", { key: "label" })]));
  await assert.rejects(edit("label", { height: 80 }), /height follows its content/);
  await assert.rejects(edit("label", { height: "hug" }), /height follows its content/);
  const label = await figma.getNodeByIdAsync(out.keyed.label.id);
  await edit("label", { width: 120 });
  assert.equal(label.width, 120);
});

test("a present-but-malformed structured value rejects the WHOLE delta — no partial apply", async () => {
  const node = await renderKeyedRowFrame();
  await assert.rejects(edit("card", { fill: "#ff0000", position: false } as never), /position must be "absolute" or "none"/);
  await assert.rejects(edit("card", { fill: "#ff0000", layout: false } as never), /flcm\.edit\.layout must be an object/);
  await assert.rejects(edit("card", { fill: "#ff0000", layout: { padding: [] } } as never), /pad must be a number, a CSS box shorthand/);
  await assert.rejects(edit("card", { fill: "#ff0000", pin: [] } as never), /pin must be an object/);
  assert.deepEqual(node.fills[0].color, { r: 0, g: 0, b: 1 }); // the valid fill beside them never landed
});

test("container words on a frame that isn't (or won't be) row/column reject; naming mode legalizes", async () => {
  const out = await render(frame({ key: "wrap", width: 200, height: 200 }, [frame({ key: "free", width: 100, height: 100 })]));
  const free = await figma.getNodeByIdAsync(out.keyed.free.id);
  await assert.rejects(edit("free", { layout: { gap: 24 } }), /need an auto-layout/);
  // Killing auto-layout and spacing it in the same breath is a contradiction — reject that too.
  const row = await renderKeyedRowFrame();
  await assert.rejects(edit("card", { layout: { mode: "none", gap: 24 } }), /leaves this frame free-form/);
  assert.equal(row.layoutMode, "HORIZONTAL");
  await edit("free", { layout: { mode: "row", gap: 24 } });
  assert.equal(free.layoutMode, "HORIZONTAL");
  assert.equal(free.itemSpacing, 24);
});

test('flcm.line({ stroke: "none" }) constructs the explicit no-stroke — the same word edit speaks', async () => {
  const out = await render(
    frame({ width: 100, height: 100 }, [
      line({ key: "bare", width: 80, stroke: "none" }),
      line({ key: "plain", width: 80 }),
    ]),
  );
  const bare = await figma.getNodeByIdAsync(out.keyed.bare.id);
  assert.deepEqual(bare.strokes, []); // the clear is written over createLine's default black
  const plain = await figma.getNodeByIdAsync(out.keyed.plain.id);
  assert.equal(plain.strokes.length, 1); // an OMITTED stroke keeps the live default — absence isn't removal
});

test("re-sizing an axis whose fill mark sits parked on an ABSOLUTE child still un-fills it", async () => {
  const out = await render(
    frame({ key: "row", width: 300, height: 100, layout: { mode: "row" } }, [
      rect({ key: "grow", width: "fill", height: 40 }),
    ]),
  );
  const grow = await figma.getNodeByIdAsync(out.keyed.grow.id);
  await edit("grow", { left: 0, top: 0 });
  assert.equal(grow.layoutGrow, 1); // parked
  await edit("grow", { width: 80 }); // named fixed while absolute — the parked mark must go
  assert.equal(grow.layoutGrow, 0);
  // And the one-delta return-to-flow + resize: the new size governs, not the old fill.
  await edit("grow", { left: 0, top: 0 });
  await edit("row", { layout: { alignItems: "flex-start" } }); // unrelated container edit, marks stay
  await edit("grow", { position: "none", width: 60 });
  assert.equal(grow.layoutGrow, 0);
  assert.equal(grow.width, 60);
});

test('TEXT height:"fill" needs a flow to fill: free-form parent and absolute text reject', async () => {
  const out = await render(
    frame({ key: "free", width: 200, height: 200 }, [text("a", { key: "t1" })]),
  );
  await assert.rejects(edit("t1", { height: "fill" }), /fill its height as an in-flow child/);
  await render(
    frame({ key: "row", width: 200, height: 200, layout: { mode: "row" } }, [
      text("b", { key: "t2", left: 0, top: 0 }),
    ]),
  );
  await assert.rejects(edit("t2", { height: "fill" }), /fill its height as an in-flow child/);
  // In flow under a row it's legal — the parent realizes it via STRETCH.
  const inRow = await render(
    frame({ key: "row2", width: 200, height: 200, layout: { mode: "row" } }, [text("c", { key: "t3" })]),
  );
  const t3 = await figma.getNodeByIdAsync(inRow.keyed.t3.id);
  await edit("t3", { height: "fill" });
  assert.equal(t3.layoutAlign, "STRETCH");
  void out;
});

test("an unknown padding key rejects the whole delta instead of compiling to zero padding", async () => {
  const node = await renderKeyedRowFrame();
  await assert.rejects(edit("card", { fill: "#ff0000", layout: { padding: { wat: 12 } } } as never), /unknown prop "wat" on pad/);
  assert.deepEqual(node.fills[0].color, { r: 0, g: 0, b: 1 });
});

test("a length edit takes over from a UI-authored fill: the grow mark clears and the length governs", async () => {
  const out = await render(
    frame({ key: "row", width: 300, height: 100, layout: { mode: "row" } }, [line({ key: "rule", width: 100 })]),
  );
  const rule = await figma.getNodeByIdAsync(out.keyed.rule.id);
  rule.layoutGrow = 1; // flcm can't author this on a line — a human did, in the Figma UI
  await edit("rule", { width: 80 });
  assert.equal(rule.layoutGrow, 0);
  assert.equal(rule.width, 80);
});

test("un-stretching the container reaches a mark parked on an ABSOLUTE child too", async () => {
  const out = await render(
    frame({ key: "row", width: 300, height: 120, layout: { mode: "row", alignItems: "stretch" } }, [
      rect({ key: "a", width: 40 }),
    ]),
  );
  const a = await figma.getNodeByIdAsync(out.keyed.a.id);
  assert.equal(a.layoutAlign, "STRETCH");
  await edit("a", { left: 0, top: 0 });
  await edit("row", { layout: { alignItems: "flex-start" } });
  await edit("a", { position: "none" });
  assert.equal(a.layoutAlign, "INHERIT"); // no resurrected stretch the container no longer asks for
});

test("parent-relative words under a live GRID parent reject; node-local fixed px still lands", async () => {
  const out = await render(
    frame({ key: "grid", width: 300, height: 300 }, [rect({ key: "cell", width: 40, height: 40 })]),
  );
  const grid = await figma.getNodeByIdAsync(out.keyed.grid.id);
  grid.layoutMode = "GRID"; // not authorable through flcm — a live document fact
  const cell = await figma.getNodeByIdAsync(out.keyed.cell.id);
  await assert.rejects(edit("cell", { width: "fill" }), /GRID container/);
  await assert.rejects(edit("cell", { width: "50%" }), /GRID container/);
  await assert.rejects(edit("cell", { pin: { x: "right" } }), /GRID container/);
  await edit("cell", { width: 60 });
  assert.equal(cell.width, 60);
});

test("a Figma refusal mid-apply rolls back and the error is a pointer: identity + Figma's reason", async () => {
  const node = await renderKeyedRowFrame();
  Object.defineProperty(node, "fills", {
    set() {
      throw new Error("in set_fills: Expected an array of paints");
    },
  });
  await assert.rejects(edit("card", { fill: "#ff0000" }), (err: Error) => {
    assert.match(err.message, /flcm\.edit: Figma refused a write on FRAME/);
    assert.match(err.message, /in set_fills/);
    assert.match(err.message, /id "\d+:\d+"/);
    assert.match(err.message, /rolled back to its entry seal/);
    return true;
  });
});

// ——— the TEXT words (text / textStyle / fill / boldWeight) ———

async function renderKeyedText(content: Parameters<typeof text>[0] = "hello", props: Parameters<typeof text>[1] = {}) {
  const out = await render(frame({ width: 300, height: 100 }, [text(content, { key: "label", ...props })]));
  return figma.getNodeByIdAsync(out.keyed.label.id);
}

test("`content` with a plain string replaces the whole text, preloading the live font first", async () => {
  const node = await renderKeyedText("hello");
  figma.fontLoads.length = 0;
  await edit("label", { text: "goodbye" });
  assert.equal(node.characters, "goodbye");
  // The reflow re-lays the existing font — loaded before the mutating span, like create's preload.
  assert.deepEqual(figma.fontLoads[0], { family: "Inter", style: "Regular" });
});

test("a fontSize/lineHeight nudge lands WITHOUT re-writing the base font — presence-gated, unlike create", async () => {
  const node = await renderKeyedText("hello", { textStyle: { fontWeight: "bold" } });
  assert.deepEqual(node.fontName, { family: "Inter", style: "Bold" });
  await edit("label", { textStyle: { fontSize: 24 } });
  assert.equal(node.fontSize, 24);
  // The hazard applyTextProps's presence gate exists for: an unenriched default-triple write here
  // would reset Bold to Regular.
  assert.deepEqual(node.fontName, { family: "Inter", style: "Bold" });
});

test("a weight-only delta enriches the rest of the triple from the LIVE font — the italic survives", async () => {
  const node = await renderKeyedText("hello", { textStyle: { fontStyle: "italic" } });
  assert.deepEqual(node.fontName, { family: "Inter", style: "Italic" });
  await edit("label", { textStyle: { fontWeight: "bold" } });
  // Without enrichment the resolve would key (default family, bold, upright) and land plain "Bold".
  assert.deepEqual(node.fontName, { family: "Inter", style: "Bold Italic" });
});

test("enrichment decodes a COMBINED live label: a family-anchor on Bold Italic keeps both axes", async () => {
  const node = await renderKeyedText("hello", { textStyle: { fontWeight: 700, fontStyle: "italic" } });
  assert.deepEqual(node.fontName, { family: "Inter", style: "Bold Italic" });
  await edit("label", { textStyle: { fontFamily: "Inter" } });
  // "Bold Italic" carries weight AND slant in one label — a naive weight lookup on the whole
  // string reads 400 and silently de-bolds (the liveFontWords regression).
  assert.deepEqual(node.fontName, { family: "Inter", style: "Bold Italic" });
});

test("a malformed fontWeight rejects the whole delta instead of silently resetting to regular", async () => {
  const node = await renderKeyedText("hello", { textStyle: { fontWeight: 700 } });
  await assert.rejects(edit("label", { textStyle: { fontWeight: true } } as never), /fontWeight must be a number/);
  assert.deepEqual(node.fontName, { family: "Inter", style: "Bold" }); // wantWeight never saw the boolean
});

test("a partial font delta on a MIXED text rejects; anchoring fontFamily makes it a whole-node reset", async () => {
  const node = await renderKeyedText("plain **bold**");
  assert.equal(node.fontName, figma.mixed); // markdown bold made the ranges diverge
  await assert.rejects(edit("label", { textStyle: { fontWeight: 600 } }), /mixes fonts/);
  assert.equal(node.fontName, figma.mixed); // rejected in prepare, before any write — still mixed
  await edit("label", { textStyle: { fontFamily: "Inter", fontWeight: 600 } });
  assert.deepEqual(node.fontName, { family: "Inter", style: "Semi Bold" }); // uniform again
});

test("`content` markdown compiles runs over the live base family, per-range fonts landing on the right slice", async () => {
  const node = await renderKeyedText("hello");
  await edit("label", { text: "plain **bold**" });
  assert.equal(node.characters, "plain bold");
  assert.deepEqual(node._rangeFonts, [{ start: 6, end: 10, value: { family: "Inter", style: "Bold" } }]);
  assert.equal(node.fontName, figma.mixed); // the edit's own runs made it mixed — live-faithful
});

test("a plain-string `content` on a MIXED text succeeds, preloading EVERY range font for the reflow", async () => {
  const node = await renderKeyedText("plain **bold**");
  figma.fontLoads.length = 0;
  await edit("label", { text: "flat" });
  assert.equal(node.characters, "flat");
  // Verified live 2026-08-08: a whole-content replacement collapses the text to its LEADING
  // run's style (no positional carry-over of old range styling). Char 0 is unstyled here, so
  // the collapse lands on Regular; the leading-BOLD case is pinned by the next test.
  assert.deepEqual(node.fontName, { family: "Inter", style: "Regular" });
  assert.deepEqual(figma.fontLoads, [
    { family: "Inter", style: "Regular" },
    { family: "Inter", style: "Bold" },
  ]);
});

test("a content replacement collapses a MIXED text to its LEADING run's style — not the base", async () => {
  // The disambiguating live repro (2026-08-08): leading run BOLD, so base-style-wins and
  // leading-run-wins predict different results — live came back whole-node Bold. A mock falling
  // back to the base would pass the unstyled-first-char test above and diverge from Figma on
  // exactly the fact the mixed-font gates key on.
  const node = await renderKeyedText("**bold** plain tail");
  assert.equal(node.fontName, figma.mixed);
  await edit("label", { text: "0123456789 replacement" });
  assert.deepEqual(node.fontName, { family: "Inter", style: "Bold" });
});

test("a styled run in `content` on a MIXED text has no base family — rejects instead of landing in the default", async () => {
  await renderKeyedText("plain **bold**");
  await assert.rejects(
    edit("label", { text: ["a ", ["b", { fontWeight: "bold" }]] }),
    /no base family to resolve against/,
  );
});

test("`fill` is the TEXT's paint like every other node's; \"none\" clears it", async () => {
  const node = await renderKeyedText("hello", { fill: "#0000ff" });
  await edit("label", { fill: "#ff0000" });
  assert.deepEqual(node.fills[0].color, { r: 1, g: 0, b: 0 });
  await edit("label", { fill: "none" });
  assert.deepEqual(node.fills, []);
});

test("lineClamp needs a bounded width: hug rejects, a width in the same edit legalizes, \"none\" removes", async () => {
  const node = await renderKeyedText("a long line of words that would wrap");
  await assert.rejects(edit("label", { textStyle: { lineClamp: 2 } }), /bounded width/);
  await assert.rejects(edit("label", { textStyle: { lineClamp: 0 }, width: 120 }), /whole number/);
  await edit("label", { textStyle: { lineClamp: 2 }, width: 120 });
  assert.equal(node.textTruncation, "ENDING");
  assert.equal(node.maxLines, 2);
  // The width is now live-fixed, so a follow-up clamp needs no width word.
  await edit("label", { textStyle: { lineClamp: 3 } });
  assert.equal(node.maxLines, 3);
  await edit("label", { textStyle: { lineClamp: "none" } });
  assert.equal(node.maxLines, null);
  assert.equal(node.textTruncation, "DISABLED");
});

test("a Figma refusal on an instance child names the instance — and never auto-detaches", async () => {
  const component = figma.createComponent();
  component.name = "Card";
  const inner = figma.createRectangle();
  component.appendChild(inner);
  const inst = component.createInstance();
  figma.currentPage.appendChild(inst);
  const child = inst.children[0];
  Object.defineProperty(child, "fills", {
    set() { throw new Error("in set_fills: this property cannot be overridden on an instance sublayer"); },
  });
  await assert.rejects(edit(id(child.id), { fill: "#ff0000" }), (err: Error) => {
    assert.match(err.message, /lives inside instance "Card"/);
    assert.match(err.message, /never auto-detaches/);
    return true;
  });
});

test("a present-but-malformed textStyle rejects the WHOLE delta — the fill beside it never lands", async () => {
  const node = await renderKeyedText("hello");
  await assert.rejects(edit("label", { fill: "#ff0000", textStyle: false } as never), /must be an object/);
  await assert.rejects(edit("label", { textStyle: { wat: 1 } } as never), /unknown prop "wat"/);
  assert.equal(node.fills[0].color.r, 0); // created black — the rejected recolor never landed
});

test('flcm.text({ fill: "none" }) constructs the explicit no-fill — the same word edit speaks', async () => {
  const out = await render(
    frame({ width: 100, height: 100 }, [text("ghost", { key: "ghost", fill: "none" }), text("plain", { key: "plain" })]),
  );
  const ghost = await figma.getNodeByIdAsync(out.keyed.ghost.id);
  assert.deepEqual(ghost.fills, []); // the clear is written over createText's default black
  const plain = await figma.getNodeByIdAsync(out.keyed.plain.id);
  assert.equal(plain.fills.length, 1); // an OMITTED color keeps the live default — absence isn't removal
});

test("text + an anchored left in ONE edit resolves against the POST-reflow size", async () => {
  const node = await renderKeyedText("hi");
  await edit("label", { text: "a much longer line of text", left: 100, anchor: { x: "center" } });
  // Text applies before layout (create's order): the anchor subtracts the NEW width. The old
  // order centered the pre-reflow width and only converged on a second identical edit.
  assert.equal(node.x + node.width / 2, 100);
});

test("`boldWeight` alone re-emphasizes nothing, so it rejects naming `text`; beside `text` it sets what `**` means", async () => {
  const node = await renderKeyedText("hello");
  await assert.rejects(edit("label", { boldWeight: 600 }), /names no `text`/);
  assert.equal(node.characters, "hello"); // refused whole — nothing landed
  await edit("label", { text: "hello **world**", boldWeight: 600 });
  assert.equal(node.characters, "hello world");
  assert.deepEqual(node._rangeFonts.at(-1), { start: 6, end: 11, value: { family: "Inter", style: "Semi Bold" } });
});

test('a run\'s color: "none" compiles to a real transparent range write, not a reject or a skip', async () => {
  const node = await renderKeyedText("hello");
  await edit("label", { text: [["ghost", { color: "none" }], " rest"] });
  assert.deepEqual(node._rangeFills, [{ start: 0, end: 5, value: [] }]);
});

test("racing your own edits: a queued edit's gates read the canvas AFTER the earlier edit applied", async () => {
  const node = await renderKeyedText("a long line of words that would wrap", { width: 160 });
  // The entry-time-staleness repro: under the old shape both edits validated against the
  // pre-race canvas (width still bounded), and the clamp landed on a hug-width text — the
  // unbounded no-op sequential order rejects. Preparation now serializes in invocation order.
  const [hug, clamp] = await Promise.allSettled([
    edit("label", { width: "hug" }),
    edit("label", { textStyle: { lineClamp: 2 } }),
  ]);
  assert.equal(hug.status, "fulfilled");
  assert.equal(clamp.status, "rejected");
  assert.match((clamp as PromiseRejectedResult).reason.message, /bounded width/);
  assert.equal(node.textAutoResize, "WIDTH_AND_HEIGHT");
  assert.equal(node.maxLines, undefined); // the stale clamp never landed
});

test('the clamp gate holds from BOTH sides: width:"hug" on a live-clamped text rejects; clearing in the same edit legalizes', async () => {
  const node = await renderKeyedText("a long line of words that would wrap", { width: 160, textStyle: { lineClamp: 2 } });
  assert.equal(node.maxLines, 2);
  // The sequential twin of the race test: clamp-then-hug must reject like hug-then-clamp does,
  // or the lock's "outcomes equal some sequential order" guarantee still admits the no-op state.
  await assert.rejects(edit("label", { width: "hug" }), /would unbound a clamped text/);
  assert.equal(node.maxLines, 2);
  await edit("label", { width: "hug", textStyle: { lineClamp: "none" } });
  assert.equal(node.maxLines, null);
  assert.equal(node.textTruncation, "DISABLED");
  assert.equal(node.textAutoResize, "WIDTH_AND_HEIGHT");
});

// ——— slice 4.1: the live facts a compile reads must still hold at the seal ———

test("a live fact that changed during the resource round trip refuses the whole call — zero writes", async () => {
  const node = await renderKeyedText("hello", { textStyle: { fontWeight: "bold" } });
  const logBefore = [...figma.undoLog];
  // The image fetch is the run's suspension point, and the user has the document open across it.
  // Standing in for that user: the channel retypes the node's font before handing the bytes back.
  const g = globalThis as { __flcmHost?: unknown };
  g.__flcmHost = {
    requestImages: async (urls: string[]) => {
      node.fontName = { family: "Inter", style: "Regular" };
      return Object.fromEntries(urls.map((u) => [u, Buffer.from("bytes").toString("base64")]));
    },
    isRunCancelled: () => false,
  };
  try {
    // fontWeight was enriched against the live (bold) identity, which is gone by the time the
    // bytes land — so the delta describes a node that no longer exists in that state.
    await assert.rejects(
      edit("label", { fill: image("https://cdn.example.com/a.jpg"), textStyle: { fontSize: 20 } }),
      /changed while this call was loading fonts and images/,
    );
  } finally {
    delete g.__flcmHost;
  }
  assert.deepEqual(node.fontName, { family: "Inter", style: "Regular" }); // the user's own retype stands
  assert.equal(node.fontSize, 12); // the delta never landed — still the default size
  assert.deepEqual(figma.undoLog, logBefore); // refused in prepare: no seal, no rollback
});
