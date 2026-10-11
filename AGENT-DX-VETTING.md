# Agent DX: one vetting list, ranked by expected value

Built for fig-75 on 2026-09-30. It merges all 13 `AGENT-DX-*.md` files: six raw note files, the two grid test-drive files, and the triage, recommendations, open-questions, overnight-progress and slot-resolution files. The source notes are unchanged. Nothing here is implemented or filed; approved entries become tickets after you vet them.

## Summary

**Tiers:** 🔴 **before 10/4** · 🟡 **soon after launch** · ⚪ **someday**

| Section                                          |  🔴 |  🟡 |  ⚪ | Total |
| ------------------------------------------------ | --: | --: | --: | ----: |
| A. Open or partly open, ranked                   |  10 |  25 |   9 |    44 |
| B. Likely fixed: confirm and close               |   — |   — |   — |    30 |
| C. Already accepted by you as existing behaviour |   — |   — |   — |     4 |

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

---

## A. Open or partly open, ranked

### A-1. `find` with an explicitly undefined `within` searches the whole page 🔴

**Verdict (Graham, 2026-10-02): approve.** Omitted scope retains the current-page default. An explicitly supplied `undefined` or `null` scope must fail before searching, with an error identifying the argument. Audit other optional target arguments for the same accidental fallback while preserving documented omitted-argument behavior.

**Status:** open. `read.ts:246` does `if (within == null) return figma.currentPage`.

**Problem:** A `clone` returned `{ node }`, so `v.id` was `undefined`. Three `find({ …, within: v.id })` calls then searched the page and returned the _original_ hero's nodes, and `editMany` edited your frame while you watched it.

**Fix (note):** Refuse a query whose `within` key is present but nullish, and name the key. `flcm.id(undefined)` already refuses the same way.
**Fix (mine):** Apply the same rule to every target-bearing argument, not just `within`.

**Confidence:** high · **Size:** XS · **Sources:** SE §1, SE §1.1

### A-2. The components docs push text properties; the opinion that overrides are normal never reaches agents 🔴 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-02): approve, one sentence only.** Add concise component guidance: "Use direct overrides for ordinary text and images; expose a named component property when it makes the component easier to use." No new examples or requirement that a Boolean already be used by an instance.

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

**Status:** open. The behaviour is documented (`flcm.md:24`); there is no intent word and no refusal.

**Problem:** Stripping only the root id is the natural way to say "make a copy". It creates a new root and _moves_ every id-bearing child into it, leaving the source empty. Nothing errors.

**Fix (note, agreed):** No new verb; a wrap verb was rejected as a false ceiling. Live descendants under a newly created node must carry an explicit intent word, and the refusal names that word. Check every new subtree, not just the outermost root.

**Confidence:** high · **Size:** S · **Sources:** CS §3, CS §1 (the documented rule that never reached the agent)

### A-6. Code mode silently drops `undefined`-valued keys from a return 🔴 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-02): approve.** Preserve successful results and add one concise warning naming explicitly returned object fields omitted because their values were undefined. Do not fail or replay the script, and do not warn simply because it returns nothing. Frequency and any recurring return-shape confusion remain evidence questions, not established causes or authorization for an API redesign.

**Live verification (2026-10-02): passed.** A read-only CLI probe traversed `g.node.children[0]` on an existing main component and an instance, returned selected child ID/name/type/count fields in custom objects, and checked ID/name against native Figma children. Both returned the fields successfully. The old missing-runtime-children failure did not reproduce; this item remains scoped to undefined-field warnings.

**Status:** open. `code-mode-tools.ts:34-37` only notes that the drop happens. `c5efc86` covers the failure envelope only.

**Problem:** `return { cardId, slotId, slotName, refs }` arrived as `{ cardId }`. The agent read that as "the tool returned nothing" and filed a false bug. This hides every typo'd field access in code mode.

**Fix (note):** Add `[warn] 3 returned keys were undefined and dropped: slotId, slotName, refs`.

This is tiered 🔴 because the result is serialized in plugin host code: `plugin/src/code.ts:1095` calls `safeSerialize` from `plugin/src/serialize.ts`, not the server-shipped preamble. A fix there means a re-import after launch.

**Confidence:** high · **Size:** XS · **Sources:** PD §3.1

### A-7. Targeted `get` has no parent context: fixed sizes become `"contextual"` and position is dropped 🟡 `[HUMAN REVIEWED]`

**Partial verdict (Graham, 2026-10-02): approve preserving real parent context for targeted reads of nested nodes.** A nested node should retain the same sizing intent and parent-relative position whether read directly or through its parent: fill/hug remain semantic values, and fixed dimensions remain numeric. Apply this consistently to plugin and REST reads through the shared converter. Plugin reads can obtain the live parent directly. For targeted REST reads, investigate the filtered GET file endpoint with ids, which includes ancestor chains, instead of the current isolated file-nodes response. Keep returned content scoped to the requested subtree and preserve target-relative depth semantics; verify payload cost and parity. Actual canvas-level sizing policy remains unchanged pending its separate decision. Do not add measured pixel dimensions alongside every fill/hug value; explicit measurement remains the way to request them. The representation and write semantics for actual canvas-level design frames remain under discussion. Neither removing contextual everywhere nor the proposed bare-contextual refusal is approved by this partial verdict.

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

