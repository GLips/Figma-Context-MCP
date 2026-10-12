/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// backgroundBlur is a silent no-op on a fill-less node: Figma masks the blurred backdrop with the
// node's own paint, so the effect lands, reads back, and renders nothing. These cover the trap itself
// and the two ways an edit reaches it — the final state is what's judged, not the authored delta.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { effects as effectsSugar } from "./value-sugar.js";
import { id } from "./target.js";
import { render } from "./structure.js";
import { edit } from "./edit.js";
import { component } from "./component.js";
import { warnings as diagnostics } from "./warnings.js";

beforeEach(() => {
  createFigmaMock();
  diagnostics.discardFrom(0);
});

const blurWarnings = () => diagnostics.summary().filter((line) => line.includes("backgroundBlur renders nothing"));
const backgroundBlur = () => effectsSugar({ backgroundBlur: 20 });

test("a background blur on a fill-less node warns; a near-transparent fill silences it", async () => {
  const bare = await render({ type: "FRAME", width: 200, height: 120, fill: "none", effects: backgroundBlur() });
  assert.deepEqual(blurWarnings(), [
    "[warn] " +
      bare.id +
      " backgroundBlur renders nothing on a node with no visible fill — Figma composites the blurred backdrop through the node's own paint, so give the node a fill (a near-transparent one like \"rgba(255,255,255,0.08)\" is enough) for the frost to appear.",
  ]);

  diagnostics.discardFrom(0);
  await render({ type: "FRAME", width: 200, height: 120, fill: "rgba(255,255,255,0.14)", effects: backgroundBlur() });
  assert.deepEqual(blurWarnings(), []);
});

test("edit judges the node's final state: blur onto a filled node is silent, clearing that fill warns", async () => {
  const panel = await render({ type: "FRAME", width: 200, height: 120, fill: "rgba(255,255,255,0.14)" });

  // The delta names only effects — the fill it must be weighed against is the one already on the node.
  await edit(id(panel.id), { effects: backgroundBlur() });
  assert.deepEqual(blurWarnings(), []);

  // And the mirror: the delta names only the fill, while the blur is the node's standing state.
  await edit(id(panel.id), { fill: "none" });
  assert.equal(blurWarnings().length, 1);
});

test("a fully transparent fill is no fill, but any non-zero alpha is", async () => {
  await render({ type: "FRAME", width: 200, height: 120, fill: "rgba(255,255,255,0)", effects: backgroundBlur() });
  assert.equal(blurWarnings().length, 1);

  diagnostics.discardFrom(0);
  await render({ type: "FRAME", width: 200, height: 120, fill: "rgba(0,0,0,0.01)", effects: backgroundBlur() });
  assert.deepEqual(blurWarnings(), []);
});

// flcm.component builds a frame, warns on it, then createComponentFromNode replaces it: the warning
// must ride the returned component. A warning an EARLIER call raised on a frame it later promotes
// keeps naming the frame it described.
test("a blur warning raised while building a component lands on the component", async () => {
  const built = await component({ type: "FRAME", width: 200, height: 120, fill: "none", effects: backgroundBlur() }, { name: "Glass" });
  assert.deepEqual(built.warnings?.map((w) => w.id), [built.id]);

  diagnostics.discardFrom(0);
  const panel = await render({ type: "FRAME", left: 400, width: 200, height: 120, fill: "none", effects: backgroundBlur() });
  const promoted = await component(id(panel.id), { name: "Pane" });
  assert.notEqual(promoted.id, panel.id);
  assert.deepEqual(diagnostics.records.map((w) => w.id), [panel.id]);
});
