# Agent DX notes — slots, instances, and mutation safety

Session date: 2026-09-10. Written without reading the other two `AGENT-DX-NOTES*.md` files,
so overlap with them is coincidental and disagreement is real disagreement.

Context for weighting this: a long session building a Shopify homepage redesign in Figma —
~14 sections across a desktop 1600 artboard and a mobile 393 artboard, heavy use of component
sets, variants, and SLOT-based section components. Mostly `figma_execute_code` with a mix of
`flcm` verbs and raw plugin API, plus `get_screenshot` on almost every build step.

Ordered by how much damage each one did.

---

## 1. Moving a node between two SLOTs corrupts it, silently — P0

This is the only thing this session that destroyed work.

```js
const slots = {}; // collected by walking an INSTANCE
slots["Body start"].appendChild(slots["Tabs"].children[0]);
```

`appendChild` **returned success.** No throw, no warning.

Afterwards the node was in a zombie state:

- It still appeared in `slots['Body start'].children`.
- It still **rendered on the canvas** (visible in `get_screenshot`).
- Its id — `I956:7264;956:6626;956:7289` — no longer resolved for _any_ operation:

```
in remove:      The node (instance sublayer or table cell) with id "..." does not exist
in get_name:    The node (instance sublayer or table cell) with id "..." does not exist
in insertChild: The node (instance sublayer or table cell) with id "..." does not exist
```

So I could neither read it, move it back, nor delete it. `figma.currentPage.loadAsync()` did not
refresh it. `flcm.remove(flcm.id(...))` did not work either.

**Cause (inferred):** the instance-sublayer id encodes the node's _path_ through the instance
(`I<instance>;<slot>;<child>`). Moving the node to a different slot invalidates that path while
leaving the node alive in the document. Nothing reconciles the two.

**Recovery that worked.** `clone()` of the whole enclosing section produced fresh ids where the
same node read and deleted fine. So: clone the section → repair the clone → `insertChild` it back
at the original index in the artboard → `remove()` the corrupted original. About fifteen calls.

**Why this is easy to hit.** The `Department section` component in this file exposes
`Body start` / `Body end` slots. Swapping which slot holds the product grid and which holds the
nav card is the single most natural edit to want to make. I reached for it immediately.

**Ask:** fail loud at the `appendChild`. Something like

> `flcm: cannot move a node between slots of the same instance — the sublayer id encodes its slot
path and would be invalidated. Clone the node, append the clone to the target slot, and remove
the original.`

Even a hard error that leaves the document untouched would have cost me one call instead of fifteen.

**What _is_ safe**, for the docs:

| Operation                                    | Safe?        |
| -------------------------------------------- | ------------ |
| `slot.appendChild(freshlyRenderedNode)`      | yes          |
| `slotChild.remove()`                         | yes          |
| `slotChild.clone()` → append clone elsewhere | yes          |
| `otherSlot.appendChild(slotChild)`           | **corrupts** |

The reliable pattern is **clear → build fresh → append**, never move. Worth stating positively in
the `structure` section rather than leaving agents to discover the negative.

---

## 2. `flcm.append` into a SLOT target times out — P1

```js
await flcm.append(flcm.id(slot.id), { type: "FRAME", children: [ ... ] })
→ Unable to establish connection to Figma after 10 seconds. Please check your internet connection.
```

Reproduced twice on different slots, in different calls, minutes apart. Raw
`slot.appendChild(node)` on the same slot in the next call worked instantly, so the connection was
fine and the slot was fine.

Two separate problems:

1. The verb appears not to handle SLOT targets.
2. The error blames the user's network for what is almost certainly a server-side hang. I wasted a
   call re-testing connectivity because the message told me to.

If tree verbs genuinely don't support slot targets, reject that loudly at the call site — that's
exactly the fails-loud contract everywhere else in the DSL, and its absence here was conspicuous.

---

## 3. A failed call can leave the document half-mutated — P1

The timed-out call in §2 was a multi-step mutation:

```js
for (const k of [...kids(tabs)]) k.remove();   // ← this ran
const r = await flcm.append(flcm.id(tabs.id), ...);  // ← this hung
```

The slot came back **emptied but not repopulated.** I only found out by re-reading.

I'm not asking for transactions. I'm asking for one line in the reference:

> A call that errors may have already applied part of its work. Re-read state before retrying.

I would have written much smaller calls from the beginning had I known. Instead I wrote large
declarative calls — which is what the DSL's design encourages — and each failure left me guessing
how far it got. There's a real tension here worth naming in the docs: `flcm`'s style pushes toward
one big `render`, but the failure mode punishes exactly that.

---

## 4. `clone()` is the sanctioned read escape hatch, but its geometry lies — P1

Reading slot-resident subtrees by cloning the parent out, walking the clone, then discarding it is
the trick that makes auditing possible at all. I used it constantly and it's genuinely valuable.

But **cloning re-runs auto-layout**, and for `layoutWrap: WRAP` the clone does not settle the same
way as the live node.

My overflow audit cloned each section and reported:

```
worst overflow: 817px at "04 · Department — Tattoo :: Body > Body end"
```