**Status:** open. The "spins about its centre" wording arrived in `9bb7608` (9/15), whose message is about _when_ rotation composes, not where it pivots. The site-exploration session that found the mismatch came later (note dated 9/21), and no commit since touches the pivot. All four rotation rows still say "centre" (`flcm.md:263,376,389,420`), and I found no left/top translation. `measure` reports the unrotated box, so nothing in a read reveals the difference.

**Problem:** A grid of rotated lines landed entirely outside its hero, and dimension lines were about 100px off. The agent rebuilt them all as rectangles.

**Fix (note):** Correct the doc word now (XS). Optionally, later, translate left/top so the centre pivot is true, which is nicer for LINE dividers.

**Confidence:** high; the agent reproduced it in isolation · **Size:** XS (doc) / S (behaviour) · **Sources:** SE §2, GTD2 §2, GTD2 §6

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

### A-14. Renames: `pin` → `constraints`, `anchor` → `origin` 🔴 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-02): approve `pin` → `constraints`; remove `anchor`.** Preserve pin's behavior and values under the name constraints. After reviewing the session audit, Graham chose to remove the anchor placement helper. This supersedes the conditional anchor-to-origin rename and proposed origin behavior expansion; do not introduce origin. Remove the helper from supported inputs, implementation, reference generation and examples, and reconcile affected tests. The audit found use concentrated in one July tool-ergonomics exercise plus one explicit centering probe, with no observed uses in the two client projects. See `.scratch/anchor-usage-audit/report.md` for coverage limits. A-12 now separately approves center-pivot rotation without exposing a pivot/origin option.

**Status:** open. Both words are still in `schema.ts:219,227`. The `fromRead` → `toSpec` half of the note is moot, because `fromRead` was removed.

**Problem:** `pin` is Figma's `constraints` with the name coined and the values borrowed. `anchor` carries a _wrong_ CSS prior (anchor positioning); what it actually does is `transform-origin`. Coined words are held only in context, and context decays.

**Fix (note):** Rename both. Keep `left|center|right` values. Do it while it is still "cheap while nothing has shipped."

**Confidence:** medium; the benefit is inferred, not measured · **Size:** S (breaking) · **Sources:** PD §15

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

### A-20. Promoting an existing design: no worked example, and the invented-default and clone-fill traps remain 🟡 `[HUMAN REVIEWED]`

**Verdict (Graham, 2026-10-10): approve both fixes, with no worked example.**

- **Moves and clones keep their size (fig-115).** A live node landing in a frame without auto-layout freezes a `fill` carried over from its old parent at its current pixel size. A `fill` written in the same call still covers the parent.
- **Remove `defaultValue` (fig-116).** In a main component, Figma keeps a property's default and its bound layer identical: binding writes the default into the layer, and editing either updates the other (live-checked for text). So the default is always the bound layer's content.
  - Every property must be bound in the same call.
  - Binders that disagree fail, naming each one.
  - Reads and writes drop the field together.

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

### A-42. `measure` has no page coordinates; `clone`'s return shape differs from its siblings ⚪

**Verdict (Graham, 2026-10-09): approve the clone fix; drop page coordinates.**

- `flcm.clone` returns the copy's handle, the same shape `edit` returns, so `(await flcm.clone(...)).id` works like every other verb. Delete `CloneResult` and its `to` field. `remove` keeps `{ removedId, from }`: a deleted node shouldn't look like a usable handle.
- No `pageX`/`pageY`. Overlays belong in the closest container, where parent-relative x/y already work, and review notes have Figma annotations.
- Correct `measure`'s docs: x/y are relative to the containing frame or page, not the immediate parent. GROUP and BOOLEAN_OPERATION parents are skipped.

**Status:** partly.

- `measure`'s frame of reference and `clone`'s `{ node, to? }` are now both stated in the verbs rows (`flcm.md:99,109`).
- `measure` still has no `pageX`/`pageY`.
- `clone` is still the odd shape out. It triggered A-1.

**Fix (note):** Add `pageX`/`pageY`. Make `clone` return spec-with-ids like the other creating verbs, or make `.id` resolve on its result.

**Confidence:** medium · **Size:** S · **Sources:** SE §1.1, SE §3, T8, T29

### A-43. `flcm.component` rollback blamed `get_layoutMode` on a node that "does not exist" ⚪

**Status:** unclear. I found nothing addressing it. It was seen once and not narrowed.

**Fix (note):** Reproduce first. The rollback message itself is praised; only the attribution is wrong.

**Confidence:** low · **Size:** ? · **Sources:** PD §5

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
