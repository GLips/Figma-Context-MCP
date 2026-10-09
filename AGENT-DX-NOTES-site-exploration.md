# flcm / figma-mcp — agent DX notes, site-exploration workload

Written by Claude (Fable 5.1) during and immediately after the session, not from reading the code.

**Transcript:** `/Users/graham/.claude/projects/-Users-graham-Programming-framelink-figma-mcp/cac90cea-dbfe-4780-a81b-c53ed58f8bbd.jsonl`
(session `cac90cea-dbfe-4780-a81b-c53ed58f8bbd`, covering the whole session up to the point this note
was written; no compaction had happened yet).

Every item below is a real event in that file — the exact script I ran, what came back, and what the
human said about it. **Go read it rather than trusting a summary.**

`[HUMAN REVIEWED]` on an item means it was discussed in conversation with Graham and the wording
reflects that discussion. It is a record of what has been talked through, not a sign-off — each still
wants his check before it goes out for implementation.

**The task:** a broad visual exploration for a new framelink.ai marketing site, built live in Figma
while the human reacted between rounds. Brief and moodboard, four palette-driven direction sheets
(~500 nodes each), three atmosphere studies, five element-driven direction pages built around one
reusable specimen card, a mock Figma window, and two poster-scale hero variants. About 35 write calls
and 20 screenshots over roughly two hours; ~2,500 nodes on one page.

This is a different shape from the existing notes. [product-design](AGENT-DX-NOTES-product-design.md)
is one screen with a human in the loop; [mobile](AGENT-DX-NOTES-mobile.md) is adapt-a-page;
[component-surgery](AGENT-DX-NOTES-component-surgery.md) is instance work. This one is **throwaway
volume**: many large free-form compositions, almost no components, lots of absolute positioning,
measured geometry used to draw annotations over live nodes, and a human whose feedback was about
whether the _design_ landed, not whether the file was right.

The headline: **the build loop held up at volume, and the two things that actually bit were both
silent.** A `find` with an undefined `within` searched the whole page and edited the wrong hero, and
rotation pivots on the top-left corner while the docs say centre. Everything else that went wrong
failed loud, fast, and with the fix in the message — but every one of those cost a full resend of a
multi-thousand-token script, which is §11 and the item Graham asked for by name.

---

## 1. `find({ within: undefined })` silently searches the whole page

**Impact: high. Cost: trivial. Not in triage.**

Late in the session I cloned a hero to make a variant, then edited "the clone":

```js
const v = await flcm.clone(session.d12, {
  name: "12b · Structure at scale · overprint",
  left: 5200,
  top: 1000,
});
session.d12b = v.id;
const card = (await flcm.find({ name: "Session card · x-ray", type: "FRAME", within: v.id }))[0];
const structure = (await flcm.find({ name: "structure", type: "FRAME", within: v.id }))[0];
const chrome = (await flcm.find({ name: "chrome", type: "FRAME", within: v.id }))[0];
// ... editMany on card / structure / chrome ...
return v.id;
```

Came back `{ console: [], errors: null }` with no `result` — `v.id` was `undefined` (see 1.1). Every
`find` then ran with `within: undefined`, which the tool treated as "no `within`", searched the page,
and returned the _original_ hero's nodes because they sort first. The edits landed on the original.
I only noticed because the next screenshot was of the wrong frame. Graham was looking at that frame
when it changed under him.

Verified in isolation afterwards:

```js
const w = await flcm.find({ type: "TEXT", within: undefined });
return w.length; // → 836
```

**Why it happened.** `within` absent and `within: undefined` are indistinguishable to a `?.`-style
check, and the tool picked the permissive reading. For a query key whose whole job is to _narrow the
blast radius of an edit_, that is the wrong default: the failure mode is a mutation on the wrong node.

**Suggestion:** treat an explicitly present `within` key with a non-target value as an error —
`"within" in query && query.within == null` → fail loud naming the key. Same for `flcm.id(undefined)`,
which already does this correctly (`flcm.id: expected a node id string … got undefined` — that one
saved me in the first ten minutes).

### 1.1 `clone` is the one creating verb that doesn't return a handle

**Impact: low on its own; it is the trigger for §1. Cost: small. Evidence for [triage 29](AGENT-DX-TRIAGE.md) ("creation return shapes"), which is settled — this is the residual.**

