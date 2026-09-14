# flcm / figma-mcp — agent DX notes

Written by Claude (Opus 5) immediately after a real session, not from reading the code.

**The task:** take an approved 1600×7065 desktop homepage design (14 sections, ~800 nodes, zero
components) and componentize it — build 16 components, replace all ~120 occurrences with instances,
preserve pixels exactly, in preparation for a mobile design. Everything below is something I
actually hit, in the order it cost me time.

The headline: **the create-from-scratch path is excellent and the promote-an-existing-design path
is undocumented.** Nearly every problem below is a variant of that one gap. The verbs I needed
mostly exist; I just had to discover the workflow by trial and error, and the two things that
genuinely don't exist (`replace`, image-by-`imageRef`) are both only needed on that path.

Two of these (§7, §9) are **silent data/geometry corruption**, not ergonomics. Those are the ones
I'd fix first.

---

## 1. The font-loading cliff (the thing that actually broke)

**What happened.** One `figma_execute_code` call exceeded the 120s MCP timeout, got backgrounded,
then died at the 300s idle limit — leaving the document half-mutated (a component built, one
instance created, the node it was replacing not yet deleted). I had to write a recovery script to
work out how far it got.

The cause was mine, but it's a mistake the docs invite. I was copying text onto instance sublayers
in bulk and wrote:

```js
async function setText(node, value) {
  await figma.loadFontAsync(node.fontName); // ← per node, serial, inside a nested loop
  node.characters = value;
}
```

Two instances × 7 links, plus three cards × 5 chips ≈ 30 serial `loadFontAsync` round-trips. The
fix was three lines:

```js
const fonts = new Map();
collect(...);                                  // walk the trees, dedupe by family|style
await Promise.all([...fonts.values()].map(f => figma.loadFontAsync(f)));
```

**3 distinct fonts, loaded once, in parallel. The identical work then returned instantly.**

**Why I wrote the bad version.** I dropped to the raw API because I was setting text on _instance
sublayers_ in bulk, and I wasn't confident `flcm.editMany` would accept `I<instanceId>;<path>`
targets. The `edit` docs do say `flcm.edit("I12:3;4:5", …)` works — but it's one sentence of prose
inside the components section, with no example. So I hedged toward raw.

**Suggestions, in priority order:**

1. **Make `editMany` pre-scan for fonts.** Collect every distinct `fontName` across all entries that
   change `text`, `Promise.all` the loads, _then_ apply. This is invisible to the caller and makes
   the fast path the default path. If it already does this — say so in giant letters, because I had
   no way to know.
2. **State the guarantee explicitly** in the `edit` section: _"flcm loads fonts for you. You never
   need to call `figma.loadFontAsync`. If you drop to raw `figma._`to set`characters`, you own
   font loading — dedupe and parallelize."\* One sentence would have saved this whole incident.
3. **Show one bulk instance-sublayer example.** The single most common real operation — "I have 6
   instances and per-instance text for each" — has no worked example anywhere.
4. Consider a soft warning when a single `figma_execute_code` call issues more than ~N serial
   `loadFontAsync`s. The failure mode is a 300s hang, which is expensive and leaves a partial write.

---

## 2. The pairing-code preamble is on every reference call

Every `get_flcm_reference` response opens with ~170 tokens of pairing-code instructions — including
the ones I made _after_ the session was approved and I'd run a dozen successful
`figma_execute_code` calls.

I called the reference 4 times. That's ~700 tokens of text telling me to relay a code the user
didn't need. It also creates ambiguity about whether the session state has changed, when it hasn't.

**Suggestion:** only emit the banner when the session isn't approved. If you want it always present,
make it one line stating the actual state: `Session approved — no action needed.`

---

## 3. `flcm.get()` on a COMPONENT doesn't return what a FRAME returns

Straight after promoting a node, I did the obvious thing:

```js
const comp = await flcm.component(flcm.id('950:4192'), { name: 'Category tile', propertyDefinitions: {...} });
const spec = await flcm.get(comp.node);
spec.node.children.map(...)   // TypeError: cannot read property 'map' of undefined
```

I needed the children's ids to bind properties to them (§6), so this is directly on the critical
path of every component I built. I fell back to raw `figma.getNodeByIdAsync` + a hand-written tree
walk, and used that for the remaining 15 components — meaning **I never used `flcm.get` again after
the first hour.**

If a COMPONENT's children are deliberately reported through the `components` map rather than
inline, that's defensible, but the docs describe that shape only for _instances_ ("An INSTANCE
therefore carries no `children` of its own"). Nothing says a COMPONENT differs from a FRAME.

