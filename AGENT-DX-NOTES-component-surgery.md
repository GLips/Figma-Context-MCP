# flcm / figma-mcp — agent DX notes, component-surgery workload

Written by Claude (Opus 5, `claude-opus-5[1m]`) during and immediately after the session, not from
reading the code — then pressure-tested against the source and by a Codex review, which corrected
several claims. Corrections are marked where they land.

**Transcript:**
`/Users/graham/.claude/projects/-Users-graham-Programming-clients-fodzyme-fodmap-scanner-app/f1567989-70e0-4356-89d0-921e74509435.jsonl`
(session `f1567989-70e0-4356-89d0-921e74509435`, 50,915,177 bytes, spanning several compactions —
the design work starts well before the portion I can still see directly).
**Codex review session:** `01a0a716-6f90-7a72-9c9e-25a0b471a835`.

Every item is a real event in that file — the script I ran, what came back, what the human said.
**Go read it rather than trusting a summary.** Probes run afterward to check a claim are marked as
probes.

**Items marked `[HUMAN REVIEWED]`** were worked through with Graham in conversation and have a
solution he shaped. That is a record of what has been discussed, not a sign-off — each still wants
his check before it goes out for implementation. Unmarked items he has not seen discussed.

**The task:** designing the FODMAP Scanner mobile app in Figma, page `4969:11701`, file
`ZqwdZDd71wSRUhOZb7zCOu`. A `Page header` component with eight properties and a slot; re-bodying a
live `Tab bar` that 23 instances already depended on; folding it into a variant set; converting five
approved result screens onto the new header. **331 `figma_execute_code` calls, 102 `get_screenshot`,
12 `get_flcm_reference`**, across roughly a working day.

This differs from [`AGENT-DX-NOTES-mobile.md`](AGENT-DX-NOTES-mobile.md) (screens from scratch) and
[`AGENT-DX-NOTES-slots.md`](AGENT-DX-NOTES-slots.md) (slot mechanics) in one way that turns out to
matter: almost nothing here was a fresh render. It was **surgery on live nodes** — read a thing,
work out how it is held together, change part of it, keep every instance downstream working. That
path is dominated by the _read_ vocabulary, and that is where the findings cluster.

The headline: **the conceptual half of the documentation never reached me, and the read output
taught me the raw API instead.** Both have single, fixable causes. Everything else here is smaller
than those two.

---

## 1. The mental model ships only to an agent that asks for nothing

**Impact: high. Cost: low. `[HUMAN REVIEWED]`.**

I filed two findings that were both wrong, and chasing why produced the best item in this document.

I claimed the root-id-moves-children trap was undocumented. It is documented, in `narrative.ts`, in
the exact words I needed:

> "To create a data copy, remove the ids from every node you want copied, including slot content in
> overrides. **Removing only the root id creates a new root and moves its id-bearing children.**"

I claimed `session` appears only twice in the reference, both times holding a node id. There is a
full **"Session across calls"** section that says _"Save specs, constants, SVG markup and looked-up
ids in session"_ — precisely the thing I spent a day not doing.

Both live in `MENTAL_MODEL`, which `src/mcp/tools/flcm-docs/reference.ts` emits in exactly two
places:

