# flcm / figma-mcp — agent DX notes, mobile-adaptation workload

Companion to `AGENT-DX-NOTES.md` in this folder. That one is from the componentization pass — build
components out of an approved desktop design. This one is from the session immediately after:
**adapt that finished 1600px desktop homepage down to a 393px mobile frame using the components it
just produced.** Where a finding overlaps, I cite the other file rather than restating it.

**Why this is a different workload.** Componentization is _additive and structural_ — you're making
new nodes and rewiring parents. Mobile adaptation is _subtractive and dimensional_ — the nodes all
already exist and you're changing one number (width, 1600 → 393) and then repairing everything that
number broke. That means the whole session is spent on sizing, reflow and constraint behaviour, and
it lands almost entirely on the parts of flcm's vocabulary that model **how a layout responds to
its container** — which turns out to be the thinnest part of the vocabulary.

I got through the Header and Hero (both verified by screenshot, both good) before an approval drop
blocked me. Findings below are from that stretch.

---

## 1. `layoutWrap`, `counterAxisSpacing` and `minWidth` are the entire mobile toolkit, and none of them are in flcm

This is a sharper version of `AGENT-DX-NOTES.md` §11, which files min/max width as a missing
feature. Having actually done the work, it's not one missing prop — it's that **the three
primitives that make a desktop grid become a mobile grid are all outside the vocabulary, and they're
only useful together.**

Every remaining section of this page is the same operation: a `NO_WRAP` row of N cards becomes a
wrapping 2-up grid. Here is what I had to write for the trust bar — the simplest instance of it:

```js
const bar = await figma.getNodeByIdAsync("951:5027");
bar.layoutWrap = "WRAP";
bar.itemSpacing = 12; // main-axis gap
bar.counterAxisSpacing = 16; // gap BETWEEN WRAPPED LINES — only meaningful once wrap is on
bar.paddingLeft = 20;
bar.paddingRight = 20;
bar.paddingTop = 18;
bar.paddingBottom = 18;
for (const item of bar.children) {
  item.layoutSizingHorizontal = "FILL";
  item.minWidth = 148; // this is what makes it 2-up instead of 4-up
}
```

Note what happened to the padding. flcm has a perfectly good word for padding, but once I was in
raw for `layoutWrap` I set padding raw too — because mixing the two conventions inside one function
is worse than committing to one. So a single missing prop pulled an entire section's layout code out
of flcm. That's the real cost, and it compounds: everything I write raw is code where I own font
loading, suffixed property names, and `figma.mixed` guards (`AGENT-DX-NOTES.md` §1, §13, §17).

What it should have been:

```js
await flcm.edit(bar, {
  layout: { mode: "row", flexWrap: "wrap", gap: 12, rowGap: 16, padding: { x: 20, y: 18 } },
});
await flcm.editMany(items.map((t) => ({ target: t, changes: { width: "fill", minWidth: 148 } })));
```

**The CSS mapping is clean and already correct**, which is the argument for doing it:

| Figma                    | CSS / flcm                  | Notes                 |
| ------------------------ | --------------------------- | --------------------- |
| `layoutWrap: 'WRAP'`     | `flexWrap: 'wrap'`          | direct                |
| `itemSpacing` (row mode) | `columnGap` — already `gap` | flcm's existing `gap` |
| `counterAxisSpacing`     | `rowGap`                    | see wrinkle below     |
| `minWidth` / `maxWidth`  | `minWidth` / `maxWidth`     | identical names       |

**The `counterAxisSpacing` wrinkle is worth designing for deliberately.** It's a property that
_only exists once wrapping is on_ — on a `NO_WRAP` frame it's inert. So it can't just be another
entry in the `layout` bag; setting `rowGap` without `flexWrap: 'wrap'` is meaningless and should
**fail loud** in exactly the way flcm already fails loud elsewhere:

```
flcm: "rowGap" only applies to a wrapping container — set layout.flexWrap: "wrap" beside it,
or use "gap" for the main-axis spacing you probably meant.
```

