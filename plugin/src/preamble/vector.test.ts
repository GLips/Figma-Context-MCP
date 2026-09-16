// The mock models SVG imports as frames of vectors (with a nested group, and colors baked into every
// vector) and path data as a native vector whose box is its geometry's bounding box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";

import { render } from "./render.js";

createFigmaMock();

// Every vector under the imported frame, in document order — what theming has to reach.
const artOf = (frame: any): any[] =>
  (frame.children ?? []).flatMap((child: any) => (child.type === "VECTOR" ? [child] : artOf(child)));

const warningsOf = async (run: () => Promise<unknown>): Promise<string[]> => {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return lines;
};

test("VECTOR builds a VECTOR carrying the path data, themed by fill", async () => {
  const out = await render({ type: "VECTOR", d: "M8 5 L19 12 L8 19 Z", fill: "#6366F1" });
  const node = await figma.getNodeByIdAsync(out.id);
  assert.equal(node.type, "VECTOR");
  assert.deepEqual(node.vectorPaths, [{ windingRule: "NONZERO", data: "M8 5 L19 12 L8 19 Z" }]);
  assert.equal(node.fills[0].type, "SOLID");
});

test("a path's box is the path's bounding box; width/height are ignored with one warning naming the node", async () => {
  // The bug this exists for: a 6x12 chevron authored "on a 24 grid" used to be stretched to 24x24,
  // non-uniformly, and the reply echoed 24x24 as though it had meant something.
  let out: any;
  const warnings = await warningsOf(async () => {
    out = await render({ type: "VECTOR", d: "M15 18 L9 12 L15 6", stroke: "#111", width: 24, height: 24 });
  });
  const node = await figma.getNodeByIdAsync(out.id);
  assert.equal(node.width, 6);
  assert.equal(node.height, 12);

  assert.equal(warnings.length, 1, "one warning for the node, not one per ignored word");
  assert.match(warnings[0], /spec: a VECTOR with `d` is bare geometry/);
  assert.match(warnings[0], /width\/height was ignored/);
  assert.match(warnings[0], /`scale`.*`svg`/s); // both escape hatches, named
});

test("scale multiplies the path's natural box, uniformly", async () => {
  const out = await render({ type: "VECTOR", d: "M15 18 L9 12 L15 6", stroke: "#111", scale: 3 });
  const node = await figma.getNodeByIdAsync(out.id);
  assert.equal(node.width, 18);
  assert.equal(node.height, 36);
});

test("scale must be a positive number — the word exists so art can't stretch", async () => {
  for (const scale of [0, -2, "2" as never, Infinity]) {
    await assert.rejects(render({ type: "VECTOR", d: "M0 0 L10 10", scale }), /`scale` must be a positive number/);
  }
});

test("VECTOR builds a VECTOR carrying markup; render yields a FRAME with clipsContent cleared", async () => {
  const markup = '<svg viewBox="0 0 24 24"><path d="M12 2 L22 20 L2 20 Z" fill="#0B1020"/></svg>';
  const out = await render({ type: "VECTOR", svg: markup, width: 32, height: 32 });
  const node = await figma.getNodeByIdAsync(out.id);
  // createNodeFromSvg returns a FRAME (a frame of vectors), so the handle reports the real created type.
  assert.equal(node.type, "FRAME");
  assert.equal(node.clipsContent, false); // vector art isn't clipped to its viewBox
  assert.equal(node.width, 32); // an svg import IS a canvas — size words apply to it
});

test("fill/stroke beside svg repaint every vector inside, including nested groups", async () => {
  const markup = '<svg viewBox="0 0 24 24"><path d="M0 0Z" fill="#0B1020"/></svg>';
  const out = await render({ type: "VECTOR", svg: markup, fill: "#FF0000", stroke: "none" });
  const frame = await figma.getNodeByIdAsync(out.id);

  const art = artOf(frame);
  assert.equal(art.length, 2, "the mock imports a flat vector and one nested in a group");
  for (const vector of art) {
    assert.deepEqual(vector.fills[0].color, { r: 1, g: 0, b: 0 }, "the markup's baked color is overridden");
    assert.deepEqual(vector.strokes, [], '"none" clears the strokes the markup baked in');
  }
  // The group frame is scaffolding, not art: painting it would put a backdrop behind the icon.
  const group = frame.children.find((child: any) => child.type === "FRAME");
  assert.deepEqual(group.fills, []);
});

test("imported art carries SCALE constraints, so resizing the frame scales the drawing", async () => {
  // The plugin typings promise nothing here, so flcm sets them rather than inherit Top/Left.
  const out = await render({ type: "VECTOR", svg: '<svg viewBox="0 0 24 24"><path d="M0 0Z"/></svg>' });
  const frame = await figma.getNodeByIdAsync(out.id);
  const walk = (node: any): any[] => [node, ...(node.children ?? []).flatMap(walk)];
  for (const child of (frame.children ?? []).flatMap(walk)) {
    assert.deepEqual(child.constraints, { horizontal: "SCALE", vertical: "SCALE" }, child.type + " must scale with the canvas");
  }
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
  const out = await render({ type: "VECTOR", d: "M0 0 L10 0 L10 10 Z", fill: "#fff" });
  const node = await figma.getNodeByIdAsync(out.id);
  assert.equal(node.fills[0].type, "SOLID");
  assert.deepEqual(node.strokes, []);
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