```js
function indexBody(): string {          // get_flcm_reference()  ← no arguments
  return `# flcm reference\n\n${MENTAL_MODEL}\n\n## Sections\n\n…`;
}
export function buildFullReference(): string {   // the committed repo doc, not served per call
  return `# Authoring with \`flcm\`\n\n${MENTAL_MODEL}\n\n${body}\n`;
}
```

I called `get_flcm_reference` twelve times. **Every call named sections.** I never received the
index, so I never received the mental model.

That is the delivery shape: **the conceptual content ships only to the caller who asks for nothing,
and an agent asks for nothing only before it knows what it is doing.** By the time you know you need
the rules about identity and copying, you are naming `structure` and `components` — and those
sections do not carry them. The better you get at using the tool, the less of its most important
page you see.

**Suggestion:** put `MENTAL_MODEL`, or a compressed form of it, at the head of **every** named
section response. It is the part that stops an agent being wrong about what a spec _is_, and it is
currently the only part a working agent never sees.

**This is the root cause of several items below**, which is why they are short: §3 and the session
half of §8 are both "I did not know a documented rule", and both fix here.

---

## 2. A targeted read has no parent, so it loses size and position together

**Impact: high. Cost: medium. `[HUMAN REVIEWED]` — direction agreed.**

`flcm.get(target)` on a node returns a different shape than the same node read as a child of its
parent. Read directly:

```json
{
  "id": "4984:24330",
  "name": "scrim",
  "type": "RECTANGLE",
  "width": "contextual",
  "height": "contextual",
  "designedWidth": "402px",
  "designedHeight": "94px",
  "pin": { "x": "stretch", "y": "stretch" }
}
```

The **same node** as `parent.children[0]`:

```json
{
  "id": "4984:24330",
  "name": "scrim",
  "type": "RECTANGLE",
  "width": 402,
  "height": 94,
  "position": "absolute",
  "left": 0,
  "top": 0,
  "pin": { "x": "stretch", "y": "stretch" }
}
```

**One cause for both losses** (Codex located it): `get` snapshots the target alone and calls
`simplify([snapshot])`, so the core treats it as a read root with no real parent. Fixed axes collapse
to `"contextual"`; emitting `position`/`left`/`top` needs parent context there is none of. Real
`"fill"` and `"hug"` survive — so "every targeted read rewrites sizes" was overstated; it is fixed
sizes that go.

**What it cost.** Every time I read a node to find out how it was positioned, flcm answered in
Figma's words and hid its own — `readOnlySource` sits in the same payload carrying `constraints`,
`absoluteBoundingBox` and `ownOrigin`. So I wrote `node.constraints = {...}` and
`node.layoutPositioning = 'ABSOLUTE'` through `figma.getNodeByIdAsync` dozens of times, for a header
whose entire design is absolute + stretch children. Session raw-API counts: `getNodeByIdAsync` ~190,
`layoutPositioning` 19, `constraints =` 12, `appendChild` 25, `.fills =` 11.

The `verify` section says it plainly: _"**Author with `flcm`** … \*\*Drop to `figma._`\*_ for … viewport,
selection, and other document rather than design operations."_ Correct instruction, beaten by the
read output on every call.

**`"contextual"` is writable — but only whole.** My first draft said it could not be written back at
all. Wrong, and the correction sharpens the finding:

```js
width: "contextual", designedWidth: "402px"   // normalizes to width: "402px"  ✓
width: "contextual"                           // width is deleted              ✗
```

A complete read carries its own fallback. Pull one field out — which is what anyone does to change
one thing — and the fallback is gone, the value is silently stripped, and you are told _"the changes
object is empty — nothing to apply."_ A value that survives only if you carry the whole object around
is a trap for the most ordinary edit there is.

The motivation is good, and worth recording in Graham's words:

> "The main issue the contextual label is meant to address is when a user copies some top-level
> frame, it always has this absolute value … agents are always implementing the designs with exactly
> those dimensions. And so you get like web pages that instead of being responsive are just this
> hard-coded thing, and they look really bad, and it's clearly not the designer's intent."

**Suggestion (agreed direction):** give targeted authoring reads their real parent context, so they
return numeric sizes plus `position`/`left`/`top` like the child-scoped read already does. Keep
"don't hardcode this" as advice _beside_ the geometry rather than _instead of_ it. Reject a bare
`"contextual"` by name rather than stripping it — making it a silent no-op would only relocate the
silence. One caveat from the review: whatever the advice field is called, it should not claim to know
design intent the runtime cannot see. Page-root status is evidence, not proof.

---

## 3. A spec with a new parent and live children silently dismantles the source

**Impact: high — the only finding here that takes apart existing work. Cost: low. `[HUMAN REVIEWED]`.**

Probe. Build a frame with two text children, delete **only the root id**, append the result
elsewhere:

```js
const spec = clean(live);
delete spec.id; // root: create
spec.children = spec.children.map(clean); // children: keep their live ids
await flcm.append(flcm.id(dest.id), spec);
```

```json
{ "SRC_children_after": [], "DEST_children_after": ["SRC:4989:24378"] }
```

The original frame is **empty**. Its two text nodes were relocated into the copy. No error, no
warning.

The trap is that stripping the root id is the natural way to say "make a copy" — it is what makes the
root create instead of move, so you assume that is the whole story. The children quietly do the
opposite. Underneath it, one data shape answers two different questions:

```js
{ type: "FRAME", width: 200 }        // "make something like this"
{ id: "4989:24375", width: 200 }     // "that exact node, change its width"
```

Elegant — it is why there is no separate move verb. But the meaning is _per node_, and a tree shows
no sign of the mix. Mine read as "a frame with two text children" and meant "make an empty frame,
then take those two nodes out of wherever they live."

**Two corrections to my first draft.** The behaviour is documented (§1 — I never received that page).
And a blanket refusal would be wrong: the mix is supported and tested, because wrapping existing
content needs exactly this shape — `{ type: "FRAME", children: [{ id: existing.id }] }`.

**Suggestion (agreed):** no new verb. Require live descendants under a **newly created** node to
state the intent — an explicit word on the spec — and have the refusal name it. Check every new
subtree, not only the outermost root. Wrapping stays one shape that works for one node or ten; the
only change is that you now have to mean it.

We considered a dedicated `wrap` verb and rejected it. Graham's reason generalises past this item:
_"If we have explicit wrap that only supports partial wrapping, agents will get the illusion of
completeness — that that's all they can do with it."_ A verb covering the easy half teaches a false
ceiling, which is the failure mode in §1, §9 and §14.

Describe the damage as **dismantling** the source, not destroying it. The nodes are relocated, not
deleted.

---

## 4. Writes outlive the reply

**Impact: high — silent, and it undermines every screenshot. Cost: medium. `[HUMAN REVIEWED]`.**

Derived from the source in review; I verified it live, in the shape that is nobody's mistake:

```js
let err = null;
try {
  await Promise.all([
    flcm.edit(flcm.id("0:0"), { name: "nope" }),                  // rejects fast
    flcm.render({ type: "FRAME", name: "QUEUED-SURVIVOR", … }),   // sibling verb
  ]);
} catch (e) { err = String(e.message || e); }
return { caught: err };          // → "Input must be a valid number"
```

Next call:

```js
await flcm.find({ name: "QUEUED-SURVIVOR" }); // → ["4990:24380"]
```

The batch rejected, I caught the error and returned, and the sibling `render` **still landed**. An
unawaited verb behaves the same way: return immediately, and the write shows up afterward.

Nothing in the response says work is outstanding. Two consequences that matter more than a stray
node:

- **Screenshots become unreliable.** The project rule I work under is _"do not ship UI you have not
  seen"_, so I shoot immediately after a write. If the file is still moving, I am reviewing a
  half-finished frame and calling it good.
- **Cancellation has a hole.** Stop targets a run that has already reported itself finished, so there
  is a window where nothing is listening and writes continue.

**Suggestion (agreed):** drain the verb queue before replying. Where that is not possible, report
what is still outstanding — `pending: 1` beats silence.

---

## 5. Instance child edits are dropped without ever being compared

**Impact: high — silent wrong output on an ordinary edit. Cost: low. `[HUMAN REVIEWED]`.**

`plugin/src/preamble/compile-tree.ts:53`:

```js
const children =
  type === "INSTANCE" && inheritedChildren(id, readChildren, at) ? undefined : readChildren;
