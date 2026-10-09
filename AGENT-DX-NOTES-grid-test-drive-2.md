# Agent DX notes: grid test drive 2 (2026-09-15, late)

Same brief as drive 1 (three greyscale wireframes: 1440 dashboard, 1440 pricing, 1200 gallery
with a double-wide featured tile), same covert setup — a fresh Opus agent, blank scratch page, no
mention of grid or of being observed, feedback asked for afterwards. Run against the tree at
`4df6858` (implicit rows, LINE fill, native aliases, svg, paint stacks, definitive CANCEL; the
warnings-record change `3deeac0` landed after the drive, so the agent saw the old overflow strings).

Frames left on the scratch page: Dashboard `4999:25201`, Pricing `4999:25420`, Gallery `4999:25652`.

Fixes from this drive landed the same night: `b3f5c07`, `9bb7608`, `04c2195`, `b92a61e`. Two items
remain open for triage: §3's end-of-run diagnostics (Quick choice) and §4's LINE `strokeAlign`
parity gap (Inform).

---

## What changed since drive 1

**It used a grid.** The gallery is a real grid: `gridTemplateColumns` named, `gridTemplateRows`
left implicit, the featured tile placed with `gridColumn: "1 / span 2", gridRow: "1 / span 2"` and
`height: "fill"`, the other eleven auto-flowed. In the agent's words: _"Implicit hug rows + a
2-row-span child at height:"fill" worked correctly first try — that part is genuinely good."_ Drive
1's blocker (mandatory rows) is gone.

Still no raw Figma calls. Reference reading was one refused blank call, then one fetch of
`mental-model`, `props`, `render`. The `alignSelf "stretch" requires an in-flow row/column parent`
refusal with its `spec.children[1].children[0]` path and rollback sentence was, again, "the best
error of the session" — fixed in one shot without a read.

KPI cards and plan cards stayed rows of `fill` children (correct; grid was considered and rejected
for the plan cards: "three equal children in a row is exactly what fill is for"). The comparison
table stayed a column of rows because it needed `LINE width: "fill"` dividers between rows, which
a grid cannot carry across tracks — value columns are hand-budgeted `214`px against 1280.

---

## 1. A grid container under a row/column loses `width: "fill"` — HIGH

**Impact: high — silent, and it wrecks the frame. Cost: bug fix, plus one live probe.**

The agent wrote, under a 1200 fixed column with 56px side padding:

```js
{ name: "Gallery grid", width: "fill",
  layout: { mode: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "30px 24px" },
  children: tiles }   // each tile width: "fill", height: "hug"
```

Result: tracks about a character wide, every caption one letter per line, root height 3514 instead
of ~1274. No error. It blamed `minmax(0, 1fr)`, "fixed" it with `repeat(4, 254px)` computed by
hand, and moved on. Reproduced live after the drive with three column templates:

| template                    | grid width | `layoutSizingHorizontal` | tracks      | tiles |
| --------------------------- | ---------- | ------------------------ | ----------- | ----- |
| `repeat(4, minmax(0, 1fr))` | **1**      | **FIXED**                | FLEX ×4     | 1px   |
| `repeat(4, 1fr)`            | **1**      | **FIXED**                | FLEX ×4     | 1px   |
| `repeat(4, 254px)`          | **1**      | **FIXED**                | FIXED 254×4 | 254px |

So the tracks were never the bug. **The grid container's own `width: "fill"` is dropped**: it lands
as a FIXED 1px frame under its column parent. `fr` tracks then divide 1px; px tracks overflow the
1px frame by 1087px, which is exactly what the new overflow warning reported. The agent's fix was
an illusion that happened to paint right.

Suspects: the order between `writeGridTracks` (which flips a hugging axis to FIXED while tracks are
written and restores HUG only when no track is FLEX) and the flow parent's fill placement for the
child; or `gridOwnSize` writing FIXED after the parent applied FILL. Neither the mock tests nor
`probe:grid` cover a grid container that is itself a `fill` child of a row/column — the commonest
placement for a grid.

