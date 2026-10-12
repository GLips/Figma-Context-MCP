# Agent DX: one vetting list, ranked by expected value

Built for fig-75 on 2026-09-30. It merges all 13 `AGENT-DX-*.md` files: six raw note files, the two grid test-drive files, and the triage, recommendations, open-questions, overnight-progress and slot-resolution files. The source notes are unchanged. Approved entries become tickets after you vet them; once an entry's approved scope ships, it moves to `AGENT-DX-VETTING-SOLVED.md` with its A-number intact.

## Summary

**Tiers:** 🔴 **before 10/4** · 🟡 **soon after launch** · ⚪ **someday**

| Section                                          |  🔴 |  🟡 |  ⚪ | Total |
| ------------------------------------------------ | --: | --: | --: | ----: |
| A. Open or partly open, ranked                   |   0 |  21 |   7 |    28 |
| B. Likely fixed: confirm and close               |   — |   — |   — |    30 |
| C. Already accepted by you as existing behaviour |   — |   — |   — |     4 |

16 A entries, including all ten 🔴, have shipped and moved to `AGENT-DX-VETTING-SOLVED.md`; the counts above are what remains.

B and C are untiered. Each B entry names any residual, and where a residual exists it has its own entry in A. The A entries were ranked, not filtered, so nothing is dropped.

**Launch rule used for 🔴.** fig-40 says anything that is only cheap _before_ users hold a build must land first. The DSL ships from the server (ADR-0010), so preamble and doc changes stay cheap after launch. The 🔴 items are of three kinds:

- plugin-host or protocol changes (`plugin/src`, `FlcmHost`), which force a manifest re-import once users have a build;
- public renames;
- silent-damage or false-statement bugs a first-week user is likely to hit, when they cost XS–S.

**fig-31 status: not shipped.** I did a light read only, at HEAD `bcc3439`:

- `src/services/errors/rate-limit.ts` still says nothing about the plugin.
- `src/mcp/index.ts:62-72` still passes `pluginBridge` only to `registerCodeModeTools`. `registerTools` and `get-figma-data-tool.ts` never see it.
- `get_figma_data`'s description (`get-figma-data-tool.ts:115`) mentions the plugin only for annotations.
- No commit since the 9/4 foreman check touches the 429 path.

Nothing in the notes duplicates fig-31, but A-17 (compact outline) and fig-31 both ask what the plugin read door should look like.

**Commit messages consulted.** I read every commit message since 9/1 wherever the code alone was ambiguous. `43bd428` lists the six component-surgery fixes it made. Several of the later batch commits (`6491609`, `2713b86`, `e472128`) have subject lines only, so for those the code is the only evidence.

**Branches checked.** `data-trees-phases-0-2` (HEAD) is the most advanced branch; `canonicalize-convergence` and `plugin/data-first` are behind it. Two items sit off HEAD:

- `codex/saved-script-cli` has one unmerged commit, `ce61b37`. It adds an `execute <file>` CLI, which is relevant to A-3.
- The detached worktree at `2ad6d94` adds only slot-validity test scenarios.

**Top 5 by expected value**

1. **A-1: `find({ within: undefined })` searches the whole page and edits the wrong node.** Silent, and the edit lands on the user's frame. Trivial fix.
2. **A-2: Components docs push agents toward text properties instead of overrides.** Reproduced in every component session so far. It is a paragraph of docs. `[HUMAN REVIEWED]`
3. **A-3: A script has no address, so every validation error is paid for by resending the whole script.** You raised this; about a third of one session's write tokens were resends. `[HUMAN REVIEWED]`
4. **A-4: Enumerated sets read as closed, so agents file capabilities that exist as missing.** The predicate on `find` is the main case. It led to confident false statements to you. `[HUMAN REVIEWED]`
5. **A-5: A new node whose spec includes live children silently moves them out of the source.** This takes apart existing work. `[HUMAN REVIEWED]`

**Stale claims found while checking.** Triage 29 lists "persistent promotion aliases implemented", but `e472128` deleted `promotion-aliases.ts`. The docs now say the replaced root id stops resolving (`flcm.md:684`). `fromRead`, which product-design §15 discusses at length, no longer exists (last seen in `0a76043`). Both are noted below where relevant.

