/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Unknown-prop rejection (ratified decision 1): the authoring surface fails loud on an unknown prop —
// at the verb, before it touches the canvas. Pinned here:
// the REJECT FIRES loud, with the offender + path named, at every verb and nested object. (Schema and
// runtime word lists can't drift: both read vocabulary.ts, and schema.ts's exact-key check is a type.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock } from "../../harness/figma-mock.mjs";
import { render, gradient, image, effects, find } from "./runtime.js";
import { compileTree } from "./compile-tree.js";

createFigmaMock();

test("verbs reject an unknown top-level prop, naming it, the verb, and the node type's vocabulary", async () => {
  await assert.rejects(
    render({ type: "FRAME", background: "#fff" } as never),
    /flcm\.render: FRAME at spec: unknown prop "background" — a FRAME takes only /,
  );
  await assert.rejects(
    render({ type: "TEXT", text: "hi", textTransform: "upper" } as never),
    /spec: unknown prop "textTransform" — a TEXT takes only /,
  );
  await assert.rejects(
    render({ type: "RECTANGLE", radius: 4 } as never),
    /spec: unknown prop "radius" — a RECTANGLE takes only /,
  );
  await assert.rejects(render({ type: "LINE", height: 10 }), /spec: unknown prop "height" — a LINE takes only /);
  await assert.rejects(
    render({ type: "VECTOR", d: "M0 0 L1 1", borderRadius: 2 }),
    /spec: unknown prop "borderRadius" — a VECTOR takes only /,
  );
  assert.throws(
    () => gradient({ type: "linear", stops: ["#000", "#fff"], colors: [] } as never),
    /flcm\.gradient: unknown prop "colors" — the props here are /,
  );
  assert.throws(
    () => image("https://x/y.png", { scale: "FILL" } as never),
    /flcm\.image: opts: unknown prop "scale"/,
  );
  assert.throws(
    () => effects({ dropShadow: true } as never),
    /flcm\.effects: unknown prop "dropShadow"/,
  );
});

test("a non-object where a props/query object belongs names THAT mistake, not the string's indices", async () => {
  // find refuses a bare string with steering (a query has no existence tiebreak, unlike a Target —
  // the ruling lives on read.ts's rejectStringQuery); the author's own value is echoed into the fix.
  await assert.rejects(find("TEXT" as never), (err: Error) => {
    assert.match(err.message, /the query must be an object, not a string/);
    assert.match(err.message, /Did you mean flcm\.find\(\{ type: "TEXT" \}\)/);
    return true;
  });
  await assert.rejects(render("red" as never), /flcm\.render: spec: must be a node spec object/);
  await assert.rejects(render([1, 2] as never), /must be a node spec object/);
  await assert.rejects(render(false as never), /must be a node spec object/);
});

test("nested authoring objects reject unknown keys with a path-threaded error", async () => {
  await assert.rejects(
    render({ type: "FRAME", layout: { mode: "row", flexWrap: "nowrap" } as never }),
    /spec\.layout: unknown prop "flexWrap" — a FRAME's layout takes only /,
  );
  await assert.rejects(
    render({ type: "TEXT", text: "hi", textStyle: { fontVarient: "small-caps" } as never }),
    /spec\.textStyle: unknown prop "fontVarient"/,
  );
  await assert.rejects(
    render({ type: "FRAME", constraints: { z: "left" } as never }),
    /spec\.constraints: unknown prop "z"/,
  );
});

test("an svg VECTOR's layout typo rejects exactly like a RECTANGLE's", () => {
  const layout = { alignSelff: "stretch" };
  assert.throws(() => compileTree({ type: "RECTANGLE", layout }, "flcm.render"), /flcm\.render\.layout: unknown prop "alignSelff" — a RECTANGLE's layout/);
  assert.throws(() => compileTree({ type: "VECTOR", svg: "<svg></svg>", layout }, "flcm.render"), /flcm\.render\.layout: unknown prop "alignSelff" — a VECTOR's layout/);
});

test("a run delta rejects an unknown key, naming the run index", async () => {
  await assert.rejects(
    render({ type: "TEXT", text: ["ok", ["styled", { textTransfrom: "uppercase" }] as never] }),
    /spec\.text\[1\]\[1\]: unknown prop "textTransfrom"/,
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
    /spec\.effects: unknown prop "foo"/,
  );
  await assert.rejects(
    render({ type: "RECTANGLE", effects: { filter: "blur(4px)", bar: 1 } as never }),
    /spec\.effects: unknown prop "bar"/,
  );
  // Both vocabularies in one bag still parse — the shape `get` hands back.
  await assert.doesNotReject(render({ type: "FRAME", effects: { boxShadow: shadow, blur: 4 } }));
});

test("plural offenders are all named", async () => {
  await assert.rejects(
    render({ type: "FRAME", foo: 1, bar: 2 } as never),
    /spec: unknown props "foo", "bar" — a FRAME takes only /,
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
      constraints: { x: "left" },
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
