// Phase 5 — geometry read-back on handles. render() populates each returned handle's `boundingBox` with
// the node's resolved { x, y, width, height } AFTER the whole tree is laid out, so a covered child reports
// its settled size, not the provisional hug it held mid-walk. That timing is the whole point of the pass:
// capturing geometry at walk time would freeze stale sizes for fill/percent/absolute-covered children.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { frame, rect, render } from "./flcm.js";

createFigmaMock();

test("a handle exposes the node's resolved boundingBox { x, y, width, height }", async () => {
  const out = await render(
    frame({ width: 300, height: 200 }, [
      rect({ key: "box", width: 40, height: 24, absolute: { x: 20, y: 12 } }),
    ]),
  );
  assert.deepEqual(out.keyed.box.boundingBox, { x: 20, y: 12, width: 40, height: 24 });
});

test("a covered child's boundingBox reflects its SETTLED size, not its walk-time provisional one", async () => {
  // w:"fill" only stretches to 300 once the tree settles; the read-back must run after that, not at
  // stampKey time when the child still holds its hug width.
  const out = await render(
    frame({ width: 300, height: 200 }, [rect({ key: "bar", width: "fill", height: 12 })]),
  );
  assert.equal(out.keyed.bar.boundingBox.width, 300);
});

test("the root handle carries its own boundingBox", async () => {
  const out = await render(frame({ width: 120, height: 80 }));
  assert.deepEqual(out.root.boundingBox, { x: 0, y: 0, width: 120, height: 80 });
});