Every placing verb returns "the spec copied with ids", so `(await flcm.render(x)).id` is the idiom the
tool description teaches and I used ~30 times. `clone` returns `{ node, to? }`. It is documented in the
verbs table — I hadn't read that section, and nothing in the one-line tool description
(`clone(target, props?, parent?)`) hints that its shape differs from its neighbours.

**Suggestion:** either return the cloned root's spec-with-ids like the others (with `to` as a sibling
field), or make `.id` resolve on the returned object. Failing that, the tool-description line for
`clone` should carry `→ { node, to? }` since it is the odd one out.

---

## 2. Rotation pivots on the top-left corner; the docs say centre

**Impact: medium — silently misplaces geometry, and reads can't reveal it. Cost: one word in the docs, or honouring the documented behaviour. Not in triage.**

The `rotation` prop row, in both `props` and `edit`:

> Composes AFTER layout sizing: the parent sizes the node … and the node then spins about its centre.

I built a drawing-grid with rotated lines on that promise:

```js
for (let x = 0; x <= 1440; x += 40)
  grid.push({ type: "LINE", width: 900, left: x - 450, top: 450, rotation: 90, stroke: C.line });
```

Not one vertical line showed up in the hero. A dimension line placed the same way rendered ~100px away
from where it was aimed. Earlier, a crosshair's vertical `LINE` (`left: 45, top: 72, rotation: 90,
width: 130`) produced `overflows "Crosshair" by 52px on y` — which is exactly what you get if the line
starts at `top` and extends 130px _downward_ from there, not if it spins about its centre.

Verified in isolation with a marker dot at each node's `(left, top)`:

```js
{ type: "LINE", width: 100, left: 100, top: 100, rotation: 90 }            // renders from (100,100) straight down
{ type: "RECTANGLE", width: 20, height: 100, left: 250, top: 100, rotation: 45 }  // top-left corner stays on the dot
```

Both pivot on the origin. And `measure` on the rotated line reports `{ x: 100, y: 100, width: 100,
height: 0 }` — the unrotated box — so there is no read that would have told me.

I rebuilt every vertical rule as a 1px-wide `RECTANGLE`, which is what I'd recommend to the next
agent anyway.

**Suggestion:** pick one. Either the doc sentence becomes "rotates about its top-left corner, like
Figma's own rotation field", or the compiler translates `left`/`top` so the documented centre pivot
is true. The first is a one-line change and enough; the second is nicer for lines specifically
(a rotated `LINE` is the divider/dimension case, and "spins about its centre" is what you want there).

---

## 3. `measure` is parent-relative, and roots make it look page-absolute

**Impact: medium — silently wrong placement; cost me two full rebuilds. Cost: a phrase in the tool description, or two extra fields. Context: [triage 8](AGENT-DX-TRIAGE.md) approved "on-demand parent-relative x/y"; this is what that decision feels like from the other side.**

The verbs table says it plainly: _"Measured pixels relative to the immediate parent."_ That is on me —
I read `mental-model`, `props`, `paint`, `vector`, `render` and `css-subset`, not `verbs`, and the
tool description lists `measure(target)` with no return shape.

What made the wrong model sticky: every `measure` I ran for the first 90 minutes was on a **root**,
whose parent is the page, so `x`/`y` came back as page coordinates and my model was "absolute".
When I finally measured children to draw bounding boxes over them:

```js
const m = await flcm.measure(n.id);
const x = m.x - HX,
  y = m.y - HY; // HX = the hero's page x