```

If the node is an instance and its children are the inherited echo, `children` is discarded —
**without comparing what you passed against what the component says.** Read an instance, change a
word in a nested text, write the tree back: the edit goes in the bin. No error.

Editing works by the documented routes — `flcm.edit(sublayerId, { text })`, or
`overrides: { "11:9": { text } }`. What silently fails is read-modify-write on the whole tree, which
is the natural move and the one surgery invites.

**Suggestion (agreed):** compare the passed children against the component's before discarding. Where
they differ, convert to an override — the path and the delta are both already in hand. Refuse loudly
where conversion is not possible.

---

## 6. `pin: "stretch"` resizes the node you just authored

**Impact: high — silent wrong output. Cost: low (bug). `[HUMAN REVIEWED]`** — Graham, in session: _"I'm unaware
of anything intentional here."_

Probe, four cases, each authoring a 200×100 absolute child inside a 200×100 frame:

| case                                  | authored | got         |
| ------------------------------------- | -------- | ----------- |
| no pin, no padding                    | 200×100  | 200×100 ✓   |
| `pin: { x: "stretch", y: "stretch" }` | 200×100  | **300**×100 |
| no pin, padding 8                     | 200×100  | 200×100 ✓   |
| `pin` stretch + padding 8             | 200×100  | **300×84**  |

The width becomes **300** — not the parent's 200, not the content box's 184, a number with no
relationship to the call. The height becomes the parent's content box (100 − 8 − 8), which an
absolutely-positioned child should not be subject to.

The only signal is `[warn] flcm.render: overflow in 1 containers … Write succeeded.`, which names the
container and reports success. §11 explains why nothing else could have told me: the return value
echoed my 200×100 back.

---

## 7. There is no authored form for a paint stack

**Impact: medium-high. Cost: feature work. `[HUMAN REVIEWED]`** — Graham, in session: _"I definitely think we
should support paint stacks. The fact that we don't is a real oversight for sure."_

```
Error: flcm: fill has 2 stacked paints, and flcm paints one — there is no authored form for a
paint stack. Pass the single paint you want, or duplicate the node with flcm.clone to keep the
stack.
```

The case that hits it is the most common composite in mobile design: **a photograph with a
legibility scrim over it.** All five of this app's result screens are an IMAGE fill plus a
`GRADIENT_LINEAR` fill on one node. I did it with raw `node.fills = [imagePaint, gradientPaint]`.

The suggested escape does not fit. `flcm.clone` preserves a stack you already have; the operation you
want is "this instance shows _this_ photo" — editing one paint inside a stack the component defines,
which clone cannot express.

**Decided in session 2026-09-15 `[HUMAN APPROVED]`:** `fill: [paint, paint, …]` and the same for
`stroke`, **top-first — CSS order, identical to what `get` returns.** The first entry paints on top,
so a read pastes back unchanged; the write reverses on the way into Figma, which stores the stack
bottom-first. Bottom-first authoring (the original suggestion, Figma's order) is rejected: it would
give reads and writes opposite orders for the same array. The scrim example is
`fill: [flcm.gradient({...}), flcm.image(url)]`. The refusal's clone remedy is deleted — it never
fit; the message becomes the stack form itself. `overrides[path].fill` takes the same array, so
"this instance shows _this_ photo" is an override on the image entry.

**Landed `d006833`.** The read side was already top-first with a lone paint emitted bare, so no
goldens moved. Order is known in two functions, one per direction (`compilePaintWord`,
`bridge.toFigmaPaintStack`). It also exposed a bug: image provenance was stamped from entry 0, so a
scrim over a photo would have wiped the photo's source; it now follows the topmost url-backed image.

---

## 8. `session`, `to`, and per-run runtimes

**Impact: medium-high. Cost: medium (redesign, not a patch). `[HUMAN REVIEWED]` — fix the run-binding
regardless of what happens to functions.**

I used `session` heavily and it never failed. **25 keys survived the whole working day and several
compactions.** It deep-copies on write, so a stored value cannot be corrupted by later mutation of
its source, and its refusals name the exact offending path. The reliability was total.

Every key held a **node id**, a flag, or an index path. What I never put in it is the thing I retyped
all day:

```js
const INK="#313F27", INK2="#5A6457", SURF="#FFFDEA", BORDER="#DDDFCA", THUMB="#EFEDE0";
const t=(text,size,weight,color,extra={})=>({type:"TEXT",text,fill:color,textStyle:…});
const NOPIC={type:"VECTOR",d:"M10.41 10.41a2 2 0 1 1-2.83-2.83…"};
```

Dozens of near-identical preambles. That costs context in a session that compacted repeatedly, and it
drifts: the same "no picture" glyph appears in the transcript three ways — a `d` at 20×20, the same
`d` at 24×24, and a full `<svg>` with different geometry. **Two carry §10's bbox-stretch bug**,
because each was retyped rather than reused.

The reference already tells agents to do better (_"Save specs, constants, SVG markup and looked-up
ids in session"_). It never reached me — that is §1 — and Graham's framing is the one that section
should lead with:

> "It seems like such a powerful primitive to have nearly a REPL available to you."

**On functions.** `session` refuses them. I first called that artificial, having proved a closure
survives across requests on `globalThis`. The real reason is in `code.ts:767` — `flcm` is rebuilt per
request over a host closing over `to` (`{ id, connKey }`, the reply address), so a stored function
holds a **dead request's** `flcm`. I verified a stale `flcm` still reads and writes from a later
request.

Corrected damage list, after review:

| Claim                                   | Verdict                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| Bypasses the current run's cancellation | **Yes** — and cancellation is cooperative, so say "bypasses the cooperative checks" |
| `flcm.image()` hangs                    | **No** — the server replies `IMAGES_ERROR` for finished runs                        |
| Reads register into the stale egress    | **Yes**, but the effect is bypassed projection and larger output                    |
| Only the `to` closures matter           | **No** — each runtime also owns its **mutation queue**, plus counters and caches    |

That last row is the one I missed, and it is the biggest. Mixing a stale and a current `flcm` means
two queues and no shared lock, which bypasses the intended whole-verb serialization.

**`to` itself is not broken** — `reply(to, body)` must answer the request that asked, and that is
inherently per request. It is _over-applied_: three host methods bake in their own run where they
should ask which run is executing.

```js
isRunCancelled: () => cancelledRuns.isCancelled(to); // should be: the run I'm inside
requestImages: (urls) => requestServerImages(to, urls); // should be: whoever is executing
registerRead: egress.registerRead; // should be: the executing run's egress
```

**Suggestion (agreed):** fix the run-binding regardless of what happens to functions. Heed the
review's caution — this is tractable as a redesign, not as three closure replacements. A mutable
"current run" can misattribute unfinished work from one run to another (see §4: outstanding work is
already real), and the runtime ships per server request, so building it once needs a version policy.
The smaller containment fix is to **reject host-backed use after the originating run settles**, which
closes the hole without the redesign.

**My honest position on function storage: not worth building for its own sake.** Every helper I would
actually have stored is a pure spec builder that never touches `flcm`; storing it as a source string
and rebuilding it already works, and is the _correct_ pattern rather than a workaround — indirect
`eval` does not capture the caller's lexical scope, so the rebuilt function closes over the current
request. If the run-binding gets fixed, function support follows nearly free. Not the other way
round.

**`globalThis` is an inconsistency, not a hole.** There is no attacker; the agent writes all the code.
But `session` refuses something as unsafe and `globalThis` allows it silently, so an agent that gets
refused, shrugs, and reaches for the nearest global lands on the cancellation gap with nothing
warning it. Fix the run-binding and there is nothing left to be inconsistent about.

---

## 9. The multi-child append exists, and it is spelled `render`

**Impact: medium-high. Cost: one clause.**

Asked to lay out a comparison board, I wrote eighteen sequential mutations — six raw reparents and
twelve separate `flcm.append` round-trips — because `append` takes one spec and I wanted twelve
children under one existing parent.

Two obvious forms are refused, with good messages. The third works:

```js
await flcm.render({ id: parent.id, children: [
  { type: "RECTANGLE", name: "a", … },
  { type: "RECTANGLE", name: "b", … },
] });                                   // → parent now has children ["a", "b"]
```

Exactly the semantics `structure` states. But `render`'s description is entirely about page placement
— _"Place on the current page"_, _"On a render root it is where on the PAGE the tree lands"_ — and
`append`, the verb whose **name** means add-a-child, is the singular one. I read `verbs` and
`structure` this session and came away believing twelve children meant twelve calls.

**Suggestion:** one clause in the `verbs` table's `render` row — _"With an id and `children`, adds
several children to a live node in one call."_ Highest value per character in the document, and it
replaces wording that currently misdirects rather than adding a page.

---

## 10. `d` plus an explicit `width`/`height` rescales the path's bounding box

**Impact: high — silent, and it disfigures artwork rather than breaking it, so it survives review.
Cost: low. `[HUMAN REVIEWED]`** — decided in session 2026-09-15.

Probe with Lucide's `chevron-left`, whose path occupies a 6×12 box on the 24 grid:

```js
flcm.render({ type: "VECTOR", d: "M15 18l-6-6 6-6", width: 24, height: 24, … })  // → 24×24
flcm.render({ type: "VECTOR", d: "M15 18l-6-6 6-6",                        … })  // →  6×12
```

The sized one is the same chevron stretched 4× horizontally and 2× vertically. No error, no warning,
and the return echoes the 24×24 I asked for (§11).

**What is actually wrong.** `width`/`height` on a VECTOR do what they do on every node: set the box.
A vector's box IS its geometry, so on a 6×12 path a 24×24 box can only mean "scale the art",
non-uniformly. Omitting them is already correct — the vector comes out at its path's natural box. The
instinct that adds them is "this icon lives on a 24 grid", which is a canvas, not a box. The domain
language for "a path on a canvas" is SVG with a `viewBox`, and flcm already has that word: `svg`
produces what Figma itself uses for an icon, a 24×24 frame with the vector inside. The agent avoided
it for one reason — colours are baked into the markup, so the result is not themeable. That is not
a Figma limit; `createNodeFromSvg` makes one VECTOR per shape, and flcm simply never touches them.

**Solution.**

1. **`svg` becomes themeable.** `fill` and `stroke` beside `svg` apply to every vector inside the
   frame, overriding the markup. The icon is then written in the syntax every agent already knows,
   with no bespoke word.
2. **`d` is bare geometry.** Its box is its path's bounding box. `width`/`height` on create are
   ignored — the node keeps its natural box — and the reply carries one warning naming the node and
   pointing at `scale` and `svg`. Not a refusal: the write the agent meant is the one that lands.
3. **`scale` on the path form.** `{ d, scale: 2 }` — a single number, uniform by construction, no
   bounding-box knowledge needed at create time. Resizing an existing vector stays what it is:
   `edit(id, { width, height })` scales the geometry, and on an edit the agent can see the current
   box so the intent is unambiguous.
4. **Verify live** whether `createNodeFromSvg` gives the inner vectors scale constraints. If it does
   not, flcm sets them, so `edit(icon, { width: 48, height: 48 })` scales the icon rather than
   leaving a 24px chevron floating in a 48px frame.

**Not the solution:** redefining VECTOR `width`/`height` as a viewport (changes the meaning of the
box on one type), a `viewBox` key on the path form (a bespoke word for a concept `svg` already
carries), or a heuristic that infers canvas-vs-scale from the path's coordinates.

**Landed `1a2f2d1`.** The IR now has one discriminated `WriteVectorSource` (`path` with `scale` |
`svg` markup), so `scale` has no home on the svg arm by construction and malformed `d` fails at
compile, not apply. Two calls the implementer made beyond the spec, both kept: `width: "fill"` on a
`d` vector is ignored too (the coherent rule is "the path form has no canvas"), and `scale`
multiplies the box, not the stroke (`{ d, scale: 2, strokeWidth: 2 }` means stroke 2). Known
costs: `get` of a hand-resized vector re-rendered without its id comes back at natural size with
the warning (`flcm.clone` is the faithful copy); `edit(svgImport, { fill })` still paints the frame,
because a live svg import is a plain FRAME. Figma's typings say nothing about `createNodeFromSvg`
constraints, so flcm sets SCALE on every descendant itself. `pnpm probe:vector` is the live check.

---

## 11. Placement verbs echo authored values, so a divergence cannot be reported

**Impact: high — this is why §6 and §10 are silent. Cost: medium.**

Documented, and I concede that up front. The verbs table says every placement verb _"Builds the spec
copied with ids on every node"_, and `render` spells out the consequence: _"Returned dimensions
remain the authored values; use measure for realized pixels."_ Both accurate.

```js
const r = await flcm.render({ … width: 200, height: 100, pin: { x: "stretch", y: "stretch" } … });
r.children[0]                                   // → { width: 200, height: 100 }
await flcm.measure(flcm.id(r.children[0].id))   // → { width: 300, height:  84 }
```

The return is my own input handed back with ids attached. It agrees with me perfectly and it is
wrong. No value in that payload can ever disagree with what I asked for, so a write that lands
differently is invisible unless I separately `measure` and compare by hand — which, across 331
writes, nobody does. Being told to use `measure` does not fix that: a contract only honoured by
distrusting every return value is not one an agent can act on at scale.

**Suggestion, narrowed after review:** keep authored intent in the returned spec; report observed
divergence _separately_. `divergences: [{ id, prop: "width", authored: 200, realized: 300 }]`, empty
on almost every call, makes the non-empty case impossible to miss. Some clamping diagnostics already
exist (`sizing-diagnostics.ts`) — this extends that channel rather than inventing one.

---

## 12. `readOnlySource` is four fifths of every read

**Impact: medium — context budget, and it is what teaches the raw vocabulary in §2. Cost: low.**

```js
JSON.stringify(full.node).length; // 2318
JSON.stringify(stripReadOnlySource(full.node)).length; //  461
```

Five times the payload, on a two-node tree. On the real `Page header` every read cost several
thousand tokens I discarded. This session compacted repeatedly, and reads of live structure were a
meaningful share of what filled the window. I wrote a strip helper by hand more than once, in
different scripts, having forgotten I wrote it in a compacted-away turn.

It also does the harm in §2: `readOnlySource` is where `constraints`, `layoutPositioning` and
`ownOrigin` are legible, so the block I always discard is the block that taught me to write raw
Figma.

**Suggestion:** `flcm.get(target, { source: true })`, off by default. Its stated purpose — preserving
decoded state beyond the authoring vocabulary — is a clone-and-audit concern, which is exactly where
asking for it explicitly is natural.

---

## 13. `editMany` is the one verb that does not take flcm's universal `{ id, …props }` shape

**Impact: medium. Cost: low.**

Seven sibling frames needing the same loosening. What I wrote, and what came back:

```js
await flcm.editMany([{ id: "4979:17241", layout: { mode:"column", alignSelf:"stretch", … } }, …]);
```

```
Error: flcm.editMany: 7 of 7 entries were rejected, so NOTHING was applied …
  [0] flcm: unknown props "id", "layout" on flcm.editMany's entry — takes only "target", "changes".
  [1] … identical …   (×7)
