/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { render } from "./structure.js";
import { get, find, resolveTarget } from "./read.js";

// Its own file on purpose: counts are memoized per preamble evaluation, i.e. per module instance.
test("reads carry counts on the node under each pin, fetched once per run and reassigned after edits", async () => {
  const figma = createFigmaMock() as { fileKey?: string };
  figma.fileKey = "abc";
  await render({
    type: "FRAME",
    key: "screen",
    width: 400,
    height: 400,
    children: [
      { type: "RECTANGLE", key: "card", width: 200, height: 200 },
      { type: "RECTANGLE", key: "hidden", width: 400, height: 400, visible: false },
    ],
  });
  const screen = await resolveTarget("screen");
  const card = await resolveTarget("card");
  const calls: unknown[] = [];
  const g = globalThis as { __flcmHost?: unknown };
  g.__flcmHost = {
        runCancellation: () => null,
    isRunFinished: () => false,
    callServer: async (capability: string, payload: unknown) => {
      calls.push([capability, payload]);
      return {
        pins: [
          { nodeId: screen.id, x: 10, y: 10 },
          { nodeId: screen.id, x: 300, y: 300 },
        ],
      };
    },
  };
  try {
    const { node } = await get("screen");
    assert.equal(node.comments, 1);
    assert.equal(node.children?.find((child) => child.id === card.id)?.comments, 1);
    const [slim] = await find({ key: "card" });
    assert.equal(slim.comments, 1);

    // The run moves the card off the pin: the next read reassigns without another fetch.
    card.x = 250;
    card.y = 0;
    const moved = await get("screen");
    assert.equal(moved.node.comments, 2);
    assert.equal(moved.node.children?.find((child) => child.id === card.id)?.comments, undefined);
    assert.deepEqual(calls, [["comments.pins", { fileKey: "abc" }]]);
  } finally {
    delete g.__flcmHost;
  }
});
