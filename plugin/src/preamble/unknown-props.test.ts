import { render } from "./render.js";
// Unknown-prop rejection (ratified decision 1): the authoring surface fails loud on an unknown prop —
// at the verb, before it touches the canvas. Two
// concerns pinned here:
//   1. The tier-2 DRIFT GUARD — each runtime KNOWN_KEYS group equals Object.keys of its schema FIELD_GROUP.
//      The runtime sets can't be sourced from schema.ts's zod (it must never enter the QuickJS bundle — the
//      purity gate), so they're hand-mirrored; this test is what keeps them honest when a prop is added.
//   2. The REJECT FIRES loud, with the offender + path named, at every verb and nested object.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import {
  KNOWN_KEYS,
  DIRECTIONAL_KEYS,
  BINDING_FIELD_KEYS,
  NODE_KEYS_BY_TYPE,
  gradient,
  image,
  effects,
} from "./flcm.js";
import { find } from "./read.js";
import {
  FIELD_GROUPS,
  SizeSchema,
  FrameSchema,
  TextSchema,
  ShapeSchema,
  EllipseSchema,
  LineSchema,
  InstanceSchema,
} from "./schema.js";

createFigmaMock();

test("compiler key sets match the complete prop schemas", () => {
  const schemas = {
    FRAME: FrameSchema,
    TEXT: TextSchema,
    RECTANGLE: ShapeSchema,
    ELLIPSE: EllipseSchema,
    LINE: LineSchema,
    INSTANCE: InstanceSchema,
  };
  assert.deepEqual(Object.keys(NODE_KEYS_BY_TYPE).sort(), Object.keys(schemas).sort());
  for (const type of Object.keys(schemas) as (keyof typeof schemas)[]) {
    assert.deepEqual(
      [...NODE_KEYS_BY_TYPE[type]].sort(),
      Object.keys(schemas[type].shape).sort(),
      type,
    );
  }
});

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
  const anchorShape = (
    SizeSchema as unknown as { shape: { anchor: { unwrap(): { shape: Record<string, unknown> } } } }
  ).shape.anchor.unwrap();
  assert.deepEqual([...DIRECTIONAL_KEYS].sort(), Object.keys(anchorShape.shape).sort());
  // `pin` reuses DIRECTIONAL_KEYS (z.custom — no zod shape to reflect on), so the anchor guard covers it too.
});

test("the binding bag's fields match their inline schema shape (drift guard)", () => {
  // componentPropertyReferences' fields are defined inline in BINDING_FIELDS, not as their own
  // FIELD_GROUP, so guard them by unwrapping the zod object — as the anchor guard above does. The
  // runtime holds them as PER-CONSTRUCTOR lists (a `slot` is a frame's word); their UNION is the set.
  const shape = (
    FrameSchema as unknown as {
      shape: { componentPropertyReferences: { unwrap(): { shape: Record<string, unknown> } } };
    }
  ).shape.componentPropertyReferences.unwrap();
  assert.deepEqual([...BINDING_FIELD_KEYS].sort(), Object.keys(shape.shape).sort());
});

test("verbs reject an unknown top-level prop, naming it and the verb", async () => {
  await assert.rejects(
    render({ type: "FRAME", background: "#fff" } as never),
    /unknown prop "background" on FRAME/,
  );
  await assert.rejects(
    render({ type: "TEXT", text: "hi", textTransform: "upper" } as never),
    /unknown prop "textTransform" on TEXT/,
  );
  await assert.rejects(
    render({ type: "RECTANGLE", radius: 4 } as never),
    /unknown prop "radius" on RECTANGLE/,
  );
  await assert.rejects(render({ type: "LINE", height: 10 }), /unknown prop "height" on LINE/);
  await assert.rejects(
    render({ type: "VECTOR", d: "M0 0 L1 1", borderRadius: 2 }),
    /unknown prop "borderRadius" on VECTOR/,
  );
  assert.throws(
    () => gradient({ type: "linear", stops: ["#000", "#fff"], colors: [] } as never),
    /unknown prop "colors" on flcm\.gradient/,
  );
  assert.throws(
    () => image("https://x/y.png", { scale: "FILL" } as never),
    /unknown prop "scale" on flcm\.image opts/,
  );
  assert.throws(
    () => effects({ dropShadow: true } as never),
    /unknown prop "dropShadow" on flcm\.effects/,
  );
});