```

Five seconds later, shape fixed, the same seven entries rejected again for `alignSelf`.

**`{ id, …props }` is flcm's universal shape and `editMany` is the exception.** _"No id creates. An id
moves and edits that live node"_ is the rule for every placement verb and every nested child. I did
not guess `{ id, layout }` — the rest of the tool taught it to me.

**One mistake printed seven times.** At fifty entries it buries whatever else is in the batch.

**All-or-nothing is per call, not per script.** Both rejections sat inside a larger script whose first
two `flcm.edit` calls had already landed, so "NOTHING was applied" is true of the batch and false of
the document.

**Suggestion, revised after review:** keep the verb — its batch validation and rollback differ
materially from a loop of edits, which is a reason to exist the verbs table should state, because
"one atomic batch" reads as a performance feature and I reached for it as one. Let entries accept
`{ id, …changes }` alongside `{ target, changes }`; collapse identical per-entry errors to
`[0–6] identical: …`.

**Related, one line:** `alignSelf` is not an flcm word and does not need to be — a child stretching on
the cross axis is `height: "fill"`. See §14.

---

## 14. Read words that flcm cannot write get a different answer on every verb

**Impact: medium. Cost: low. `[HUMAN REVIEWED]`** — decided in session 2026-09-15.

Two refusals, same root cause: the message enumerates the legal members of the bag you got wrong and
stops, so a dead end reads like a complete answer.

```
flcm: unknown prop "alignSelf" on flcm.editMany.layout — takes only "mode", "gap", "wrap",
"padding", "justifyContent", "alignItems".
```

```
flcm: unknown query key "depth" on flcm.find's query — takes only type, name, key, within,
hasAnnotations.
```

**What is actually wrong.** Reads and writes share one vocabulary: a word means the same thing on both
sides. That is not a promise that every read word has a write. The read shape is CSS-flavoured;
Figma expresses some of those concepts differently (`alignSelf: "stretch"` is the child sizing its
counter axis `"fill"`; `zIndex` is sibling order) or not at all yet (grid words, until grid authoring
lands). `compile-tree.ts` already owns the table that decides this per read word
(`LAYOUT_WORD_DISPOSITIONS`: author, or refuse with a reason) — but only `render` consults it.
`edit` and `editMany` fall through to the generic closed-set message, so the same word gets two
answers depending on the verb. And `alignSelf` should never have been a refusal at all: it has an
exact Figma counterpart, so refusing forces the agent to discover the translation flcm exists to do.

`depth` is a different shape of the same blind spot. `find` takes two arguments: a query object with
five keys the plugin matches cheaply, and a predicate that runs on each candidate's full read shape.
Anything the query cannot express — depth, `componentId`, text contents — belongs in the predicate.
(`find({ type: "INSTANCE" }, (n) => n.componentId === "…")` works today; I used raw
`getInstancesAsync` nine times because the refusal made the query keys look like the whole surface.)

**Solution.**

1. `alignSelf` joins the input alias table (`input-aliases.ts`) and translates to counter-axis
   `"fill"`. Translation is what flcm is; the alias table is where incoming words are already
   rewritten before compile.
2. Every verb's layout bag validates through the same path: aliases, then the disposition table, then
   the closed-set check. One table, one answer per word, on `render`, `edit` and `editMany` alike. A
   new read field needs one row, not one per verb.
3. `find`'s unknown-query-key refusal gains one fixed sentence: any other filter goes in the
   predicate, `find`'s second argument, which sees the full read shape. True for every unknown key, so
   it is not a per-mistake hint.

**Not the solution:** hand-written "did you mean" prose per refusal. A refusal names a neighbouring
answer only when a table the compiler already owns can produce it, or the answer is true for the
whole class of mistake.

**Landed:** 1 and 2 in `c4924e5`/`e5025e7` (then narrowed: `alignSelf` is grid-only, ADR-0014);
Figma's native grid spellings (`gridColumnAnchorIndex`, `gridColumnSpan`, `gridChildVerticalAlign`,
native track shapes) joined the alias table in `2e5b9cc`, documented once in a "Native spellings
accepted" block rather than in every props table. 3 is with the `svg` agent (same file).

---

## 15. The overflow warning names the container, not the child, the axis or the amount

**Impact: medium. Cost: low. `[HUMAN REVIEWED]`** — decided in session 2026-09-15.

```
[warn] flcm.insertBefore: overflow in 1 containers; clipped (0): ; unclipped (1): 4984:24261.
Write succeeded.
```

**What was actually happening.** I read these as false positives on correct, intended writes — an
absolutely-positioned scrim pinned `stretch`/`stretch` inside a clipping parent, which I assumed was
_supposed_ to exceed its parent's box. That assumption was wrong. The check only fires when a corner
lands more than 0.01px outside the parent (`sizing-diagnostics.ts` `overflows`), so a scrim that
stretches to exactly the parent's edges is silent. Every warning I skimmed was §6 being reported
correctly: the stretch was applied before the parent's own size settled, so the scrim came out at the
wrong size. With §6 fixed, those warnings stop on their own. A high false-positive rate did not train
me to skim it; a true-positive rate I could not read did.

What remains is the message. It names the symptom's location (the parent id) in the same words for
every case, prints empty buckets with their labels (`clipped (0): ;`), and says nothing about which
child, on which axis, by how much, or whether it matters.

**Solution.**

1. Name the worst offender per container — child id and name, parent id and name, axis, and the
   amount past the edge, computed from the same corner projection the check already does. Several
   offenders in one container: name the largest and add "and N more".
2. Drop empty buckets and the stray semicolon. Clipped and unclipped become separate sentences, each
   emitted only when non-empty.
3. Say in one clause why each matters, so the agent knows which one to act on: unclipped overflow
   paints outside the parent; clipped overflow is invisible.

Unclipped, the one to act on:

```
[warn] flcm.insertBefore: 4986:24352 "Scrim" overflows 4986:24351 "Header" by 100px on x; the
parent does not clip, so the excess paints outside it. Write succeeded.
```

Clipped, informational:

```
[warn] flcm.render: 4986:24410 "Row" overflows 4986:24400 "List" by 24px on y; the parent clips,
so the excess is invisible. Write succeeded.
```

**Not the solution:** suppressing the warning for out-of-flow `stretch`-pinned children. My own
incorrect 300px scrim has exactly that shape; suppression would have hidden §6.

**Landed `3deeac0`** with §24. The overflow record names the worst child (id and name), the parent,
the axis and the amount, adds "and N more", and says whether the parent clips. Drive 2 confirmed
the old message's cost: two near-identical warnings, one on a clean render and one on a wrecked
one, and the agent had learned to skim (grid-test-drive-2 §3).

---

## 16. A queued call reports as though it might have written

**Impact: medium-high for the message; the throughput claim is unproven. Cost: low. `[HUMAN REVIEWED]`** —
16a decided in session 2026-09-15: the inactivity timer starts at `running` (the 45s run ceiling is
the only bound while queued, which is correct — a queued run is waiting on real work ahead of it).
The queued message becomes DEFINITIVE, not hedged: the plugin already knows at the moment CANCEL
arrives whether the run has started (it sent `queued` and has not sent `running`), so it answers the
CANCEL immediately from that knowledge — "never executed" or "already running" — and skips the run
silently when the queue reaches it. The server waits one round trip for that answer before rejecting,
so the caller reads "never executed; safe to retry" or "was running; inspect before retrying". The
plugin's existing dequeue refusal only fires when the queued run reaches the front of the queue,
i.e. after the slow run ahead of it finishes, which is why the server could not simply wait for it.
Rides the protocol 6 bump. 16b stands as written.

**Landed `c7a76b3`.** The plugin keeps one row per outstanding run (`phase`, `cancelled`) and
answers every CANCEL at once with `CANCEL_RESULT` (`never-executed` | `was-running` | `unknown`);
the server holds only the rejection wording for one round trip (1s) and words it from the answer
(`outcome: "not-submitted"` for never-executed). A caller-withdrawn abort does not wait. One rule
decides the inactivity deadline: none while queued, armed on submitted/running. Needs a plugin
rebuild + re-import; an old plugin pays the 1s and gets the hedge.

Two bridge timeouts, same board, seconds apart:

```
b8fe753… (EXECUTE_CODE, last phase running, 15112ms) saw no traffic for 15000ms. Completion is
unconfirmed; cancellation requested. Raw code may still finish. Inspect affected nodes before
retrying.

