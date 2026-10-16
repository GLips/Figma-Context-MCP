# Agent DX notes: grid test drive and probe findings (2026-09-15)

Two sources, both from the session that landed GRID authoring (`e5025e7`, `c4924e5`):

- A fresh agent given a plain design brief on the scratch page — three greyscale wireframes: a
  1440 dashboard with four KPI cards and a table, a 1440 pricing page with three plan cards and a
  comparison table, a 1200 gallery of twelve tiles in rows of four with a double-width featured
  tile. It was not told grid existed or that it was being observed. Asked for feedback afterwards.
- The agent that ran the live probes for the first six fixes.

All items below are `[HUMAN APPROVED]` for the dispositions stated; dispatched for implementation
in the same session unless marked otherwise.

---

## 1. It never used a grid

**Impact: high — the feature landed and the first real task routed around it. Cost: low.**

The KPI cards and plan cards were rows with `fill` children, which is correct. The gallery was a
**wrapping row with hand-computed pixel widths** — `(1200-96-72)/4 = 258`, featured `2*258+24 = 540`
— and will not reflow. The comparison table was a column of row frames with fixed value columns.

Grid was considered twice and rejected both times for the same reason: `gridTemplateRows` was
mandatory. For tiles that hug their captions the agent did not know a row height or a row count, so
`{ gridTemplateColumns: "1fr 1fr 1fr 1fr", children: [{ gridColumn: "span 2" }, …] }` — the
one-liner it wanted — was not available.

**Solution:** `gridTemplateRows` is optional. Omitted means implicit rows, CSS semantics: hug-sized
tracks, count derived from the children's placement against the column count. Columns stay
required — Figma flows row-wise, so that is the one axis that must be explicit. Columns-only-given-
rows was considered and rejected: it would need a second flow direction nobody has asked for.

## 2. Percent on a grid child refuses, and the agent did not know why

**Impact: low. Cost: one sentence.** The refusal is correct (the cell, not the frame, would be the
reference, and Figma has no percent-of-cell). The docs do not say so, and the uncertainty pushed the
table off grid. **Solution:** one sentence in the grid docs: px, fill (the cell) or hug; percent
refused because the reference would be the cell.

## 3. A LINE cannot span its column

**Impact: medium — the commonest LINE is a divider. Cost: low, plus one live check.**

A LINE is a length and no height, and flcm sizes it on a numeric `width` only. The grid change put
the child placement words on every leaf, so LINE's props table now lists `layout.alignSelf
"stretch"` as an alias for counter-axis fill, directly under "There is no height, fill, or hug".
The agent used it:

```
flcm.render: … children[4]: alignSelf "stretch" conflicts with the authored counter-axis size;
use "fill".
```

`fill` is refused on a LINE. The docs walked it into an error whose remedy is also an error. It used
a 1px RECTANGLE, which is what everyone ends up doing.

**Solution:** LINE accepts `width: "fill"` under a row or column (`layoutSizingHorizontal = "FILL"`
on the LineNode; Figma's UI allows it). **Verified live 2026-09-15** (`pnpm probe:line-fill`, 8/8):
a divider under a column takes the content width, under a row takes the remaining length, and the
read says `"fill"`. Landed in `4b6cac4` together with §1 (implicit rows, `pnpm probe:grid` 14/14),
§2 and §5.

## 4. Overflow warning on `replace` with nothing overflowing

**Impact: medium — a false positive trains skimming (see component-surgery §15). Cost: investigate.**

```
[warn] flcm.replace: overflow in 1 containers; clipped (0): ; unclipped (1): 4997:25100. Write succeeded.
```

Screenshot showed nothing overflowing. **Cause found and fixed (`562ad7e`):** `node.removed` answers
only for the node `remove()` was called on; descendants of a detached subtree still answer `false`
and keep the geometry they held when detached. `replace` inserts the replacement beside the
original, so the original's subtree is squeezed by the extra sibling, then deleted — and the
diagnostic still measured a container inside it. Diagnostics now ask attachment-to-a-page instead
of the flag. Message wording is §15's item.

## 5. Two doc gaps

Not findable in the reference: whether cross-axis `"fill"` works under a hugging parent (the agent
dodged it by fixing the dashboard's height), and what `wrap: true` does with a `"fill"`-width child.
**Solution:** state the actual rule the compiler enforces, in the sizing docs. Done in `4b6cac4`:
cross-axis `"fill"` under a hug parent is legal (only a percent is the refused cycle); a `"fill"`
child under `wrap: true` closes its line.

## 6. Reference tool skew (artifact, no fix)

The agent saw the old tool description ("index + cheat-sheet") with the new handler (refuses blank
calls, points at `mental-model`), because the client cached the tool list before the server was
restarted. It could not request `mental-model` from the old schema. Not a repo bug; reconnect the
MCP server in the client after restarting it.

---

## Probe-runner findings

### 7. Probe scripts used a stale pairing shape

`requestUntilApproved` split into `(status, submit, opts)` at protocol v4; the probes passed one
callback, re-sent `EXECUTE_CODE` as their "poll" and could never pass. Fixed in
`probe-queued-writes.mjs` and `probe-pin-stretch.mjs` (committed in `43bd428`).
`probe-midrun-await.mjs` and `probe-commit-undo.mjs` fixed in `c7a76b3`; midrun-await passes live.

### 8. Silent exit when another server holds the port

**Resolved by plugin-owned grants (fig-93):** a probe started beside a running MCP server binds the
next free port in the block and the plugin dials it too, so there is nothing to wait for.

### 9. Two failed probe runs left their nodes behind (open)

`pnpm probe:vector` errored in the sandbox twice (the check read `constraints` on a GROUP; fixed in
`4df6858`), and both runs left every node they had created on the page — eight named probe nodes
and three unnamed frames — although the script's `finally` removes `roots`. Checked live: the
sandbox does run a `finally` with awaits after an uncaught throw (a rectangle created before the
throw was removed inside it). So the cause is elsewhere; unverified guess is the probe process
exiting on the error reply before the plugin's cleanup mutations flushed. Low priority, but a probe
that fails must not litter the user's page: worth one look at `fail()` vs. the reply ordering.

---

## What was good, in the agent's words

No raw Figma calls at all. "The rollback sentence told me the exact canvas state; the
`spec.children[2].children[0].children[4]` path pinpointed the node; the fail-loud rules on
percent-under-hug saved a failed attempt; the props section alone was enough to build everything
else."