test("a non-object where a props/query object belongs names THAT mistake, not the string's indices", async () => {
  // find refuses a bare string with steering (a query has no existence tiebreak, unlike a Target —
  // the ruling lives on read.ts's rejectStringQuery); the author's own value is echoed into the fix.
  await assert.rejects(find("TEXT" as never), (err: Error) => {
    assert.match(err.message, /flcm\.find takes a query object; got a string/);
    assert.match(err.message, /Did you mean flcm\.find\(\{ type: "TEXT" \}\)/);
    return true;
  });
  await assert.rejects(render("red" as never), /plain node spec/);
  await assert.rejects(render([1, 2] as never), /plain node spec/);
  await assert.rejects(render(false as never), /plain node spec/);
});

test("nested authoring objects reject unknown keys with a path-threaded error", async () => {
  await assert.rejects(
    render({ type: "FRAME", layout: { mode: "row", flexWrap: "nowrap" } as never }),
    /unknown prop "flexWrap" on FRAME\.layout/,
  );
  await assert.rejects(
    render({ type: "TEXT", text: "hi", textStyle: { fontVarient: "small-caps" } as never }),
    /unknown prop "fontVarient" on TEXT\.textStyle/,
  );
  await assert.rejects(
    render({ type: "FRAME", left: 1, anchor: { z: "left" } as never }),
    /unknown prop "z" on anchor/,
  );
  await assert.rejects(
    render({ type: "FRAME", pin: { z: "left" } as never }),
    /unknown prop "z" on pin/,
  );
});

test("a run delta rejects an unknown key, naming the run index", async () => {
  await assert.rejects(
    render({ type: "TEXT", text: ["ok", ["styled", { textTransfrom: "uppercase" }] as never] }),
    /unknown prop "textTransfrom" on TEXT run\[1\]/,
  );
});

test("the CSS effects bag rejects unknown keys", async () => {
  // parseCssEffects reads a positive list, so a typo alongside a real CSS key would vanish silently.
  // The `effects:` prop takes BOTH vocabularies in one bag (a read `effects` carries CSS strings and
  // native-effect sugar at once), so the reject runs over their union and names `effects` — the place the
  // author wrote the typo — rather than whichever half the split happened to drop it into.
  const shadow = "0px 4px 8px rgba(0,0,0,0.25)";
  await assert.rejects(
    render({ type: "FRAME", effects: { boxShadow: shadow, foo: 2 } as never }),
    /unknown prop "foo" on effects/,
  );
  await assert.rejects(
    render({ type: "RECTANGLE", effects: { filter: "blur(4px)", bar: 1 } as never }),
    /unknown prop "bar" on effects/,
  );
  // Both vocabularies in one bag still parse — the shape `get` hands back.
  await assert.doesNotReject(render({ type: "FRAME", effects: { boxShadow: shadow, blur: 4 } }));
});

test("plural offenders are all named", async () => {
  await assert.rejects(
    render({ type: "FRAME", foo: 1, bar: 2 } as never),
    /unknown props "foo", "bar" on FRAME/,
  );
});

test("known props on every node type render", async () => {
  // A representative spread of real props per verb — none should trip the reject.
  await assert.doesNotReject(
    render({
      type: "FRAME",
      name: "n",
      width: 100,
      height: "hug",
      fill: "#fff",
      layout: { mode: "row", gap: 8, padding: 4 },
      left: 1,
      top: 2,
      anchor: { x: "center" },
      pin: { x: "left" },
    }),
  );
  await assert.doesNotReject(
    render({
      type: "TEXT",
      text: "hi",
      fill: "#000",
      textStyle: { fontSize: 14, fontWeight: "bold", textAlign: "center" },
    }),
  );
  await assert.doesNotReject(
    render({
      type: "TEXT",
      text: [["b", { fontWeight: "bold", color: "#f00", hyperlink: "https://x" }]],
    }),
  );
  await assert.doesNotReject(
    render({ type: "RECTANGLE", fill: "#fff", borderRadius: 4, strokeWidth: 1 }),
  );
  await assert.doesNotReject(render({ type: "LINE", stroke: "#000", width: 40, strokeWidth: 2 }));
  await assert.doesNotReject(render({ type: "VECTOR", d: "M0 0 L1 1", fill: "#000" }));
  await assert.doesNotReject(
    render({ type: "VECTOR", svg: '<svg viewBox="0 0 1 1"></svg>', width: 24 }),
  );
  assert.doesNotThrow(() =>
    gradient({ type: "radial", stops: ["#000", "#fff"], at: { x: 50, y: 50 } }),
  );
  assert.doesNotThrow(() => image("https://x/y.png", { scaleMode: "FIT", placeholder: true }));
  assert.doesNotThrow(() => effects({ shadow: true, blur: 4, glass: true }));
});
