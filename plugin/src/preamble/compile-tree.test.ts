// The authoring boundary's one compile. What must not regress silently: an instance's inherited
// children are an ECHO — they cannot be re-parented, and the compile drops them, which is what
// preserves the live sublayers. A word CHANGED on one is a real edit, so it must survive that drop:
// it lifts to the override path the composite sublayer id already spells.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { compileTree } from "./compile-tree.js";
import { render } from "./render.js";
import { component } from "./component.js";
import { append } from "./structure.js";
import { get } from "./read.js";
import { id } from "./flcm.js";

test("a word changed on an instance's inherited child compiles to an override at its path", () => {
  const readShape = {
    id: "12:3",
    type: "INSTANCE",
    componentId: "9:9",
    children: [
      {
        id: "I12:3;4:5",
        type: "FRAME",
        children: [{ id: "I12:3;4:5;6:7", type: "TEXT", text: "After", readOnlySource: { characters: "Before" } }],
      },
    ],
  };
  const tree = compileTree(readShape, "flcm.append");
  // The echo never becomes children: omitting them is what preserves the live sublayers.
  assert.equal(tree.children, undefined);
  assert.deepEqual(tree.authoring!.overrides, { "4:5;6:7": { text: "After" } });

  // An untouched echo carries nothing beyond identity, so it still compiles to no override at all.
  const untouched = compileTree({ ...readShape, children: [{ id: "I12:3;4:5", type: "FRAME", children: [{ id: "I12:3;4:5;6:7", type: "TEXT" }] }] }, "flcm.append");
  assert.equal(untouched.authoring!.overrides, undefined);
});

test("a child edit and an explicit override disagreeing on one word refuse naming both", () => {
  assert.throws(
    () => compileTree(
      {
        id: "12:3",
        type: "INSTANCE",
        overrides: { "4:5": { text: "From the override" } },
        children: [{ id: "I12:3;4:5", type: "TEXT", text: "From the child" }],
      },
      "flcm.append",
    ),
    /overrides\["4:5"\]\.text and the inherited child at that path give different values/,
  );
  // The two AGREEING is the ordinary read shape — a read states an override both ways — so it merges.
  const merged = compileTree(
    {
      id: "12:3",
      type: "INSTANCE",
      overrides: { "4:5": { fill: "#00FF00" } },
      children: [{ id: "I12:3;4:5", type: "TEXT", text: "Edited", fill: "#00FF00" }],
    },
    "flcm.append",
  );
  assert.deepEqual(merged.authoring!.overrides, { "4:5": { fill: "#00FF00", text: "Edited" } });
});

test("a read-modify-write of an instance's tree lands the nested text edit on the live sublayer", async () => {
  const figma = createFigmaMock();
  const chip = await component({ type: "FRAME", children: [{ type: "FRAME", children: [{ type: "TEXT", text: "Before" }] }] });
  const stamped = await render({ type: "INSTANCE", componentId: chip.id! });
  const holder = await render({ type: "FRAME", left: 400, top: 400 });
  const live = await figma.getNodeByIdAsync(stamped.id!);

  const { node } = await get(id(stamped.id!));
  const echo = JSON.parse(JSON.stringify(node));
  echo.children[0].children[0].text = "After";
  await append(id(holder.id!), echo);

  assert.equal(live.children[0].children[0].characters, "After");
});
