/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { beginMutatingApply } from "./verb-error.js";
import { render } from "./runtime.js";
import { FlcmError } from "./flcm-error.js";

createFigmaMock();

test("Figma's refusal keeps its own words when placement invalidates native parent access", () => {
  let invalid = false;
  const parent = { id: "1:1", type: "INSTANCE", name: "Host", parent: null };
  const node = { id: "I1:1;2:2", type: "FRAME", name: "Body", getPluginData: () => "", get parent() {
    if (invalid) throw Error("stale native parent");
    return parent;
  } };
  const fail = beginMutatingApply(node as unknown as SceneNode);
  invalid = true;
  const error = fail(new Error("original native placement refusal"));
  assert.equal(error.kind, "figma");
  assert.deepEqual(error.node, { type: "FRAME", name: "Body", id: "I1:1;2:2" });
  assert.match(error.reason, /^Figma refused a change to this layer: "original native placement refusal"/);
  assert.match(error.reason, /inside instance "Host"/);
  assert.doesNotMatch(error.message, /stale native parent/);
});

test("a failure flcm raised inside an instance keeps its kind and reason and isn't blamed on Figma or the component", () => {
  const instance = { id: "1:1", type: "INSTANCE", name: "Host", parent: null };
  const node = { id: "I1:1;2:2", type: "FRAME", name: "Body", parent: instance, getPluginData: () => "" };
  // A Figma limit flcm detected itself is figma-kind, but only Figma's own throw reads "Figma refused".
  for (const kind of ["internal", "figma"] as const) {
    const error = beginMutatingApply(node as unknown as SceneNode)(new FlcmError(kind, "the font Inter Bold isn't available here."));
    assert.equal(error.kind, kind);
    assert.equal(error.reason, "the font Inter Bold isn't available here.");
    assert.equal(error.node?.name, "Body");
    assert.doesNotMatch(error.message, /Figma refused|edit the component/);
  }
});

test("a render that fails on a nested node names that node by its spec path, not the page it was building into", async () => {
  const createRectangle = figma.createRectangle;
  figma.createRectangle = () => {
    const node = createRectangle.call(figma);
    Object.defineProperty(node, "fills", { set() { throw new Error("in set_fills: Expected an array of paints"); } });
    return node;
  };
  try {
    await assert.rejects(
      render({ type: "FRAME", name: "Card", children: [{ type: "RECTANGLE", name: "Swatch", fill: "#f00" }] }),
      (err: FlcmError) => {
        assert.equal(err.kind, "figma");
        assert.equal(err.call, "flcm.render");
        assert.equal(err.path, "flcm.render.spec.children[0]");
        assert.equal(err.node?.name, "Swatch");
        assert.match(err.message, /^flcm\.render: RECTANGLE "Swatch" at spec\.children\[0\]: Figma refused a change to this layer: "in set_fills/);
        assert.doesNotMatch(err.message, /PAGE/);
        return true;
      },
    );
  } finally {
    figma.createRectangle = createRectangle;
  }
});

test("an flcm legality check on a nested node refuses before any write, naming that node's path", async () => {
  const before = figma.currentPage.children.length;
  await assert.rejects(
    render({ type: "FRAME", name: "Card", layout: { mode: "row" }, children: [{ type: "RECTANGLE", name: "Bar", width: "50%", height: 4 }] }),
    (err: FlcmError) => {
      assert.equal(err.kind, "authoring");
      assert.equal(err.path, "flcm.render.spec.children[0]");
      assert.match(err.message, /^flcm\.render: RECTANGLE "Bar" at spec\.children\[0\]: a percent w\/h/);
      assert.doesNotMatch(err.message, /Figma refused/);
      return true;
    },
  );
  assert.equal(figma.currentPage.children.length, before);
});

test("a failed placement of slot content names its spec path once and gives no edit-the-component advice", () => {
  const instance = { id: "1:1", type: "INSTANCE", name: "Host", parent: null };
  const slot = { id: "I1:1;2:2", type: "SLOT", name: "Body", parent: instance };
  const node = { id: "3:3", type: "FRAME", name: "Card", parent: slot, getPluginData: () => "" };
  const error = beginMutatingApply(node as unknown as SceneNode, { path: "flcm.append.spec" })(new Error("in set_layoutGrow: refused"));
  assert.equal(error.path, "flcm.append.spec");
  assert.match(error.message, /^FRAME "Card" \(id "3:3"\) at flcm\.append\.spec: Figma refused a change to this layer/);
  assert.doesNotMatch(error.message, /edit the component/);
  assert.equal(error.message.split("flcm.append.spec").length, 2);
});
