// flcm.edit — the mutate verb. What must not regress silently: a delta applies exactly its fields
// through the shared appliers (the header's named hazard — riding a constructor would inject
// layout.mode "none" and turn a recolor into an auto-layout kill), validation rejects with ZERO
// writes, legality is per node type (create's own word sets), and a Figma refusal surfaces as a
// pointer error carrying the target's identity. The undo scaffold's call sequence is pinned by
// mutation-lock.test.ts, not re-asserted here.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, line, render, image, id } from "./flcm.js";
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
  await assert.rejects(edit("card", { x: 10 } as never), /not on edit yet/);
  await assert.rejects(edit("card", {}), /empty/);
  // A mistyped scalar rejects the WHOLE delta — the valid fill beside it must not land as a
  // partial write (QuickJS has no type checking, so this is the runtime's only line of defense).
  await assert.rejects(edit("card", { fill: "#ff0000", opacity: "bad" } as never), /`opacity` must be a number/);
  // Named words whose values are all null/undefined compile to nothing — same hazard as {}.
  await assert.rejects(edit("card", { fill: undefined }), /compiled to nothing/);
  // All rejected pre-lock: no undo activity, node untouched.
  assert.deepEqual(figma.undoLog, logBefore);
  assert.deepEqual(node.fills[0].color, { r: 0, g: 0, b: 1 });
});

test("legality is per node type: a LINE takes no fill, exactly as flcm.line does", async () => {
  const out = await render(frame({ width: 100, height: 100 }, [line({ key: "rule", length: 80 })]));
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
  const g = globalThis as { __flcmRequestImages?: unknown };
  g.__flcmRequestImages = async (urls: string[]) =>
    Object.fromEntries(urls.map((u) => [u, Buffer.from("fake-image-bytes").toString("base64")]));
  try {
    await edit("card", { fill: image(url) });
  } finally {
    delete g.__flcmRequestImages;
  }
  assert.equal(node.fills[0].type, "IMAGE");
  assert.equal(JSON.parse(node.getPluginData("flcm/image")).url, url);
  // Replacing the image with a solid must wipe the provenance — a stale url would claim the
  // solid paint came from an image.
  await edit("card", { fill: "#00ff00" });
  assert.equal(node.getPluginData("flcm/image"), "");
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