### How to read an entry

- **Sources** use short names: `NOTES` (componentize), `slots`, `mobile`, `CS` (component-surgery), `PD` (product-design), `SE` (site-exploration), `GTD1`/`GTD2` (grid test drives), and `T#` (a triage entry number).
- **Fix** is labelled _(note)_ when it is the note's proposal, _(mine)_ when it is my own, and _(note, amended)_ when I changed the note's proposal.
- **Confidence** covers two things: that the problem is real and current, and that the fix is right.
- **Size** runs XS (under an hour of agent time), S, M, L.
- **Status**:
  - _open_: I found no trace of a fix.
  - _partly_: some of it landed; the residual is named.
  - _likely fixed_: the code clearly shows the fix. These are all in section B.
- `[HUMAN REVIEWED]` means the item was discussed with you and the note records that you shaped the solution. It still wants your check.
- **Tickets** (on every entry with a verdict) lists the tickets carrying it, follow-ups included: _shipped_ (ticket closed), _in progress_, _open_ (filed, not started), or `none (approved, not filed)`.

---

## A. Open or partly open, ranked

### A-13. Overflow warnings: noise from clipping parents, and false positives from mid-run states 🟡

**Status:** partly.

- The message now names child, parent, axis, amount and "and N more" (B-8).
- A clipping parent still gets a full line; only the wording changes.
- Diagnostics still run per verb (`mutation-lock.ts:229`). The GTD2 §3 quick choice, to re-check final geometry once at end of run, is unapplied.

**Problem:**

- 24 lines of intentional bleeds under clipping parents buried a real 742px bug that the agent then misdiagnosed.
- 14 transient per-verb warnings made a clean dashboard look like the wrecked gallery.
- Agents learn to skim the warning, so it misses when it is right.

**Fix (note):**

- Collapse clipped overflow to one line per parent with a count, and keep full lines for unclipped overflow.
- Re-check touched containers once on final geometry at end of run.
- Keep the 0.01px tolerance.

**Confidence:** high · **Size:** S · **Sources:** SE §7, SE §10, GTD2 §3, PD §7, CS §15

### A-15. No signal when a text node wraps 🟡

**Status:** open. There is no wrap warning and no `lines` count.

**Problem:** A headline wrapped at 34px, then at 29px. Each attempt cost a render, a screenshot and a human looking at it broken. Content wider than its container is invisible in reads.

**Fix (note):** Add `lines` on text handles and a warning when an authored text node wraps unexpectedly, in the same warning channel as overflow. Measuring text without creating a node (PD §9b) is a separate question; see A-41.

**Confidence:** medium-high · **Size:** S · **Sources:** PD §9a, mobile §11

### A-16. Named reference sections don't carry the mental model: likely fixed by a different route ⚪ `[HUMAN REVIEWED]`

**Status:** likely fixed by a different route. `43bd428`'s message names this as the chosen fix: "mental-model is a named section and blank calls are refused with the section list, so the identity/copy/session rules reach section callers instead of only the full dump." The tool description repeats the pointer. The note's own proposal, prepending a compressed model to every section, was not built. I've kept the entry in A, rather than B, only because that residual is a live alternative.

**Problem:** The rules on identity, copying and what `session` is for reached only a no-argument caller, and a working agent names specific sections.

**Fix (note):** Put a compressed mental model at the head of every section response.
**Fix (mine):** Close this unless a later drive shows agents skipping `mental-model`. GTD2's agent fetched it unprompted.

**Confidence:** medium-high that the chosen route suffices · **Size:** XS · **Sources:** CS §1, CS §23

### A-17. No bounded "outline" for orienting in an unfamiliar file 🟡

**Status:** open. You explicitly deferred this design (T31), and dropped the oversized-output confirmation gate.

**Problem:** A cautious first scan returned 102k characters on a 114-page file. A "summarize this subtree" read is the most re-written helper across agents.

**Fix (note):** `flcm.outline(target?, { depth })`: id, name, type and size, with counts instead of children past the depth. It should also report incomplete coverage (see A-19).

**Confidence:** medium-high · **Size:** M · **Sources:** PD §11, NOTES §26.7, slots §8, T31, OPEN-QUESTIONS "Compact hierarchy inspection"

