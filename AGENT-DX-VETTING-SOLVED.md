# Agent DX: solved entries

Entries from `AGENT-DX-VETTING.md` whose approved scope has shipped. Each keeps its original A-number, verdict and `Tickets:` line, so references elsewhere still resolve. The **Status** text under each entry is the original vetting snapshot from before the fix, not the current state.

If one of these comes back, move it back to the vetting list with a fresh repro.

### A-1. `find` with an explicitly undefined `within` searches the whole page 🔴

**Verdict (Graham, 2026-10-02): approve.** Omitted scope retains the current-page default. An explicitly supplied `undefined` or `null` scope must fail before searching, with an error identifying the argument. Audit other optional target arguments for the same accidental fallback while preserving documented omitted-argument behavior.

**Tickets:** fig-98 (shipped)

**Status:** open. `read.ts:246` does `if (within == null) return figma.currentPage`.

**Problem:** A `clone` returned `{ node }`, so `v.id` was `undefined`. Three `find({ …, within: v.id })` calls then searched the page and returned the _original_ hero's nodes, and `editMany` edited your frame while you watched it.

**Fix (note):** Refuse a query whose `within` key is present but nullish, and name the key. `flcm.id(undefined)` already refuses the same way.
**Fix (mine):** Apply the same rule to every target-bearing argument, not just `within`.

**Confidence:** high · **Size:** XS · **Sources:** SE §1, SE §1.1

### A-2. The components docs push text properties; the opinion that overrides are normal never reaches agents 🔴 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-02): approve, one sentence only.** Add concise component guidance: "Use direct overrides for ordinary text and images; expose a named component property when it makes the component easier to use." No new examples or requirement that a Boolean already be used by an instance.

**Tickets:** fig-99 (shipped)

**Status:** open. There is no "most content should not be a property" paragraph. The old "prefer a property over overriding" sentence is gone.

**Problem:** Every component session reached for text properties first. One agent invented eight `Link N` properties and wrote placeholders over real content. Another told you "typed properties and nesting are mutually exclusive" and had you pick between them. The correct rule already exists in NOTES §18, but agents don't read the notes files; they read `get_flcm_reference(["components"])`.

**Fix (note):** Put a short paragraph above the `propertyDefinitions` table:

- Text and images vary by override.
- Declare a property only when the layer is hard to reach or the name carries meaning.
- A boolean earns its place when a layer is optional by design.
- Declare a boolean only if some instance uses it.

**Confidence:** high · **Size:** XS · **Sources:** PD §1, NOTES §18, NOTES §7 (the data-loss chain this triggered), T27 (watch item), OPEN-QUESTIONS "Watch: exposing every text layer"

### A-3. Scripts have no durable address, so every rejection costs a full resend 🟡 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-02): approve saved-file execution through MCP.** Add a JavaScript file-path alternative to inline code on the MCP code-execution tool, using the same FLCM runtime and shared execution path as the CLI. Document the option concisely in that tool’s own description and arguments. This approval covers file-based execution; the separate helper-source/session/eval proposal below is not included.

**Tickets:** fig-100 (shipped), fig-119 (shipped)

**Status:** partly. HEAD has no `scriptPath`. The unmerged `ce61b37` on `codex/saved-script-cli` adds a CLI `execute <file>`, but that is a CLI command, not something `figma_execute_code` accepts. `session` still refuses functions, and the store-source-then-`eval` pattern is undocumented.

**Problem:**

- A 9k-token script went out three times, once for each one-line validation fix. That is about 18k tokens of resends; roughly a third of that session's write-call tokens were repeats.
- Helper blocks and colour constants get retyped every call. They drift: the same glyph ended up authored three ways, two of them with the bbox-stretch bug.

**Fix (note):**

- `figma_execute_code({ scriptPath })`, resolved under the same asset root `flcm.image` enforces, so it adds no new trust boundary.
- A doc line setting the paradigm: "over a screenful, write it to a file and run it by path".
- Document keeping helper _source strings_ in `session` and `eval`-ing them back.

**Fix (mine):** Decide whether `ce61b37`'s shared execution path is the base for this, or whether the CLI is a separate idea.

This is server-only, so it is not launch-gated. It is ranked 3rd on value.

**Confidence:** high on the problem, medium on the shape · **Size:** S–M · **Sources:** SE §11, CS §8 (the session-constants half)

