/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { beginMutatingApply } from "./verb-error.js";
import { render } from "./render.js";

createFigmaMock();

test("error reporting preserves the original refusal when placement invalidates native parent access", () => {
  let invalid = false;
  const parent = { id: "1:1", type: "INSTANCE", name: "Host", parent: null };
  const node = { id: "I1:1;2:2", type: "FRAME", name: "Body", getPluginData: () => "", get parent() {
    if (invalid) throw Error("stale native parent");
    return parent;
  } };
  const fail = beginMutatingApply("move", node as unknown as SceneNode);
  invalid = true;
  const error = fail(new Error("original native placement refusal"));
  assert.match(error.message, /original native placement refusal/);
  assert.match(error.message, /inside instance "Host"/);
  assert.doesNotMatch(error.message, /stale native parent/);
});

test("a render that fails on a nested node names that node, not the page it was building into", async () => {
  const createRectangle = figma.createRectangle;
  figma.createRectangle = () => {
    const node = createRectangle.call(figma);
    Object.defineProperty(node, "fills", { set() { throw new Error("in set_fills: Expected an array of paints"); } });
    return node;
  };
  try {
    await assert.rejects(
      render({ type: "FRAME", name: "Card", children: [{ type: "RECTANGLE", name: "Swatch", fill: "#f00" }] }),
      (err: Error) => {
        assert.match(err.message, /Figma refused a write on RECTANGLE "Swatch" at \S+\.children\[0\], being built into PAGE/);
        assert.match(err.message, /— in set_fills/);
        return true;
      },
    );
  } finally {
    figma.createRectangle = createRectangle;
  }
});

test("an flcm legality check on a nested node names that node and does not blame Figma", async () => {
  await assert.rejects(
    render({ type: "FRAME", name: "Card", layout: { mode: "row" }, children: [{ type: "RECTANGLE", name: "Bar", width: "50%", height: 4 }] }),
    /flcm\.render: failed mid-apply on RECTANGLE "Bar" at \S+\.children\[0\], being built into PAGE .* — a percent w\/h/,
  );
});

test("a failed placement of slot content names its spec path once and gives no edit-the-component advice", () => {
  const instance = { id: "1:1", type: "INSTANCE", name: "Host", parent: null };
  const slot = { id: "I1:1;2:2", type: "SLOT", name: "Body", parent: instance };
  const node = { id: "3:3", type: "FRAME", name: "Card", parent: slot, getPluginData: () => "" };
  const message = beginMutatingApply("flcm.append.spec", node as unknown as SceneNode)(new Error("in set_layoutGrow: refused")).message;
  assert.match(message, /^flcm\.append\.spec: Figma refused a write on FRAME "Card"/);
  assert.doesNotMatch(message, /edit the component/);
  assert.equal(message.split("rolled back").length, 2);
});