### A-18. Address slot content by slot name 🟡 `[HUMAN REVIEWED]`

**Status:** open. Slot content still goes through `overrides[path].children`, keyed by an id path.

**Problem:** Each variant has its own slot id, so agents parse `Axis=Value` names and assume the slot is child 0. Both are fragile.

**Fix (note, confirmed with you):** `slots: { Content: [...] }`. Figma slot names are unique within a component and required. Keep the id path for cases that genuinely need an id.

**Confidence:** high · **Size:** S · **Sources:** PD §4

### A-19. Audits and scans silently skip what they can't read 🟡

**Status:** open. There is no "N unreadable" count anywhere. One silent `catch {}` drops unreadable component definitions (`read.ts:222`).

**Problem:** An audit reported "zero FIT remaining" while 36 nodes had been skipped. A skipped node must never look like a clean one.

**Fix (note):**

- Any read, find or audit path reports an explicit unreadable count.
- Optionally add `flcm.audit(node)`: children past their parent's bounds, text wider than its box, fill nodes collapsed below a threshold.

**Confidence:** medium. Most slot unreadability is fixed, so this may be rare now · **Size:** S (count) / M (audit) · **Sources:** NOTES §26.2b, NOTES §23, mobile §11, mobile §2, T3, T18

### A-21. `flcm.variants` can't extend an existing set, and returns a bare handle 🟡

**Status:** open.

- `variants` refuses set members (`component.ts:678`).
- It returns a handle, not `{ node }`.
- You explicitly deferred the extension design (T25), pending an axis/value contract.

**Problem:** Adding a `Breakpoint` axis to existing components means rebuilding the set and re-pointing every instance. In surgery work, this is the more common direction.

**Fix (note):** `variants` accepts an existing set as a target, per the open questions (destination and axis values, validation, preservation).
**Fix (mine):** Settle the return shape at the same time.

**Confidence:** high on need · **Size:** M–L · **Sources:** NOTES §4, NOTES §13, CS §17, T25, T29, OPEN-QUESTIONS "Extending existing variant sets"

### A-22. A VECTOR can't be read back into authoring input 🟡 `[HUMAN REVIEWED]`

**Status:** open. I saw no read→author path for VECTOR, and `flcm.md:78` says REST reads can't supply paths.

**Problem:** Every icon was re-emitted from the agent's own context on every version. What is already in the file can't be reused through flcm.

**Fix (note):** Make VECTOR readable as `d`/`svg` input on the plugin read path.

**Confidence:** medium; fidelity may have changed this since · **Size:** M · **Sources:** PD §3.2, PD §18 #5

### A-23. Instance sublayer residuals 🟡

**Status:** partly.

- An inherited RECTANGLE refuses width/height, but the check is gated on `node.type === "RECTANGLE"` (`bridge.ts:759-767`), so other inherited types may still no-op silently.
- `flcm.detach` returns a handle and records nothing about what was lost.
- There is no doc line on planning a size variant axis when a component has fixed-size children.

**Problem:** Silent no-op beside applied neighbours: the "one mutation lies, the neighbouring one throws" pattern.

**Fix (note):** Widen the refusal to every inherited sublayer type. `detach` logs component, baked overrides and sibling count. Add one line on fixed-child components needing a variant axis.

**Confidence:** medium (the RECTANGLE gating is from code reading, not a live check) · **Size:** S · **Sources:** mobile §9, mobile §10, T6, T17

### A-24. Radial gradient's 100% stop sits outside the shape 🟡

**Status:** open. `radialTransform` still uses 0.5 scale (`paint.ts:44-46`), and the docs don't say where the stop lands.

**Problem:** A soft glow renders as a hard disc. Every CSS glow idiom assumes the last stop is at or inside the edge.

**Fix (note):** Map 100% to the box edge or to CSS farthest-corner, or document the current behaviour next to `at`.

**Confidence:** high · **Size:** XS–S · **Sources:** SE §4

### A-25. Stated font-loading and raw-escape responsibilities 🟡

**Status:** partly. flcm preloads fonts in parallel (`fonts.ts:145-150`). The reference only implies this, there is no "if you drop to raw, you own font loading" line, and `figma.mixed` isn't mentioned. T33 (keep these as raw responsibilities) is pending your decision.

