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
import { render, edit, gradient, image, effects, find } from "./runtime.js";
import { compileTree } from "./compile-tree.js";

const figma = createFigmaMock();

test("verbs reject an unknown top-level prop, naming it, the verb, and where the node type's props are listed", async () => {
  await assert.rejects(
    render({ type: "FRAME", shimmer: true } as never),
    /flcm\.render: FRAME at spec: unknown prop "shimmer" — every prop a FRAME takes is in the "props" section of the flcm reference\./,
  );
  await assert.rejects(
    render({ type: "TEXT", text: "hi", textTransform: "upper" } as never),
    /spec: "textTransform" goes in textStyle: \{ textStyle: \{ textTransform: … \} \}\./,
  );
  await assert.rejects(
    render({ type: "RECTANGLE", radius: 4 } as never),
    /spec: unknown prop "radius" — did you mean "borderRadius"\? Every prop a RECTANGLE takes/,
  );
  await assert.rejects(render({ type: "LINE", height: 10 }), /spec: a LINE doesn't take the prop "height"; drop it\. Every prop a LINE takes/);
  await assert.rejects(
    render({ type: "VECTOR", d: "M0 0 L1 1", borderRadius: 2 }),
    /spec: a VECTOR doesn't take the prop "borderRadius"; drop it\. Every prop a VECTOR takes/,
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
    /spec\.layout: unknown prop "flexWrap" — did you mean "wrap"\? Every prop a FRAME's layout takes is in the "props" section/,
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
  assert.throws(() => compileTree({ type: "RECTANGLE", layout }, "flcm.render"), /flcm\.render\.layout: unknown prop "alignSelff" — did you mean "alignSelf"\? Every prop a RECTANGLE's layout takes/);
  assert.throws(() => compileTree({ type: "VECTOR", svg: "<svg></svg>", layout }, "flcm.render"), /flcm\.render\.layout: unknown prop "alignSelff" — did you mean "alignSelf"\? Every prop a VECTOR's layout takes/);
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
    /spec: unknown props "foo", "bar" — every prop a FRAME takes/,
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

// A long vocabulary dumped into an error buries the one word the agent needed, so the refusal names
// the closest word and points at the reference section that lists the rest.
test("a misspelled prop gets its closest word, not the whole vocabulary, at create and at edit", async () => {
  // An edit's words are judged before its target resolves, so its refusal can't yet say "a FRAME".
  const misspelled = (err: Error) => {
    assert.match(err.message, /unknown prop "fil" — did you mean "fill"\? Every prop (a FRAME takes|here) is in the "props" section of the flcm reference\./);
    assert.doesNotMatch(err.message, /"stroke"/);
    return true;
  };
  await assert.rejects(render({ type: "FRAME", fil: "#fff" } as never), misspelled);
  await render({ type: "FRAME", key: "typo" });
  await assert.rejects(edit("typo", { fil: "#fff" } as never), misspelled);
});

test("a short closed set is listed in full, since it is the whole answer", () => {
  assert.throws(
    () => gradient({ type: "linear", stops: ["#000", "#fff"], angel: 90 } as never),
    /flcm\.gradient: unknown prop "angel" — did you mean "angle"\? The props here are "type", "stops", "angle", "at"\./,
  );
});

test("a word another node type takes refuses at edit in the same shape as at create", async () => {
  await render({ type: "RECTANGLE", key: "box" });
  const refusal = /a RECTANGLE doesn't take the prop "fontSize"; drop it\. Every prop a RECTANGLE takes is in the "props" section of the flcm reference\./;
  await assert.rejects(edit("box", { fontSize: 12 } as never), refusal);
  await assert.rejects(render({ type: "RECTANGLE", fontSize: 12 } as never), refusal);
});

// Edit's type-blind gate leaves every node word to the typed prelude, which knows the target: a
// nested word isn't sent to a bag the type lacks, nor a create-only word given another type's reason.
test("a node word refuses at edit exactly as at create, judged by the target's own type", async () => {
  await render({ type: "RECTANGLE", key: "plate" });
  for (const word of ["lineHeight", "padding"]) {
    const refusal = new RegExp(`a RECTANGLE doesn't take the prop "${word}"; drop it\\. Every prop a RECTANGLE takes`);
    await assert.rejects(edit("plate", { [word]: 2 } as never), refusal);
    await assert.rejects(render({ type: "RECTANGLE", [word]: 2 } as never), refusal);
  }
  await render({ type: "FRAME", key: "panel" });
  await assert.rejects(edit("panel", { d: "M0 0" } as never), (err: Error) => {
    assert.match(err.message, /a FRAME doesn't take the prop "d"; drop it\./);
    assert.doesNotMatch(err.message, /path geometry/);
    return true;
  });
});

test("a misspelled word leads its own sentence, and a nested bag's word is offered by its bag", async () => {
  await assert.rejects(
    render({ type: "FRAME", component: true, propertyDefinitions: {} } as never),
    /spec: unknown prop "component" — every prop a FRAME takes is in the "props" section of the flcm reference\. A FRAME doesn't take the prop "propertyDefinitions"; drop it\./,
  );
  await assert.rejects(render({ type: "FRAME", paddng: 2 } as never), /unknown prop "paddng" — did you mean "padding" \(in layout\)\?/);
});

// The mistakes agents make most are real flcm words in the wrong place. Spelled against the gated set
// alone they drew a wrong "fix" (lineHeight → minHeight), so the vocabulary places them first.
test("a word a nested bag takes is sent there, at create and at edit, instead of spelled as a typo", async () => {
  const toTextStyle = (word: string) => (err: Error) => {
    assert.match(err.message, new RegExp(`"${word}" goes in textStyle: \\{ textStyle: \\{ ${word}: … \\} \\}\\.`));
    assert.doesNotMatch(err.message, /did you mean/);
    return true;
  };
  await assert.rejects(render({ type: "TEXT", text: "hi", lineHeight: 1.5 } as never), toTextStyle("lineHeight"));
  await assert.rejects(render({ type: "TEXT", text: "hi", fontWeight: 700 } as never), toTextStyle("fontWeight"));
  await render({ type: "TEXT", text: "hi", key: "copy" });
  await assert.rejects(edit("copy", { lineHeight: 2 } as never), toTextStyle("lineHeight"));
  await assert.rejects(
    render({ type: "FRAME", padding: 8, gap: 4 } as never),
    /spec: "padding" goes in layout: \{ layout: \{ padding: … \} \}\. "gap" goes in layout: \{ layout: \{ gap: … \} \}\.(?! Every)/,
  );
});

test("a real word this node type doesn't take is refused as that, with the drop-it step", async () => {
  await assert.rejects(
    render({ type: "TEXT", text: "hi", strokeWidth: 1 } as never),
    /spec: a TEXT doesn't take the prop "strokeWidth"; drop it\. Every prop a TEXT takes is in the "props" section/,
  );
  // A container layout word on a node that only sits in a flow is not sent to a layout it lacks.
  await assert.rejects(render({ type: "RECTANGLE", padding: 4 } as never), /spec: a RECTANGLE doesn't take the prop "padding"; drop it\./);
});

test("a one-letter word is matched only whole, so a pad side's initial isn't 'corrected' to x", async () => {
  await assert.rejects(render({ type: "FRAME", layout: { mode: "row", padding: { t: 4 } as never } }), (err: Error) => {
    assert.match(err.message, /spec\.layout\.padding: unknown prop "t" — the props here are /);
    assert.doesNotMatch(err.message, /did you mean/);
    return true;
  });
});

test("an edit-only type's words are pointed at the edit section, where they are listed", async () => {
  const component = figma.createComponent();
  figma.currentPage.appendChild(component);
  await assert.rejects(edit(component.id, { text: "x" } as never), /a COMPONENT doesn't take the prop "text"; drop it\. Every prop a COMPONENT takes is in the "edit" section/);
});

test("CSS and Figma spellings are told the flcm word, at create and at edit alike", async () => {
  await render({ type: "FRAME", key: "moved" });
  await assert.rejects(edit("moved", { x: 4 } as never), /"x" is no flcm word: position is not spelled with bare x\/y — use `left`\/`top`/);
  await assert.rejects(render({ type: "FRAME", y: 4 } as never), /"y" is no flcm word: position is not spelled with bare x\/y/);
  await assert.rejects(render({ type: "TEXT", text: "hi", color: "#000" } as never), /"color" is no flcm word: .*`fill`/);
  // Words sharing one explanation are named in one clause, so the sentence is said once.
  await assert.rejects(edit("moved", { x: 1, y: 2 } as never), (err: Error) => {
    assert.match(err.message, /"x", "y" are no flcm words: position is not spelled/);
    assert.equal(err.message.split("position is not spelled").length, 2);
    return true;
  });
});
