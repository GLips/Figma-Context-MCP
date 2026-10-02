/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Per-side `strokeWidth` — read emits the CSS border-width shorthand ("0px 0px 0px 1px") for a node
// whose sides differ, so the write side must take that same string or a get → copy of a left-only
// border is refused. Pinned: the round trip, edit's parity with create, and the types with one weight.
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

const sides = (node: any) => [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight];

test("a left-only border round-trips: create lands per side, get spells it back, and the data copy re-authors", async () => {
  const out = await render({ type: "FRAME", key: "row", width: 100, height: 40, stroke: "#000000", strokeWidth: "0px 0px 0px 1px" });
  assert.deepEqual(sides(await figma.getNodeByIdAsync(specNode(out, "row").id)), [0, 0, 0, 1]);

  const { node: read } = await get("row");
  assert.equal(read.strokeWidth, "0px 0px 0px 1px");
  const { id, key, ...copy } = read;
  const copied = await render(copy);
  assert.deepEqual(sides(await figma.getNodeByIdAsync(copied.id)), [0, 0, 0, 1]);
});

test("edit takes the 4-value shorthand on a rectangle and can return to uniform", async () => {
  const out = await render({ type: "RECTANGLE", key: "box", width: 50, height: 50, stroke: "#000000", strokeWidth: 1 });
  const node = await figma.getNodeByIdAsync(specNode(out, "box").id);
  await edit("box", { strokeWidth: "1px 2px 3px 4px" });
  assert.deepEqual(sides(node), [1, 2, 3, 4]);
  await edit("box", { strokeWidth: "2px" });
  assert.equal(node.strokeWeight, 2);
});

test("a type with one stroke weight refuses a per-side width by name, on create and edit", async () => {
  await assert.rejects(
    render({ type: "ELLIPSE", width: 20, height: 20, stroke: "#000000", strokeWidth: "1px 2px" }),
    /ELLIPSE has one stroke weight/,
  );
  await render({ type: "LINE", key: "rule", width: 40, stroke: "#000000" });
  await assert.rejects(edit("rule", { strokeWidth: "0px 0px 0px 1px" }), /LINE has one stroke weight/);
});
