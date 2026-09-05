import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, changesBetween, repetitions } from "../src/shared/analyze.js";
import type { Obj, Replay } from "../src/shared/model.js";
function replay(design: Obj, text: string): Replay {
  return {
    design,
    serialized: { tree: text, yaml: text, json: text },
    timings: { simplifyMs: 1, serializeMs: { tree: 1, yaml: 1, json: 1 } },
    revision: "test",
    sourceHash: "test",
    pipeline: "test",
  };
}
test("matches nodes by ID, reports moves and changed fields without insertion churn", () => {
  const left: Obj = {
    nodes: [
      { id: "a", width: 10 },
      { id: "b", width: 20 },
    ],
  };
  const right: Obj = { nodes: [{ id: "new" }, { id: "a", width: 11 }, { id: "b", width: 20 }] };
  assert.deepEqual(
    changesBetween(left, right).map((c) => [c.kind, c.nodeId, c.path]),
    [
      ["changed", "a", "/nodes/a/width"],
      ["added", "new", "/nodes/new"],
    ],
  );
  assert.ok(
    changesBetween(left, { nodes: [{ id: "a", children: [{ id: "b", width: 20 }] }] }).some(
      (c) => c.kind === "moved" && c.nodeId === "b",
    ),
  );
  assert.ok(
    changesBetween(left, { nodes: [{ id: "b" }] }).some(
      (c) => c.kind === "removed" && c.nodeId === "a",
    ),
  );
});
test("distinguishes formatting, compressed representation, and semantic change in each format", () => {
  const plain: Obj = { nodes: [{ id: "a", type: "FRAME", fills: ["#FFFFFF"] }] };
  const compressed: Obj = {
    nodes: [{ id: "a", template: "T" }],
    templates: { T: { type: "FRAME", fills: "S" } },
    styles: { S: ["#FFFFFF"] },
  };
  assert.equal(
    analyze(replay(plain, '[FRAME] "x" #a'), replay(plain, '[FRAME]   "x" #a')).serialization.tree,
    "formatting-only",
  );
  assert.equal(
    analyze(replay(plain, "a"), replay(compressed, "b")).serialization.json,
    "representation-only",
  );
  assert.equal(
    analyze(replay(plain, "a"), replay({ nodes: [{ id: "a", fills: ["#000000"] }] }, "b"))
      .serialization.yaml,
    "semantic",
  );
});
test("finds repeated facts across metadata, nodes, and styles and measures UTF-8 bytes", () => {
  const design: Obj = {
    metadata: { components: { c: { name: "Button" } } },
    nodes: [{ id: "a", name: "Button", children: [{ id: "b", text: "é" }] }],
    styles: { name: "Button" },
  };
  assert.equal(repetitions(design)[0].occurrences, 3);
  const m = analyze(replay(design, "é"), replay(design, "é")).metrics.json.candidate;
  assert.equal(m.bytes, 2);
  assert.equal(m.nodes, 2);
  assert.equal(m.maxDepth, 1);
  assert.equal(m.components, 1);
});
test("recognizes a uniquely matching field relocation without claiming ambiguous values moved", () => {
  const changes = changesBetween(
    { nodes: [{ id: "a", layout: { width: 80 } }] },
    { nodes: [{ id: "a", width: 80 }] },
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "moved");
  assert.deepEqual(changes[0].before, { path: "/nodes/a/layout/width", value: 80 });
  const ambiguous = changesBetween(
    { nodes: [{ id: "a", one: { width: 80 }, two: { width: 80 } }] },
    { nodes: [{ id: "a", width: 80 }] },
  );
  assert.ok(ambiguous.every((c) => c.kind !== "moved"));
});
test("format parsing preserves text meaning and exposes compression table changes", () => {
  const same: Obj = { nodes: [{ id: "a", text: "Save now" }] };
  const a = replay(same, '{"text":"Save now"}');
  const b = replay(same, '{ "text" : "Save now" }');
  assert.equal(analyze(a, b).serialization.json, "formatting-only");
  assert.equal(analyze(a, replay(same, '{"text":"Savenow"}')).serialization.json, "semantic");
  const tableChange = analyze(
    replay({ nodes: [], styles: { old: "value" } }, "a"),
    replay({ nodes: [], styles: { next: "value" } }, "b"),
  );
  assert.equal(tableChange.changes.length, 0);
  assert.equal(tableChange.emittedChanges.length, 2);
});
test("resolves the historical globalVars/elements tables while preserving their emitted changes", () => {
  const legacy: Obj = {
    nodes: [{ id: "a", template: "T" }],
    elements: { T: { type: "FRAME", fills: "S" } },
    globalVars: { styles: { S: ["#FFFFFF"] } },
  };
  const modern: Obj = {
    nodes: [{ id: "a", template: "T" }],
    templates: { T: { type: "FRAME", fills: "S" } },
    styles: { S: ["#FFFFFF"] },
  };
  const result = analyze(replay(legacy, "a"), replay(modern, "b"));
  assert.equal(result.changes.length, 0);
  assert.ok(result.emittedChanges.some((c) => c.path.startsWith("/globalVars/")));
  assert.deepEqual(result.baselineNodes[0].fields.fills, ["#FFFFFF"]);
});