### A-4. Enumerated sets read as closed, so agents conclude documented capabilities are missing 🔴 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-02): approve, clarify through removal.** Consolidate search guidance into one authoritative reference row: the listed query keys are closed; the optional predicate can test any field in each candidate's full flcm read shape. Remove redundant surrounding explanations rather than adding another paragraph or expanding example lists. Route likely query-key misses concisely in the existing error guidance. No additional search facets in this batch. Apply the illusion-of-completeness principle; examples are optional, not the fix.

**Tickets:** fig-101 (shipped), fig-130 (shipped)

**Status:** partly.

- Landed: `name` accepts a RegExp, and the unknown-query-key refusal now carries `FIND_PREDICATE_HINT` (`read.ts:283`).
- Open:
  - The verbs row still says only "Optional predicate sees expanded read data" (`schema.ts:839`).
  - There is no `n.text?.includes(…)` example.
  - The query row doesn't say that text and `componentId` aren't query keys.
  - `n.characters` silently matches nothing.

**Problem:** Four "phantom gaps" in one draft and five in another were features that already existed and were documented. The costly one: an agent told you your designer's 30 frames were not in the file. Lists read as authoritative, and prose after a list reads as commentary.

**Fix (note):**

- Rewrite the reference, don't add to it.
- State what makes an open set open ("the predicate receives each node's full read shape; test any field").
- Put that inside the list's own row.
- Spend examples on the boundary (`n => n.text?.includes("Total")`).
- Route the predictable misses ("text is not a key; use the predicate").
- Mark closed sets as closed.

Add one line that `name` also matches a TEXT's auto-name, which is its content (SE §10).

**Open decision (T30):** keep canonical predicates only, or add `find({ text })` and `find({ componentId })` facets. PD §12 is the evidence against predicates-only.

**Confidence:** high · **Size:** S · **Sources:** PD §12, PD §16, CS §14.3, CS §23, NOTES §15, NOTES §24, SE §10, T30, REMAINING §5

### A-5. A new node with live id-bearing descendants silently moves them out of the source 🔴 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-02): defer for separate design consideration.** Claude proposed explicit copy/move intent, and a read-to-template helper was also discussed; neither is approved. Preserve the shared-tree wrapping workflow while reconsidering how copying and moving should be expressed. The historical explicit-intent proposal below is not current implementation approval.

**Verdict (Graham, 2026-10-09): approve a diagnostic plus docs; no new syntax.** This diagnoses the mistake; it doesn't prevent it. Preventing it means changing how read ids become authored references, through an explicit copy/move word or a read-side id that stops counting as identity once its root is dropped. That was declined for launch, because `clone` already copies explicitly and one incident doesn't justify a permanent change to the surface. If prevention becomes a requirement, prefer the explicit word.

- Docs: `clone` is the one documented copy route. Delete the strip-ids-to-copy recipe, but keep the sentence explaining what deleting only the root id does. Recipes show wrapping and extracting by mapping ids (`node.children.map(({ id }) => ({ id }))`), so selecting live nodes needs no selector syntax.
- Warning: after a verb succeeds, report live nodes placed directly into a node that verb created, where they ended up outside their old parent. One line per source container, saying whether it is now empty and naming `flcm.clone` for copying. Skip sources the verb removed, and slot content Figma copied rather than moved.

**Tickets:** fig-109 (shipped), fig-110 (shipped)

**Status:** open. The behaviour is documented (`flcm.md:24`); there is no intent word and no refusal.

**Problem:** Stripping only the root id is the natural way to say "make a copy". It creates a new root and _moves_ every id-bearing child into it, leaving the source empty. Nothing errors.

**Fix (note, agreed):** No new verb; a wrap verb was rejected as a false ceiling. Live descendants under a newly created node must carry an explicit intent word, and the refusal names that word. Check every new subtree, not just the outermost root.

**Confidence:** high · **Size:** S · **Sources:** CS §3, CS §1 (the documented rule that never reached the agent)

### A-6. Code mode silently drops `undefined`-valued keys from a return 🔴 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-02): approve.** Preserve successful results and add one concise warning naming explicitly returned object fields omitted because their values were undefined. Do not fail or replay the script, and do not warn simply because it returns nothing. Frequency and any recurring return-shape confusion remain evidence questions, not established causes or authorization for an API redesign.

**Live verification (2026-10-02): passed.** A read-only CLI probe traversed `g.node.children[0]` on an existing main component and an instance, returned selected child ID/name/type/count fields in custom objects, and checked ID/name against native Figma children. Both returned the fields successfully. The old missing-runtime-children failure did not reproduce; this item remains scoped to undefined-field warnings.

