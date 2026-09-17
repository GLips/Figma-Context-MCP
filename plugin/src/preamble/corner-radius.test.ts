// Per-corner `borderRadius` — the one word where read's CSS shorthand and write's authored value
// have to be the same string (ADR-0007/0011). Read emits "8px 8px 0px 0px" for a mixed-corner node;
// the write side used to refuse it outright, so a `get` result could not re-author. What's pinned
// here is the round trip and the CSS fill-in rules, not the parser's internals.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { specNode } from "../../harness/spec-node.js";
import { get } from "./flcm.js";
import { render } from "./render.js";
import { edit } from "./edit.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

async function renderCard(borderRadius: number | string) {
  const out = await render({ type: "FRAME", key: "card", width: 100, height: 60, borderRadius });
  return figma.getNodeByIdAsync(specNode(out, "card").id);
}

test("read's own shorthand re-authors: the string a get hands back lands corner for corner", async () => {
  // Verbatim what core/src/simplify.ts emits — "0px", not "0".
  const node = await renderCard("8px 8px 0px 0px");
  assert.deepEqual(
    [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius],
    [8, 8, 0, 0],
  );
  // And it comes back out spelled the way it went in — the round trip the ADR asks for.
  const { node: read } = await get("card");
  assert.equal(read.borderRadius, "8px 8px 0px 0px");
});

test("CSS fill-in rules: 1, 2 and 3 values expand the way border-radius does", async () => {
  const corners = async (value: number | string) => {
    figma = createFigmaMock(); // a fresh page per case, so the root-overlap warning stays quiet
    const node = await renderCard(value);
    return [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
  };
  assert.deepEqual(await corners(6), [6, 6, 6, 6]);
  assert.deepEqual(await corners("6px"), [6, 6, 6, 6]);
  assert.deepEqual(await corners("4px 12px"), [4, 12, 4, 12]); // TL/BR, then TR/BL
  assert.deepEqual(await corners("4px 12px 20px"), [4, 12, 20, 12]); // TL, TR/BL, BR
  assert.deepEqual(await corners("1px 2px 3px 4px"), [1, 2, 3, 4]); // clockwise from top-left
});

test("an elliptical corner has no Figma equivalent and fails loud rather than dropping a radius", async () => {
  await assert.rejects(
    render({ type: "FRAME", width: 100, height: 60, borderRadius: "10px / 20px" }),
    /circular.*elliptical/s,
  );
  await assert.rejects(
    render({ type: "FRAME", width: 100, height: 60, borderRadius: "1px 2px 3px 4px 5px" }),
    /1–4 values/,
  );
});

test("edit takes the same vocabulary create does, both directions", async () => {
  const node = await renderCard(12);
  await edit("card", { borderRadius: "16px 16px 0px 0px" });
  assert.deepEqual(
    [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius],
    [16, 16, 0, 0],
  );
  // Back to uniform: the mixed state must be reachable AND leavable, or an edit could only ever
  // add per-corner radii.
  await edit("card", { borderRadius: 4 });
  assert.equal(node.cornerRadius, 4);
});