That error would have been genuinely useful, because `gap` vs `rowGap` in a wrap container is the
exact thing a person gets wrong.

CSS also gives you the shorthand for free if you want it: `gap: "16px 12px"` = `row-gap column-gap`,
which maps to `counterAxisSpacing` + `itemSpacing`. That's more idiomatic than two props and fits
the "CSS is the dialect" principle better.

**Suggestion:** add `flexWrap`, `rowGap` (or the two-value `gap` shorthand) to the `layout` object,
and `minWidth`/`maxWidth`/`minHeight`/`maxHeight` to the size props. Together they turn responsive
adaptation from a raw-API task into a first-class flcm one. Individually, any one of them still
forces the raw escape.

---

## 2. Silent sizing collapse when a cloned frame is narrowed

**What happened.** I cloned the desktop frame and set its width to 393. The hero is a row:
a **fixed 1024px** promo beside a **fill** segment rail. At 393 (353 after padding) there is no room
left, so the fill sibling clamped:

| Node                         | Desktop                | After width 1600 → 393    |
| ---------------------------- | ---------------------- | ------------------------- |
| `Block group/Segment rail`   | 480 × 472, `FILL/grow` | **1** × 472, `FILL/grow`  |
| `Segment tile — Tattoo` (×4) | 480 × 102, `FILL/grow` | **36** × 102, `FILL/grow` |

The tiles landed at exactly 36px — their own horizontal padding (18 + 18), hugging nothing.

This is correct Figma behaviour; it is not a bug. **The problem is that it's invisible in the
read.** I was inspecting with raw `layoutSizingHorizontal`, which cheerfully reports `FILL` for a
1px-wide node. A healthy fill node and a fully collapsed one are byte-identical in that read. The
only way I spotted it was noticing `w: 1` while eyeballing a structure dump, and the only way I knew
what to _restore_ was reading the untouched desktop original alongside.

The repair was to re-assert sizing that had never been un-set — it was still `FILL`, it just had
nothing to fill:

```js
{ target: flcm.id('951:5018'), changes: { width: 'fill', height: 'hug' } },   // rail
{ target: flcm.id('951:5023'), changes: { width: 'fill', height: 96 } },      // ×4 tiles
```

**What I'd want**, in order of preference:

1. **Surface intent-vs-realized divergence in the read.** flcm's render output already carries an
   `intent` field (`intent: { width: "fill", height: "hug" }`) beside the realized pixel size — so
   the ingredients exist. If `get` reported both, an agent could diff them and see a `fill` node
   realized at 1px. That's a general-purpose health signal, not a special case.
2. A `collapsed: true` flag, or a warning in the tool result, when a node's realized size falls
   below its own padding + content minimum after an edit.
3. Failing both, one line in the docs: _"narrowing a container below its fixed children's total
   width silently clamps its `fill` siblings toward zero; re-assert sizing after a resize rather
   than assuming it survived."_

I'd take (1). It's the smallest change and it makes a whole class of resize damage visible.

---

## 3. Fixed-width text does not reflow, and there's no bulk way to fix it

The single most common breakage when narrowing a cloned design, and the one I'd fix second.

Inside the hero's overlay copy frame — which I had already set to 313px wide — the text nodes were
still authored at desktop widths:

```
Up to 40% off rotary mac    540  FIXED
FK Irons, Peak, Bishop, …   470  FIXED
```

They rendered clipped: the subhead read `FK Irons, Peak, Bishop, Cheyenne. Pro pricing applie` with
the tail cut off at the frame edge. Nothing errored; the screenshot is how I caught it. The fix is
one word each:

```js
{ target: flcm.id('951:5009'), changes: { width: 'fill' } },
{ target: flcm.id('951:5010'), changes: { width: 'fill' } },
```

At which point they reflowed to 313 × 72 and 313 × 40 and looked right.

The ergonomic gap: **there is no way to say "every TEXT under this subtree should fill".** On a
14-section page that's the operation you want dozens of times. `flcm.editMany` takes explicit
targets only, so today it's `find` → map → `editMany`, and `find`'s results have to be plumbed
through by hand.