38175975… (EXECUTE_CODE, last phase queued, 15018ms) saw no traffic for 15000ms. [same text]
```

The `running` one is the eighteen-mutation script from §9. The `queued` one is a pure read with no
writes at all. _"Raw code may still finish. Inspect affected nodes before retrying"_ is correct for
the first and misinformation for the second — I went and inspected nodes for a call that had not
touched the document.

Two things, of different confidence:

**a. The message is wrong for a queued call, and the clock runs while queued.** 15018ms of a 15000ms
budget was spent waiting. Both cheap to fix. One caveat from review: `last phase queued` is the last
_observed_ state, so a definitive "never started; safe to retry" needs a dequeue acknowledgment
rather than an inference.

**b. I claimed the cause was call count, and that is not established.** Twelve `flcm.append` calls are
not necessarily twelve bridge round-trips, and the log does not say which work was slow. **Do not
close triage #13 on this evidence.** §9 is worth fixing on its own merits; whether it would have
prevented this timeout is unproven.

Separately: an unscoped page-wide `flcm.find({ hasAnnotations: true })` timed out on a 2120×7419
imported section. Scoping with `within` was fine.

---

## 17. Smaller things

- **Three size representations in one API.** `get` reports `"contextual"` and `designedWidth:
"402px"`; the child-scoped read reports `402`; `measure` reports `402`. A small tax on every
  geometry check, paid often.
- **`fontSize` is a top-level alias but `lineHeight` is not**, so half a type ramp goes in `textStyle`
  and one field can go either place.
- **`flcm.variants` has no add-to-a-set form** — documented and refused clearly, but in surgery you
  more often want to add a variant to an existing set than to fold loose components into a new one.
  Already deferred as triage item 25; one more vote, from a workload where it is the common
  direction.
- **`find`'s 5000-node materialization cap** fired correctly and read well when I ran an unscoped
  predicate query, telling me exactly how to narrow it. Noted because I hit it by being careless, not
  because it is wrong.

---

## 18. Platform, not yours

So the next agent does not go hunting:

- `relative-transform` cannot be overridden on an instance sublayer — `Error: in set_x: This property
cannot be overridden in an instance`. Absolute position is inherited from the component. Position it
  in the component.
- Raw `node.remove()` is refused on a component-owned node where `flcm.remove(flcm.id(...))` succeeds.
  An flcm win, listed below.

---

## 19. Mine, and the tool did not make them likely

- I hand-typed Lucide path data for `camera` and `house` from memory and got both wrong; the camera
  body sat two points low with the wrong corner radius. Graham spotted it on screen.
- I painted the 44×44 tap box white instead of the 24px svg frame inside it, shipping a white square
  where a chevron belonged.
- I cloned a status bar out of a header and then removed the header, which took the clone with it.
- I wrote `flcm.id(p.id)` against `flcm.page.current()`, whose return is `{ fileName, page, pages }`.
  Filed as a gap, cut on checking.
- **I ran a delete-by-name loop without looking at what matched**, and removed a node of Graham's
  (`4984:21325`) along with my own probe. I also ran an unscoped `find({}, predicate)` that tried to
  materialize 6771 nodes and locked Figma up. Both mine; the cap message (§17) did its job.

---

## 20. What was genuinely good

- **`flcm.variants` preserved all 23 existing instance links.** I had built a parallel `Tab bar` set
  before discovering one already existed with 23 instances across the file. Deleting the duplicate,
  re-bodying the original and folding it into a set carried every instance forward with no
  relinking. The single largest thing the tool saved me, and the operation I most expected to have to
  do by hand.
- **`session`'s reliability was total.** 25 keys across a working day and several compactions, zero
  losses. Deep-copy on write, so a stored value cannot be corrupted by mutation of its source, and
  refusals that name the exact offending path (`session.probe.fn`, not "bad input"). Both complaints
  in §8 are about framing, not design.
- **`flcm.remove` works where raw `remove()` is refused** on component-owned nodes.
- **Fails-loud messages name the legal vocabulary.** The empty-edit error printed all 36 editable
  words including `pin` — which, hit on day one instead of hour nine, would have saved most of §2.
  §14 asks to extend this virtue, not replace it.
- **Slot declaration by append.** Appending a frame bound to a not-yet-existing slot name declares the
  property. No separate step, no ordering to get wrong.
- **Component property binding round-trips legibly.** `componentPropertyReferences: { visible: "Show
picture" }` reads and writes bare, so an eight-property component stayed comprehensible across
  several compactions of my own context.
- **`figma_execute_code` + `get_screenshot` as a loop.** 331 writes, 102 screenshots. Every visual bug
  in this document was caught by looking; none by reading a return value.

---

## 21. Suggested priority

`[HUMAN REVIEWED]` marks the items already talked through. Still wants a check before implementation.

| #   | Item                                                     | Impact      | Cost       |                    |
| --- | -------------------------------------------------------- | ----------- | ---------- | ------------------ |
| 1   | Mental model ships only to the no-argument caller        | high        | low        | `[HUMAN REVIEWED]` |
| 3   | New parent + live children dismantles the source         | high        | low        | `[HUMAN REVIEWED]` |
| 5   | Instance child edits dropped without comparison          | high        | low        | `[HUMAN REVIEWED]` |
| 6   | `pin: "stretch"` resizes the authored node               | high        | low        | `[HUMAN REVIEWED]` |
| 4   | Writes outlive the reply                                 | high        | medium     | `[HUMAN REVIEWED]` |
| 9   | `render`-by-id is the multi-child append                 | medium-high | one clause |                    |
| 16a | Queued call reports as though it may have written        | medium-high | low        |                    |
| 14  | Refusals do not name the neighbouring word               | medium      | low        |                    |
| 13  | `editMany`'s entry shape contradicts the rest of flcm    | medium      | low        |                    |
| 15  | Overflow warning names the container, not the child      | medium      | low        |                    |
| 12  | `readOnlySource` opt-in rather than always-on            | medium      | low        |                    |
| 10  | `d` + explicit size rescales the path bbox               | high        | low        |                    |
| 11  | Divergence between authored and realized is unreportable | high        | medium     |                    |
| 2   | Targeted reads have no parent context                    | high        | medium     | `[HUMAN REVIEWED]` |
| 7   | No authored form for a paint stack                       | medium-high | feature    | `[HUMAN REVIEWED]` |
| 8   | Run-binding: fix `to`, then functions follow             | medium-high | redesign   | `[HUMAN REVIEWED]` |

---

## 22. The one-paragraph version

Two causes account for most of this document. The reference's mental model — which holds the rules
about identity, copying, and what `session` is for — ships **only** to a caller that requests no
sections, and I named sections on all twelve of my calls, so I never received it. And a targeted
`flcm.get` has no parent context, so it drops `position`/`left`/`top` and collapses fixed sizes to
`"contextual"`, while `readOnlySource` sits in the same payload speaking fluent Figma; that is why I
reached for `figma.getNodeByIdAsync` about 190 times for capabilities flcm has and documents. Four
things I was ready to file as missing were phantom gaps, and a fifth — bulk append — turned out to be
spelled `render({ id, children })`. Against that, three silent-wrong-output paths worth fixing on
their own: a spec with a new parent and live children dismantles the source subtree; `pin: "stretch"`
resizes an absolute child to a width of 300; and edits to an instance's inherited children are
discarded without ever being compared. One more, verified live: a rejected `Promise.all` still lands
its sibling write _after_ the call has reported failure, so any screenshot taken straight afterward
may be of a file that is still moving. The genuine missing feature is paint stacks.

---

## 23. The emergent finding: capability after capability failed to reach me

Only visible once the whole list exists. **Five** things I was prepared to report as impossible, the
tool does:

| I believed                      | It is actually                       | Why it did not reach me                                          |
| ------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| no absolute positioning         | `position: "absolute"`, `left`/`top` | the targeted read omits all three (§2)                           |
| no constraints                  | `pin: { x, y }`                      | the read shows Figma's `constraints` in `readOnlySource` instead |
| no annotation text              | the `annotations` prop, round-trips  | I read it through raw first and never went back                  |
| no instances-of-component query | `find({type:"INSTANCE"}, predicate)` | the predicate gets one clause, no example (§14)                  |
| no bulk append                  | `render({ id, children })`           | `render` is documented entirely as page placement (§9)           |

Plus two rules I broke that are written down plainly and that I never received at all, because they
live on the one page a section-naming caller never gets (§1).

That is not seven documentation gaps. Every one of them is documented. **What stopped the
documentation reaching me was, in almost every case, another part of the tool teaching me something
else** — a read that speaks raw Figma, a refusal that enumerates one bag as though it were the whole
vocabulary, a verb whose description covers one of its two jobs, a return value that can only ever
agree with me.

The lever is not more documentation. Volume is what made these unreachable. It is that **every
surface an agent touches during a mistake is a documentation surface** — the read payload, the error
message, the verb's one-line summary, the value handed back after a write — and those surfaces
currently carry instruction that competes with the reference, or carry none at all. Fixing §1, §2,
§9, §11 and §14 would retire more of this document than fixing the bugs would.

One cheap instrument for the next round: count raw `getNodeByIdAsync` calls per session alongside
flcm verb calls. A high ratio is a session where an agent could not find the authored form, and the
properties it reaches for afterwards name the gap precisely. Mine would have flagged
`layoutPositioning` and `constraints` inside the first hour.

---

## 24. Warnings belong on the node they are about

**Impact: medium-high — it is the delivery channel for §6, §10, §11 and §15. Cost: medium.
`[HUMAN APPROVED]`** — added in session 2026-09-15 from discussion, not from the original run. Not
part of any other item's fix; it absorbs Quick choice E (§11's `divergences` channel).