**Problem:** A 300s hang left a half-mutated document because serial `loadFontAsync` calls ran inside a loop. The agent dropped to raw only because it wasn't sure flcm handled fonts.

**Fix (note):** Two sentences in the raw-escape section: flcm loads fonts for you, raw callers must dedupe and parallelise, and `figma.mixed` is a Symbol.

**Confidence:** high · **Size:** XS · **Sources:** NOTES §1, NOTES §19, T33

### A-26. Responsive residuals: verification and docs 🟡

**Status:** partly. The approved vocabulary landed (B-19, B-20). Still open:

- Wrapped-row equal-height check.
- Row↔column transition check with fixed and fill children.
- The "Responsive by default" heading rename.
- A short "adapting to a narrower frame" passage.

All are settled scope per REMAINING §2.

**Fix (note):** Run the two targeted live checks. Rename the heading to "Constraints on positioned children". Correct any stale capability statements.

**Confidence:** high · **Size:** S · **Sources:** mobile §4, mobile §7, mobile §12, T12, T21, T35, REMAINING §2

### A-27. Whole-script partial-write boundary: decision pending 🟡

**Status:** partly. The per-call rollback message says earlier calls "committed and stand" (`verb-error.ts:55`). T14's recommendation, to accept partial writes and add no whole-script transactions, awaits your acceptance. "Re-read before retrying" isn't in the execution guidance.

**Fix (note):** Accept the recommendation, and add the one execution-guidance sentence if it's missing.

**Confidence:** high · **Size:** XS (decision) · **Sources:** slots §3, CS §13, T14, REMAINING §3

### A-28. Bare unitless `0` refused in the padding shorthand 🟡

**Status:** open. `css.ts:327-347`: only `box-shadow` accepts a bare 0.

**Problem:** `padding: "0 48px"` took four sheets down in one script. Unitless zero is the one bare number every CSS author writes by reflex.

**Fix (note):** Accept unitless `0` in shorthands only.

**Confidence:** high · **Size:** XS · **Sources:** SE §6

### A-29. `edit` refuses `d` on a VECTOR without naming the route that works 🟡

**Status:** partly. The placement-verb route works and is documented (`flcm.md:467`). `edit`'s refusal lists 40 words and doesn't name that route.

**Problem:** The agent used `replace` instead, which minted a new id and orphaned its handles.

**Fix (note):** Accept `d`/`vectorPaths` in `edit` for path-born vectors, or end the refusal with "geometry edits go through render or append with the node's id".

**Confidence:** high · **Size:** XS · **Sources:** SE §5

### A-30. Gradient stops as tuples fail with a hex-colour error 🟡

**Status:** open. `gradientStops` (`flcm.ts:1207-1215`) still produces "bad hex color undefined".

**Fix (note):** Use a shape error instead: "stops[0] must be a color string or { color, pos }, got an array". Or accept the tuple.

**Confidence:** high · **Size:** XS · **Sources:** PD §6, PD §15 (the CSS-string form was the one guessed right)

### A-31. `flcm.remove` on an absent node throws, so every cleanup is try/catch 🟡

**Status:** open.

**Fix (note):** Add a tolerant `removeMany(ids)` that reports which ids were absent, or document swallowing as intended.
**Fix (mine):** Weigh this against fails-loud. An absent id in cleanup is usually benign, but not always.

**Confidence:** medium · **Size:** XS · **Sources:** PD §13

### A-32. `lineHeight` isn't a top-level alias while `fontSize` is 🟡

**Status:** open (`input-aliases.ts:61`).

**Fix (note):** Alias it, or make neither of them top-level.

**Confidence:** high · **Size:** XS · **Sources:** CS §17

### A-33. LINE's read emits `strokeAlign`, but its write refuses it 🟡

**Status:** open. `LINE_KEYS` lacks `strokeAlign` (`flcm.ts:84`). The omission looks deliberate: `9211b62` made `strokeAlign` an authoring word on "frame/rect/ellipse/path and edit" only. The read side was never narrowed to match, which is what GTD2 reproduced when re-authoring a read spec failed.