**Suggestion:** let `editMany` accept a query as a target, or add `flcm.editAll(query, changes)`:

```js
await flcm.editAll({ type: "TEXT", within: heroCopy }, { width: "fill" });
```

This is a small addition that pays for itself immediately on any adaptation workload, and it reuses
the `find` query shape that already exists.

---

## 4. Free-form overlay children ignore the resize entirely

The promo block is a free-form frame (no auto-layout) with an image rect, a scrim, and an absolutely
positioned copy frame — the standard hero-with-overlay construction. I resized it from 1024 × 472 to
353 × 440. The auto-layout parts adapted. The free-form children did not:

- The copy frame stayed at **540 × 167 at (56, 56)** — 540 wide inside a 353 box.
- The carousel dots landed at **(56, 404)** — in a box that was 400 tall at the time, i.e. sitting on
  or past the bottom edge.

Constraints were in play (the parent design is well built) but they scale/pin a child, they don't
re-lay-it-out, so a 3:1 width change just produces a correctly-pinned overflowing element. I had to
place both explicitly:

```js
{ target: flcm.id('951:5006'), changes: { width: 313, left: 20, top: 152 } },
{ target: flcm.id('951:5014'), changes: { left: 20, top: 414 } },
```

I don't think this is fixable in flcm — it's what constraints are. But it _is_ the thing that makes
"clone the desktop frame and narrow it" only about 80% automatic, and it's worth a sentence in any
responsive guidance: **auto-layout subtrees survive a width change; free-form subtrees need manual
replacement of every coordinate.** Knowing that up front changes how you budget the task.

Related, same category: hug-width instances silently overflow. The hero's two CTAs are Button
instances at 163 and 146 wide with a 12px gap — 321px into 313px of space. Nothing warns; they just
poke out. I restacked the row to a column with both buttons `width: 'fill'`, which is the correct
mobile treatment anyway.

---

## 5. Connection and approval failure modes — what I actually saw

I hit three distinct failure strings in one session and they behave very differently. Being precise
because the expensive one is expensive.

**(a) "momentarily disconnected" — transient, retry immediately.** Exact string:

```
The Figma plugin is momentarily disconnected — the server restarted and the plugin reconnects on
its own within a second or two, so this call did not run. Retry this exact call.
```

I got this **4 times** (once on a structure read, twice on the clone, once on a ping). Every one
cleared on the next attempt. The message is accurate, returns instantly, and its explicit
"do NOT ask the user to reopen the plugin" is good — that instruction stopped me throwing away a
valid approval. **Keep this message as-is.**

One thing I did that I'd recommend as standard practice: after two "did not run" responses on a
_mutating_ call (the clone), I listed the page's children before retrying, to confirm no partial
clone had landed. It hadn't — the claim was truthful. But "did not run" is a claim about a write,
and verifying it costs one cheap read.

**(b) "No Figma plugin connected" — presents as fatal, was actually transient.** Exact string:

```
No Figma plugin connected. Open the Framelink plugin in Figma desktop and try again.
```

This one reads like a hard stop and tells you to go bother the human. I sent a one-line ping instead
and it worked immediately; the plugin had never closed. **This is a false escalation** — it's the
same underlying transient as (a) but with a message that directs the agent to interrupt the user for
nothing. Suggest either collapsing it into (a)'s wording, or adding "if this persists across two
retries" before the instruction to open the plugin.

**(c) Approval drop — the expensive one.** Exact string:

```
This Figma session is not approved yet, so this call did not run — the server held the call open
for 40s waiting for approval and it didn't arrive. … approve session 2886 …
```

It happened twice. The first time (session `1015`) a single retry caught it — the human was
evidently mid-click. The second time (session `2886`) it never recovered, and **I retried five
times: three full calls and two pings, each held open for 40s ≈ 200 seconds of dead wall-clock**
before I stopped and escalated.

