// Vector (Phase 2): flcm.svg pastes opaque markup; flcm.path is a single themeable vector. Construction is
// inert (checked on the built WriteNode); the plugin calls are render-time (bridge) behavior, checked
// against the in-memory figma mock (which models createNodeFromSvg → a FRAME of vectors, and createVector).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { svg, path, render } from "./flcm.js";

createFigmaMock();

test("flcm.path builds a VECTOR carrying the path data, themed by fill", async () => {
  const wn = path({ d: "M8 5 L19 12 L8 19 Z", fill: "#6366F1", width: 24, height: 24 });
  assert.equal(wn.type, "VECTOR");
  assert.equal(wn.pathData, "M8 5 L19 12 L8 19 Z");
  assert.equal(wn.fills!.length, 1);

  const out = await render(wn);
  const node = figma.getNodeById(out.root.id);
  assert.equal(node.type, "VECTOR");
  assert.deepEqual(node.vectorPaths, [{ windingRule: "NONZERO", data: "M8 5 L19 12 L8 19 Z" }]);
  assert.equal(node.fills[0].type, "SOLID");
  assert.equal(node.width, 24); // author w/h resizes the vector
});

test("flcm.svg builds a VECTOR carrying markup; render yields a FRAME with clipsContent cleared", async () => {
  const markup = '<svg viewBox="0 0 24 24"><path d="M12 2 L22 20 L2 20 Z" fill="#0B1020"/></svg>';
  const wn = svg(markup, { width: 32, height: 32 });
  assert.equal(wn.type, "VECTOR");
  assert.equal(wn.svg, markup);

  const out = await render(wn);
  const node = figma.getNodeById(out.root.id);
  // createNodeFromSvg returns a FRAME (a frame of vectors), so the handle reports the real created type.
  assert.equal(node.type, "FRAME");
  assert.equal(node.clipsContent, false); // vector art isn't clipped to its viewBox
  assert.equal(node.width, 32);
});

test("flcm.path with no fill is transparent (like the other primitives)", async () => {
  const out = await render(path({ d: "M0 0 L10 10", stroke: "#fff", strokeWidth: 2 }));
  const node = figma.getNodeById(out.root.id);
  assert.deepEqual(node.fills, []);
  assert.equal(node.strokes[0].type, "SOLID");
});

test("flcm.path with a fill and no stroke clears Figma's default vector stroke (no unauthored outline)", async () => {
  // figma.createVector() seeds a default black stroke; a fill-only path must come out unstroked to match
  // rect/frame. The mock replicates that default, so this bites if the bridge ever stops stripping it.
  const out = await render(path({ d: "M0 0 L10 0 L10 10 Z", fill: "#fff", width: 24, height: 24 }));
  const node = figma.getNodeById(out.root.id);
  assert.equal(node.fills[0].type, "SOLID");
  assert.deepEqual(node.strokes, []);
});

test("fill/stroke on flcm.svg fail loud — colors live in the markup (ADR-0003 no-op rejection)", () => {
  const markup = '<svg viewBox="0 0 24 24"><path d="M0 0Z"/></svg>';
  assert.throws(() => svg(markup, { fill: "#f00" } as never), /colors are baked into the SVG markup/);
  assert.throws(() => svg(markup, { stroke: "#f00" } as never), /colors are baked into the SVG markup/);
});

test("malformed vector inputs fail loud", () => {
  // svg needs an actual <svg> document — a URL or bare string is the common mistake.
  assert.throws(() => svg("https://example.com/logo.svg"), /expected SVG markup/);
  assert.throws(() => svg(null as never), /expected SVG markup/);
  // path needs a non-empty `d`.
  assert.throws(() => path({ d: "" } as never), /non-empty string/);
  assert.throws(() => path({} as never), /non-empty string/);
  assert.throws(() => path(null as never), /expected a props object/);
});