**Fix (note):** Accept it on write, or stop emitting it for LINE. Either way, a read must re-author.
**Fix (mine, given `9211b62`):** Stop emitting it for LINE, where inside/outside has no meaning, rather than widen the write.

**Confidence:** high · **Size:** XS · **Sources:** GTD2 §4

### A-34. Pasted images always land outside the asset root 🟡

**Status:** open. The asset-root rule is documented (`flcm.md:519`); "copy pasted images into the repo" isn't.

**Fix (note):** One sentence in `images`, or allow the session temp dir. The second is a trust-boundary decision for you.

**Confidence:** high · **Size:** XS · **Sources:** SE §8

### A-35. Unscoped page-wide `find({ hasAnnotations: true })` times out 🟡

**Status:** open. The 5,000-node cap covers only the predicate path (`read.ts:359`). `hasAnnotations` has no cap; the docs only suggest `within`.

**Fix (mine):** Apply the same materialization cap and scoping message to `hasAnnotations`.

**Confidence:** medium · **Size:** XS · **Sources:** CS §16 (last para)

### A-36. Unpositioned render roots land at 0,0 🟡

**Status:** partly. The overlap note is good (`root-overlap.ts`). T36 settled "measurement plus ordinary positioning, no placement helper".

**Problem:** It hit about 8 times in one design session. Comparison boards are the core loop of design work, and your "stop deleting versions" instruction makes it worse.

**Fix (note):** Given T36, show the placement loop in the docs. If you revisit, `render({ …, beside: handle })` is the only semantics agents asked for.

**Confidence:** high on frequency · **Size:** XS (doc) / S (beside) · **Sources:** PD §8, slots "What's working", T36

### A-37. Reference granularity: `components` is one huge section ⚪

**Status:** partly. The banner is now approval-aware (B-18); `components` is still one section (`reference.ts:292`), though `e2a226b` halved it.

**Fix (note):** Split it into create, properties, variants, slots and instances.
**Fix (mine):** Check sizes first. The trimmed section may be fine, and splitting adds more lists that read as closed.

**Confidence:** low-medium · **Size:** S · **Sources:** NOTES §17, T34

### A-38. Variables and styles: authoring collections, modes and styles ⚪ `[HUMAN REVIEWED]`

**Status:** open.

**Fix (note):** Collections, variables, modes, and styles of every kind Figma supports, plus discovery. This is the second half of A-9. Porting a codebase's tokens into Figma is exactly agent work.

**Confidence:** high on value · **Size:** L · **Sources:** PD §2

### A-39. Content-review workflow: wrong tiles, stale labels and names ⚪

**Status:** open decision (T20). The recommendation is to treat these as agent workflow errors using existing reads. Full-fidelity reads (B-13) now put instance property values in reach, which weakens the original complaint.

**Fix (note):** Accept the T20 recommendation.

**Confidence:** medium · **Size:** — · **Sources:** mobile §12, NOTES §22, T20

### A-40. Historical stalls and timeouts remain unexplained ⚪

**Status:** investigation. Tracing landed (`6a869b2`). The page-switch stall, the SLOT-append timeout and the queued-read timeout are all unreproduced. The CS §16b call-count theory is unproven, so don't close T13 on it.

**Fix (note):** One controlled active-file vs inactive-file comparison when possible.

**Confidence:** low · **Size:** M · **Sources:** slots §2, CS §16b, T13, OVERNIGHT, SLOT-ACCESS-RESOLUTION

### A-41. Measure a string without creating a node ⚪

**Status:** open question. It may be a platform limit.

**Fix (note):** Treat it as a question. A-15 removes most of the pain.

**Confidence:** low · **Size:** ? · **Sources:** PD §9b

### A-44. Loose ends: probe litter and one unreproduced `editMany` miss ⚪

**Status:** open.

- Failed probes still leave nodes: host-side `fail()` just exits, and three probes have no `finally`. This is dev-only.
- One `editMany` entry didn't land and couldn't be reproduced. It is recorded, and there is no action.

**Fix (note):** Look at `fail()` vs. reply ordering. Otherwise, ignore unless the `editMany` miss recurs.

**Confidence:** low · **Size:** XS · **Sources:** GTD1 §9, SE §9

---

## B. Likely fixed: confirm and close