**Tickets:** fig-102 (shipped)

**Status:** open. `code-mode-tools.ts:34-37` only notes that the drop happens. `c5efc86` covers the failure envelope only.

**Problem:** `return { cardId, slotId, slotName, refs }` arrived as `{ cardId }`. The agent read that as "the tool returned nothing" and filed a false bug. This hides every typo'd field access in code mode.

**Fix (note):** Add `[warn] 3 returned keys were undefined and dropped: slotId, slotName, refs`.

This is tiered 🔴 because the result is serialized in plugin host code: `plugin/src/code.ts:1095` calls `safeSerialize` from `plugin/src/serialize.ts`, not the server-shipped preamble. A fix there means a re-import after launch.

**Confidence:** high · **Size:** XS · **Sources:** PD §3.1

### A-7. Targeted `get` has no parent context: fixed sizes become `"contextual"` and position is dropped 🟡 `[HUMAN REVIEWED]`

**Partial verdict (Graham, 2026-10-02): approve preserving real parent context for targeted reads of nested nodes.** A nested node should retain the same sizing intent and parent-relative position whether read directly or through its parent: fill/hug remain semantic values, and fixed dimensions remain numeric. Apply this consistently to plugin and REST reads through the shared converter. Plugin reads can obtain the live parent directly. For targeted REST reads, investigate the filtered GET file endpoint with ids, which includes ancestor chains, instead of the current isolated file-nodes response. Keep returned content scoped to the requested subtree and preserve target-relative depth semantics; verify payload cost and parity. Actual canvas-level sizing policy remains unchanged pending its separate decision. Do not add measured pixel dimensions alongside every fill/hug value; explicit measurement remains the way to request them. The representation and write semantics for actual canvas-level design frames remain under discussion. Neither removing contextual everywhere nor the proposed bare-contextual refusal is approved by this partial verdict.

**Tickets:** fig-123 (shipped)

**Status:** open.

- `read.ts:258-261` still roots the target.
- A bare `width: "contextual"` with no `designedWidth` is still silently deleted (`authoring-input.ts:48-51`). The result is "the changes object is empty".

**Problem:**

- The same node reads as `width: "contextual"` with no position when targeted, and as `402` with `position`/`left`/`top` when read as a child. That gives three size representations across `get`, child reads and `measure`.
- The positional truth sat only in `readOnlySource`, which taught the agent raw Figma: about 190 `getNodeByIdAsync` calls in one session. `readOnlySource` is now off the wire (B-13), so that half has eased.

**Fix (note, agreed direction):**

- Give targeted authoring reads their real parent context, so they return numeric sizes and position like a child read.
- Keep "don't hardcode this" as advice _beside_ the geometry.
- Refuse a bare `"contextual"` by name.

**Fix (mine):** Ship the refusal now; it is XS and ends a silent no-op. Treat the parent-context change as the M part.

**Confidence:** high · **Size:** XS + M · **Sources:** CS §2, CS §12, CS §17 (three size representations), CS §23

### A-8. Moving slot content across slots or out of a slot can leave zombie nodes 🔴