That was my mistake, and it's worth naming precisely so the next agent doesn't repeat it. The
reasoning error was treating (c) like (a). But (a) is free — it returns instantly — while **(c) costs
40 seconds per attempt and cannot possibly succeed unless a human clicks something.** Retrying an
unattended blocker is just sleeping.

**The right agent behaviour, concretely:**

| Failure                     | Retries              | Then                                                        |
| --------------------------- | -------------------- | ----------------------------------------------------------- |
| "momentarily disconnected"  | up to 3, immediately | escalate; verify no partial write first if the call mutated |
| "No Figma plugin connected" | 2                    | escalate                                                    |
| "session is not approved"   | **1**                | **escalate with the code immediately**                      |

One retry on (c) is worth it — it catches the mid-click case, which is real, and it's the difference
between a smooth resume and a needless interruption. Two or more is not.

**The product observation underneath this:** I was running as a subagent, and **a subagent cannot
prompt the user.** So an approval drop mid-run is an unconditional hard stop for exactly the
workload the tool is most valuable for — long unattended edits. The session id also rotated between
drops (`1015` → `2886`), so a code relayed in a report may already be stale by the time a human
reads it. Worth considering: a longer-lived or inheritable approval, or approval scoped to the file
rather than the connection, so that an hour-long agent run doesn't need a human at the 40-minute
mark.

---

## 6. What worked well

- **Cloning a 14-section, ~800-node, ~120-instance frame was one fast operation** and every instance
  link survived. The whole clone-then-adapt strategy rests on that and it held up completely.
- **Partial `layout` deltas merge rather than replace.** I re-padded 12 sections with
  `{ layout: { padding: {...} } }` and every section kept its existing `mode` and `gap` —
  e.g. a section reading `V g22 p[40,52,40,52]` became `V g22 p[20,36,20,36]`. That's the behaviour
  you want and it isn't stated outright in the props table; worth saying so explicitly, because the
  alternative (a `layout` object replacing wholesale) is equally plausible from the docs and would
  have silently flattened 12 sections.
- **Root-level overrides on instance roots worked exactly as advertised.** I resized six instances
  from their instance roots — four `Segment tile`s to `width: 'fill', height: 96` and two `Button`s
  to `width: 'fill'` — with no effect on their masters and no detaching.
- **Neither section I completed needed a Mobile variant of any component.** Header and Hero were
  both achievable through container changes and root-level instance overrides alone. That's a real
  validation of the fluid-first approach: the components as built are genuinely width-agnostic, and
  the desktop-only assumptions all lived in the _sections_, not the components.

---

## 7. Doc gaps specific to responsive work

- **The `layout` table doesn't name its own absence.** It lists `mode, gap, padding,
justifyContent, alignItems` with no indication that Figma _has_ wrap and flcm doesn't cover it. An
  agent reading that table reasonably concludes wrap isn't available in Figma at all, and designs
  around a constraint that doesn't exist. One line — _"No wrap and no min/max sizing yet: set
  `layoutWrap` / `counterAxisSpacing` / `minWidth` via raw `figma._`"\* — would have saved me
  rediscovering it.
- **"Responsive by default" is about the wrong kind of responsive.** That heading in the `props`
  section covers constraints on _positioned_ children — how a pinned node behaves when its parent
  resizes. I went to it expecting guidance on auto-layout responsiveness (fill/hug/min-max under a
  changing container) and it's a different topic. The content is good; the heading collides with the
  main meaning of "responsive" for anyone doing breakpoint work. Consider "Constraints on positioned
  children".
- **Nothing covers narrowing an existing layout.** The docs assume you're building at a known size.
  There's no passage on what happens to `fill` siblings, fixed-width text, or free-form overlays when
  a container shrinks — which is the entire mobile workload. A short "Adapting a design to a
  narrower frame" section covering §2, §3 and §4 above would be the responsive counterpart to the
  "promoting an existing design" guide that `AGENT-DX-NOTES.md` §6 asks for.

---

## 8. What I'd fix first

**`flexWrap` + `rowGap` + `minWidth`/`maxWidth` in the `layout` and size vocabularies.** Not because
each is individually large, but because they're the three legs of one operation — turning a fixed
N-across row into a wrapping grid — and missing any one of them drops the whole section into raw
`figma.*`, which is where every other hazard in both these files lives. Second: surface
intent-vs-realized size divergence in the read, so a `fill` node collapsed to 1px doesn't look
identical to a healthy one. Third, and cheapest: make the "No Figma plugin connected" message stop
telling agents to interrupt the human over what is usually a one-second reconnect, and add a line to
the approval message about how expensive a retry is, so agents escalate after one attempt instead of
sleeping for three minutes like I did.

---

## 9. Instance sublayers: one mutation fails silently, the neighbouring one throws

This is the single most expensive thing I hit, and it cost me the most because of _how_ it failed,
not _that_ it failed.

Inside an instance, a sublayer's size and position are locked to the main component. Two ways of
trying to change them behave completely differently:

```js
// SILENT NO-OP — reports success, dimensions unchanged
await flcm.edit(flcm.id("I951:5040;950:4194"), { width: 132, height: 132 });
node.resize(132, 132); // also silent; logs fine, nothing moves

