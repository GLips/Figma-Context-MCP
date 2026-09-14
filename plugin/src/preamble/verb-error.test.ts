import { test } from "node:test";
import assert from "node:assert/strict";
import { beginMutatingApply } from "./verb-error.js";

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
