import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { render } from "./render.js";
import type { FrameProps } from "./schema.js";

createFigmaMock();

test("padding accepts numbers, CSS box shorthand and edge objects", async () => {
  const cases: [FrameProps["layout"]["padding"], number[]][] = [
    [24, [24, 24, 24, 24]],
    [{ x: 8, y: 16 }, [16, 8, 16, 8]],
    [{ top: 4, left: 2 }, [4, 0, 0, 2]],
    ["24px", [24, 24, 24, 24]],
    ["12px 16px", [12, 16, 12, 16]],
    ["1px 2px 3px", [1, 2, 3, 2]],
    ["1px 2px 3px 4px", [1, 2, 3, 4]],
    [{ x: "24px" }, [0, 24, 0, 24]],
  ];
  for (const [padding, expected] of cases) {
    const out = await render({ type: "FRAME", layout: { mode: "row", padding } });
    const node = await figma.getNodeByIdAsync(out.id);
    assert.deepEqual(
      [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
      expected,
    );
  }
  await assert.rejects(
    render({ type: "FRAME", layout: { padding: { x: "24em" } as never } }),
    /pad\.x must be a number or "Npx"/,
  );
  await assert.rejects(
    render({ type: "FRAME", layout: { padding: [] as never } }),
    /pad must be a number, a CSS box shorthand/,
  );
});

test("strokeAlign accepts the read vocabulary and rejects unknown values", async () => {
  for (const [strokeAlign, expected] of [
    ["outside", "OUTSIDE"],
    ["center", "CENTER"],
    [undefined, "INSIDE"],
  ] as const) {
    const out = await render({ type: "RECTANGLE", stroke: "#000", strokeAlign });
    assert.equal((await figma.getNodeByIdAsync(out.id)).strokeAlign, expected);
  }
  await assert.rejects(
    render({ type: "RECTANGLE", strokeAlign: "outer" as never }),
    /strokeAlign is "inside", "outside" or "center"/,
  );
});

test("render rejects layout words the node cannot realize", async () => {
  await assert.rejects(
    render({ type: "TEXT", text: "hi", height: 80 }),
    /a TEXT's height follows its content/,
  );
  await assert.doesNotReject(render({ type: "TEXT", text: "hi", height: "hug" }));
  await assert.rejects(render({ type: "RECTANGLE", width: "hug" }), /"hug" sizes to content/);
  await assert.rejects(render({ type: "FRAME", width: "hug" }), /"hug" sizes to content/);
  await assert.rejects(render({ type: "FRAME", layout: { gap: 12 } }), /need an auto-layout/);
  await assert.doesNotReject(
    render({ type: "FRAME", width: "hug", layout: { mode: "row", gap: 12 } }),
  );
  await assert.doesNotReject(render({ type: "TEXT", text: "hi", width: "hug" }));
});

test("pixel metrics work for dimensions and position; unsupported units reject", async () => {
  const out = await render({ type: "FRAME", width: "320px", height: 200, left: "16px", top: 8 });
  const node = await figma.getNodeByIdAsync(out.id);
  assert.deepEqual([node.width, node.height, node.x, node.y], [320, 200, 16, 8]);
  await assert.rejects(render({ type: "FRAME", width: "20em" }), /width\/height must be a number/);
  await assert.rejects(render({ type: "FRAME", left: "20vw" }), /left must be a number/);
});

test("root position lands on the page; an in-flow child's explicit pin is stored", async () => {
  const out = await render({
    type: "FRAME",
    width: 40,
    height: 40,
    left: 42,
    top: 17,
    layout: { mode: "row", gap: 4 },
    children: [{ type: "RECTANGLE", width: 10, height: 10, pin: { x: "right" } }],
  });
  const root = await figma.getNodeByIdAsync(out.id);
  assert.deepEqual([root.x, root.y], [42, 17]);
  assert.equal(root.children[0].constraints.horizontal, "MAX");
});

test("parent-relative sizes reject when the parent cannot resolve them", async () => {
  await assert.rejects(
    render({ type: "FRAME", width: "fill", layout: { mode: "row" } }),
    /node's parent is the page/,
  );
  await assert.rejects(
    render({
      type: "FRAME",
      width: 300,
      height: 200,
      children: [{ type: "TEXT", text: "t", height: "fill" }],
    }),
    /in-flow child of an auto-layout parent/,
  );
});

test("mistyped scalar values reject before writing", async () => {
  await assert.rejects(
    render({ type: "RECTANGLE", opacity: "bad" as never }),
    /`opacity` must be a number/,
  );
  await assert.rejects(
    render({ type: "LINE", rotation: "bad" as never }),
    /`rotation` must be a number/,
  );
});

test("alignItems stretch stretches auto-sized children while preserving fixed sizes", async () => {
  const out = await render({
    type: "FRAME",
    layout: { mode: "row", alignItems: "stretch" },
    children: [{ type: "ELLIPSE" }, { type: "ELLIPSE", height: 50 }],
  });
  const root = await figma.getNodeByIdAsync(out.id);
  assert.equal(root.children[0].layoutAlign, "STRETCH");
  assert.notEqual(root.children[1].layoutAlign, "STRETCH");
});

test("alignment maps supported values and refuses unrealizable spacing", async () => {
  const out = await render({
    type: "FRAME",
    layout: { mode: "row", justifyContent: "space-between" },
  });
  assert.equal((await figma.getNodeByIdAsync(out.id)).primaryAxisAlignItems, "SPACE_BETWEEN");
  await assert.rejects(
    render({ type: "FRAME", layout: { mode: "row", justifyContent: "space-around" as never } }),
    /layout\.justifyContent must be one of/,
  );
  await assert.rejects(
    render({ type: "FRAME", layout: { mode: "row", justifyContent: "space-evenly" as never } }),
    /space-around\/space-evenly/,
  );
  await assert.rejects(
    render({ type: "FRAME", layout: { mode: "row", alignItems: "space-between" as never } }),
    /layout\.alignItems must be one of/,
  );
});

test("layout mode sets the native container mode and refuses missing grid templates", async () => {
  const column = await render({ type: "FRAME", layout: { mode: "column" } });
  const free = await render({ type: "FRAME" });
  assert.equal((await figma.getNodeByIdAsync(column.id)).layoutMode, "VERTICAL");
  assert.equal((await figma.getNodeByIdAsync(free.id)).layoutMode, "NONE");
  await assert.rejects(
    render({ type: "FRAME", layout: { mode: "grid" } }),
    /grid.*requires.*gridTemplate/,
  );
});

test("text alignment maps supported values and refuses unknown ones", async () => {
  const out = await render({ type: "TEXT", text: "t", textStyle: { textAlign: "center" } });
  assert.equal((await figma.getNodeByIdAsync(out.id)).textAlignHorizontal, "CENTER");
  await assert.rejects(
    render({ type: "TEXT", text: "t", textStyle: { textAlign: "middle" as never } }),
    /textStyle\.textAlign must be one of/,
  );
});

test("CSS blend modes apply to each node kind and reject unsupported values", async () => {
  const out = await render({
    type: "FRAME",
    mixBlendMode: "overlay",
    children: [
      { type: "ELLIPSE", mixBlendMode: "MULTIPLY" },
      { type: "TEXT", text: "hi", mixBlendMode: "soft-light" },
      { type: "FRAME", mixBlendMode: "screen" },
    ],
  });
  const root = await figma.getNodeByIdAsync(out.id);
  assert.equal(root.blendMode, "OVERLAY");
  assert.deepEqual(
    root.children.map((node) => node.blendMode),
    ["MULTIPLY", "SOFT_LIGHT", "SCREEN"],
  );
  await assert.rejects(
    render({ type: "FRAME", mixBlendMode: "plus-lighter" }),
    /unsupported blend/,
  );
});

test("line clamps require a bounded width and a positive whole number", async () => {
  const out = await render({
    type: "FRAME",
    width: 400,
    layout: { mode: "column" },
    children: [
      { type: "TEXT", text: "A long title", textStyle: { lineClamp: 2 }, width: 200 },
      { type: "TEXT", text: "A long title", textStyle: { lineClamp: 1 }, width: "fill" },
      { type: "TEXT", text: "A long title", textStyle: { lineClamp: 3 }, width: "50%" },
    ],
  });
  const root = await figma.getNodeByIdAsync(out.id);
  assert.deepEqual(
    root.children.map((node) => node.maxLines),
    [2, 1, 3],
  );
  assert.ok(root.children.every((node) => node.textTruncation === "ENDING"));
  await assert.rejects(
    render({ type: "TEXT", text: "t", textStyle: { lineClamp: 2 } }),
    /bounded width/,
  );
  await assert.rejects(
    render({ type: "TEXT", text: "t", textStyle: { lineClamp: 2 }, width: "hug" }),
    /bounded width/,
  );
  for (const lineClamp of [0, 1.5])
    await assert.rejects(
      render({ type: "TEXT", text: "t", textStyle: { lineClamp }, width: 200 }),
      /whole number/,
    );
});

test("frames do not clip by default; clip true opts in", async () => {
  const def = await figma.getNodeByIdAsync((await render({ type: "FRAME" })).id);
  const on = await figma.getNodeByIdAsync((await render({ type: "FRAME", clip: true })).id);
  const off = await figma.getNodeByIdAsync((await render({ type: "FRAME", clip: false })).id);
  assert.equal(def.clipsContent, false);
  assert.equal(on.clipsContent, true);
  assert.equal(off.clipsContent, false);
});