// LOUD THROW
node.x = 20;
// Error: in set_x: This property cannot be overridden in an instance: relative-transform
```

Same conceptual operation — "this sublayer is the wrong shape for a 393px frame" — and one half of
it tells me and the other half lies. I spent two round-trips writing a resize, reading back the
node, seeing the old numbers, assuming I'd addressed the wrong id, re-reading the tree, and writing
it again. The `set_x` error message is the good one: it names the property, names the reason, and is
immediately actionable. `resize()` should throw the same class of error rather than returning
cleanly.

Worse, in a mixed `editMany` the _other_ keys apply. I sent `{ width, height, fontSize, fills }` to
a set of Category tile sublayers; the type and fill changes landed, the dimensions didn't, and the
call reported success. There's no partial-application signal anywhere in the result. If flcm can't
detect this ahead of time, the minimum viable fix is to echo back the realized values for any
geometry key it was asked to set, so a diff is visible without a second read.

### The knock-on: fixed-size images inside cards dictate the mobile grid

Because a card's image well can't be shrunk through its instance, the card has a hard minimum width
that has nothing to do with the design. Category tile has a 132px image plus 20px padding either
side; Brand tile has a 140px logo. On a 353px content width that arithmetic allows exactly two
columns and no more — so several sections are 2-up not because 2-up is the right rhythm for them,
but because the API wouldn't let me go 3-up. That's a layout decision made by a tooling limitation,
and it's invisible in the resulting file. Anyone auditing this later will assume it was deliberate.

The proper fix is a `Size` variant axis on those components (as I did for Product card), which is a
_master_ edit — out of scope for a mobile pass that's forbidden from touching masters. Worth
flagging in the docs: **if a component contains a fixed-size child, it cannot be adapted to a
narrower breakpoint through instances at all. Plan the variant axis at component-creation time.**

---

## 10. Detaching was the only escape hatch, and I used it six times

Promo card (×3, section 09) and Facet card (×3, section 07) both put their copy block in as a
free-form child with `MIN/MIN` constraints at a fixed 400px inside a non-auto-layout parent. At
393px the copy ran off the card and took the CTA with it. Nothing reachable from the instance fixes
it: `resize()` no-ops (§9), `.x` throws (§9), and constraints on a child you can't move don't help.

So I detached those six instances **on the mobile frame only** and fixed them as plain frames:

```js
const card = inst.detachInstance();
card.layoutSizingHorizontal = "FILL";
card.resize(card.width, 250);
const copy = card.children[2];
copy.resize(313, copy.height);
copy.x = 20;
copy.y = 250 - copy.height - 18;
copy.constraints = { horizontal: "STRETCH", vertical: "MAX" };
```

That works, and it's the right call for a comp, but it's a real cost: those six cards are now
disconnected from their masters and won't receive any future component change. `detachInstance()` is
a one-way door with no flcm-level warning around it. A `flcm.detach` that logged _what was lost_
(component name, which overrides were baked, how many siblings remain attached) would at least make
the debt legible in the transcript.

---

## 11. Reading a layout tells you almost nothing about whether it looks right

I caught most of the genuine problems in this pass from **screenshots, not from reads.** Examples
the structural read looked completely healthy for:

- **Trust bar**: four instances at `171` wide, all `FILL`, all `HUG` height — textbook. The screenshot
  showed all four cells' text running over each other, because the `Copy` frame _inside_ each
  instance was `HUG` at 177px and simply overflowed its parent. Overflow is not an error state in the
  model; it's just a child wider than its parent, and nothing in a read flags it.
- **Section headers**: `Copy` HUG + `Link` HUG in a horizontal row reads fine at any width. At 353px
  "Studio & medical supplies" and "Shop all studio →" were printing on top of each other.
- **Header nav**: seven HUG children in a `NO_WRAP` row. Structurally valid, visually a sentence cut
  off mid-word at the frame edge.

All three are the same bug class — **content wider than container, in a frame that doesn't clip** —
and it is completely invisible to `get`/`find`. This is worth a first-class affordance: a
`flcm.audit(nodeId)` that walks a subtree and reports children whose bounds exceed their parent's,
text nodes whose rendered width exceeds their box, and `FILL` nodes realized under some threshold.
Every single defect I fixed in the review pass would have come out of that one call, and I'd have
found them in one round-trip instead of fourteen screenshots.

Related: `get_screenshot` on the full 393×12757 frame renders at a scale where nothing is legible.
`scale` exists but it's the wrong lever here — it multiplies resolution uniformly, so the only way
to make a 12757px-tall artboard readable is to make the image proportionally enormous. What's
missing is a **crop**: a `region` argument (`y: 4200, height: 900`), or the ability to screenshot a
y-range of a frame. Without it, reviewing a tall mobile artboard means one call per section and
knowing every section id in advance — fourteen round-trips to do what one scrolling review would do
for a human.

---

## 12. Things I got wrong, and why

Recording these because the _why_ is usually a tooling affordance, not carelessness.

- **I dropped the wrong six category tiles.** The desktop rail has twelve; mobile takes six. I
  filtered by index rather than by content and ended up with a six-tile grid that was entirely
  tattoo — no jewelry, no piercing, no PMU, no PPE. Nothing in the tree read tells you a tile's
  _subject_; the layer names were uniform and the distinguishing content was in image fills and
  component property values I hadn't read. I rebuilt the balance by copying Title/Count property
  values and image fills across from the desktop original. A read that surfaced instance
  `componentProperties` values inline (rather than requiring a separate lookup per node) would have
  made the imbalance obvious at a glance.
- **A "Shop all machines" button survived into the Piercing section.** It came in as a clone and the
  label is a component _property_, so it doesn't appear in the layer name or in a normal subtree
  read — the instance was still called `Button — Shop all machines` while sitting inside a piercing
  card. Same root cause as above: property values are invisible unless you go looking for them.
  Cross-checking against the desktop frame's text content is what caught it.
- **I set `counterAxisAlignItems = 'STRETCH'` on a wrapping row** to equalize card heights per row.
  It's rejected — `Expected 'MIN' | 'MAX' | 'CENTER' | 'BASELINE'`. The working equivalent is
  `child.layoutSizingVertical = 'FILL'` on each child, which does stretch to row height under wrap.
  That equivalence isn't documented anywhere and I found it by guessing.
- **Stale sizing modes after changing `layoutMode`.** Flipping a frame from `HORIZONTAL` to
  `VERTICAL` keeps children's `layoutGrow`/`layoutSizingVertical` from the old axis, so a footer
  input that had been `FILL`-width became `FILL`-_height_ and collapsed to 1px tall, and the band
  itself stayed `FIXED` at its old 1182px. Nothing errors. Any `layoutMode` flip needs an immediate
  sweep of `layoutGrow` and both sizing modes on the frame and every child — that would be a good
  thing for flcm's `layout` verb to do automatically, since the old-axis values are never meaningful
  after the flip.