```

→ `[warn] "Rectangle" overflows "structure" by 5200px on x and 31 more`. That warning is the good
part: it told me in one line. But the second rebuild was _also_ wrong, because children of children
are relative to _their_ parent, so I had to walk the tree accumulating offsets. Third build worked.

**Suggestion (pick one, cheapest first):**

- The tool description line: `measure(target) → { x, y, width, height } relative to the parent`.
- Or add `pageX`/`pageY` alongside — the bounding-box-over-a-live-node case (annotations, callouts,
  dimension lines, x-ray overlays) is exactly the one where you're placing a _sibling of an ancestor_
  and parent-relative is the wrong frame.

---

## 4. A radial gradient's 100% stop lands outside the shape

**Impact: medium-low — silently renders a hard disc where a soft glow was asked for. Cost: small. Not in triage.**

A sun-glow behind a horizon:

```js
{ type: "ELLIPSE", width: 900, height: 900, fill: flcm.gradient({ type: "radial", stops: [{ color: "rgba(240,166,58,1)", pos: 0 }, { color: "rgba(240,166,58,0)", pos: 100 }] }) }
```

Rendered as a hard-edged solid disc. Reading it back:

```json
"handles": [ { "x": 0.5, "y": 0.5 }, { "x": 1.5, "y": 0.5 }, { "x": 0.5, "y": 1.5 } ]
```

The 100% stop sits at 1.0× the box away from centre, so at the ellipse's edge (0.5×) the paint is still
~50% opaque. CSS `radial-gradient(circle, …)` defaults to `farthest-corner`, ≈0.707× for a square box,
and _every_ CSS glow idiom assumes the last stop is at or inside the edge. Moving the transparent stop
to `pos: 50` fixed it, which is the sort of thing you only know after reading `readOnlySource`.

**Suggestion:** map the sugar's 100% to the box edge (handles at 1.0) or to CSS farthest-corner
(≈1.207). Either is closer than 1.5. If 1.5 is deliberate, say so in the `flcm.gradient` fields table
next to `at`.

---

## 5. `edit` rejects `d` on a VECTOR, and the rejection doesn't say where geometry edits go

**Impact: low-medium. Cost: trivial either way. Not in triage.**

I needed to re-aim a leader line:

```js
await flcm.editMany([{ id: "5057:34157", d: "M0 90 L40 0", left: 700, top: 270 }, …]);
// → flcm: unknown prop "d" on flcm.editMany — flcm.editMany takes only "gridColumnAnchorIndex", … (40 words)
```

But `props › VECTOR` says: _"An id-bearing VECTOR accepts d or vectorPaths as a geometry edit and
preserves its live identity."_ Both are true — the route is a **placement verb** with `{ id, d }`, not
`edit`. The rejection lists forty legal words and doesn't mention the one route that works, so I used
`replace`, which minted a new id and dropped the old one out of every handle I was holding.

**Suggestion:** accept `d`/`vectorPaths` in `edit` for path-born VECTORs (it's the same identity-preserving
write), or have the "unknown prop `d`" rejection end with _"geometry edits go through render/append
with the node's id"_. The docs sentence is right; it just isn't where the failure is.

---

## 6. Padding shorthand refuses a bare `0`

**Impact: low. Cost: trivial. Not in triage.**

```js
layout: {
  padding: "0 48px";
}
// → flcm: expected a number or "Npx" (e.g. 24 or "24px"), got "0" — em/%/rem and bare numeric strings are not coerced.
```

The message is clear and I fixed it in one round trip (`{ x: 48, y: 0 }`). But it took _four_ sheets
down with it, because the same helper was in each, and unitless zero is the one bare number every
CSS author writes by reflex. The refusal is defensible for `"12"`; for `"0"` it's a tax.

**Suggestion:** accept `0` unitless inside the shorthand (CSS does, unconditionally). Nothing else.

---

## 7. Overflow warnings for clipping parents are noise at volume

**Impact: low-medium — it dilutes the warnings that matter. Cost: small. Feedback on the overflow feature that [triage 12/18](AGENT-DX-TRIAGE.md) shipped.**

Rendering four direction sheets produced 24 console lines, all of this shape:

```
[warn] 5056:31868 "Rectangle" overflows 5056:31867 "Hazard stripe" by 330.27px on x and 8 more; the parent clips, so the excess is invisible.
[warn] 5056:32019 "02" overflows 5056:32018 "Hero A" by 284px on x; the parent clips, so the excess is invisible.
```

Every one is a bleed I authored on purpose: hazard stripes, cropped numerals, a card running off the
hero. `clip: true` _is_ the declaration of intent. Meanwhile the two warnings in this session that
were real bugs — a 5200px overflow (§3) and a 742.5px one (my own arithmetic, see §10) — arrived in
the same voice, in a list I'd learned to skim.

**Suggestion:** when the parent clips, collapse to one line per parent with a count
(`"Hazard stripe" clips 9 children`), and keep the per-child verbose line for parents that _don't_
clip, since that's where paint lands outside. Or a `warnings: "overflow-unclipped"` knob per call.
Don't drop them entirely — the 5200px line paid for the feature.

---

## 8. Pasted images live outside the asset root

**Impact: low. Cost: his call — it's a trust-boundary policy, not a bug. Not in triage.**

The four reference images the human pasted into the conversation landed at
`/private/tmp/claude-501/…/images/1.png`. `flcm.image` refused them with the correct message
(_the path resolves outside the asset root … only files under that root can be placed_). I copied them
into `.scratch/site-exploration/refs/` (gitignored) and carried on; 30 seconds lost.

Noting it so the next agent doesn't go hunting: **pasted images will always be outside the root**, and
the move is copy-into-repo, not `--asset-root`. If that's the intended workflow, one sentence in the
`images` section saying so would save the round trip. If the session temp dir should be allowed, that's
a security decision I shouldn't make in a note.

---

## 9. One `editMany` entry didn't land, and I can't reproduce it

**Impact: unknown; recorded for the transcript, not for action. Not reproduced.**

In the §1 call, this batch reported success:

```js
await flcm.editMany([
  { id: card.id, top: 250, left: 520 },
  { id: structure.id, top: -180, left: -80 },
  { id: headline.id, top: 150, textStyle: { fontSize: 176 } },
  { id: para.id, top: 560 },
]);
```

`measure` immediately afterwards: card at `(520, 250)` ✓, headline resized ✓, paragraph moved ✓,
**`structure` still at `(0, 0)`**. A lone `flcm.edit(structure.id, { left: -80, top: -180 })` in the next
call applied fine, and the same shape (`editMany` with negative `left`/`top` on a free-form child beside
another entry) applied fine in an isolated test. Look for it around the "12b" clone in the transcript if
a similar report ever shows up; otherwise ignore.

---

## 10. Things that were mine, kept only because the tool's part is instructive

- **`flcm.id(undefined)`** on a cleanup line, first call of the session. Failed loud, correct message.
  Graham saw "a bunch of errors" at the start; this was the first.
- **Spreading node props into `textStyle`.** My helper put `left`/`top` inside `textStyle`; the
  rejection named the path (`spec.children[4].children[1].children[4].children[6]`) and listed the legal
  words. Fixed in one round trip. The only tool note: the _whole_ four-sheet render died with it, which
  is the correct pre-write validation doing its job — nothing was left on the canvas.
- **Guessing `editMany`'s entry shape** as `{ target, changes }`. Rejected with the right shape in the
  message. That's what the message is for.
- **`find({ name: "Ruler" })` matched a FRAME _and_ its label TEXT** (a TEXT is auto-named by its
  content), then `within` a TEXT failed loud. Adding `type: "FRAME"` fixed it. Worth a line in the
  `find` docs: name matches text content by default, so filter by `type`.
- **The 742.5px overflow was arithmetic** — I mapped over `[0, 5, 10, 15, 20, 25]` and used the value
  as an index. The warning was exactly right. I misdiagnosed it as a text-sizing bug, wrote a fix that
  masked it, and only found the real cause while verifying this note. Owning that because it's the
  strongest evidence for §7: a correct warning in a wall of benign ones got pattern-matched to "benign".

---

## 11. One validation error throws away the whole script, and the only retry is to resend it

**Impact: high — it multiplies the cost of every other error in this note. Cost: small-medium. Related to [triage 14](AGENT-DX-TRIAGE.md) (partial writes) only in that pre-write validation is what makes re-running safe; the retry cost itself isn't in triage.**

Graham raised this one, not me:

> "The thing about those errors in the beginning is that a single error killed your entire script and
> you had to rewrite everything again using up a bunch of tokens."

> "I think that's kind of unfortunate that you can't tweak a script a little bit more. Honestly, maybe
> that should be the suggested paradigm that you write these scripts to some durable place. That way you
> can iterate more rapidly without needing to rewrite everything every time."

The numbers from this session. The four-direction-sheet script was ~9k tokens of `code`. It went out
three times — once rejected for `left`/`top` inside `textStyle` (§10), once for `padding: "0 48px"` (§6),
then it landed. Two one-line fixes cost ~18k tokens of verbatim resend. The rebuilt Measure hero (§2)
was another ~4k resent to change a helper. And the round-two sheet builder couldn't be parked in
`session` because functions are refused there, so every direction call re-shipped the same helper block.
Across the session I'd estimate a third of all write-call tokens were repeats of code that had already
been sent.

**Why it happens.** `figma_execute_code` takes `code` as a string, per call, with nothing durable
between calls except plain data. That is the right shape for the _result_ (ids and snapshots), but it
means the script has no address: it can't be edited, only replaced. Meanwhile the tool already has the
property that makes edit-and-rerun safe — validation rejects before the first write, so a failed run
leaves nothing behind (§12) — and it isn't being cashed in.

**Suggestion:** give the script a durable home and let the tool run it from there.

```js
// the agent writes/edits this with its ordinary file tools
// .flcm/site-exploration/direction-sheets.js
figma_execute_code({ scriptPath: ".flcm/site-exploration/direction-sheets.js" });
```

- Paths resolve inside the same asset root that `flcm.image` already enforces, so there's no new
  trust boundary.
- A rejected run then costs an `Edit` of one line and a re-run by path, not a resend.
- The doc paradigm follows: _"for anything over a screenful, write the script to a file and run it by
  path; keep `code` for one-liners and reads."_
- A cheap adjacent win: let `session` hold **source strings** that a later call can `eval` into helpers
  — functions can't survive, but their text can, and the reference could say so.

This is the same model the harness's own Workflow tool uses (`script` inline for the first run, then
`scriptPath` + edit + resume), and it exists there for exactly this reason.

---

## 12. What was genuinely good

- **Pre-write validation at volume.** Four ~500-node sheets in one call failed twice on validation
  errors and left _zero_ nodes behind either time. With per-sheet `try/catch` the third run landed all
  four. That's the property that makes big speculative renders cheap.
- **Error messages carry the fix.** Wrong `editMany` shape, wrong prop on `textStyle`, `within` a TEXT,
  bare `0` padding, out-of-root image — every one named the path or the legal alternatives and none took
  more than one round trip. Only §1 and §2 failed silently, which is why they're the top two.
- **Overflow warnings caught both real geometry bugs instantly** (§3's 5200px, §10's 742px). §7 is about
  their signal-to-noise, not their existence.
- **`session` carried the specimen spec across eight calls.** One plain-data card, deep-copied and
  re-rendered in five directions, then scaled 2.6× by walking the spec. No re-authoring, no ids leaking.
- **`replace` as the geometry-edit fallback** worked first time and kept the node in place.
- **`anchor: { x: "center" }` with `left`** made centred dimension labels a one-liner.
- **Screenshot `scale` below 1** (0.12 for the whole page, 0.5–0.7 per sheet) made the "does this read
  as a thumbnail" test free. That test decided round two.
- **`editMany` all-or-nothing with indexed rejections** — one batch of 31 edits rejected on shape,
  reported once, fixed once.
- **Live `measure` on every descendant** to draw bounding boxes over a ghosted card is the whole
  "structure, not screenshots" hero. Once I had the coordinate frame right (§3), it was ~20 lines.

---

## 13. Suggested priority

| #   | Item                                                                     | Impact     | Cost            | Reviewed |
| --- | ------------------------------------------------------------------------ | ---------- | --------------- | -------- |
| 11  | Run a script by path; durable scripts as the paradigm                    | high       | small-medium    | yes      |
| 1   | `within: undefined` fails loud                                           | high       | trivial         |          |
| 2   | Rotation pivot: fix the doc word, or honour centre                       | medium     | trivial / small |          |
| 3   | `measure` frame of reference in the tool description, or `pageX`/`pageY` | medium     | trivial / small |          |
| 7   | Collapse clipped-overflow warnings per parent                            | low-medium | small           |          |
| 4   | Radial 100% stop at the box edge                                         | medium-low | small           |          |
| 5   | `d` in `edit`, or the rejection names the route                          | low-medium | trivial         |          |
| 1.1 | `clone` return shape                                                     | low        | small           |          |
| 6   | Bare `0` in padding shorthand                                            | low        | trivial         |          |
| 8   | Pasted-image root: document the copy, or allow the temp dir              | low        | his call        |          |
| 9   | Unreproduced `editMany` miss                                             | ?          | none            |          |

---

## 14. The one-paragraph version

At volume the tool is reliable: big speculative renders validate before writing, every ordinary
mistake fails loud with the fix in the message, and `session` plus `measure` plus screenshots make a
two-hour, 2,500-node exploration feel routine. The two findings that matter are both silent. `find`
with an undefined `within` searches the whole page and will edit the wrong node (§1) — trivially
fixable. Rotation pivots on the top-left corner while the docs promise centre, and `measure` reports
the unrotated box so nothing reveals it (§2). Behind those, `measure`'s parent-relative frame is
documented but didn't reach me (§3), radial gradients put their last stop outside the shape (§4), and
the overflow warnings need a quieter voice for parents that clip, because the loud one is being
learned as background (§7). Underneath all of it: a script is a string with no address, so every
validation error is paid for twice, and scripts-by-path would make the fails-loud model actually cheap (§11).
