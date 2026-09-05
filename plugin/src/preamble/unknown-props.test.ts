// Unknown-prop rejection (ratified decision 1): the authoring surface fails loud on an unknown prop —
// surface-wide, at construction, before render touches the canvas — instead of silently dropping it. Two
// concerns pinned here:
//   1. The tier-2 DRIFT GUARD — each runtime KNOWN_KEYS group equals Object.keys of its schema FIELD_GROUP.
//      The runtime sets can't be sourced from schema.ts's zod (it must never enter the QuickJS bundle — the
//      purity gate), so they're hand-mirrored; this test is what keeps them honest when a prop is added.
//   2. The REJECT FIRES loud, with the offender + path named, at every verb and nested object.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { KNOWN_KEYS, DIRECTIONAL_KEYS, frame, text, rect, line, svg, path, gradient, image, effects } from "./flcm.js";
import { find } from "./read.js";
import { FIELD_GROUPS, SizeSchema } from "./schema.js";

// Constructors are inert POJO builders (figma untouched), but flcm.ts imports the bridge — install the mock.
createFigmaMock();

test("KNOWN_KEYS mirrors schema.ts FIELD_GROUPS exactly (drift guard)", () => {
  // Same group set on both sides — neither a stray runtime group nor a missing one.
  assert.deepEqual(Object.keys(KNOWN_KEYS).sort(), Object.keys(FIELD_GROUPS).sort());
  for (const group of Object.keys(FIELD_GROUPS) as (keyof typeof FIELD_GROUPS)[]) {
    assert.deepEqual(
      [...KNOWN_KEYS[group]].sort(),
      Object.keys(FIELD_GROUPS[group]).sort(),
      `runtime KNOWN_KEYS.${group} drifted from schema FIELD_GROUPS.${group} — add the new prop to both, or neither`,
    );
  }
});

test("the directional nested set (anchor) matches its inline schema shape (drift guard)", () => {
  // anchor is defined inline in SIZE_FIELDS, not as its own FIELD_GROUP — so guard it by unwrapping the
  // zod object directly. prop() wraps each field in .optional(); .unwrap() peels it.
  const anchorShape = (SizeSchema as unknown as { shape: { anchor: { unwrap(): { shape: Record<string, unknown> } } } }).shape.anchor.unwrap();
  assert.deepEqual([...DIRECTIONAL_KEYS].sort(), Object.keys(anchorShape.shape).sort());
  // `pin` reuses DIRECTIONAL_KEYS (z.custom — no zod shape to reflect on), so the anchor guard covers it too.
});