**Suggestion:** either return `children` inline for a COMPONENT (it's a frame with a hat), or
document the difference and show how to reach the sublayer ids you need for binding.

---

## 4. Return-shape inconsistency across the creating verbs

```js
const r = await flcm.render(tree);      // { node, keyed }
const c = await flcm.component(spec);   // { node, keyed }
const s = await flcm.variants([...]);   // the handle ITSELF — no .node
```

I wrote `set.node.id`, got `flcm: cannot resolve target undefined`, and — this is the annoying part
— **the four member components had already been created and combined into a set before the throw.**
The failed call left a real COMPONENT_SET on the canvas that I had to go find by scanning the
staging frame. I worked around it with `set.id || set.node.id` for the rest of the session, which is
the kind of line you write when you've stopped trusting the API.

**Suggestion:** make `variants` return `{ node }` like its siblings. Also worth noting that
`variants` isn't atomic the way `edit`/`editMany` are ("nothing is written until every gate
passes") — the set was created and _then_ my code failed. The atomicity contract that's stated so
clearly for `edit` isn't stated, or apparently held, for `variants`.

---

## 5. `flcm.component()` returns a node with a NEW id

`createComponentFromNode` replaces the node, so the id you passed in is dead afterwards:

```js
await flcm.component(flcm.id('950:4192'), {...});
await figma.getNodeByIdAsync('950:4192');   // null
```

The children keep their ids (which is what makes binding work), but the root doesn't. The docs say
the target form _"promotes in place — same parent, same index"_, which reads like the node survives.
It survives _positionally_, not _identically_.

**Suggestion:** one line in the target-form bullet: _"The COMPONENT is a new node with a new id; its
children keep theirs. Use the returned handle, not the id you passed in."_

---

## 6. The two-step property dance on the promote path is undocumented

This is the biggest doc gap, so I'll be specific about the model I had to reverse-engineer.

**The docs only show the spec form**, where declaring and binding happen in one call and
`defaultValue` is derived from the binding node:

```js
await flcm.component(
  flcm.frame({...}, [ flcm.text("Label", { componentPropertyReferences: { text: "Label" } }) ]),
  { propertyDefinitions: { Label: { type: "text" } } },   // no defaultValue — derived
);
```

**When you promote an existing node that's structurally impossible.** There's no spec to hang
`componentPropertyReferences` on — the children are already live nodes. So:

- `defaultValue` becomes **required** (nothing binds the property in this call, and the rule
  _"a property nothing binds must state a defaultValue"_ kicks in)
- binding is a **second call**, `flcm.edit(sublayerId, { componentPropertyReferences: {...} })`
- which means you need the sublayer ids, which is where §3 bites

The working shape, which nothing in the docs shows:

```js
// 1. clone into a staging frame (see §8)
const c = await flcm.clone(flcm.id(srcId), flcm.id(STAGE));
await flcm.edit(c.node, { left, top, width, name });

// 2. promote, declaring properties with EXPLICIT defaults
const comp = await flcm.component(c.node, {
  name: "Category tile",
  propertyDefinitions: {
    Title: { type: "text", defaultValue: "Tattoo Machines" }, // required here — and see §7
  },
});

// 3. re-read via raw API to get sublayer ids (§3), then bind — batched
const live = await figma.getNodeByIdAsync(comp.node.id);
await flcm.editMany([
  {
    target: flcm.id(live.children[1].children[0].id),
    changes: { name: "Title", componentPropertyReferences: { text: "Title" } },
  },
]);
```

**Suggestion:** add a worked example called _"Promoting an existing design block"_. It's the whole
second half of the product's job — the first half is generating designs, the second is systematizing
designs somebody already made — and right now only the first half has examples.

---

## 7. FOOTGUN: an invented `defaultValue` permanently overwrites real content

This one is silent data loss and it bit me for real.

Because the promote path _requires_ `defaultValue` (§6) and I was declaring eight text properties
for a footer link column, I typed placeholder defaults rather than reading the eight real strings
off the node first:

```js
for (let i = 1; i <= 8; i++) defs["Link " + i] = { type: "text", defaultValue: "Link " + i };
```

The moment I bound the layers, all eight real link names — "Tattoo machines", "Cartridges", … —
were replaced by "Link 1".."Link 8" in the master. I didn't notice because every _instance_ had a
per-instance override, so the page still looked right. It only surfaced later when the human looked
at the component library and saw a column of `Link 1…Link 8` placeholders.

**Then it got worse.** Later I deleted those eight properties (they were over-engineering — see the
"property vs override" note in §18). The docs say deleting a property _"frees the layers it drove"_
— and it does, but the layer keeps **the invented default**, not the content it had before the
property ever existed. The original strings were gone. I had to re-type all eight by hand.

So the failure chain is: _target form requires a defaultValue_ → _nothing tells you it will
overwrite_ → _instances mask the damage_ → _deleting the property bakes the damage in permanently._

**Suggestions:**

1. **Derive `defaultValue` in the target form too.** At the moment `flcm.edit(node, {
componentPropertyReferences: { text: 'Title' } })` binds a layer, flcm could read that layer's
   current text and use it if the property has no explicit default. That removes the requirement
   entirely on the path where it's most dangerous.
2. **Failing that, warn loudly in the docs:** _"In the target form, read `defaultValue` off the node
   you are about to bind. A value you invent will overwrite that node's real content, and deleting
   the property later will not restore it."_
3. Consider making property deletion restore the pre-binding value if flcm can retain it.

---

## 8. The staging-frame workflow is load-bearing and undiscoverable

You cannot clone a fill-sized node onto the page:

```
flcm.clone: "fill" and "N%" resolve against a parent frame, and this node's parent is the page —
a page has no bounded size. Use pixel dimensions, or move the node into a frame first.
```

Good error — it told me the fix. But this is _the first thing you hit_ when componentizing an
existing design, because every block in a well-built design is `fill`-sized. The recipe I settled on
and used 16 times:

```js
// A free-form (no auto-layout) staging frame, so promoted components don't get re-laid-out
const { node: stage } = await flcm.render(
  flcm.frame({
    name: "Components",
    left: 1760,
    top: 0,
    width: 1600,
    height: 2600,
    fill: "#fafbfc",
    clip: false,
  }),
);
const c = await flcm.clone(flcm.id(srcId), stage);
await flcm.edit(c.node, { left, top, width: 237 }); // fill → fixed, and place it
```

The subtlety worth documenting: **the staging frame must not have auto-layout**, or it repositions
and resizes every component you park in it. I got that right by luck. But going free-form is what
sets up §9.

---

## 9. FOOTGUN: `clone` keeps `fill` sizing into a free-form parent, and silently stretches

**The bug the human spotted:** one of my sixteen components, `Segment tile`, came out **480 × 2600**
instead of 480 × 102. Twenty-five times too tall, sitting in the middle of the component library.

**Why.** In the design, `Segment tile` lives in a vertical hero rail with `layoutSizingVertical:
FILL`. I cloned it into the free-form staging frame from §8 — which I had arbitrarily made 2600px
tall. `fill` was preserved, and in a free-form parent it resolved against the parent's bounds. So
"fill" silently came to mean "be 2600 tall", and then I promoted that to a COMPONENT. Every instance
minted from it would have inherited that.

**The part that makes it a genuine footgun rather than my carelessness:** flcm _already has this
guard_. Cloning onto a page refuses precisely because "a page has no bounded size" (§8). But a
free-form FRAME is in exactly the same semantic position — its height is an arbitrary number the
author picked, carrying no layout meaning — and there the same operation succeeds silently. The
guard checks _"can this resolve?"_ when the question that matters is _"does this resolve to anything
meaningful?"_

It's also self-concealing: I verified every section with screenshots and saw nothing, because the
_instances_ re-acquire `fill` from their real rows. Only the master was wrong, and masters live
off-canvas where you don't look.

**And it's the fourth link in a chain**, which is why I think it's worth fixing at the root:

1. Cloned nodes retain `fill` sizing.
2. So an auto-layout staging frame would stretch every component you park in it…
3. …which forces a free-form staging frame, which offers no layout help — hence hand-picked
   coordinates and the ragged, hand-placed library the human then had to ask me to tidy.
4. And free-form + retained `fill` = silent stretch to an arbitrary number.

**Suggestions:**

1. **On `clone`/`move` into a free-form parent, clear `fill`/`%` sizing and fix the node at its
   current pixel size.** A free-form parent has no primary/counter axis, so there is no axis for
   `fill` to be a mark on. This matches the language already in the docs for `move` ("`fill` … is
   cleared and re-applied against the new parent") — there's just nothing to re-apply it to here.
2. Or extend the page guard: refuse, and say _"this node is `fill`-sized on the vertical axis and
   the destination is free-form; pass an explicit `height`."_
3. Longer term, a **`flcm.library(components, options)`** helper — take N components, lay them out
   on a grid with labels, size the board to fit — would remove the whole chain. Building a component
   library is a first-class use case and it currently has no layout support at all, which is why
   mine came out ragged enough to need a second pass.

---

## 10. Missing: a `replace` verb

The single most repeated operation in the task, ×120:

```js
const res = await flcm.insertBefore(flcm.id(oldId), flcm.instance(comp, {
  width: old.layoutSizingHorizontal === 'FILL' ? 'fill' : old.width,   // hand-carried sizing
  componentProperties: {...},
}));
const rect = await figma.getNodeByIdAsync('I' + res.node.id + ';' + imgPath);
rect.fills = oldFills;                                                  // raw fallback (§11)
await flcm.remove(flcm.id(oldId));
```

Four steps, and I wrote this `sizeOf(old)` helper in _every single call_ because the instance
doesn't inherit the layout sizing of the thing it replaces:

```js
function sizeOf(old) {
  const s = { width: old.layoutSizingHorizontal === "FILL" ? "fill" : old.width };
  if (old.layoutSizingVertical === "FILL") s.height = "fill";
  return s;
}
```

**Suggestion:** `await flcm.replace(target, spec)` — put `spec` where `target` is, **inherit
`target`'s layout sizing, layoutGrow and constraints**, delete `target`, return the new handle. The
sizing inheritance is the valuable half: it's the part I'd have silently got wrong if I hadn't been
screenshotting.

There's also a related trap I hit twice: **capture text and fills as plain values before you remove
the source node.** Holding a node reference across `flcm.remove` throws `node does not exist`, and
because the removal has already happened, the throw leaves the document mutated.

---

## 11. Missing: image fills by `imageRef`

`flcm.image(src)` takes an https URL or a local path under the server's asset root. There is no way
to say _"the image already in this file, the one this other node is using."_

Componentizing an existing design is ~90% moving existing images onto new instances. So every card
type forced the same raw fallback:

```js
const rect = await figma.getNodeByIdAsync("I" + instId + ";" + imgPath);
rect.fills = oldRect.fills; // raw figma.* — flcm has no word for this
rect.resize(oldRect.width, oldRect.height);
```

`flcm.get` _reports_ the fill as a rich object (`{ type: "IMAGE", imageRef, scaleMode, objectFit,
imageDownloadArguments… }`), so the read vocabulary knows about it — but the write vocabulary can't
consume it. That directly violates the stated "read words are write words" principle, and it's the
violation that cost me the most raw-API escapes.

**Suggestion:** accept a read's image-fill object back as a `fill` value, or add
`flcm.image({ imageRef })`.

---

## 12. Missing: `minWidth` / `maxWidth` / `layoutWrap`

The task was _componentize in preparation for mobile_. Figma's min/max width on auto-layout, plus
auto-layout wrap, are precisely the mechanisms that make a component survive being narrowed — a card
with `width: fill, minWidth: 160` inside a wrapping row **is** a responsive grid, with no variants
and no second design.

flcm has no word for any of them (`layout` is `{ mode, gap, padding, justifyContent, alignItems }`),
so I couldn't express the one thing the task was actually about, and had to hand the mobile agent
raw-API instructions (`node.layoutWrap = 'WRAP'`, `node.minWidth = 160`) instead.

In CSS-dialect terms these are `min-width`, `max-width` and `flex-wrap`, so they'd sit naturally in
the existing vocabulary. **This is my top feature request** — it's what "prepare this for mobile"
means, mechanically.

---

## 13. `flcm.variants` can't add to an existing set — and this is about to bite

Documented as a known gap: _"there is no add-to-an-existing-set form."_

For generate-from-scratch that's fine. For real design-system work it's a wall. The very next step
on this project is adding a `Breakpoint = Desktop | Mobile` axis to ~6 of the components I just
built. Today that means rebuilding each set from scratch and re-pointing every instance — and
re-pointing instances means losing or manually re-applying every override, across ~120 instances.

I had to explicitly forbid the mobile agent from attempting it.

**Suggestion:** `flcm.variants` accepting an existing set as a target, or an
`addVariant(set, component, variant)`. This is the difference between "flcm can build a design
system" and "flcm can build a design system once."

---

## 14. Read words are NOT always write words

The stated principle is strong and mostly true, which makes the exceptions cost more than they would
in an API that didn't promise it. Two I hit:

**Property bindings.** Read reports the Figma word, write takes the CSS-ish word:

```js
// what get / componentPropertyReferences reports:
{ "characters": "Title#950:7", "visible": "Show count#950:9" }
// what you must write:
{ text: "Title", visible: "Show count" }
```

So `visible` round-trips and `characters`/`text` doesn't. I noticed only because I logged bindings
back to verify them.

**Property names carry an id suffix on read, and the two APIs disagree about it:**

```js
comp.componentPropertyDefinitions; // { "Label#950:50": {...}, "Style": {...} }
instance.setProperties({ Label: x }); // ✗ Could not find a component property with name: 'Label'
flcm.edit(inst, { componentProperties: { Label: x } }); // ✓ resolves bare names
```

This cost me a failed call on a nested Button instance inside a Collection nav card. flcm's
behaviour is the nicer one; the trap is that mixing raw and flcm in one script — which §3, §10 and
§11 all force you to do — means switching between the two conventions constantly.

---

## 15. `flcm.find` can't filter by component

I wanted "every instance of this component" — the bread-and-butter query for auditing a
componentization pass. `find`'s query is `{ type, name, key, within }`, so I walked the tree
manually and immediately hit:

```
in get_mainComponent: Cannot call with documentAccess: dynamic-page.
Use node.getMainComponentAsync instead.
```

So the manual path needs an async call per node, and the ergonomic path doesn't exist. I ended up
filtering by layer _name_, which worked only because I'd been disciplined about naming instances
`Category tile — {title}`.

**Suggestion:** add `componentId` to `find`'s query. `flcm.find({ componentId: comp.id })` is how
you answer "did I get them all?", which is the last question of every migration.

---

## 16. `get_screenshot` renders isolated nodes on transparency — and it caused a false alarm

I screenshotted a footer band to verify my work. It came back as pale blue text on white, with the
column headings **completely invisible**. I thought I'd destroyed the footer and started diagnosing.

Nothing was wrong. The band's dark navy comes from its _parent_, so rendering the band alone put
white headings on a transparent (→ white) background. I confirmed by screenshotting the parent.

A couple of wasted minutes, and more importantly a moment where I nearly "fixed" something that
wasn't broken — the worst class of agent error.

**Suggestion:** a `background` option (`"parent"` | a CSS color | `"checkerboard"`), defaulting to
compositing against the nearest opaque ancestor. Or a note in the tool description.

Everything else about this tool is great — `scale` up to 4, and the build → screenshot → look → fix
loop is what made me confident enough to touch ~120 nodes in a revenue-critical file. I screenshotted
after every batch and it caught nothing, which is exactly what you want it to do. (Though note §9:
it can't catch a defect that only exists on the master, off-canvas.)

---

## 17. `get_flcm_reference` section granularity

`components` is one enormous section: create + propertyDefinitions + bindings + variants + slots +
instance + overrides + detach + edit. I needed _"how do I declare a text property on a promoted
node"_ and got ~4,000 tokens including the entire slot system, which I never used.

The no-arg index also repeats the whole cheat-sheet that's already in the `figma_execute_code` tool
description I have in context.

**Suggestion:** split into `components-create`, `components-properties`, `components-variants`,
`components-slots`, `components-instances`; trim the duplicated cheat-sheet.

---

## 18. Guidance the docs don't give: property vs. override

Not a bug — a missing paragraph, and the human caught me getting it wrong mid-task.

The docs state the mechanics of both perfectly and never say when to reach for which. I declared
eight `Link N` text properties on a footer column, which was over-engineering: they're eight
identical siblings you can double-click on canvas, so all I did was clutter the properties panel,
invent meaningless names, and set up the data loss in §7.

The rule I landed on, which I'd put in a box in the docs:

> **Use a property when the layer is hard to reach** — buried in the tree, or hidden — **or when the
> name carries meaning** (`Title`, `Price`). **Otherwise use an override.**
>
> The asymmetry that makes _boolean_ properties worth declaring: an override can hide a layer fine,
> but un-hiding it means hunting for an invisible layer in the tree. So a boolean earns its place
> when a layer is optional _by design_.

Corollary I applied when auditing my own work: **declare a boolean only if some instance actually
uses it.** I'd speculatively added `Show count`, `Show badge`, `Show link 5–8` — zero instances used
any of them. `Show eyebrow` stayed, because 3 of 6 section headers genuinely turn it off.

---

## 19. Smaller things

- **`clipsContent` → `clip`.** The Figma word is `clipsContent`, the CSS word is `overflow`, flcm's
  word is `clip` — a third option, not guessable from either direction. (The error listed every
  valid prop, so it cost one round-trip.)
- **`figma.mixed` is a Symbol and breaks naive serialization.** My first structure-dump threw
  `TypeError: cannot convert symbol to string` on a text node with mixed `fontSize`/`fontName` (a
  price with a strikethrough run). Every agent writing an inspection script hits this on their first
  non-trivial file. One line in the raw-escape-hatch section would cover it.
- **Mixed-run text can't survive a text property.** A price node reading `$49.99  $149.99`, where
  the second run is 14px strikethrough, loses its styling the moment a `text` property drives it —
  a property sets one uniform style. I split it into `Price` + `Compare at` nodes, which is the
  better data model anyway. Worth a sentence: _"a text property replaces all runs; a multi-run node
  needs either an override or splitting."_
- **`flcm.edit(target, { width })` on a just-cloned node** silently converts `fill` → fixed. That's
  what I wanted, but it's a meaningful state change as a side effect of naming a dimension — and see
  §9 for what happens on the axis you _don't_ name.

---

## 20. What was genuinely good

Worth saying, because the list above is all complaints:

- **Fail-loud is the best part of this API by a distance.** `unknown prop "clipsContent" on
flcm.frame — flcm.frame takes only "name", "key", …` with the complete legal list is _exactly_ the
  right error for an agent: self-repairing, one round-trip, no guessing. The `clone`-onto-page error
  even told me the fix. Every API I use should do this.
- **`editMany`'s atomicity + one-undo-step** let me batch 5–8 renames-and-bindings per component
  without worrying about half-applied state. I leaned on this constantly.
- **CSS-as-dialect really does reduce lookups.** I wrote `justifyContent`, `borderRadius`,
  `alignItems`, `#1C365E` from muscle memory and they worked.
- **The read shape is well designed** — `"width": "fill"`, `"height": "hug"`, `designedWidth`
  alongside a `contextual` size. I could tell what a node would _do_ on resize just by reading it,
  which is what let me tell the human "your cards are already fluid; it's the rows that break."
- **`flcm.clone` handling instance-bearing subtrees** meant I could componentize a Collection nav
  card that already contained a Button instance, and the nested instance survived. First try.
- **`keyed`.** Authoring a tree with `key` on each node and getting back a map of live ids is by far
  the nicest way to build-then-bind. It's what made the two-variant Product card set easy, and it's
  the affordance that would fix §3 if `get` exposed something equivalent for existing trees.

---

## 21. FOOTGUN: `layoutMode` on an instance root is a silent no-op — through raw API _and_ flcm

To be clear about what is and isn't the finding: an instance inheriting `layoutMode` from its main
component is correct and expected behaviour, not a bug. You can override an instance's _sizing_ and
_spacing_, not its layout direction. The finding is only that both APIs accept the write and report
success.

Root-level layout overrides on instances are real and documented, so I expected to be able to stack a
section header that couldn't fit its row at 393px:

```js
hdr.layoutMode = "VERTICAL"; // raw API — assignment "succeeds"
await flcm.edit(flcm.id(hdr.id), {
  // flcm — returns without error
  layout: { mode: "column", gap: 6, alignItems: "flex-start" },
});
hdr.layoutMode; // still 'HORIZONTAL'
```

Both paths report success. Neither changes anything. What makes this worse than a plain no-op is that
**neighbouring props on the same call do apply** — in the same `flcm.edit` that failed to change
`mode`, `gap: 6` took effect. (Which is itself consistent: the node was already an auto-layout frame,
so spacing is overridable; only the direction isn't.) But the result is partial application with no
signal about which half landed, and if you don't re-read the node afterwards you'll believe the whole
edit worked.

`flcm.edit` already fails loud on unknown props and bad enum values — I hit both on the way to this
call, `unknown prop "align"` then `alignItems must be one of ...`. An inherited, non-overridable
property is exactly the same class of mistake and should get the same treatment:

> `flcm: layout.mode cannot be overridden on an INSTANCE — an instance inherits layout mode from its
main component. Change the component, add a variant, or wrap the instance in a frame.`

That error would also have told me the answer, which took two extra round-trips to work out.

---

## 22. The review gap: what a build agent can't see about its own work

Worth recording because it's a process finding, not an API one. A subagent built the mobile frame,
then self-reviewed it section by section with screenshots and fixed a genuinely long list — overlapping
trust cells, a 1px-wide footer band, a wrong CTA label inherited from a clone. Good pass. Reviewing the
same 14 sections afterwards, three things had survived it:

1. A section header whose eyebrow and link abutted with **`itemSpacing: 0`** — visible only because
   the two strings in _that one_ section were both long.
2. A facet card whose scrim was byte-identical to its two siblings but read as illegible, because the
   narrower mobile crop landed on the bright corner of a different photo.
3. A frame still named `03 · Category rail (12 up, 2 rows)` after being rebuilt as a 6-tile 2-up grid.

None are findable by reading the tree — (1) and (3) look correct in the layout data, and (2) is
_identical_ in the layout data to two cards that are fine. All three needed a rendered pixel, and (2)
needed `scale: 2` before it was obvious. This is the strongest argument for the crop/region argument
the mobile notes ask for in their §11: at `scale: 1` a 12757px artboard is unreadable, and at
`scale: 2` you can't screenshot the whole thing. The reviewer is forced into node-by-node screenshots
and therefore into knowing in advance which node to look at — which is exactly what they don't know.

---

## 23. FOOTGUN: a FIXED height on an auto-layout frame overflows in total silence

This one bit twice on the same artboard, and a human found both by eye before any agent did. A scan of
the finished mobile frame for _auto-layout frames whose children don't fit their fixed height_ returned
exactly two nodes — and they were exactly the two the human had already flagged:

| node                        | height | content needs |
| --------------------------- | ------ | ------------- |
| `01 · Hero — Segment Split` | 520    | 958           |
| Footer Band 3 heading       | 24     | 46            |

The mechanism is a three-part trap and every part is quiet:

1. **Giving a frame an explicit height makes it FIXED, permanently.** `flcm.frame({ height: 520 })` and
   any later `resize()` both set `layoutSizingVertical: 'FIXED'`. Adding children afterwards never
   re-derives it. There's no `height: "hug"` equivalent you can pass at construction time that survives
   a subsequent resize, so "I sized the frame while roughing it out, then filled it with content" —
   the normal way anyone builds — lands you here by default.
2. **`clipsContent: false` means the overflow still renders.** It doesn't clip, so it doesn't _look_
   broken in isolation. Screenshot that node alone and it's perfect.
3. **The parent lays out siblings by the declared height, not the content height.** The artboard is an
   auto-layout column, so it stacked the next section at `y = 220 + 520` while the hero's content ran to 958. The trust bar was therefore drawn _underneath_ 438px of hero. The only way to see it is to
   screenshot the parent — and if you're reviewing section by section, you never do.

So: correct-looking data, correct-looking isolated screenshot, and the corruption is only visible two
levels up. That's the worst possible signature.

**What would fix it.** `flcm.edit` and `flcm.render` already walk the tree and already know both numbers.
An auto-layout frame whose non-absolute children exceed its fixed extent is almost never intentional —
warn on it, in the `console` array the tool already returns:

> `flcm: "01 · Hero" has layoutSizingVertical FIXED at 520px but its children need 958px, and
clipsContent is false — content will render outside the frame and overlap siblings. Set height "hug"?`

A one-line `flcm.audit(nodeId)` returning that list for a subtree would have caught both in a single
call. Sizing bugs are the dominant failure mode of responsive work and they are exactly the class a
machine can check and a human shouldn't have to.

---

## 24. `flcm.find` can't search text, and the predicate hides the fact that it can

Updating §15. The query surface is `{ type, name, key, within }` — `name` matches on substring,
`within` scopes to a subtree, and the error naming the four legal keys is genuinely good:

```js
flcm.find({ name: "Segment tile" }); // 9 nodes
flcm.find({ type: "TEXT", within: "951:5003" }); // 19 nodes
flcm.find({ text: "Shop by gauge" });
//  → unknown query key "text" on flcm.find — takes only "type", "name", "key", "within"
```

Text search is the single most useful lookup on a content-heavy file — "which node says _Shop all
machines_" is how you find a wrong label when the layer name is generic. It's absent from the query,
and finding out that the **predicate** can do it takes a detour, because the predicate receives a
**read spec, not a live node**:

```js
{
  id, name, type, width, text, textStyle, fill;
}
```

So the obvious attempt fails, and fails the worst way available — **zero results, no error**:

```js
flcm.find({ type: "TEXT" }, (n) => n.characters.includes("rotary")); // → [] . Wrong, silently.
flcm.find({ type: "TEXT" }, (n) => n.text.includes("rotary")); // → the 2 nodes. Correct.
```

`characters` is the Figma API's word and the word every agent arrives with. Returning `[]` for it is
§14 ("read words are not always write words") biting again, but harder, because there's no error to
read — you conclude the node doesn't exist.

Three asks, cheapest first:

- **Document that the predicate takes a spec, and show the text-search one-liner.** It's the single
  most likely thing anyone wants from `find`, and it already works.
- **Accept `text` in the query** as sugar for that predicate — string = substring, and while you're
  there make `name` accept a RegExp. Today a regex `name` doesn't fail loud, it crashes:
  `in findAll: "findAll" callback crashed: TypeError: not a function`.
- **Accept `componentId`** (still the §15 ask). "Every instance of this master" is how you assess blast
  radius before touching a component, and it currently needs a hand-rolled walk with
  `getMainComponentAsync` on every INSTANCE — 189 of them on this file.

---

## 25. An alias table for Figma-API words (design sketch)

flcm's vocabulary is internally consistent — `docs/canonical-vocabulary.md` pins "no write word is
spelled differently from its read field," and `text` is the canonical content word at both edges.
`characters` is not an flcm inconsistency; it's the word every agent arrives holding, because we're all
trained on the Figma Plugin API. Same for `clipsContent`, `itemSpacing`, `cornerRadius`, `x`/`y`.

The repo already has the exact machinery this needs, which makes it cheap:

- `plugin/src/preamble/schema.ts` — `FIELD_GROUPS` (zod), the write-side source of truth.
- `plugin/src/preamble/flcm.ts` — `KNOWN_KEYS`, a hand-mirrored runtime copy (schema.ts can't enter the
  QuickJS bundle — the purity gate).
- `plugin/src/preamble/unknown-props.test.ts` — a drift guard asserting the two deep-equal, failing with
  _"add the new prop to both, or neither."_

So: define `FIELD_ALIASES` beside `FIELD_GROUPS`, hand-mirror it, extend that same drift guard. One
source of truth, already-proven enforcement.

**Resolve at `validate.ts`, not at the writers.** Its own comment says it "runs before any target is
resolved, so a misspelled word reads 'unknown prop' no matter what it targets" — it is already the
single choke point for construct, `edit`, `editMany` and `fromRead`. One insertion covers every path.

**Resolve _and_ warn, rather than resolve silently.** Push a line into the `console` array the tool
already returns:

> `flcm: "characters" is Figma's word — flcm calls a TEXT's content "text". Accepted this time.`

Silent aliasing would make `characters` a permanent second spelling of a canonical field, which is
exactly what the vocabulary doc rules out: it permits _sugar_ (a bare number for `"16px"`), but sugar
compiles to the canonical form and never becomes an output spelling. A synonym isn't sugar. Warning
keeps the ergonomics and still teaches the canonical word, so the vocabulary doesn't fork.

**What the table can't reach.** `flcm.find`'s predicate is arbitrary JS over a plain read spec, with no
validation layer to intercept — `n.characters` is simply `undefined`, so the call returns `[]` with no
error (§24). No alias table helps there. That one needs `text` accepted as a query key.

---

## 26. Findings from two parallel agents (tile-grid section + mobile carousels)

Two subagents worked the same file concurrently on disjoint territory. Their findings, deduped and
ranked — the first one is the most dangerous thing in this whole document.

### 26.1 FOOTGUN: an invisible per-instance `minWidth` silently clamps `resize()`

Resizing product-card instances from 170.5 to 145 "succeeded" — and read back at **160**. No error, no
warning, no clamp notice. The main component has `minWidth: null`; the `160` lives as a **per-instance
override on every card in the file**, invisible in the layers panel and absent from the master. Because
the cards had always been ≥160 wide, it had never once bitten. Setting `node.minWidth = null` before the
resize fixes it.

This is the same silent-corruption family as §7 and §9, and it is the strongest argument in this
document for the **read-back rule**. The agent caught it _only_ because its brief said "re-read after
mutating — never trust a write you haven't read back." Without that, it would have shipped four
carousels at 160px with a 6px peek and documented them as 145. Every number in its report would have
been wrong, and the error would have been invisible until a human squinted at a screenshot.

Asks, in order: **`resize()` that clamps should say so** (it already knows both numbers); `flcm.get`
should surface `minWidth`/`maxWidth` overrides, which today read as absent; and the reference should
warn that constraint props are per-instance overridable and therefore invisible at the master.

### 26.2 Instances inside a SLOT have unreadable sublayers

Rendering is correct; reading is broken. A slot-donated instance's `children` come back with ids shaped
`I951:5073;950:4295`, but `child.name` throws `in get_name: The node ... does not exist` and
`getNodeByIdAsync` on that id returns `null`. Reproduced on all 12 tiles across two slots; the identical
component in a plain FRAME reads fine. So an agent **cannot introspect anything it puts in a slot** —
which matters, because slots are the affordance you reach for precisely when the content is arbitrary.

### 26.2a FOOTGUN: moving a node OUT of a SLOT destroys it

The read bug in §26.2 has a destructive twin. Slot-resident instances can't be read — so the obvious
workaround is to move them somewhere readable, edit, and move them back. **Don't.** They keep their
slot-scoped id (`I955:6143;955:6093;955:6164`) after reparenting, and that id no longer resolves:

```js
temp.appendChild(tile); // succeeds
tile.type; // "INSTANCE" — still reads
tile.name; // throws: "The node ... does not exist"
tile.width; // throws
await figma.getNodeByIdAsync(tile.id); // null
slot.appendChild(tile); // throws — cannot be put back
```

The node becomes a zombie: present in `parent.children`, `type` readable, **every other property throws,
unresolvable by id, and impossible to reparent**. Six tiles were unrecoverable this way and had to be
rebuilt from scratch by harvesting title/count/`imageHash` off their desktop counterparts.

Three things make this severe rather than merely annoying:

1. **`appendChild` out of the slot succeeds.** Nothing refuses, nothing warns. The damage is done by a
   call that reports success — the §7/§9/§26.1 signature again.
2. **It's the natural workaround for §26.2.** The docs say slot content is freely movable
   (_"`append`/`insertBefore`/`move`/`remove` work on and under it however deep"_), which is true
   _within_ the slot; moving **out** is what breaks. That distinction is not stated anywhere.
3. **It half-completes a batch.** My loop processed two sections, then threw on the third _after_
   moving its six tiles out — leaving the section empty, collapsed from 833px to 353px, and the tiles
   unrecoverable. There's no transaction boundary across a `figma_execute_code` call, so a mid-loop
   throw leaves the document in a state neither the agent nor the user asked for.

**The working escape hatch is `clone()`, not `move`** — a clone of a slot-resident instance has fully
readable sublayers, and the original stays untouched. Read via clone, discard the clone, then write
through the original node handle _in place_ (writes to a slot child work fine; it's only reads and
reparenting that break). Two agents independently arrived at the clone trick; nobody should have to.

Minimum fix: **make moving a node out of a SLOT fail loud** — the API already knows the id is about to
become invalid. Better: keep the node valid by re-issuing a normal id on reparent, which is what any
caller would expect from `appendChild`.

### 26.2b The read bug silently corrupts audits

Worth separating from §26.2 because it cost me a wrong claim to the user. An audit that walks the tree
and wraps property reads in `try/catch` — the only way to survive §26.2 — **silently skips every
slot-resident node**. I swept three artboards for image paints with `scaleMode: FIT`, converted 46, and
reported "zero FIT remaining anywhere." It was wrong: 36 nodes had been skipped by the catch, and 10 of
12 tiles in one section were still FIT. The screenshot showed it plainly; the audit did not.

So the read bug doesn't just block introspection — it makes a whole-file audit **quietly under-report**,
in exactly the direction that reads as success. Any `find`/audit helper the MCP grows (§23, §26.7) must
either read slot content correctly or report an explicit "N nodes unreadable" count. A skipped node must
never be indistinguishable from a clean one.

### 26.3 §12 confirmed, and it's worse than "missing props"

`layout` still has no `wrap`, no counter-axis gap, and no `minWidth`. For responsive work this isn't a
missing convenience — `layoutWrap` **is** the mechanism for a fluid tile grid, and `minWidth` is what
actually decides column count. Both agents had to follow every `flcm.component`/`render` with a raw-API
patch pass. One of them concluded flcm "was not the right tool for this job and I stopped using it,"
dropping to raw `figma.*` throughout. That's the real cost: the DSL's fail-loud guarantees get abandoned
wholesale because a handful of props are missing from one bag.

### 26.4 `flcm.instance` layout props are validated against the spec, not the component

```js
flcm.insertBefore(sib, flcm.instance(comp, { layout: { gap: 22, padding: … } }))
// → "layout gap/padding … need an auto-layout container — this instance isn't one"
```

The component root _is_ a column. The gate inspects the inert spec rather than resolving `componentId`,
so you must redundantly restate `mode: "column"` to describe a fact the component already knows.

### 26.5 `isExposedInstance` is the only nested-property affordance, and it's undocumented

Plugin-API property _forwarding_ (parent text prop → nested instance prop) does not exist. The honest
mechanism is `InstanceNode.isExposedInstance = true` on the nested instance, which surfaces its
properties on every parent instance. It fails informatively (_"Instance must be contained within a
component or component set to be exposed"_) but only if you already know to reach for it. It belongs in
the `components` reference section — building a section component out of nested components is a mainline
use case, not an edge one.

### 26.6 The disconnect message instructs you to retry forever

> _"The plugin reconnects on its own within a second or two … Retry this exact call. This is NOT a
> failure … do NOT ask the user to reopen the plugin."_

During a ~15-minute outage this text was returned identically to every call, from three agents and the
main session. It gives no retry count, no elapsed-downtime signal, and no way to distinguish a
two-second relay blip from a dead bridge — while explicitly arguing against the correct response
(tell the human to check the Figma tab). Between them the agents burned ~25 calls and several minutes of
backoff following its advice. After N consecutive failures it should say something different, and it
should stop telling the caller the outage is momentary when the server can see that it isn't.

### 26.7 Reading a section subtree at depth 3 blows the token limit

One read of five section subtrees at depth 3 returned 92k characters and spilled to a file. The workable
shape was depth 2 plus a hand-rolled field whitelist — which every agent re-invents. A first-class
"summarize subtree" read (name/type/geometry/layout/sizing/clip/componentProperties, depth-capped,
instance internals collapsed to a child count) is the single most re-written helper across all four
agents on this file, and it pairs naturally with the `flcm.audit` ask in §23.

---

## 27. The one-paragraph version

Fix the two silent-corruption bugs first: **§7** (an invented `defaultValue` destroys real content,
irreversibly) and **§9** (`clone` keeps `fill` into a free-form parent and stretches a component to
an arbitrary size, invisibly, because instances mask it). Then add the **"promoting an existing
design"** guide — clone → staging frame → promote with derived defaults → `editMany` to bind — since
that one missing page is upstream of half this list. Then the missing verbs and props: **`replace`**,
**`minWidth`/`maxWidth`/`layoutWrap`**, **image-by-`imageRef`**, **add-to-existing-variant-set**, and
**`find({ componentId })`**. Make `editMany` batch its font loads and say so loudly. Everything else
here is ergonomics; those are the ones that cost me correctness rather than time.