**Fixed `b3f5c07`.** Not an ordering bug: one write clobbered another. The flow parent marked the
child `layoutAlign: "STRETCH"`, then the grid's own-size step wrote `layoutSizingHorizontal =
"FIXED"`, and in Figma those are one word per axis — the second write resets the mark to INHERIT
(verified live with raw calls; pinned as a probe check). A single `fillAxis()` is now the one way
any parent policy fills a child: the native `layoutSizing* = "FILL"` write, which is the mark and
the mode at once, so order cannot undo it. The mock now models the clobber. Live: the drive's exact
spec gives grid width 1088, tiles 254, no warnings. `probe:grid` 14 → 17 checks.

**Also:** the docs sentence _"Fractional axes need explicit fixed or fill sizing"_ is what the agent
believed it was satisfying (container `fill`, children `fill`). Once the bug is fixed the sentence
should say which node's sizing it means and what happens if it is missing. **Done:** "An fr track
divides THIS FRAME's own width, so name that width in the same call — a number, or "fill" under a
row/column parent; a hugging width is refused, never guessed."

## 2. `LINE width: "fill"` + `rotation: 90` in a row makes a 1200px vertical hairline — MEDIUM

```js
{ type: "LINE", width: "fill", stroke: "#E3E3E3", strokeWidth: 1, rotation: 90 }
```

as the middle child of a 1440 row (sidebar | line | main). `fill` resolved along the row's main
axis (~1200), then the rotation applied: a 1200px-tall line, frame height 2583 instead of 1048. No
refusal, no warning naming rotation. The agent deleted it and tinted the sidebar instead.

The LINE props row now advertises `"fill"` for "the divider case", and `rotation` three rows later
as if independent. In a row, a _vertical_ divider is what anyone wants from a rotated line, and
Figma cannot give it: a LINE has no height to fill. **Proposed:** refuse `"fill"` together with a
non-zero `rotation` on a LINE, naming the honest construction (a 1px-wide RECTANGLE with
`height: "fill"`) — refusal, not translation, because nothing in Figma renders it.

**Landed `9bb7608`** (`assertLineFillUnrotated`, create and edit, either word arriving alone; LINE
props note says `"fill"` is for an unrotated row/column parent; `probe:line-fill` 8 → 11).

## 3. Two renders, near-identical overflow warnings, opposite meaning — MEDIUM (partly landed)

Dashboard: _"overflow in 14 containers; clipped (0): ; unclipped (14): …"_ — screenshot clean,
ignored. Gallery: _"overflow in 13 containers; clipped (12): …; unclipped (1)"_ — frame wrecked,
caught only because `measure()` said 3514. _"It costs a round-trip to act on, which means I
learned to ignore it, which means it didn't save me when it was right."_

The message half is landed in `3deeac0` (component-surgery §15/§24): the warning now names the
child, parent, axis and amount, and rides on the node. **Open:** whether the dashboard's fourteen
unclipped overflows were real. The frame is still on the page (`4999:25201`); with the new message
they can be measured. If they are rounding-level (sub-pixel text boxes) the 0.01px tolerance is
wrong for text; if they are real, the agent's clean screenshot hid them.

**Investigated: neither.** The same corner projection run over the live frame (66 containers, 109
text children) finds a largest excess of 9e-5px, a float artifact 100× under tolerance, and no
fractional text heights; re-rendering the frame's own read spec emits no warning. The fourteen were
**transient**: diagnostics fire per verb over the containers that verb touched, so an incremental
build (render, then edits in the same call) reports intermediate states that no longer existed by
the last line. **Proposed, not applied (`[Quick choice]`):** keep the 0.01 tolerance; re-check the
touched containers' _final_ geometry once at the end of the run instead of per verb — cheap now
that warnings are node-attached records (`3deeac0`), and it would have removed all fourteen while
keeping the gallery's true positive.

## 4. `text: ""` reads back with no `text` key — LOW

Authored `text: ""` for an empty price-unit TEXT; `flcm.get` returned `{ id, type: "TEXT" }` with
no `text` at all. The agent's `c.text === ""` search then threw on its own code. A read should say
`text: ""` for an empty text node — the write accepted it, so the read must reproduce it.

**Landed `b92a61e`** (core `buildFormattedText`: no text block → `{}`; empty TEXT → `text: ""`; no
goldens moved). **Same family, open:** re-authoring the Dashboard's read spec fails on
`unknown prop "strokeAlign" on LINE` — the read emits it, `KNOWN_KEYS.line` refuses it. `[Inform]`:
either LINE accepts `strokeAlign` on write or the read stops emitting it for a LINE.

## 5. `alignSelf: "stretch"` on a grid child refuses — LOW

CSS grid's `align-self: stretch` is the commonest value. Figma has no STRETCH cell alignment, but
the meaning is exactly `height: "fill"` (the cell), which is the same translation flow children
already get. **Proposed:** alias it (accept-and-rewrite) on grid children too, so the refusal the
agent hit — correct, and well written — never fires for this spelling.

**Landed `04c2195`:** `alignSelf: "stretch"` → `height: "fill"` and `justifySelf: "stretch"` →
`width: "fill"` on grid children (verified live: measures exactly the cell). Still refuses with no
cell/flow, and when stretch contradicts an authored size on the same axis.

## 6. Doc gaps the agent named

- That `rotation` composes _after_ layout sizing (nothing says so).
- What "fill sizing" means for `fr` tracks (see §1).
- The LINE row's "divider case" in a **row** parent is the case that cannot work rotated (§2).

All three done in `9bb7608`/`b3f5c07` (`rotation` now says it composes after layout sizing, on
every type's props table).

---

## What the agent would change

_"Put silent-garbage-geometry into fails-loud. flcm's whole pitch is that it refuses rather than
approximates, and twice it approximated."_ Both instances trace to §1 and §2.

## What was good, in the agent's words

Implicit rows and the span placement worked first try. The `alignSelf` refusal's path and rollback
sentence. The mental-model note that cross-axis `"fill"` under a hugging parent is legal but
percent is not — "I leaned on that for the sidebar and it held." Percent/fill/hug semantics in
`props` are "dense but correct." No escape hatch needed.