test("verbs reject an unknown top-level prop, naming it and the verb", () => {
  assert.throws(() => frame({ background: "#fff" } as never), /unknown prop "background" on flcm\.frame/);
  assert.throws(() => text("hi", { textTransform: "upper" } as never), /unknown prop "textTransform" on flcm\.text/);
  assert.throws(() => rect({ radius: 4 } as never), /unknown prop "radius" on flcm\.rect/); // it's borderRadius
  assert.throws(() => line({ height: 10 } as never), /`height` is not one of flcm\.line's words/); // a line sizes on width only
  assert.throws(() => path({ d: "M0 0 L1 1", borderRadius: 2 } as never), /unknown prop "borderRadius" on flcm\.path/);
  assert.throws(() => gradient({ type: "linear", stops: ["#000", "#fff"], colors: [] } as never), /unknown prop "colors" on flcm\.gradient/);
  assert.throws(() => image("https://x/y.png", { scale: "FILL" } as never), /unknown prop "scale" on flcm\.image opts/);
  assert.throws(() => effects({ dropShadow: true } as never), /unknown prop "dropShadow" on flcm\.effects/);
});

test("a non-object where a props/query object belongs names THAT mistake, not the string's indices", async () => {
  // find refuses a bare string with steering (a query has no existence tiebreak, unlike a Target —
  // the ruling lives on read.ts's rejectStringQuery); the author's own value is echoed into the fix.
  await assert.rejects(find("TEXT" as never), (err: Error) => {
    assert.match(err.message, /flcm\.find takes a query object; got a string/);
    assert.match(err.message, /Did you mean flcm\.find\(\{ type: "TEXT" \}\)/);
    return true;
  });
  // Every other props bag rides the shared gate's non-object backstop; frame's array slip gets
  // its own steering (children are positional, so "fix your props" would misdiagnose it).
  assert.throws(() => rect("red" as never), /flcm\.rect takes an object \(props: .*— got "red"/s);
  assert.throws(() => frame([1, 2] as never), /children are the second argument/);
  // A present falsy non-object is malformed, not absence — `props ?? {}` (never `||`) is what
  // keeps false/0/"" flowing into the gate while null/undefined still mean "no props".
  assert.throws(() => frame(false as never), /flcm\.frame takes an object .*— got false/s);
  assert.throws(() => text([["s", false]] as never), /run\[0\] takes an object .*— got false/s);
  assert.doesNotThrow(() => rect(null as never));
});

test("nested authoring objects reject unknown keys with a path-threaded error", () => {
  assert.throws(() => frame({ layout: { mode: "row", flexWrap: "nowrap" } as never }), /unknown prop "flexWrap" on flcm\.frame\.layout/);
  assert.throws(() => text("hi", { textStyle: { fontVarient: "small-caps" } as never }), /unknown prop "fontVarient" on flcm\.text\.textStyle/);
  assert.throws(() => frame({ left: 1, anchor: { z: "left" } as never }), /unknown prop "z" on anchor/);
  assert.throws(() => frame({ pin: { z: "left" } as never }), /unknown prop "z" on pin/);
});

test("a run delta rejects an unknown key (the grounded silent-drop site), naming the run index", () => {
  // compileRun read a positive list and never looked at the rest — a typo'd word on a run just vanished.
  assert.throws(
    () => text(["ok", ["styled", { textTransfrom: "uppercase" }] as never]),
    /unknown prop "textTransfrom" on flcm\.text run\[1\]/,
  );
});

test("the CSS effects bag (a node's `effects:` prop) rejects an unknown key too — surface-wide policy", () => {
  // parseCssEffects reads a positive list, so a typo alongside a real CSS key would vanish silently.
  // The `effects:` prop takes BOTH vocabularies in one bag (a read `effects` carries CSS strings and
  // native-effect sugar at once), so the reject runs over their union and names `effects` — the place the
  // author wrote the typo — rather than whichever half the split happened to drop it into.
  const shadow = "0px 4px 8px rgba(0,0,0,0.25)";
  assert.throws(() => frame({ effects: { boxShadow: shadow, foo: 2 } as never }), /unknown prop "foo" on effects/);
  assert.throws(() => rect({ effects: { filter: "blur(4px)", bar: 1 } as never }), /unknown prop "bar" on effects/);
  // Both vocabularies in one bag still parse — the shape `get` hands back.
  assert.doesNotThrow(() => frame({ effects: { boxShadow: shadow, blur: 4 } }));
});

test("plural offenders are all named", () => {
  assert.throws(() => frame({ foo: 1, bar: 2 } as never), /unknown props "foo", "bar" on flcm\.frame/);
});

test("known props on every verb still construct (the reject is closed, not over-broad)", () => {
  // A representative spread of real props per verb — none should trip the reject.
  assert.doesNotThrow(() =>
    frame({ name: "n", width: 100, height: "hug", fill: "#fff", layout: { mode: "row", gap: 8, padding: 4 }, left: 1, top: 2, anchor: { x: "center" }, pin: { x: "left" } }),
  );
  assert.doesNotThrow(() => text("hi", { fill: "#000", textStyle: { fontSize: 14, fontWeight: "bold", textAlign: "center" } }));
  assert.doesNotThrow(() => text([["b", { fontWeight: "bold", color: "#f00", hyperlink: "https://x" }]]));
  assert.doesNotThrow(() => rect({ fill: "#fff", borderRadius: 4, strokeWidth: 1 }));
  assert.doesNotThrow(() => line({ stroke: "#000", width: 40, strokeWidth: 2 }));
  assert.doesNotThrow(() => path({ d: "M0 0 L1 1", fill: "#000" }));
  assert.doesNotThrow(() => svg('<svg viewBox="0 0 1 1"></svg>', { width: 24 }));
  assert.doesNotThrow(() => gradient({ type: "radial", stops: ["#000", "#fff"], at: { x: 50, y: 50 } }));
  assert.doesNotThrow(() => image("https://x/y.png", { scaleMode: "FIT", placeholder: true }));
  assert.doesNotThrow(() => effects({ shadow: true, blur: 4, glass: true }));
});
