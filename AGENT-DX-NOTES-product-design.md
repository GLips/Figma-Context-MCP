# flcm / figma-mcp — agent DX notes, live product-design workload

Written by Claude (Opus 5) during and immediately after the session, not from reading the code.

**Transcript:** `~/.claude/projects/-Users-graham-Programming-clients-fodzyme-fodmap-scanner-app/5a319f22-75ea-497e-9544-8aa0f80527a6.jsonl`
(session `5a319f22-75ea-497e-9544-8aa0f80527a6`, covering the work up to the first compaction).

Every item below is a real event in that file — the exact script I ran, what came back, and what the
human said about it. **Go read it rather than trusting a summary.** Items here are deliberately
short on reconstruction for that reason; where I have paraphrased my own reasoning after the fact I
am probably being kinder to myself than the transcript is.

**The task:** redesign a mobile scan-result screen for a real product, in Figma, _while the human
watched and reacted_. Read a designer's 30 imported frames for reference, propose three directions,
take the human's pick, then factor it into components. Roughly 20 write calls over two hours,
every one of them followed by a screenshot the human also looked at.

This is a different shape of workload from the existing notes. [NOTES.md](AGENT-DX-NOTES.md) is
componentize-an-approved-design, [mobile](AGENT-DX-NOTES-mobile.md) is adapt-a-desktop-page,
[slots](AGENT-DX-NOTES-slots.md) is mutation-safety archaeology. This one is **design the thing in
the first place, with a human in the loop**, and the friction lands in different places: iteration
cost, orientation, and the fact that I kept building the file wrong in ways the tool endorsed.

The headline: **the build loop is genuinely excellent; what an agent can leave behind is not.**
Screenshot → look → fix works, fails-loud is mostly superb, and `editMany` is a real tool. Two
things undercut it. The docs teach _mechanics_ with no opinion about _what a good Figma file looks
like_, so I confidently built things the reference permits and the human rejected on sight. And
with no variables or styles, every value I wrote is a literal baked into a node — the file reads
correctly in a screenshot and is unmaintainable the moment anyone wants to change it.

§1 is the one the human asked for by name, and the best value in the document — it costs a
paragraph and it reproduces across every agent session so far. §2 is the biggest thing missing.

---

## 1. [human reviewed] The text-property reflex — agents reach for properties when overrides are correct

**Impact: high. Cost: a doc sentence. Confirmed to reproduce across sessions —
[triage 27](AGENT-DX-TRIAGE.md) already lists "text-property overuse stays a watch item".**

I built a `FODMAP block` component and immediately declared three text properties (`Group`,
`Level`, `Ingredients`). I did not consider overrides. Then it got worse: I tried to nest a base
`Card` inside the block, hit the (correct) refusal that you cannot bind a property to a layer placed
inside a nested instance's slot, and **reported a false trade-off to the human** — "typed properties
and nesting are mutually exclusive, pick one." I even had them pick.

That was wrong. Text in an instance overrides directly. There was no trade-off, and the human had
to tell me so:

> "Why are you always insistent on using text properties? Text can be overridden directly without
> using a property."

Once I stopped using properties, the nested structure worked first try and nothing was lost.

**Why I did it, mechanically.** Two things in the reference push this way, and neither is wrong on
its own:

- The components section is _about_ properties. `propertyDefinitions`, binding, defaults,
  `componentPropertyReferences` and the per-type field table run for pages. Overrides get a
  paragraph, and it is framed as the thing you do _to_ a sublayer, not as the normal way content
  varies.
- This sentence, in the `flcm.instance` docs:

  > "Prefer a property over overriding the layer it drives, which works but leaves the property
  > unset."

  Read cold, that is an instruction to prefer properties. It is really about _not fighting a
  property that already exists_ — but an agent authoring a new component reads it as "properties are
  the sanctioned path."

