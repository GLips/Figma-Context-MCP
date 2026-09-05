// The stacking papercut this exists for: two renders with no `left`/`top` both land at the page
// origin, and the agent — holding a handle, not a canvas — sees two identical successes. What must
// not regress is that the SECOND render says so, and that a root landing clear stays silent.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, render } from "./flcm.js";
import { describeRootOverlap } from "./root-overlap.js";

let figma = createFigmaMock();

beforeEach(() => {
  figma = createFigmaMock();
});

const renderRoot = async (name: string, at?: { left: number; top: number }) =>
  figma.getNodeByIdAsync((await render(frame({ name, width: 200, height: 100, ...at }))).root.id);

test("a root landing on empty canvas says nothing", async () => {
  const root = await renderRoot("solo");
  assert.equal(describeRootOverlap(root), null);
});

test("a second origin render names the node it buried, its box, and the prop that moves it", async () => {
  await renderRoot("card");
  const second = await renderRoot("card 2");
  const note = describeRootOverlap(second);
  assert.match(note, /"card 2" at 0,0 \(200×100\) landed on top of 1 node/);
  assert.match(note, /"card" at 0,0 \(200×100\) covers 100% of it/);
  assert.match(note, /`left`\/`top` on the root/);
});

test("absolute placement clear of everything is silent; a partial landing quotes its share", async () => {
  await renderRoot("card");
  const clear = await renderRoot("far", { left: 400, top: 400 });
  assert.equal(describeRootOverlap(clear), null);

  // Half the width, all the height => 50% of the new root is over "card".
  const half = await renderRoot("half", { left: 100, top: 0 });
  assert.match(describeRootOverlap(half), /"card" at 0,0 \(200×100\) covers 50% of it/);
});

test("a graze under the floor is not worth a line", async () => {
  await renderRoot("card");
  // 2px of a 200px width overlap => 1%, below the 5% floor.
  const graze = await renderRoot("graze", { left: 198, top: 0 });
  assert.equal(describeRootOverlap(graze), null);
});

test("many neighbours are ranked and counted, never silently dropped", async () => {
  for (let i = 0; i < 5; i++) await renderRoot("n" + i);
  const last = await renderRoot("last");
  const note = describeRootOverlap(last);
  assert.match(note, /landed on top of 5 nodes/);
  assert.match(note, /; and 2 more\./);
});