The code clearly shows each of these. Every entry is from a read of HEAD `bcc3439`; nothing was run. Residuals, where any exist, are open entries in A.

| #    | Item                                                                                                     | Evidence                                                                                                                                                                     | Sources                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| B-1  | Writes outlive the reply                                                                                 | Queue drained before reply, plus a "N write(s) finished after your code returned" warning (`plugin/src/code.ts:1011,1034-1040`, `43bd428`)                                   | CS §4 `[HR]`                                                                               |
| B-2  | Instance read-modify-write drops nested edits                                                            | Echoed children lifted into `overrides[path]`; conflicts refused (`compile-tree.ts:57-61,245-295`). Numeric sizes on the echo are deliberately dropped                       | CS §5 `[HR]`                                                                               |
| B-3  | `pin: "stretch"` resizes the authored node                                                               | `43bd428` ("covers the parent after the parent's own size settles, on both axes"); `scripts/probe-constraints-stretch.mjs`. Not re-verified live                             | CS §6 `[HR]`                                                                               |
| B-4  | Stale per-request runtime bypasses cancellation (run-binding)                                            | Stored runtimes refused after the run settles (`code.ts:966-976`, `mutation-lock.ts:113-124`). The full redesign and function storage were judged not worth building (CS §8) | CS §8 `[HR]`                                                                               |
| B-5  | No authored paint stack                                                                                  | `d006833`, top-first arrays                                                                                                                                                  | CS §7 `[HUMAN APPROVED]`                                                                   |
| B-6  | `d` + width/height rescales the path; `svg` not themeable                                                | `1a2f2d1`                                                                                                                                                                    | CS §10 `[HR]`                                                                              |
| B-7  | Returned values echo authored input, so divergence is invisible                                          | Node-attached warning records carry authored/realized (`3deeac0`); clamp feedback in `sizing-diagnostics.ts:113-120`                                                         | CS §11, CS §24, mobile §2 (intent vs realized), mobile §9 (echo realized), NOTES §26.1, T7 |
| B-8  | Overflow warning names only the container                                                                | Names child, parent, axis, amount, "and N more" (`sizing-diagnostics.ts:139-143`)                                                                                            | CS §15, PD §7                                                                              |
| B-9  | Queued call reported as though it may have written                                                       | Definitive CANCEL_RESULT (`c7a76b3`, `bridge.ts:1363`)                                                                                                                       | CS §16a `[HR]`                                                                             |
| B-10 | `editMany` entry shape; repeated identical errors                                                        | `{ id, …changes }` (`fe4c800`); identical failures collapsed (`edit-many.ts:113-127`)                                                                                        | CS §13                                                                                     |
| B-11 | Refusal words differ per verb; `alignSelf`                                                               | One disposition path; grid-only `alignSelf` plus stretch aliases (`c4924e5`, `e5025e7`, `2e5b9cc`, `04c2195`)                                                                | CS §14 (1–2), GTD2 §5                                                                      |
| B-12 | Multi-child append undocumented                                                                          | Render row: "With an id and children, it adds several children to that live node in one call" (`flcm.md:92`)                                                                 | CS §9                                                                                      |
| B-13 | Instance/component `children` absent in the read; `readOnlySource` bloat                                 | Full-fidelity runtime reads, lean wire projection with sized elision markers; `readOnlySource` stripped on the wire (`4a5fdad`, `b1e0335`, `7678004`; `core/src/project.ts`) | PD §3 `[HR]`, PD §3.2 `[HR]`, CS §12, NOTES §3, T28                                        |
| B-14 | Grid: mandatory rows, percent docs, LINE fill, grid container losing `fill`, rotated-LINE fill, doc gaps | `4b6cac4`, `b3f5c07`, `9bb7608`                                                                                                                                              | GTD1 §1, GTD1 §2, GTD1 §3, GTD1 §5; GTD2 §1, GTD2 §2, GTD2 §6                              |
| B-15 | `text: ""` reads back with no `text`                                                                     | `b92a61e`                                                                                                                                                                    | GTD2 §4 (first half)                                                                       |
| B-16 | False overflow warning on `replace`                                                                      | `562ad7e`                                                                                                                                                                    | GTD1 §4                                                                                    |
| B-17 | Probe stale pairing shape; silent exit on a held port                                                    | `43bd428`, `c7a76b3`                                                                                                                                                         | GTD1 §7, GTD1 §8                                                                           |
| B-18 | Pairing banner on every reference call                                                                   | Approval-aware (`session-guidance.ts:34`)                                                                                                                                    | NOTES §2, T34                                                                              |
| B-19 | No wrap, gap or min/max vocabulary                                                                       | `wrap`, `gap: "row col"`, min/max sizes (`schema.ts:165-190`)                                                                                                                | NOTES §12, NOTES §26.3, mobile §1, T15                                                     |
| B-20 | Layout-mode flip leaves stale sizing; instance-root `layout.mode` silently ignored                       | Children swept on mode change (`bridge.ts:298`, `layout-native.ts:75-80`); instance-root refusal (`bridge.ts:772`)                                                           | mobile §12, NOTES §21, slots §5, T5, T12 (part)                                            |
| B-21 | Instances moved into a slot have unreadable sublayers                                                    | `4a295eb`, live-verified per SLOT-ACCESS-RESOLUTION                                                                                                                          | NOTES §26.2, T2                                                                            |
| B-22 | Clone drops component-property bindings                                                                  | `4e0829a`; overnight live verification                                                                                                                                       | slots §6, T9                                                                               |
| B-23 | No `replace` verb                                                                                        | `flcm.replace` inherits placement and size (`schema.ts:830`). `detach` residual is in A-23                                                                                   | NOTES §10, T23                                                                             |
| B-24 | No way to reuse an image already in the file                                                             | A read-shape fill carrying `imageRef` is accepted as a hash paint (`css.ts:118-133`). `flcm.image` itself still takes url or path only                                       | NOTES §11, T24                                                                             |
| B-25 | `editMany` serial font loads                                                                             | Parallel preload shared across the batch (`fonts.ts:145-150`). Doc residual is in A-25                                                                                       | NOTES §1 (suggestion 1)                                                                    |
| B-26 | Timeout blames the user's internet connection                                                            | That string no longer exists in `src`, `plugin/src` or the docs                                                                                                              | slots §2 (second half)                                                                     |
| B-27 | Approval doesn't survive plugin reopen                                                                   | Persisted (`4604af0`, `approval-store.ts`). Message residual is in A-10                                                                                                      | mobile §5c, T38                                                                            |
| B-28 | Nested-instance exposure undocumented                                                                    | Documented via the `exposed` prop (`flcm.md:438,597,698`); the reference never says `isExposedInstance`                                                                      | NOTES §26.5, T27                                                                           |
| B-29 | Promoted root's new id undocumented                                                                      | `flcm.md:684` says the replaced root id no longer resolves. **Note:** T29's "persistent promotion aliases" were removed in `e472128`, so T29's disposition text is stale     | NOTES §5, T29                                                                              |
| B-30 | `fromRead` verbs row contradicts the structure section on INSTANCE                                       | Moot: `fromRead` no longer exists. `get`'s node goes straight to placement verbs                                                                                             | PD §15 (doc bug), PD §18 #10                                                               |

These are likely fixed per the overnight report, but I didn't check them in code. Their commits, `6491609` and `2713b86`, have subject lines only, so the messages don't narrow it:

- **T16:** contextual fill default for new text in bounded columns.
- **T26:** instance layout validated against the inherited component layout. Implemented; the selected-variant/slot case was still being checked.
- **T32:** the clip/font-size normalization and baseline writes.

## C. Already accepted as existing behaviour (kept for completeness)

| #   | Behaviour                                                                           | Your disposition                                                                                     | Sources                       |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------- |
| C-1 | A clone used for auditing may settle to different geometry than its source          | Accepted; no clone fix                                                                               | slots §4, T4                  |
| C-2 | Binding applies the property default; deleting the property keeps the current text  | Accepted; no change. A-20 still carries the _invented_-default warning, which is a separate question | NOTES §7, T10, OPEN-QUESTIONS |
| C-3 | A text property flattens mixed-style runs                                           | Accepted                                                                                             | NOTES §19, T11                |
| C-4 | Component children are reported in the components map; render handles omit children | Docs judged sufficient. B-13 has since removed the in-sandbox gap                                    | NOTES §3, slots §7, T28       |