[§18 of NOTES.md](AGENT-DX-NOTES.md#18-guidance-the-docs-dont-give-property-vs-override) already
contains the correct rule, and it is good. It did not reach me: it is a third of the way into an
892-line document that I never read, because I read `get_flcm_reference(["components"])` — which is
what an agent building components actually calls.

**What would have stopped me:** put the opinion in the `components` reference section, above the
`propertyDefinitions` table, not in a separate notes file. Something like:

> **Most content should NOT be a property.** Text and images in an instance are overridden
> directly — that is the normal path, and it keeps the properties panel meaningful. Declare a
> property only when the layer is hard to reach (buried, hidden, inside a nested instance) or when
> the _name_ is the point (`Title`, `Price`). A component with eight text properties is almost
> always a component that should have none.
>
> Corollary: a `boolean` property earns its place more easily than a `text` one, because
> un-hiding a hidden layer by override means hunting for an invisible node.

The human's framing is worth keeping verbatim, because it explains why this belongs in the tool's
docs rather than in a style guide somewhere: _"it's more of an opinion about how a Figma file should
be laid out, rather than an actual requirement for use — but in this case I do actually want it."_
The tool is the only thing in the loop that every agent reads. If it holds no opinion, every agent
invents one, and they all invent the same wrong one.

**Related and unfixed:** the same question about colour has no answer at all — see §2.

---

## 2. [human reviewed] No variables and no styles — every value an agent writes is a baked literal

**Impact: high. The largest missing capability for design-system work. Needs building, not a doc
fix.**

`flcm` has no access to Figma variables or to shared styles. Not to create them, not to bind to
them, not to read what already exists. The paint section documents solid colour strings, gradients
and image hashes and stops there; type, spacing, radius and effects are the same story.

The consequence is structural, not cosmetic: **every value I write is a literal baked into a node.**
Across this session I wrote `#2D4024` by hand something like thirty times, plus a dozen `#FFFDEA`s
and a scatter of 20s and 32s for padding. Nothing connects any of them. If the human changes the
brand green tomorrow, the file I built has thirty independent places to find it, and the design
system already sitting in their repo (`palette.ts`, `tokens.ts` — named, deduplicated, reviewed)
has no representation in Figma at all. **An agent with this tool cannot produce a maintainable
file.** It can only produce a file that looks right in a screenshot.

Both halves are needed, and they are separate pieces of work:

**Usage — bind to what already exists.** Let any styleable prop take a reference by name instead of
a value:

```js
flcm.frame({
  fill: { variable: "surface/verdict-needs-fodzyme" },
  padding: { variable: "space/l" },
});
flcm.text("Take with FODZYME", { textStyle: { style: "Heading/Title Strong" } });
```

This is the one that unblocks the common case. A human hands an agent a file that already has a
system in it, and the agent should build _with_ that system rather than beside it. Right now it has
no way to even discover the system exists.

**Authoring — create the system in the first place.** Whatever a designer can define by hand, an
agent should be able to define: collections, variables and modes, and styles **of every kind Figma
supports** — text, paint, effect, grid — not just consume them. The example below shows two of
those; the rule is "all of them," not "these."

```js
await flcm.variables.collection("Palette", { modes: ["Light", "Dark"] });
await flcm.variables.define("Palette", "surface/verdict-needs-fodzyme", {
  Light: "#FFD988",
  Dark: "#3A2F10",
});
await flcm.style.text("Heading/Title Strong", { size: 34, lineHeight: 36, weight: "SemiBold" });
```

This is the one that makes the tool useful for the job I was actually doing. Porting a codebase's
existing tokens into Figma is mechanical, tedious, and exactly what an agent should do — and it is
currently impossible. Same for the reverse: a design pass that invents six new surfaces should be
able to leave them behind as named things.

Discovery matters as much as the verbs. `flcm.variables.list()` / `flcm.styles.list()` returning
names, ids and current values is what lets an agent open an unfamiliar file and find out what
vocabulary it is supposed to speak.

**Cost, honestly:** I do not know the plugin-API shape well enough to size this. Styles look
cheaper — `setFillStyleIdAsync` and friends are a flat id set. Variables need collection and mode
resolution and have an async binding API, so the usage half is probably a much smaller change than
the authoring half. If only one ships, ship usage-by-name for variables; it is the one that stops
agents forking the design system on every write.

**One thing that is NOT in scope here:** colour cannot be a component property. Figma's property
types are `boolean | text | instance_swap | variant` and that is a platform constraint, not
something this tool can fix. Noted only so the next agent does not go looking.

---

## 3. [human reviewed] The deduped read shape breaks ordinary traversal — `node.children` is silently absent

**Impact: medium-high, and recurring across sessions. This is a design fix, not a doc fix — the
docs are already correct and it happened anyway. SUPERSEDED IN PART BY §3.2** — if the runtime
carries full fidelity as a general rule, the lazy-accessor proposal below stops being a
components-specific workaround and becomes one consequence of that rule.\*\*

**First, the correction, because it changes what the fix should be.** I originally filed this as
"`flcm.get` on a COMPONENT returns nothing usable" and pushed back on
[triage 28](AGENT-DX-TRIAGE.md)'s disposition. I was wrong. The data came through, and the
reference says so plainly in the `structure` section:

> `flcm.get` returns `{ node, components }`. `node` is the read shape; `components` appears only
> when the subtree holds a component or an instance of one, and names each one ONCE — its
> `children` and its property definitions live there, keyed by component id.

What I ran:

```js
const g = await flcm.get(flcm.id("4971:15346"));
const slot = g.node.children?.[0];
return {
  cardId: g.node.id,
  slotId: slot?.id,
  slotName: slot?.name,
  refs: slot?.componentPropertyReferences,
};
```

```json
{ "cardId": "4971:15346" }
```

`g.components["4971:15346"].children` was sitting right there, with the property definitions I also
wanted. I never touched `g.components`. I dropped to `figma.getNodeByIdAsync` to fetch data the call
had already handed me, then filed a complaint about the tool.

**Why this is still worth fixing.** Per the human, this is not the first session it has come up in,
and "the docs say so" has now failed to prevent it more than once. The reason is structural rather
than careless: `node.children` is how you walk a tree in every other context, code mode exists
precisely so an agent can _loop_ over things, and on an INSTANCE or COMPONENT that reach returns
`undefined` instead of failing. The natural traversal is the wrong one, and it is wrong quietly.

The dedupe itself is right — naming each component once is what keeps a read of a real screen from
being enormous, and nobody wants the same component body repeated forty times.

**The fix: the two shapes do not have to be the same shape.** Dedupe is a _wire format_ concern, and
the script runs inside the plugin. Only what I `return` crosses the wire. So the in-scope object can
be fully traversable while the serialized payload stays deduped, and the tension disappears.

Concretely: on an INSTANCE or COMPONENT read shape, define `children` as a **lazy, non-enumerable**
accessor that resolves through the components map and applies the instance's overrides.

```js
// works, costs nothing unless touched
for (const child of g.node.children) { … }
```

- **Lazy** — nothing materialises unless someone reaches for it, so a `get` that is never traversed
  is exactly as cheap as today.
- **Non-enumerable** is the load-bearing part: `JSON.stringify` skips it, so returning a node
  serialises the same bytes it does now. Duplication becomes something an agent opts into by
  explicitly returning a resolved subtree, not a cost imposed on every call.

**The override merge is the sleeper value.** Walking an instance's children _correctly_ means
reconstructing `I<instanceId>;<path>` ids and merging the override map onto the component's
children. That is fiddly enough that an agent will either get it subtly wrong — reading the
component's text where it meant the instance's — or bail to the raw API, which is what I did. An
accessor is the one place that logic can be written once and be right.

**Cheaper fallback, if a lazy accessor is too much magic:** make `children` a _throwing_ getter on
those types — _"an INSTANCE carries no children of its own; use
`result.components[node.componentId].children`, or `flcm.resolve(node)`"_. That is consistent with
fails-loud everywhere else in this tool and costs almost nothing. It does not fix looping, which is
the thing actually worth protecting, so treat it as the floor rather than the goal.

**What I would avoid** is shipping an explicit `flcm.resolve()` as the _only_ answer. It works, but
it inherits the exact problem that caused this: an agent who does not know the sidecar exists does
not know to call the thing that unpacks it. The point of the accessor is that the natural reach is
the correct one.

**Two implementation unknowns I did not check:** whether a non-enumerable accessor survives however
results are serialised back across the bridge (structured-clone may drop or throw where
`JSON.stringify` politely skips), and whether `{ ...node }` spreading into constructors — which the
reference advertises — depends on `children` being enumerable.

---

## 3.1. [human reviewed] Code mode drops `undefined` keys from a return with no signal

**Impact: medium. Cheap. General — this hides every wrong reach in code mode, not just §3's.**

Related to §3 but worth fixing separately, because it is what let a wrong reach look like a tool
failure. My return had four keys and three of them evaluated to `undefined`. `undefined` is not
representable in JSON, so they vanished on the way out and I saw:

```json
{ "cardId": "4971:15346" }
```

A successful call, three keys gone, no signal. Nothing distinguishes "the tool returned nothing" from
"you asked for fields that do not exist on this shape" — and I picked the wrong one and wrote it up.

**Suggestion:** report dropped keys alongside the result.

```
{ "cardId": "4971:15346" }
[warn] 3 returned keys were undefined and dropped: slotId, slotName, refs
```

That is one line and it would have cost me a single retry instead of a wrong conclusion in a
document. It generalises past components to every typo'd field access and every renamed property in
a script — which, in code mode, is the most common way to be quietly wrong.

---

## 3.2. [human reviewed] Full fidelity inside the runtime, elided on the wire

**Impact: highest structural idea in this document. Generalises §3 and settles a class of smaller
questions in one decision. Aligned with Graham in session.**

**The vision:** code running inside `figma_execute_code` sees the file completely. What crosses the
wire into an agent's context is a separate, deliberately lean projection. Today they are the same
shape, so every token-saving omission also removes a _capability_ — the sandbox pays no tokens, but
it is charged as if it does.

**The precedent is already yours**, ratified for one case. `simplifiedIndex` in `read.ts` passes
`{ components: false }` with this comment:

> "a predicate must still see inside instances. `get` moves an instance's children to the sidecar to
> save the agent tokens; **this index is in-sandbox and pays none**."

That reasoning is right and it is not specific to `find`. Making it general turns a running series of
one-off judgement calls into a single rule.

### What it fixes: you cannot build from what is already in the file

Before the switch to Lucide I authored icons with `flcm.svg(markup)`. Across three full-screen
versions and four badge treatments, **I re-emitted the path markup from scratch every single time.**
I never called `clone` or `fromRead` once in the whole session.

Not laziness — flcm's read path could not give the markup back, so the only copy was in my own
context window. Had it dropped out, the icons would have been gone, while sitting untouched in the
file the whole time. (Recoverable through raw Figma APIs, as it turns out. But not through the route
an agent is actually using.)

That is the cost in one sentence: **an agent cannot reliably build new things out of what is already
there, so it re-derives detail it should never be thinking about.** Everything I made was authored
blind, from memory, every time.

### Elide visibly

**Every field the wire projection drops keeps its key and gets a marker carrying its size.** Not a
list of elidable fields — the rule, so it covers fields added later.

An agent that sees a key knows the data exists and can ask for it. An agent that sees nothing
concludes the capability does not exist — which is exactly the failure that produced four phantom
gaps in this document's first draft (§16).

The marker must be structurally distinct from a real value, not a string. `text: "<25kb elided>"` is
valid authoring input and could end up as literal words on a screen.

### What this settles

- **§3** — the components sidecar stops being a special case. In the sandbox, children are just there.
- **Every future "should the read shape carry X" debate.** Yes, in the runtime. The only question left
  is what the wire shows by default.

**Not settled by this, despite my first draft saying so:** whether a _copy_ should inherit annotations
attached to the original. That is write policy, and elision does not answer it.

## 4. [human reviewed] Slot content should be keyed by slot NAME, not slot id

**Impact: medium. Largely retired by the resolution below — recorded because the bookkeeping it
forced is a good illustration of the cost.**

`flcm.component()` returns `{ node, keyed }` and **not** the slot's path, which is the one thing a
caller needs next in order to fill the slot. In a variant set each variant has its own slot id, so
one lookup is not enough. I wrote this by hand:

```js
const paths = {};
for (const m of made) {
  const live = await figma.getNodeByIdAsync(m.component.id);
  const v = live.name.split("=")[1]; // parsing "Surface=Warning" — fragile
  paths[v] = live.children[0].id; // assuming the slot is child 0 — also fragile
}
```

Both assumptions are load-bearing and neither is guaranteed.

**Resolution (confirmed with Graham in session): address slots by name.** Every Figma slot has a
name, names cannot be duplicated within a component, and an unnamed slot cannot be created — verified
on the Figma end during this conversation. So the name is a safe key, and it is the one the author
already knows, because they declared it in `propertyDefinitions`.

```js
slots: {
  Content: [{ type: "TEXT", text: "…" }];
}
```

There is then nothing for `component()` to return, and the variant case collapses too: the same key
works across every variant, so the `Axis=Value` parsing above disappears rather than being handed to
me pre-built.

**Original suggestion, now superseded:** returning a `slots` map of ids from `component()` /
`variants()`. Keep the id path available for the cases that genuinely need an id; it should not be
the way content gets authored.

---

## 5. `flcm.component()` rolled back with an error that named the wrong thing

**Impact: medium. Reproduced once, fixed by accident, cause unknown to me.**

First attempt at building `Card`, with the root position applied by a follow-up `flcm.edit` rather
than in the constructor props:

```js
const card = await flcm.component(
  flcm.frame({ name: "Card", width: 354, /* no left/top */ ... }, [...]),
  { name: "Card", propertyDefinitions: { Content: { type: "slot" } } },
);
await flcm.edit(card.node, { left: 1880, top: 0 });
```

Result:

```
Error: flcm.component: Figma refused a write on FRAME "Card" (id "4971:15339") —
in get_layoutMode: The node with id "4971:15339" does not exist.
This call rolled back to its entry seal (the canvas holds none of it);
the 0 mutating call(s) before it in this run committed and stand.
```

Moving `left`/`top` into the frame's own props made it pass on the next attempt, unchanged
otherwise. The console also logged the usual "landed on top of 1 node already on this page" overlap
warning for the 0,0 render just before it.

I cannot tell you the cause and I did not narrow it — the human was waiting. What I can say about
the _error_ is that it was actively misleading: it names `get_layoutMode` and a node that "does not
exist", when the node had just been created by that same call. My read is that promotion replaces
the root id (documented, [§5](AGENT-DX-NOTES.md#5-flcmcomponent-returns-a-node-with-a-new-id)) and
something in the path re-read the pre-promotion id, but that is a guess.

The rollback message itself is **excellent** — "the canvas holds none of it, the 0 mutating calls
before it stand" is exactly what an agent needs to decide whether to retry. Keep that. It is the
`get_layoutMode` attribution that is wrong.

---

## 6. `flcm.gradient` stop formats fail with a colour error, not a shape error

**Impact: low. One round trip. Trivial fix.**

I wrote the stops as `[color, position]` pairs, which is a reasonable guess and not the supported
shape:

```js
flcm.gradient({
  angle: 180,
  stops: [
    ["rgba(45,64,36,0)", 0],
    ["rgba(45,64,36,0.85)", 1],
  ],
});
```

```
Error: bad hex color "undefined": use #rgb, #rrggbb, #rgba, or #rrggbbaa.
    at parseHex → parseColor → gradientStops → gradient
```

The array got treated as a colour, its `.color` was `undefined`, and the message blamed hex
parsing. The docs do say stops are "a color string or `{ color, pos }`", so this is my error — but
the fails-loud principle elsewhere in this tool is _name the shape you got and the shapes you
accept_, and this one drops to a nested parser's vocabulary. `stops[0] must be a color string or
{ color, pos }, got an array` would have been a zero-round-trip fix.

I switched to the CSS string form (`"linear-gradient(180deg, rgba(...) 0%, rgba(...) 100%)"`) and
never went back. Worth noting that the CSS-string path is the more discoverable of the two.

---

## 7. Overflow warnings name a node id and nothing else

**Impact: medium, because it recurs and is never actionable.**

I got this on three separate renders:

```
[warn] flcm.render: overflow in 1 containers; clipped (0): ; unclipped (1): 4970:14984.
Write succeeded.
```

I never found out what `4970:14984` was. Resolving it means another round trip to `get`, and since
the write succeeded and the screenshot looked fine, I did what any agent will do: ignored it three
times. A warning that is always ignored is a warning that should carry its own context.

The empty `clipped (0):` list rendering as a bare colon is also a small wart.

**Suggestion:** include the node's `name` and its path or nearest keyed ancestor —
`unclipped (1): "phrases" (4970:14984), inside key "b2"`. The render just walked that tree; it has
the names.

---

## 8. Every render lands at 0,0 and the agent does the placement bookkeeping

**Impact: medium. Already [triage 36](AGENT-DX-TRIAGE.md), disposition "use measurement and
ordinary positioning; no separate placement helper." Not disputing that — recording frequency, since
I hit it about eight times in one session and it got worse under the human's
"stop deleting versions" instruction (§13).**

This is the single most repetitive thing in the session. Every comparison board — three variants
side by side, four treatments side by side, a component library off to one side — meant me tracking
an `x` cursor by hand:

```js
let x = 0;
for (const tree of [V1, V2, V3]) {
  const r = await flcm.render(tree);
  await flcm.edit(r.node, { left: x, top: 0 }); // every single time
  x += 470;
}
```

And when I forgot, I got the overlap log, which is good and which I then had to fix with another
call.

Worth knowing when weighing the disposition: **generating comparison boards is the core loop of
design work.** "Give me three variations" is a normal request, not an edge case, and every
accumulated version stays on the canvas competing for space. If there is no helper, the docs should
at least _show_ this loop — the render-root `left`/`top` note is one line in a props table, and the
natural reading is that omitting it is fine.

If a cheaper middle ever appeals: `render` taking `after: <handle>` or `beside: <handle>`, resolving
to "past that node's right edge plus a gutter," is the only placement semantics I ever wanted.

---

## 9. Unexpected text wrapping is invisible until a human looks at a screenshot

**Impact: medium. Cost me two round trips and two versions the human saw broken.**

I set a verdict headline at 34px in a 250px-wide text node. It wrapped to two lines and looked
wrong. I reduced to 29px — still wrapped. 26px — fine. Each attempt was a render, a screenshot, and
a human looking at a broken headline.

Two separable asks, and the first is much cheaper than the second.

**9a — report the line count (cheap, clearly in scope).** After a render the node exists, so the
information is already in hand: `render` returns measured `width`/`height`, and a `lines: 2` field
on a text handle costs nothing extra. Better still, warn when a text node wraps at all — the same
shape as the overflow warning in §7, which is already built:

```
[warn] flcm.render: 1 text node wrapped: "Yes — with FODZYME" → 2 lines at 34px in 250px.
```

That turns "human notices in a screenshot" into "agent notices in the return," which is the whole
difference between two round trips and zero.

**9b — measure a string without creating a node (unclear, possibly not worth it).** What I _wanted_
was to ask "how wide is this string at this size in this family" before committing. Copy churned
constantly this session — `Yes — with FODZYME`, `Take with FODZYME`, `Eat freely`, `Swap it out`,
`We couldn't read this` — and every change was a guess.

I do not know what this costs. Figma's plugin API has no clean measure-without-a-node primitive that
I am aware of, so an implementation may amount to rendering a throwaway node offscreen and deleting
it — which an agent can already do by hand, and which makes this much weaker than 9a. **Treat 9b as
a question, not a request.** If 9a ships, most of the pain goes with it.

---

## 11. Orientation blows the token budget on the first call

**Impact: medium-high for any session that starts in an unfamiliar file. Related to
[§26.7](AGENT-DX-NOTES.md#267-reading-a-section-subtree-at-depth-3-blows-the-token-limit) and
[triage 31](AGENT-DX-TRIAGE.md), but the trigger is different: this is orientation, not a subtree
read.**

My first question in an unfamiliar file was "what is in here". I wrote what seemed like a
conservative scan — top-level children of every page, capped at 60 per page, filtered to pages with
under 80 children:

```js
for (const p of figma.root.children) {
  await p.loadAsync(); /* … */
}
```

Result: **102,473 characters across 4,213 lines**, truncated to a file with instructions to read it
back in chunks. The file had 114 pages. I never read that dump; I threw it away and wrote a
narrower scan.

There is no bounded "describe this file" affordance. `flcm.page.current()` returns the page list,
which is a good start, but the next question — what is _on_ a page — has no cheap form. In this
file, `page.current()` alone returned 114 page entries and was itself a large response.

**Suggestion:** a `flcm.outline(target?, { depth })` that returns id + name + type + size and
_counts_ rather than children beyond the requested depth. The existing `find` is a filter, not a
map, and `get` is too deep by default.

---

## 12. [human reviewed] Content search exists via predicate, and I did not find it — an illusion of completeness

**Impact: medium as a feature request, high as the clearest instance of the pattern in §16.
Sharpens
[§24](AGENT-DX-NOTES.md#24-flcmfind-cant-search-text-and-the-predicate-hides-the-fact-that-it-can),
whose title — "the predicate hides the fact that it can" — turns out to describe exactly what
happened to me.**

The designer's 30 reference frames had been imported through `html.to.design`. **Every single frame
was named `div`.** Original node ids were gone, so the URLs the human gave me resolved to nothing.
`flcm.find({ name: ... })` was useless — there was no name to search.

I concluded there was no content-based way in, and hand-rolled one on the raw API:

```js
const texts = p.findAllWithCriteria({ types: ["TEXT"] });
for (const t of texts) if (needles.some(n => t.characters.toLowerCase().includes(n))) { ... }
```

Searching for phrases I knew the designer used (`stickpack`, `WHAT'S IN IT`, `Eat it`) and walking
up to the top-level ancestor recovered all 30 frames.

**This was unnecessary.** `flcm.find` takes a second argument — _"Optional predicate over the full
read shape"_ — so the supported call was always:

```js
await flcm.find({ type: "TEXT" }, (n) => n.text?.toLowerCase().includes("stickpack"));
```

Note `n.text`, **not** `n.characters` — `characters` is Figma's raw-API spelling, and the read shape
uses `text`, the same word you author with. My first draft of this very item had it wrong, because I
copied it out of the raw-API code above without noticing I had switched vocabularies. A predicate on
`n.characters` returns `undefined` for every node and matches nothing, silently — which would have
produced a _second_ false conclusion that content search does not work.

I read the verbs table, saw `find(query?, predicate?)`, and filed the capability as missing anyway.
That is on me.

**Why it happened: illusion of completeness.** The query bag is an enumerated set —
`{ type?, name?, key?, hasAnnotations?, within? }` — and an enumerated set reads as _the_ answer to
"what can I search by." I matched "text" against it, missed, and stopped. The predicate is described
in prose one clause later, generically ("over the full read shape"), naming no specific capability.
Lists read as authoritative; prose reads as commentary. So the miss felt conclusive.

**The fix is one sentence, not a new facet.** Say what makes the set open, and the whole class closes
at once:

> The predicate receives each node's full read shape — test any field on it.

That retires text, opacity, layout mode, and whatever gets added next year. It is strictly better
than swapping the example, which only fixes the case _this_ agent happened to need.

Two cheap supporting changes:

- **Change the predicate example to mark the boundary, not the centre.** It is currently
  `n => n.fill === '#FFF'` — a styling test, conceptually adjacent to the query bag, so it teaches
  "the predicate does more of the same." `n => n.text?.includes("Total")` would teach "the predicate
  reaches what the query bag cannot," at identical cost.
- **Name the absence in the query bag itself** — _"text is not a key; reach it with the predicate."_
  Inside the row, not after it: prose following a list is read as commentary and skipped.

**And a `text` facet is still worth having**, taking a regex the way `name` already does — the
structure docs say `find` accepts "a literal case-insensitive name substring or a JavaScript RegExp,"
so `find({ text: /stickpack/i })` is consistent with a convention already in place rather than a new
one. Triage 30's disposition (retain canonical predicates, no dedicated facets) is defensible on
API-surface grounds; this session is the data point that its cost is agents concluding the feature is
absent.

**The real cost, and it was not a round trip.** Because I believed I could not search by content, I
concluded the designer's frames were not in the file and **told the human so, confidently and
wrongly.** They had to push back with _"Wait, what are you talking about? This is copied straight
from the file I had been previously linking to."_ A missing capability costs a retry. A capability an
agent believes is missing costs a false statement to the person relying on it.

---

## 13. `flcm.remove` on an absent node throws, so cleanup is all try/catch

**Impact: low. Trivial.**

Iterating on a design means deleting the previous version constantly. Every cleanup block I wrote
looked like this:

```js
for (const id of ["4970:15084", "4970:15044"]) {
  try {
    await flcm.remove(flcm.id(id));
  } catch (e) {}
}
```

An empty catch in a script is a smell, and it is what the API shape forces. Either a tolerant
`removeMany(ids)` that reports which were absent, or documenting that swallowing is the intended
pattern, would be better than every agent independently inventing the empty catch.

(Noting the human's standing instruction here for the record — _"I would prefer if you didn't
continuously delete our versions"_ — which is a process point, not a tool one. But it does mean the
realistic pattern is "keep everything and place it", which makes §8's placement bookkeeping worse,
not better.)

---

## 14. Screenshots: the page-level shot is the only multi-frame view, and it is unlabeled

**Impact: medium for comparison work. Adjacent to
[triage 19](AGENT-DX-TRIAGE.md), which covers context/margins but not this.**

`get_screenshot` takes one `nodeId` or one `key`, or the whole page. For comparison boards — the
core artifact of this session — I wanted "these three frames, side by side, labeled." What I could
get was the entire page, which by then also contained the component library, an earlier rejected
version, and a stray 354×64 `Card` master sitting at the origin. The human saw all of it.

There is also no labeling: the frames carry names in Figma, and the exported PNG shows none of
them, so a three-up comparison is three unlabeled phones and I have to describe which is which in
prose.

**Two suggestions, both cheap:**

- Accept an **array** of `nodeId`s and compose them into one image with a gutter.
- An opt-in `labels: true` that draws each frame's name above it in the export.

The single-node screenshot itself is very good, and `scale` up to 4 genuinely does let me catch
hairline and small-type problems. No complaint there.

---

## 15. [human reviewed] Three names that could borrow a stronger prior

**Impact: medium, and it compounds — naming decides how often an agent guesses right without
reading. Cost: renames. Breaking, which is cheap while nothing has shipped.**

**The principle, first, because flcm already gets it right.** Choosing CSS as the dialect was not a
neutral style pick — it swapped a strong prior for a _stronger_ one. I know CSS far better than I
know Figma's plugin API, so `justifyContent`, `borderRadius`, `gap` and the colour strings never
cost me a thought in two hours.

The clean evidence is §6. flcm accepts two spellings for a gradient: a coined positional/tuple form,
and a CSS string. I guessed at the coined form and got it wrong; I wrote the CSS string without
hesitation and it worked first try. **Same feature, two spellings, and the one anchored in something
I already knew is the one I got right.** Where flcm has no anchor at all — `key`, `anchor`, `pin`,
`fill`/`hug`, `fromRead` — the vocabulary is held only in context, and context decays over a long
session. That is where guessing starts.

### `pin` → `constraints`

The strongest of the three. `pin` is Figma's `constraints`, renamed — `node.constraints =
{ horizontal, vertical }` in the API, and a panel labelled **Constraints** in the UI that designers
talk about out loud.

The tell is that **the values were already borrowed and only the name was coined**: `stretch` and
`scale` are Figma's `STRETCH`/`SCALE` verbatim. So the concept and the value set both came from
Figma, and the property name is the one invented part. Keep `left|center|right` — that is a real
improvement on Figma's `MIN|CENTER|MAX` — and take the noun:

```js
constraints: { x: "right", y: "top" }     // was: pin: { x: "right", y: "top" }
```

### `anchor` → `origin`

Not a missing prior — a **wrong** one, which is worse, because an agent does not look up a word it
believes it already knows.

`anchor` in CSS means tethering an element to _another named element_ (CSS Anchor Positioning), and
that is the more famous use of the word. flcm's `anchor` means something unrelated: which point of
_this_ node lands on `left`/`top`. That is `transform-origin`'s job, and the keyword sets are
already identical — `left|center|right` / `top|center|bottom`. Figma has no equivalent control at
all, so CSS is the right well here rather than Figma.

```js
origin: { x: "center", y: "center" }      // was: anchor: { x: "center", y: "center" }
```

### `fromRead` → `toSpec`, and the taxonomy under it

**STILL OPEN — deliberately not settled.** This is entangled with a live discussion about whether
the constructor surface should be named functions, a single `flcm.node({ type })` over plain data,
or both. Do not action the rename until that lands; the right name depends on what the verb turns
out to be. The **doc bug** at the end of this section is separate, verified, and safe to fix now.

Flagging honestly: **I never called either `fromRead` or `clone` in this session**, so this is read
from the docs rather than hit in practice.

The docs pair them — _"`fromRead` rebuilds; `clone` duplicates"_ — but that describes the
implementation, and the two are not the same kind of thing:

|         | `clone`                           | `fromRead`                          |
| ------- | --------------------------------- | ----------------------------------- |
| Takes   | a live node target                | a read shape (data)                 |
| Async   | yes, `await`                      | **no**                              |
| Returns | a node on the canvas              | a description you must still render |
| Family  | document verbs — `move`, `remove` | constructors — `frame`, `text`      |

Presenting a constructor and a document verb as a matched pair is the confusing part, and it is
taxonomy rather than naming. `fromRead`'s real sibling is the spread idiom
(`flcm.rect({ ...node, width: 320 })`) — it is the subtree version of exactly that, which the docs do
say, at the end of a paragraph about something else.

The user-facing question that actually separates them is **"do I need to change it on the way?"** —
yes wants an editable spec, no wants the canvas copy. A name that says what comes back would carry
that: `flcm.toSpec(node)`. (`rebuild` would be wrong for the same reason `fromRead` is: it implies
an action, and this verb does not act.)

**Why the spread/`fromRead` split is hard to hold.** A read node's `children` are _data_ — more read
shapes. A constructor's children argument wants _built nodes_. Same word, two types, and that single
fact is the whole reason spread works on one node and `fromRead` exists for a subtree. The docs say
it — _"`fromRead` is for a subtree, whose `children` are read shapes rather than built nodes"_ — as a
trailing clause at the end of a paragraph about something else. It is the load-bearing sentence and
the least prominent one.

Worse, there are **three** copy paths and their boundaries are drawn on **two different axes**:

|                                | spread   | `fromRead` | `clone`         |
| ------------------------------ | -------- | ---------- | --------------- |
| Scope                          | one node | subtree    | subtree         |
| Editable before it exists      | yes      | yes        | root props only |
| Instances, paint stacks, grids | —        | partly     | faithfully      |
| Sync                           | yes      | yes        | no              |

spread-vs-`fromRead` splits on **size**. `fromRead`-vs-`clone` splits on **fidelity**. Picking
correctly means holding both axes at once, and nothing in the docs presents them together. One small
table like the above would retire the whole question.

### Doc bug: the verbs table contradicts the structure section on instances

**Verified against the source. This one is not a naming opinion.**

- Verbs table: _"Anything the read shape carries that flcm has no word for (an INSTANCE, a paint
  stack, a grid) fails loud by name."_
- Structure section: _"An INSTANCE rebuilds through `flcm.instance`: a fresh stamp of the same
  component, with the read's property values and overrides re-applied."_

`plugin/src/preamble/from-read.ts` settles it — **the structure section is right.** `INSTANCE` is in
`AuthorableReadType`, has a builder (`INSTANCE: (node, subject) => instance(...)`), and gets
dedicated machinery in `readyInstanceOverridesForRebuild` to re-author its overrides and slot
content.

The verbs table is the expensive place to carry that error: it is the most-read section and it is
reproduced verbatim in the index, so an agent meets it twice before meeting anything else. Instances
are most real content, so the practical effect is that agents write `fromRead` off as useless for
real designs and reach for `clone` — losing the ability to edit on the way, which is the only reason
`fromRead` exists.

### Leave these alone

| Term           | Why it is already fine                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `key`          | React's `key` — a string identity on a declaratively-built node. Close enough that I never fumbled it once. |
| `fill` / `hug` | Figma's own UI words. Designers say "hug contents" out loud. The strongest prior available.                 |
| slot           | Both Figma and web components use it.                                                                       |

One wart, noted and not worth fixing: `width: "fill"` and `fill: "#FFF"` are the same token for
unrelated concepts. Context disambiguates and it never tripped me.

**A note on the reference's own framing.** It says _"where flcm has no CSS counterpart (`key`,
`anchor`, `pin`, `width: fill|hug`) the props page is the only source."_ Two of those four do have
counterparts — `pin` in Figma, `anchor` in CSS — so that list is partly self-inflicted. Renaming
shrinks what the props page has to carry alone, which is worth more than the rename costs while
nothing has shipped.

---

## 16. [human reviewed] The pattern under four of these: illusion of completeness

**Impact: this is the most actionable finding in the document, and it is not visible while drafting —
only once the whole list exists. Cost: a handful of sentences, no new pages.**

Four items in this document's first draft were **phantom gaps** — capabilities that already exist,
already documented, that I filed as missing anyway:

| Filed as missing                                      | Actually                                          | Where it was documented                  |
| ----------------------------------------------------- | ------------------------------------------------- | ---------------------------------------- |
| `flcm.get` returns nothing usable on a COMPONENT (§3) | `g.components[id].children` was right there       | `structure` — I was reading `components` |
| No content search (§12)                               | `find(query, predicate)` over the full read shape | `verbs`, third column — I read it twice  |
| No idiom for a right-aligned row value (cut §10)      | `justifyContent: "space-between"`                 | `props`, plain enum                      |
| Colour cannot be named or reused (§2, partly)         | True of properties; variables are the real gap    | Figma platform limit, not a flcm one     |

None of these is a documentation _shortfall_. Every one is a documentation _reach_ failure, and they
share one mechanism.

**Enumerated sets read as closed; prose reads as commentary.** The `find` row is the clearest case.
The query bag is a list — `{ type?, name?, key?, hasAnnotations?, within? }` — so it answers "what
can I search by," authoritatively. The predicate is prose one clause later, described generically,
naming no specific capability. I matched "text" against the list, missed, and stopped. A list makes a
miss feel conclusive in a way a sentence never does.

**The fix is never more examples.** A longer list looks _more_ complete, so the next agent trusts it
harder. Swapping in the example that this agent happened to need is whack-a-mole. What closes the
whole class is naming the rule that generates the set:

> The predicate receives each node's full read shape — test any field on it.

One sentence, and text, opacity, layout mode and next year's fields are all covered.

**Practical rules this suggests, all of them rewrites rather than additions:**

- **State the rule, not a longer sample.** Where a set is open, say what makes it open.
- **Put openness inside the list's own row.** Prose after an enumeration is read as commentary and
  skipped — which is exactly what happened to the predicate.
- **Say when a set really is closed.** The verbs section does this well already: _"flcm exposes
  exactly these. Nothing else is on the flcm object."_ That sentence is worth its tokens; it stops an
  agent hunting.
- **Spend examples on the boundary, not the centre.** Demonstrate what a reader would assume
  impossible; the obvious case is implied by the signature.
- **Route the predictable miss.** _"Text is not a key here — reach it with the predicate."_

**Why this outranks the individual items.** The cost of a genuinely missing feature is a retry. The
cost of a feature an agent _believes_ is missing is a confident false statement to the person relying
on it — in this session, telling the human their designer's 30 frames were not in their own Figma
file. They had to correct me. Four phantom gaps in one draft also quietly discredits the items that
are real, which is the part that hurts the next agent's report as much as this one's.

---

## 17. What was genuinely good

The complaint list is long because that is the assignment. The loop itself is strong, and these
specifically earned their place:

- **Fails-loud is mostly superb and usually names the fix.** The refusal I hit when trying to bind a
  property inside a nested instance's slot was a model of the form: it said what a binding means,
  why there was nothing to bind to, and named the two ways out (`flcm.component` in one call, or
  insert into a component that already declares it). I changed approach without a single
  diagnostic round trip.
- **`flcm.editMany` is the right primitive.** Nine text overrides across three instances in one
  atomic call, with one invalid entry rejecting the batch rather than half-applying. This is the
  verb I reached for most after `render`.
- **`render`'s `keyed` map.** Keying a few nodes and getting handles straight back is what made the
  "render, then override its contents" pattern workable at all.
- **The rollback guarantee, and saying so in the error.** "This call rolled back to its entry seal
  (the canvas holds none of it); the 0 mutating call(s) before it in this run committed and stand"
  tells me exactly whether retrying is safe. Every mutating API should say this.
- **`intent` on returned handles.** Reporting `{ width: "fill" }` alongside the measured number,
  specifically so I do not hardcode a measured value back in, is a genuinely thoughtful piece of
  design and I did not see it in any other tool.
- **Screenshot → look → fix is the whole product.** Three of the four times I got something visibly
  wrong (wrapped headline, wrapped row names, an overflowing card), I caught it in the screenshot
  before the human commented. That loop is the reason this workload is possible at all.
- **`flcm.svg` with pasted Lucide markup just worked.** The human asked for real icons instead of
  my hand-drawn paths; pasting standard 24/stroke-2 Lucide markup rendered correctly first try, at
  every size. No notes.

---

## 18. Suggested priority

✅ = discussed with Graham in session and aligned. Jump to these first.

| #     | Item                                                                                                                                                        | Impact                                                                                           | Cost               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------ |
| 1 ✅  | §3.2 — **full fidelity in the runtime, elided on the wire**, with sizes in the elision marker                                                               | Highest structural win; retires §3 and the annotations question, and makes file content reusable | Real work          |
| 2 ✅  | §2 — variable and style **usage**: bind any styleable prop by name                                                                                          | High, unblocks every file that already has a system                                              | Medium             |
| 3 ✅  | §1 — property-vs-override opinion, in the `components` reference section                                                                                    | High, recurring across agents                                                                    | A paragraph        |
| 4 ✅  | §2 — variable and style **authoring**: define collections, modes, styles                                                                                    | High, the only way an agent can build a system                                                   | Real work          |
| 5 ✅  | §3.2 — VECTOR readable back into authoring input (`AuthorableReadType` has no VECTOR)                                                                       | High — I rewrote every icon from scratch because of this                                         | Medium             |
| 6 ✅  | §4 — address slot content by slot **name**; ids stay available but stop being the authoring path                                                            | Medium, kills the variant-name parsing entirely                                                  | Small              |
| 7 ✅  | §12 — say the predicate takes the full read shape; fix the example; `find({ text })` facet                                                                  | Medium                                                                                           | Small              |
| 8 ✅  | §3.1 — report `undefined` keys dropped from a return                                                                                                        | Medium, hides every wrong reach in code mode                                                     | Trivial            |
| 9 ✅  | §15 — rename `pin` → `constraints`, `anchor` → `origin`                                                                                                     | Medium, compounds over every session                                                             | A rename, breaking |
| 10 ✅ | §15 — **doc bug**: verbs table says `fromRead` fails on INSTANCE; source says it rebuilds. Fix in the verb registry (`schema.ts:812`), the canonical source | Medium — agents write `fromRead` off for real content                                            | One line           |
| 11 ✅ | §16 — apply the illusion-of-completeness rules to the reference (name open sets, mark closed ones)                                                          | Medium, prevented four phantom gaps in this draft alone                                          | Sentences          |
| 12    | §11 — a bounded `outline` for orientation                                                                                                                   | Medium-high in unfamiliar files                                                                  | Medium             |
| 13    | §7 — overflow warnings carry names                                                                                                                          | Medium, currently always ignored                                                                 | Small              |
| 14    | §9a — wrap/line count on a text handle                                                                                                                      | Medium, turns two round trips into zero                                                          | Small              |
| 15    | §14 — multi-node and labeled screenshots                                                                                                                    | Medium for comparison work                                                                       | Small              |
| 16    | §5 — the `get_layoutMode` misattribution on component rollback                                                                                              | Medium, needs narrowing first                                                                    | Unknown            |
| 17    | §8 — placement: `render` taking `after:` / `beside:`                                                                                                        | Low-medium, disposition already stands                                                           | Small              |
| 18    | §6 / §13 — gradient stop-shape errors, tolerant remove                                                                                                      | Low                                                                                              | Trivial            |
| —     | §9b — measure text without a node                                                                                                                           | Unclear; may be a platform limit                                                                 | Open question      |
| —     | §15 — `fromRead` → `toSpec`; constructors vs. a single `flcm.node`                                                                                          | **Still open — under discussion, deliberately not settled**                                      | —                  |

## 19. The one-paragraph version

Two things, one cheap and one not.

**The cheap one: what is missing is not verbs, it is opinion.** The reference documents every
mechanism correctly and says almost nothing about whether to use it. §1 is what that costs: an agent
with a complete mechanical reference and no taste produces a mechanically valid, badly built file,
confidently, and the tool endorses every step.

That is deliberately _one_ recommendation rather than a list, because **more documentation is not
the lesson here.** Four items in this document's first draft were phantom gaps — capabilities that
already exist, already documented, that I filed as missing anyway. Volume is what made the existing
pages hard to reach. Every doc suggestion that survived changes wording already present or removes
something misleading; none of them add examples.

**The expensive one: without variables and styles, an agent cannot leave behind a maintainable
file** (§2). Every colour, size and space I wrote is a literal baked into a node, disconnected from
every other copy of itself and from the design system the product already has. That is fine for a
throwaway exploration, which is what this session was. It is disqualifying for anything an agent is
meant to hand back to a designer and have them keep.