Measured on the **live** node, the same child was 353 wide inside a 353 parent. Zero overflow. The
clone had reported it as 1170 — a stale width from before the wrap resolved.

I nearly reported a fabricated 817px bug to the user. Caught it only because 817 was too absurd to
believe.

**Ask:** wherever clone-out is recommended for reading, warn that _structure and text survive the
clone but geometry does not_ — measure width/height/x/y on live nodes. For a WRAP container the
clone is actively wrong, not merely stale.

This matters more than it sounds, because the clone-out trick is the _only_ way to read inside
slots, so anyone auditing layout is being funnelled into the one method that produces bad numbers.

---

## 5. Instance-root `layoutMode` reverts silently — P2

```js
hdr.layoutMode = "VERTICAL";
hdr.itemSpacing = 10;
// ... later
hdr.layoutMode; // → 'HORIZONTAL'
```

No error. Reads back unchanged. This is Figma's own constraint — an instance root inherits layout
from its main component — but a silent revert is precisely the class of thing the fails-loud
philosophy exists to kill. It cost me a confused round trip and a screenshot showing a title and a
link drawn on top of each other before I worked out what had happened.

The right fix turned out to be adding a `Layout = Row | Column` variant axis to the main component,
which was better design anyway. But the DSL could have told me that in the error:

> `flcm: layoutMode is inherited from the main component on an instance root and cannot be
overridden. Add a variant to the component instead.`

---

## 6. `clone()` drops `componentPropertyReferences` — P2

Hit twice earlier in this session on other components: cloning a variant to make a sibling variant
silently lost every text/visibility binding (12 of them in one case). Both times I only noticed by
reading the refs back and finding `{}`.

Notably, `figma.combineAsVariants()` **preserved** them when I used it later in the same session,
so the trap is specific to `clone()`. That asymmetry is worth one line in the `components` section:
after cloning a component, re-read and rebind `componentPropertyReferences`.

---

## 7. Returned child identities

```js
const out = await flcm.render(tree);
out.children[0].id;
```

The returned data tree carries each child's live id. Those ids work across calls and belong in
the cheat-sheet. A key is optional metadata for finding a node later.

---

## 8. Two nodes sharing a name silently collapse a result object — P3

Self-inflicted, but a symptom worth noting. Desktop and mobile sections in this file share names
(`01 · Hero — Segment Split` exists on both artboards). I keyed a result object by `node.name` and
lost half the data with no indication. Nothing for the MCP to fix; it's an argument for the
`get`/`find` verbs to always return `id` alongside `name` in slim handles so name-keying is less
tempting.

---

## What's working, specifically

Not padding — these actively changed how many calls I needed.

**Fails-loud is the feature.** Two examples from today:

```
flcm: layout.alignItems must be one of "flex-start", "flex-end", "center", "stretch" — got "baseline".
flcm: unknown props "fontFamily", "fontWeight", "fontSize", "lineHeight" on flcm.text —
  flcm.text takes only "annotations", "name", "key", ... "textStyle", "fill", ...
```

Both listed the complete valid set. I fixed each in one call without opening the reference. That is
the difference between a two-call detour and a twenty-minute hunt. Every error in the DSL should
aspire to that second one specifically — it didn't just reject, it enumerated.

**The CSS vocabulary pays off.** After one read of `props` I stopped looking things up. `borderRadius`,
`justifyContent`, `padding: '12px 16px'`, `width: 'fill' | 'hug'` — I could guess correctly nearly
every time. The places I got it wrong (`textStyle` nesting, `baseline`) were both places where CSS
and Figma genuinely diverge, and both failed loud.

**The overlap warning on render is excellent:**

```
flcm.render: "B wrapper" at 0,0 (1600×321) landed on top of 1 node already on this page:
"Homepage — Desktop 1600 (v1)" at 0,0 (1600×7732) covers 100% of it.
Set `left`/`top` on the root to place it somewhere else.
```

Named the node, gave the percentage, told me the fix. I'd make one change: I hit this maybe six
times because a root without `left`/`top` defaults to the origin, which on a real file is always
_something_. Consider making an unpositioned root land beside the current page bounds rather than
at 0,0 — the warning is good, but not needing it would be better.

**`get_screenshot` is what makes the whole thing work.** Build → look → fix is the actual loop.
Today it caught: a section header where the title and link drew on top of each other, list arrows
that looked detached from their labels, a button wrapping to two lines, and a badge rendering
behind an image well. Not one of those was visible in the node tree. `scale: 2` on a 1600px frame
is the workhorse; `scale: 4` earned its keep once, on a 1px border I'd wrongly claimed was missing.

**Annotations as a two-way channel** are underrated. The human left a note on a layer, I found it
with `find({ hasAnnotations: true })`, did the work, and cleared it. That round trip felt like the
intended use of the tool and it worked without friction.

---

## Suggested priority

1. **§1** — hard-error the cross-slot move. Data loss, easy to trigger, no workaround an agent
   would find without flailing.
2. **§2 / §3** — fix or reject slot targets in `flcm.append`; document partial application.
3. **§4** — warn that clone-out geometry is unreliable, since it's the only way to read inside slots.
4. **§5 / §6** — two `fails-loud` messages and one docs line.
5. The rest are polish.