**Verdict (Graham, 2026-10-03): approve the split fix.** A live re-run (`.scratch/agent-dx-proposals/A-08-live-rerun.md`) found that moving direct slot content now works in every direction. Inherited slot content (filled inside an enclosing component's definition) behaves differently. Figma turns a move to a sibling slot into a copy with a new id. A move anywhere outside the instance produces an unrecoverable zombie that also crashes page-wide traversal, including `flcm.find`.

- Inherited content → another slot: allowed. After every placement, re-find the node at the written index, using an indexed search from the destination where handles are stale. Return the copy's new id. Remove the stale-id alias.
- Inherited content → outside its instance: refused by name before writing.
- Fix the move error's wording: no "edit the component" advice, no doubled rollback sentence, no `flcm.flcm.append.spec`.
- `flcm.find` must survive an unreadable node rather than crash page-wide.

**Tickets:** fig-103 (shipped)

**Status:** partly.

- Descendant reads after moving into a slot are fixed (`4a295eb`, B-21).
- flcm still allows cross-slot and move-out moves (`structure.ts:74-93`; "slot content remains open", `flcm.md:674`).
- A native remapped-root move-out still invalidates the node, and flcm only survives it through the generic rollback.
- The reference has nothing on the raw-API hazard.

**Problem:** This is the only thing in the notes that destroyed work outright. Nodes stayed visible but could not be read, moved or deleted. Six tiles were rebuilt by hand; one recovery took about 15 calls.

**Fix (note):**

- Hard-refuse the cross-slot move and the move-out.
- State positively in `structure`: to change slots, clear the slot, build fresh, then append; don't move.

**Fix (mine):** Do the doc table now (XS). The refusal needs one live check of exactly which moves invalidate, since triage 1 found the answer depends on context.

**Confidence:** medium; the triage called the remaining cases context-dependent · **Size:** XS doc + S refusal · **Sources:** slots §1, NOTES §26.2a, T1, T2, SLOT-ACCESS-RESOLUTION "Still open", OPEN-QUESTIONS "Slot node readability"

### A-9. Variables and styles: usage (bind by name, discover what exists) 🟡 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-09): approve tokens as ordinary values in the shared vocabulary.**

- A token reference can stand wherever a literal can, under two distinct keys: `{ variable: … }` and `{ style: … }`. Both producers emit it, so REST and plugin reads keep one shape. Compression treats it like any other value. Tokens get no sidecar and no parallel bindings field.
- A reference carries the token's id, plus its name when the producer knows it. Writes accept the same value and bind the prop. An unknown or ambiguous name fails and lists the candidates.
- One discovery read lists the tokens the file can use.
- `teamlibrary` was added to the manifest now (fig-112), so unused library variables can be discovered later without a re-import. The plugin API can't discover library styles at all; state that once in the docs.
- Out of scope: Enterprise-only REST variable names. REST emits variable ids without names.

**Tickets:** fig-112 (shipped), fig-113 (shipped), fig-114 (shipped), fig-117 (shipped), fig-118 (shipped)

**Status:** open.

- Variables are "deliberately out of v1" (`flcm.md:970`).
- Style ids are read into snapshots, but nothing binds them; there are no `set*StyleIdAsync` or `setBoundVariable` calls.

**Problem:** Every colour, space and type value an agent writes is a baked literal: about 30 hand-typed `#2D4024` in one session. The agent cannot build _with_ the system a file already has, or even discover that one exists. The note calls it "the largest missing capability for design-system work."

**Fix (note):**

- Any styleable prop accepts `{ variable: "name" }` / `{ style: "name" }`.
- Add `flcm.variables.list()` / `flcm.styles.list()`.
- If only one ships, make it variable usage by name.

**Confidence:** high on value; the plugin-API cost is unmeasured · **Size:** L · **Sources:** PD §2

### A-10. Connection and approval messages still lack a stop condition 🔴

**Verdict (Graham, 2026-10-02): approve, including asynchronous approval.** Clarify recovery messages for disconnected plugins and pending approval. After the existing wait expires, identify the blocker, state when no code was submitted, and name the action required before retrying. Use the same guidance for all callers: report the blocker to the user or coordinating agent and retry after the required state change. Apply submission-status wording only where the call is known not to have been submitted.

Include approval after the originating request has ended in this item. Retain a pending session entry that the user can approve later, allowing the same authenticated session to use that approval on its next connection. Approval must not execute or replay the expired script; the agent still retries. In the plugin UI, visually distinguish inactive/expired requests from actively waiting requests and state clearly that nothing is currently waiting to run. Determine the secure disconnected-session handoff during implementation; a matching display name or project path alone is not session identity. Existing wait lengths need not change. This scope includes plugin UI and approval lifecycle work, beyond the original messaging-only proposal.

**Tickets:** fig-104 (shipped), fig-121 (shipped)

**Status:** partly.

- The retry-forever text is gone.
- There is a 30s reconnection window (`code-mode-tools.ts:96-104`), but after it the reply still says "…then retry" with no stop.
- `bridge.ts:902` still says "No Figma plugin connected … Open the Framelink plugin … and try again", which is the false escalation on a transient blip.
- The not-approved message (`code-mode-tools.ts:128`) doesn't tell agents to escalate after one retry or say what a wait costs. The wait is now 120s (`await-approval.ts:19`), which makes that worse.
- Approvals now persist (`4604af0`).

**Problem:** Agents burned about 25 calls in one outage and about 200s of dead approval waits in another. A subagent cannot prompt the user, so an unattended run just sleeps.

**Fix (note, amended):**

- Unify the two "not connected" wordings.
- After N consecutive failures or T seconds of downtime, say so explicitly and tell the agent to escalate.
- The approval message says "costs up to 120s per attempt and cannot succeed without a human; retry once, then escalate with the code".

This is server-only, but it is part of the first-run experience.

**Confidence:** high · **Size:** XS · **Sources:** mobile §5, NOTES §26.6, T37, T38

### A-11. Screenshots: no region crop, no multi-node composite, no labels, and context capture is opt-in 🔴

**Verdict (Graham, 2026-10-02):** Reject the additional region-crop proposal for the reported section-context problem: we expect existing node-targeted contextual screenshots with adjustable margins to address it. This is a product disposition, not a claim that every visual-review case has been verified. Multi-node composition and labels are also rejected (Graham, October 2). Separate node screenshots already support inspecting multiple designs; this report establishes a presentation convenience, not a missing inspection capability.

**Updated screenshot-default decision (supersedes the earlier approval):** Keep isolated node screenshots as the default. Context is explicitly requested; when its margin is omitted, use 10% of the target's longest side, clamped to 80–160px. Explicit finite nonnegative margins remain supported, including zero. Raising the calculated minimum from 24px to 80px remains approved implementation work.

**Tickets:** fig-124 (shipped)

**Status:** partly. `context: true` plus `margin` exists as an opt-in prototype (`code-mode-tools.ts:300-323`, `plugin/src/screenshot-capture.ts`). There is no crop, no array of ids and no labels. Per the overnight notes, cleanup can leave a temporary slice behind on forced shutdown.

**Problems:**

- A transparent-background child caused a false alarm.
- A 12,757px artboard is unreadable at scale 1.
- A three-up comparison needed a full-page shot with unrelated content in it.
- Review defects that the tree can't show need pixels, and the reviewer doesn't know in advance which node to shoot.

**Fix (note):**

- A `region` argument (a y-range).
- `nodeIds: [...]` composed with a gutter.
- Opt-in `labels`.
- Historical proposal to settle the context default: now resolved by the verdict above; T19 retains the user-observed testing requirement.

**Why 🔴:** capture lives in `plugin/src`, so any change to the capture protocol is a re-import after launch. Settle the argument shape now even if the features ship later.

**Confidence:** high on need, medium on shape · **Size:** M · **Sources:** NOTES §16, NOTES §22, mobile §11, PD §14, T19, OVERNIGHT "Remaining limits"

### A-12. Rotation docs say "spins about its centre"; the live pivot is the top-left corner 🔴

**Verdict (Graham, 2026-10-02): approve center-pivot rotation as the dialect default.** Implement transform/position compensation so rotation uses the node's center, matching the demonstrated Figma UI behavior and ordinary CSS. Do not add a pivot/origin option; callers needing a different pivot can implement it in custom code. This replaces the documentation-only proposal. Anchor removal remains approved under A-14.

**Evidence and acceptance:** Fresh live comparisons confirmed that both the native rotation setter and a rotation-only FLCM edit keep the top-left fixed; center compensation works on the retained comparison board. The Figma API describes matrix transforms as the way to implement center rotation. Verify creation and edits, already-rotated nodes, repeated identical edits without drift, simultaneous size/position changes, lines, and auto-layout children. Auto-layout controls flow-child translation, so establish the correct behavior live rather than silently falling back to top-left rotation. Keep reads, authored coordinates and documentation consistent with the chosen center-pivot contract.

**Tickets:** fig-105 (shipped)

**Status:** open. The "spins about its centre" wording arrived in `9bb7608` (9/15), whose message is about _when_ rotation composes, not where it pivots. The site-exploration session that found the mismatch came later (note dated 9/21), and no commit since touches the pivot. All four rotation rows still say "centre" (`flcm.md:263,376,389,420`), and I found no left/top translation. `measure` reports the unrotated box, so nothing in a read reveals the difference.

**Problem:** A grid of rotated lines landed entirely outside its hero, and dimension lines were about 100px off. The agent rebuilt them all as rectangles.

**Fix (note):** Correct the doc word now (XS). Optionally, later, translate left/top so the centre pivot is true, which is nicer for LINE dividers.

**Confidence:** high; the agent reproduced it in isolation · **Size:** XS (doc) / S (behaviour) · **Sources:** SE §2, GTD2 §2, GTD2 §6

### A-14. Renames: `pin` → `constraints`, `anchor` → `origin` 🔴 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-02): approve `pin` → `constraints`; remove `anchor`.** Preserve pin's behavior and values under the name constraints. After reviewing the session audit, Graham chose to remove the anchor placement helper. This supersedes the conditional anchor-to-origin rename and proposed origin behavior expansion; do not introduce origin. Remove the helper from supported inputs, implementation, reference generation and examples, and reconcile affected tests. The audit found use concentrated in one July tool-ergonomics exercise plus one explicit centering probe, with no observed uses in the two client projects. See `.scratch/anchor-usage-audit/report.md` for coverage limits. A-12 now separately approves center-pivot rotation without exposing a pivot/origin option.

**Tickets:** fig-106 (shipped)

**Status:** open. Both words are still in `schema.ts:219,227`. The `fromRead` → `toSpec` half of the note is moot, because `fromRead` was removed.

**Problem:** `pin` is Figma's `constraints` with the name coined and the values borrowed. `anchor` carries a _wrong_ CSS prior (anchor positioning); what it actually does is `transform-origin`. Coined words are held only in context, and context decays.

**Fix (note):** Rename both. Keep `left|center|right` values. Do it while it is still "cheap while nothing has shipped."

**Confidence:** medium; the benefit is inferred, not measured · **Size:** S (breaking) · **Sources:** PD §15

### A-20. Promoting an existing design: no worked example, and the invented-default and clone-fill traps remain 🟡 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-10): approve both fixes, with no worked example.**

- **Moves and clones keep their size (fig-115).** A live node landing in a frame without auto-layout freezes a `fill` carried over from its old parent at its current pixel size. A `fill` written in the same call still covers the parent.
- **Remove `defaultValue` (fig-116).** In a main component, Figma keeps a property's default and its bound layer identical: binding writes the default into the layer, and editing either updates the other (live-checked for text). So the default is always the bound layer's content.
  - Every property must be bound in the same call.
  - Binders that disagree fail, naming each one.
  - Reads and writes drop the field together.

**Tickets:** fig-115 (shipped), fig-116 (shipped), fig-125 (shipped), fig-127 (shipped), fig-129 (shipped), fig-131 (shipped)

**Status:** partly.

- `defaultValue` is derived from the bound layer when omitted (`component.ts:288-297`), which removes the forcing function.
- Clones accept fixed-size overrides (overnight notes).
- Still open:
  - No "promote an existing block" example.
  - No warning that an invented default overwrites real content.
  - Cloning a `fill` node into a free-form parent still resolves `fill` against an arbitrary height.
- T22 (close the residual complaint without a new feature) is pending your decision.

**Problem:** This is half the product's job, systematizing designs someone already made. One component came out 480×2600 and only the master was wrong, so instances hid it.

**Fix (note):**

- Refuse `fill` into a free-form parent, or fix it to current pixels.
- Add one example.
- The `flcm.library` grid helper (NOTES §9.3) stays ⚪.

**Confidence:** medium · **Size:** S · **Sources:** NOTES §6, NOTES §7, NOTES §8, NOTES §9, T8, T22

### A-42. `measure` has no page coordinates; `clone`'s return shape differs from its siblings ⚪

**Verdict (Graham, 2026-10-09): approve the clone fix; drop page coordinates.**

- `flcm.clone` returns the copy's handle, the same shape `edit` returns, so `(await flcm.clone(...)).id` works like every other verb. Delete `CloneResult` and its `to` field. `remove` keeps `{ removedId, from }`: a deleted node shouldn't look like a usable handle.
- No `pageX`/`pageY`. Overlays belong in the closest container, where parent-relative x/y already work, and review notes have Figma annotations.
- Correct `measure`'s docs: x/y are relative to the containing frame or page, not the immediate parent. GROUP and BOOLEAN_OPERATION parents are skipped.

**Tickets:** fig-111 (shipped)

**Status:** partly.

- `measure`'s frame of reference and `clone`'s `{ node, to? }` are now both stated in the verbs rows (`flcm.md:99,109`).
- `measure` still has no `pageX`/`pageY`.
- `clone` is still the odd shape out. It triggered A-1.

**Fix (note):** Add `pageX`/`pageY`. Make `clone` return spec-with-ids like the other creating verbs, or make `.id` resolve on its result.

**Confidence:** medium · **Size:** S · **Sources:** SE §1.1, SE §3, T8, T29

### A-43. `flcm.component` rollback blamed `get_layoutMode` on a node that "does not exist" ⚪

**Verdict (Graham, 2026-10-11): fixed by fig-128.** That fix stopped reads of the frame `createComponentFromNode` replaces, which is the same "does not exist" signature. If it recurs, get a proper repro then.

**Tickets:** fig-128 (shipped)

**Status:** unclear. I found nothing addressing it. It was seen once and not narrowed.

**Fix (note):** Reproduce first. The rollback message itself is praised; only the attribution is wrong.

**Confidence:** low · **Size:** ? · **Sources:** PD §5
