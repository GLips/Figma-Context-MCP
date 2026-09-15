// The mock models SVG imports as frames of vectors and path data as a native vector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";

import { render } from "./render.js";

createFigmaMock();

test("VECTOR builds a VECTOR carrying the path data, themed by fill", async () => {
  const wn = { type: "VECTOR", d: "M8 5 L19 12 L8 19 Z", fill: "#6366F1", width: 24, height: 24 };
  assert.equal(wn.type, "VECTOR");

  const out = await render(wn);
  const node = await figma.getNodeByIdAsync(out.id);
  assert.equal(node.type, "VECTOR");
  assert.deepEqual(node.vectorPaths, [{ windingRule: "NONZERO", data: "M8 5 L19 12 L8 19 Z" }]);
  assert.equal(node.fills[0].type, "SOLID");
  assert.equal(node.width, 24); // author w/h resizes the vector
});

test("VECTOR builds a VECTOR carrying markup; render yields a FRAME with clipsContent cleared", async () => {
  const markup = '<svg viewBox="0 0 24 24"><path d="M12 2 L22 20 L2 20 Z" fill="#0B1020"/></svg>';
  const wn = { type: "VECTOR", svg: markup, width: 32, height: 32 };
  assert.equal(wn.type, "VECTOR");
  assert.equal(wn.svg, markup);

  const out = await render(wn);
  const node = await figma.getNodeByIdAsync(out.id);
  // createNodeFromSvg returns a FRAME (a frame of vectors), so the handle reports the real created type.
  assert.equal(node.type, "FRAME");
  assert.equal(node.clipsContent, false); // vector art isn't clipped to its viewBox
  assert.equal(node.width, 32);
});

test("VECTOR with no fill is transparent (like the other primitives)", async () => {
  const out = await render({ type: "VECTOR", d: "M0 0 L10 10", stroke: "#fff", strokeWidth: 2 });
  const node = await figma.getNodeByIdAsync(out.id);
  assert.deepEqual(node.fills, []);
  assert.equal(node.strokes[0].type, "SOLID");
});

test("VECTOR with a fill and no stroke clears Figma's default vector stroke (no unauthored outline)", async () => {
  // figma.createVector() seeds a default black stroke; a fill-only path must come out unstroked to match
  // rect/frame. The mock replicates that default, so this bites if the bridge ever stops stripping it.
  const out = await render({
    type: "VECTOR",
    d: "M0 0 L10 0 L10 10 Z",
    fill: "#fff",
    width: 24,
    height: 24,
  });
  const node = await figma.getNodeByIdAsync(out.id);
  assert.equal(node.fills[0].type, "SOLID");
  assert.deepEqual(node.strokes, []);
});

test("fill/stroke on SVG imports fail because colors live in the markup", async () => {
  const markup = '<svg viewBox="0 0 24 24"><path d="M0 0Z"/></svg>';
  await assert.rejects(
    render({ type: "VECTOR", svg: markup, fill: "#f00" }),
    /colors are baked into the SVG markup/,
  );
  await assert.rejects(
    render({ type: "VECTOR", svg: markup, stroke: "#f00" }),
    /colors are baked into the SVG markup/,
  );
});

test("malformed vector inputs fail loud", async () => {
  // svg needs an actual <svg> document — a URL or bare string is the common mistake.
  await assert.rejects(
    render({ type: "VECTOR", svg: "https://example.com/logo.svg" }),
    /expected SVG markup/,
  );
  await assert.rejects(render({ type: "VECTOR", svg: null as never }), /expected SVG markup/);
  // path needs a non-empty `d`.
  await assert.rejects(render({ type: "VECTOR", d: "" }), /non-empty string/);
  await assert.rejects(render({ type: "VECTOR" }), /exactly one/);
});