**The situation.** A warning today is a `console.warn` string. The run captures the console and
appends the lines to the reply as `[warn] …`, with the node id buried in prose. Seven sites in the
preamble do this. An agent that logs `r.children[0]` to itself sees values it should distrust and no
sign that anything is wrong with them; the sign is in a flat list at the end of the reply, keyed by
an id it has to go and match. §11 proposes a structured `divergences` channel for the same
information. Both are the same thing delivered two ways.

**Solution.**

1. **One record type**, produced by the verbs instead of console strings:
   `{ id, prop?, message, authored?, realized? }`. `message` alone is a plain warning; `prop`,
   `authored` and `realized` are §11's divergence — the property, the value asked for, the value
   that landed.
2. **Surfaced on the node**, as a `warnings` array on the returned spec (an array because a node can
   carry more than one). The agent that logs the node sees the problem beside the values.
3. **Surfaced at run level from the same records**, as the summary lines the reply already has — but
   suppressed for any node that already reached the wire. Egress tracks read objects by identity;
   returned handles register the same way, giving one set of ids that were echoed, and the summary
   omits those. An agent that returns nothing still sees every warning; an agent that echoed the
   node does not see it twice.
4. **It is read metadata**, like `elided` and `readOnlySource`: stripped or refused on the way back
   in, because the returned spec is meant to be reusable as input.
5. **Not every warning has a node.** Overflow belongs to a parent and child pair; "writes finished
   after your code returned" belongs to the run. Those stay run-level only.

**Not the solution:** a second channel beside the console strings. The strings go away; the records
are the one source, rendered two ways.

**Landed `3deeac0`.** One per-run registry in `warnings.ts`; every former `console.warn` site
(size clamps, ignored vector width/height, overflow, diagnostics failure, writes-after-return)
writes a record. Records ride on any registered read/handle/measure object as `warnings` at
egress, and objects the agent already holds gain later warnings too; the run summary omits records
that reached the wire. `warnings` is a read-only word (stripped from input with the others). A
failed verb discards the records it added. Needs a plugin rebuild (`FlcmHost.registerRead` grew a
decorate step); no protocol bump.
