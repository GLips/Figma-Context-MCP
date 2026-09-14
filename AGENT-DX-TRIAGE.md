# Agent DX investigation triage

## Decision and delivery status — reconciled 2026-09-13

The earlier “17 open or deferred” total incorrectly mixed unmade decisions with already approved follow-up work. It is superseded by this classification. Every original entry appears once below; its original number is retained.

**What still needs discussion:** five entries have recommendations not yet accepted: **14, 20, 22, 30, 33**. They form three review topics in the [remaining recommendations](AGENT-DX-REMAINING-RECOMMENDATIONS.md). Four other entries need investigation before a solution is ready; two designs were explicitly deferred. The remaining 27 entries have settled dispositions.

| Decision / work status                                         | Entries                                              | Count |
| -------------------------------------------------------------- | ---------------------------------------------------- | ----: |
| Resolved or accepted                                           | 4, 5, 6, 7, 10, 11, 28, 37, 38                       |     9 |
| Decision settled; implementation batch completing verification | 24, 26, 29, 32                                       |     4 |
| Decision settled; delivery or follow-up remains                | 8, 9, 12, 15, 16, 17, 18, 19, 21, 23, 27, 34, 35, 36 |    14 |
| Recommendation needs review                                    | 14, 20, 22, 30, 33                                   |     5 |
| Investigation before a solution can be proposed                | 1, 2, 3, 13                                          |     4 |
| Explicitly deferred design                                     | 25, 31                                               |     2 |
| Total                                                          |                                                      |    38 |

“Settled” means no repeat approval is needed for the recorded scope. It does not mean implemented, tested, committed, or merged. In particular, the screenshot direction is approved for an experiment, not an unconditional slice implementation. Delivery status and historical evidence remain attached to each entry. Source changes remain uncommitted; test coverage differs by item.

The nine resolved entries comprise five implemented/tested resolutions and four accepted existing behaviors. The four-entry verification group retains its batch completion gate even where individual live checks have passed. The fourteen-entry delivery group includes both undispatched features and already implemented work with residual checks; it must not be described as fourteen unimplemented fixes.

[Open design questions](AGENT-DX-OPEN-QUESTIONS.md) records explicit deferrals and investigation questions. First-pass evidence is historical; the current disposition takes precedence.

## Resolved or accepted — 9

### 4. Clone-based audits: wrapped geometry differs from live nodes

**Current disposition:** Accepted existing clone behavior. A temporary copy used for auditing may have different geometry from its source; no separate clone fix requested. Direct source access remains tracked under items 1–3.

**First-pass evidence and sources:** Clone-based audits: wrapped geometry differs from live nodes. [slots §4](AGENT-DX-NOTES-slots.md#4-clone-is-the-sanctioned-read-escape-hatch-but-its-geometry-lies--p1). **Reproduced, narrowed**: cloning HUG slots with FILL children expands 353 px to master placeholder width 1170 px before reparenting; WRAP is unnecessary. FIXED-child control preserves width. Evidence: slot-validity 07; /tmp/figma-slot-archaeology/review.md.

### 5. Instance-root layout direction: ignored writes alongside applied spacing

**Current disposition:** Implemented and tested, including live direction guards. Worktree integration/commit remains separate from behavioral verification.

**First-pass evidence and sources:** Instance-root layout direction: ignored writes alongside applied spacing. [notes §21](AGENT-DX-NOTES.md#21-footgun-layoutmode-on-an-instance-root-is-a-silent-no-op--through-raw-api-and-flcm), [slots §5](AGENT-DX-NOTES-slots.md#5-instance-root-layoutmode-reverts-silently--p2). **Addressed (verified in worktree; not merged)**: shared validation rejects incompatible instance directions before writes, allows matching directions, and checks incoming swaps/variants. Automated validation and nine changed-runtime live observations passed. Evidence: instance-direction 01; /tmp/figma-instance-direction/execution.json.

### 6. Instance sublayer sizing: ignored edits alongside applied styles

**Current disposition:** Numeric child-sizing validation implemented; focused automated checks and live sizing cases passed.

**First-pass evidence and sources:** Instance sublayer sizing: ignored edits alongside applied styles. [mobile §9](AGENT-DX-NOTES-mobile.md#9-instance-sublayers-one-mutation-fails-silently-the-neighbouring-one-throws). **Reproduced**: resize stays 40 × 40, fill changes, x throws. Evidence: triage-first-pass 06.

### 7. Raw resize clamping: hidden per-instance minimum width

**Current disposition:** Bounds authoring, clearing, read parity and clamp feedback implemented; live sizing cases passed.

**First-pass evidence and sources:** Raw resize clamping: hidden per-instance minimum width. [notes §26.1](AGENT-DX-NOTES.md#261-footgun-an-invisible-per-instance-minwidth-silently-clamps-resize). **Partly reproduced**: requesting 145 px realizes 160 px with minWidth 160 px; flcm read visibility remains unverified. Evidence: triage-first-pass 09.

### 10. Property binding and deletion: default text overwrites source content

**Current disposition:** Accepted existing behavior: binding applies the property default; deletion retains current text. No change requested.

**First-pass evidence and sources:** Property binding and deletion: default text overwrites source content. [notes §7](AGENT-DX-NOTES.md#7-footgun-an-invented-defaultvalue-permanently-overwrites-real-content). **Reproduced**: binding overwrites original title; deletion retains default. Evidence: triage-first-pass 07.

### 11. Text properties: mixed-run styling loss

**Current disposition:** Accepted existing behavior. No mixed-style preservation change or further investigation requested.

**First-pass evidence and sources:** Text properties: mixed-run styling loss. **Reviewed: accepted behavior; no action requested.** [notes §19](AGENT-DX-NOTES.md#19-smaller-things). **Reproduced**: price property collapses mixed sizes/strike to uniform style. Evidence: triage-first-pass 07.

### 28. Component child lookup and render handles versus keyed results

**Current disposition:** Existing read structure and component-map documentation reviewed and sufficient; no additional documentation needed.

**First-pass evidence and sources:** Component child lookup and render handles versus keyed results. [notes §3](AGENT-DX-NOTES.md#3-flcmget-on-a-component-doesnt-return-what-a-frame-returns), [slots §7](AGENT-DX-NOTES-slots.md#7-renders-returned-node-doesnt-carry-children--p3). **Reproduced documented shape**: component children in components map; frame children inline; render handle omits children. Evidence: triage-first-pass 12.

### 37. Disconnect guidance: short reconnects versus prolonged outage retries

**Current disposition:** Reconnect and execution-state reporting implemented and tested, with targeted live connection checks. This does not close the unexplained historical stall in item 13.

**First-pass evidence and sources:** Disconnect guidance: short reconnects versus prolonged outage retries. [mobile §5](AGENT-DX-NOTES-mobile.md#5-connection-and-approval-failure-modes--what-i-actually-saw), [notes §26.6](AGENT-DX-NOTES.md#266-the-disconnect-message-instructs-you-to-retry-forever). **Partial**: deliberate plugin closure produced bounded CLI timeout with reopen guidance; reopening connected. Original prolonged MCP outage remains untested. Evidence: /tmp/figma-connection-review/review.md.

### 38. Approval drops: retry cost, rotating codes and unattended-run interruption

**Current disposition:** Approval lifecycle fixes implemented and tested; approval survived plugin reopen in live verification. Rejection/revocation/storage-failure cases have automated coverage; the original spontaneous-drop history was not reproduced.

**First-pass evidence and sources:** Approval drops: retry cost, rotating codes and unattended-run interruption. [mobile §5](AGENT-DX-NOTES-mobile.md#5-connection-and-approval-failure-modes--what-i-actually-saw). **Partial**: close/reopen intentionally clears plugin approval; same cwd/port retained its disk token but required Allow. Bounded approval waits expired without execution. Original spontaneous mid-run drop remains untested. Evidence: /tmp/figma-connection-review/review.md.

## Decision settled; implementation batch completing verification — 4

### 24. Existing image-fill reuse through imageRef

**Current disposition:** Image-reference documentation corrected; included in the implementation batch whose verification is still being completed.

**First-pass evidence and sources:** Existing image-fill reuse through imageRef. [notes §11](AGENT-DX-NOTES.md#11-missing-image-fills-by-imageref). **Not reproduced as missing capability**: real imageRef copy renders with the source hash and matching pixels in scenario 13. Evidence: triage-first-pass 13.

### 26. Instance layout validation against inherited component layout

**Current disposition:** Inherited-layout validation implemented; initial live insertion checks passed. Selected-variant/slot coverage encountered an unreadable descendant and remains under investigation.

**First-pass evidence and sources:** Instance layout validation against inherited component layout. [notes §26.4](AGENT-DX-NOTES.md#264-flcminstance-layout-props-are-validated-against-the-spec-not-the-component). **Reproduced**: spacing-only instance spec rejects despite column master. Evidence: triage-first-pass 10.

### 29. Creation return shapes and promotion root-ID replacement

**Current disposition:** Persistent promotion aliases implemented. Native Undo and Redo passed; reopen and remaining lifecycle verification pending.

**First-pass evidence and sources:** Creation return shapes and promotion root-ID replacement. [notes §4](AGENT-DX-NOTES.md#4-return-shape-inconsistency-across-the-creating-verbs), [notes §5](AGENT-DX-NOTES.md#5-flcmcomponent-returns-a-node-with-a-new-id). **Reproduced return/identity behavior**: variants returns handle; promotion replaces root ID and preserves child ID. Evidence: triage-first-pass 07, 10.

### 32. Raw/flcm vocabulary: binding names, property suffixes, clip, textStyle nesting and baseline alignment

**Current disposition:** Clipping/font-size normalization and baseline writes implemented; automated checks and initial live checks passed. Final batch verification remains open.

**First-pass evidence and sources:** Raw/flcm vocabulary: binding names, property suffixes, clip, textStyle nesting and baseline alignment. [notes §14](AGENT-DX-NOTES.md#14-read-words-are-not-always-write-words), [notes §19](AGENT-DX-NOTES.md#19-smaller-things), [notes §25](AGENT-DX-NOTES.md#25-an-alias-table-for-figma-api-words-design-sketch), [slots working section](AGENT-DX-NOTES-slots.md#whats-working-specifically). **Partly reproduced vocabulary friction**: clipsContent rejected, clip accepted; remaining aliases are documentation review. Evidence: triage-first-pass 11.

## Decision settled; delivery or follow-up remains — 14

### 8. Clone sizing: retained fill in free-form staging; explicit dimensions become fixed

**Current disposition:** Approved on-demand parent-relative x/y and numeric width/height, plus ordinary clone root overrides. Normal reads keep sizing intent.

**First-pass evidence and sources:** Clone sizing: retained fill in free-form staging; explicit dimensions become fixed. [notes §9](AGENT-DX-NOTES.md#9-footgun-clone-keeps-fill-sizing-into-a-free-form-parent-and-silently-stretches), [notes §19](AGENT-DX-NOTES.md#19-smaller-things). **Reproduced geometry**: FILL clone expands to free-form staging bounds; raw sizing modes then read FIXED. Evidence: triage-first-pass 09.

### 9. Variant cloning: missing text and visibility bindings

**Current disposition:** Approved binding-preserving clone: reuse original property IDs within the same set; create needed distinct definitions and remap outside it. Repair paths demonstrated; implementation not dispatched.

**First-pass evidence and sources:** Variant cloning: missing text and visibility bindings. [slots §6](AGENT-DX-NOTES-slots.md#6-clone-drops-componentpropertyreferences--p2). **Reproduced for variants**: raw/flcm variant clones lose both bindings; standalone clones retain them. Raw clone initial parent was not recorded. Evidence: triage-first-pass 07, 10.

### 12. Container resize and axis changes: collapsed fill, stale sizing and fixed-height overlap

**Current disposition:** Already settled; no new user decision. Remaining work is verification/documentation within the approved scope. Overflow feedback is implemented and live-tested. Original axis-change/stale-sizing history remains unresolved; partial coverage does not close the entry.

**First-pass evidence and sources:** Container resize and axis changes: collapsed fill, stale sizing and fixed-height overlap. [mobile §2](AGENT-DX-NOTES-mobile.md#2-silent-sizing-collapse-when-a-cloned-frame-is-narrowed), [mobile §12](AGENT-DX-NOTES-mobile.md#12-things-i-got-wrong-and-why), [notes §23](AGENT-DX-NOTES.md#23-footgun-a-fixed-height-on-an-auto-layout-frame-overflows-in-total-silence). **Partly reproduced**: FILL collapses to 1 px and fixed-height siblings overlap; full responsive history not replayed. Evidence: triage-first-pass 09.

### 15. Wrap, cross-axis gaps and min/max sizing coverage

**Current disposition:** Approved wrap and separate row/column gap writes with read parity. Bounds portion is already verified under item 7.

**First-pass evidence and sources:** Wrap, cross-axis gaps and min/max sizing coverage. [notes §12](AGENT-DX-NOTES.md#12-missing-minwidth--maxwidth--layoutwrap), [notes §26.3](AGENT-DX-NOTES.md#263-12-confirmed-and-its-worse-than-missing-props), [mobile §1](AGENT-DX-NOTES-mobile.md#1-layoutwrap-counteraxisspacing-and-minwidth-are-the-entire-mobile-toolkit-and-none-of-them-are-in-flcm). **Reproduced missing vocabulary**: flexWrap/rowGap/minWidth constructors reject; raw wrap fixture works. Evidence: triage-first-pass 11; slot-validity 03.

### 16. Fixed-width text reflow and query-to-bulk-edit friction

**Current disposition:** Existing bulk-edit workflow accepted. Approved omitted-width default to fill for newly authored text in width-bounded columns, with content-driven height when omitted.

**First-pass evidence and sources:** Fixed-width text reflow and query-to-bulk-edit friction. [mobile §3](AGENT-DX-NOTES-mobile.md#3-fixed-width-text-does-not-reflow-and-theres-no-bulk-way-to-fix-it). **Reproduced reflow behavior**: fixed text stays 380 px when its parent narrows; explicit FILL makes it 204 px and reflows. Query-to-bulk-edit usability remains unassessed. Evidence: triage-first-pass 11.

### 17. Free-form overlays, fixed instance children and detachment costs

**Current disposition:** Already settled; no new user decision. Remaining work is verification/documentation within the approved scope. Child-sizing guard is implemented and live-tested. Overlay/pinning and original detachment workflow remain unresolved.

**First-pass evidence and sources:** Free-form overlays, fixed instance children and detachment costs. [mobile §4](AGENT-DX-NOTES-mobile.md#4-free-form-overlay-children-ignore-the-resize-entirely), [mobile §9](AGENT-DX-NOTES-mobile.md#9-instance-sublayers-one-mutation-fails-silently-the-neighbouring-one-throws), [mobile §10](AGENT-DX-NOTES-mobile.md#10-detaching-was-the-only-escape-hatch-and-i-used-it-six-times). **Partly reproduced**: free-form child stays 350 px wide after parent narrows; instance sublayer limits reproduced in scenario 06; detach workflow not replayed. Evidence: triage-first-pass 06, 11.

### 18. Hug-content overflow and limits of structural review

**Current disposition:** Already settled; no new user decision. Remaining work is verification/documentation within the approved scope. Overflow feedback is implemented and live-tested. Broader hug-content and visual-review claims remain open.

**First-pass evidence and sources:** Hug-content overflow and limits of structural review. [mobile §4](AGENT-DX-NOTES-mobile.md#4-free-form-overlay-children-ignore-the-resize-entirely), [mobile §11](AGENT-DX-NOTES-mobile.md#11-reading-a-layout-tells-you-almost-nothing-about-whether-it-looks-right), [notes §22](AGENT-DX-NOTES.md#22-the-review-gap-what-a-build-agent-cant-see-about-its-own-work). **Partly reproduced**: fixed-height overlap needs parent context in scenario 09; broader hug-overflow and visual-review claims remain untested. Evidence: triage-first-pass 09.

### 19. Screenshot context: transparency, tall-frame crops, scale and photo-dependent contrast

**Current disposition:** Agreed experimental direction: contextual capture with bounded proportional default margin and explicit margin. Temporary slices require user-observed testing before final implementation is settled.

**First-pass evidence and sources:** Screenshot context: transparency, tall-frame crops, scale and photo-dependent contrast. [notes §16](AGENT-DX-NOTES.md#16-get_screenshot-renders-isolated-nodes-on-transparency--and-it-caused-a-false-alarm), [notes §22](AGENT-DX-NOTES.md#22-the-review-gap-what-a-build-agent-cant-see-about-its-own-work), [mobile §11](AGENT-DX-NOTES-mobile.md#11-reading-a-layout-tells-you-almost-nothing-about-whether-it-looks-right). **Partly reproduced**: transparent child export excludes parent backdrop in scenario 12; tall crops/photo contrast not tested. Evidence: triage-first-pass 12.

### 21. Wrapped-row height alignment and narrowing-design guidance

**Current disposition:** Decision settled as part of the responsive group. Remaining work is a targeted wrapped-row equal-height check and only necessary documentation corrections; no repeat product approval requested.

**First-pass evidence and sources:** Wrapped-row height alignment and narrowing-design guidance. [mobile §12](AGENT-DX-NOTES-mobile.md#12-things-i-got-wrong-and-why), [mobile §7](AGENT-DX-NOTES-mobile.md#7-doc-gaps-specific-to-responsive-work). **Non-runtime / not run**: responsive guidance and unequal wrapped-row choices need design review.

### 23. Replacing existing nodes while retaining sizing, constraints and fills

**Current disposition:** Approved replacement inheriting placement, sizing and constraints, with caller-supplied content and safe failure handling.

**First-pass evidence and sources:** Replacing existing nodes while retaining sizing, constraints and fills. [notes §10](AGENT-DX-NOTES.md#10-missing-a-replace-verb). **Reproduced missing capability**: typeof flcm.replace is undefined; composition workflow remains available. Evidence: triage-first-pass 11.

### 27. Property-versus-override choice and nested property exposure

**Current disposition:** Approved Boolean nested-instance exposure and a brief component-documentation note. Text-property overuse stays a watch item.

**First-pass evidence and sources:** Property-versus-override choice and nested property exposure. [notes §18](AGENT-DX-NOTES.md#18-guidance-the-docs-dont-give-property-vs-override), [notes §26.5](AGENT-DX-NOTES.md#265-isexposedinstance-is-the-only-nested-property-affordance-and-its-undocumented). **Verified capability / non-runtime guidance**: corrected bound-property fixture exposes a nested instance; outside-component exposure rejects. Evidence: triage-first-pass 14.

### 34. Reference size, repeated pairing banner and duplicated cheat-sheet

**Current disposition:** Approved approval-aware reference guidance. Approved sessions should receive the requested reference without repeated pairing instructions.

**First-pass evidence and sources:** Reference size, repeated pairing banner and duplicated cheat-sheet. [notes §2](AGENT-DX-NOTES.md#2-the-pairing-code-preamble-is-on-every-reference-call), [notes §17](AGENT-DX-NOTES.md#17-get_flcm_reference-section-granularity). **Non-runtime / not run**: reference size, repeated pairing banners and granularity need MCP response/usability review.

### 35. Layout documentation: merge semantics, missing coverage and responsive heading

**Current disposition:** Decision settled as part of the responsive group. Merge semantics already work; remaining work is checking and correcting inaccurate layout documentation within the approved scope.

**First-pass evidence and sources:** Layout documentation: merge semantics, missing coverage and responsive heading. [mobile §6](AGENT-DX-NOTES-mobile.md#6-what-worked-well), [mobile §7](AGENT-DX-NOTES-mobile.md#7-doc-gaps-specific-to-responsive-work). **Non-runtime guidance; behavior verified**: gap-only edit preserves mode/padding; responsive docs need editorial review. Evidence: triage-first-pass 11.

### 36. Unpositioned renders repeatedly overlap existing page content

**Current disposition:** Resolved design direction: use measurement and ordinary positioning. Delivery depends on the measurement work in item 8; no separate placement helper.

**First-pass evidence and sources:** Unpositioned renders repeatedly overlap existing page content. [slots working section](AGENT-DX-NOTES-slots.md#whats-working-specifically). **Reproduced with warning**: default-origin renders overlap staging board and log explicit placement warnings. Evidence: triage-first-pass placement warnings.

## Recommendation needs review — 5

### 14. Multi-operation scripts: earlier writes survive later errors or timeouts

**Current disposition:** The unsafe-retry and outcome-reporting changes are approved and implemented. A recommendation to accept the broader whole-script partial-write boundary has not been explicitly accepted; review only that residual recommendation.

**First-pass evidence and sources:** Multi-operation scripts: earlier writes survive later errors or timeouts. [slots §3](AGENT-DX-NOTES-slots.md#3-a-failed-call-can-leave-the-document-half-mutated--p1), [notes §1](AGENT-DX-NOTES.md#1-the-font-loading-cliff-the-thing-that-actually-broke), [notes §4](AGENT-DX-NOTES.md#4-return-shape-inconsistency-across-the-creating-verbs), [notes §10](AGENT-DX-NOTES.md#10-missing-a-replace-verb), [notes §26.2a](AGENT-DX-NOTES.md#262a-footgun-moving-a-node-out-of-a-slot-destroys-it). **Reproduced script boundary**: an earlier successful edit survives a later rejected edit; cancelled sizing attempts retain partial work but establish no complete outcome. Evidence: triage-first-pass 08; partial sizing attempts.

### 20. Instance content visibility: wrong tile selection, cloned labels and stale names

**Current disposition:** Recommendation pending: treat incorrect tile selection and stale labels as content-review workflow issues using existing reads. No new closure or documentation scope has been approved for this entry.

**First-pass evidence and sources:** Instance content visibility: wrong tile selection, cloned labels and stale names. [mobile §12](AGENT-DX-NOTES-mobile.md#12-things-i-got-wrong-and-why), [notes §22](AGENT-DX-NOTES.md#22-the-review-gap-what-a-build-agent-cant-see-about-its-own-work). **Non-runtime / not run**: wrong tile selection, stale names and original-design content require contextual review.

### 22. Existing-node promotion: staging, defaults, binding and library placement

**Current disposition:** Defaults, promotion aliases, measurement and clone/replacement conveniences already have decisions. Recommendation pending only on closing the remaining promotion-workflow/discoverability complaint without another feature.

**First-pass evidence and sources:** Existing-node promotion: staging, defaults, binding and library placement. [notes §6](AGENT-DX-NOTES.md#6-the-two-step-property-dance-on-the-promote-path-is-undocumented), [notes §8](AGENT-DX-NOTES.md#8-the-staging-frame-workflow-is-load-bearing-and-undiscoverable), [notes §9](AGENT-DX-NOTES.md#9-footgun-clone-keeps-fill-sizing-into-a-free-form-parent-and-silently-stretches). **Partly reproduced**: promotion/binding and staging behaviors tested in scenarios 07 and 09; discoverability is non-runtime. Evidence: triage-first-pass 07, 09.

### 30. Find: component/text lookup, predicate spec fields and regex-name errors

**Current disposition:** Actual RegExp support is approved, implemented, and passed initial live checks. Recommendation pending only on retaining canonical predicates instead of adding dedicated text/component facets.

**First-pass evidence and sources:** Find: component/text lookup, predicate spec fields and regex-name errors. [notes §15](AGENT-DX-NOTES.md#15-flcmfind-cant-filter-by-component), [notes §24](AGENT-DX-NOTES.md#24-flcmfind-cant-search-text-and-the-predicate-hides-the-fact-that-it-can). **Partly reproduced**: text/component query keys reject, regex crashes; characters predicate throws here, not silent zero. Evidence: triage-first-pass 11.

### 33. Raw escape responsibilities: font loading, bulk sublayer edits and mixed-value serialization

**Current disposition:** Recommendation pending: keep font loading and mixed-value handling as raw API responsibilities, correcting contradictory guidance only if found. This is not an accepted closure yet.

**First-pass evidence and sources:** Raw escape responsibilities: font loading, bulk sublayer edits and mixed-value serialization. [notes §1](AGENT-DX-NOTES.md#1-the-font-loading-cliff-the-thing-that-actually-broke), [notes §19](AGENT-DX-NOTES.md#19-smaller-things). **Partly reproduced**: mixed-value coercion throws and naive JSON omits it; slow serial-font workload not replayed. Evidence: triage-first-pass 12.

## Investigation before a solution can be proposed — 4

### 1. Raw slot moves: node validity across slots and out to frames

**Current disposition:** Active slot investigation. No movement/recovery fix approved.

**First-pass evidence and sources:** Raw slot moves: node validity across slots and out to frames. [slots §1](AGENT-DX-NOTES-slots.md#1-moving-a-node-between-two-slots-corrupts-it-silently--p0), [notes §26.2a](AGENT-DX-NOTES.md#262a-footgun-moving-a-node-out-of-a-slot-destroys-it). **Reproduced, context-dependent**: raw inherited moves break root reads; direct slot-to-slot moves break sublayers through raw/flcm. Inherited flcm moves reject and preserve readable source content. Evidence: slot-validity 02, 05.

### 2. Slot instance sublayers: unreadable handles and unresolved IDs

**Current disposition:** Active slot investigation; ordinary frames versus instance descendants and prior-read effects are being isolated. No workaround approved.

**First-pass evidence and sources:** Slot instance sublayers: unreadable handles and unresolved IDs. [notes §26.2](AGENT-DX-NOTES.md#262-instances-inside-a-slot-have-unreadable-sublayers). **Reproduced, narrowed**: reading descendants before ordinary-frame-to-slot import triggers unreadability through raw and flcm; cold imports stay readable, clones restore readability. Evidence: slot-validity 06; /tmp/figma-slot-archaeology/review.md.

### 3. Audit scripts: skipped slot nodes reported as clean

**Current disposition:** Audit completeness remains tied to unreadable descendants; final handling/guidance not settled.

**First-pass evidence and sources:** Audit scripts: skipped slot nodes reported as clean. [notes §26.2b](AGENT-DX-NOTES.md#262b-the-read-bug-silently-corrupts-audits). **Reproduced after raw inherited moves**: skipped unreadable trees falsely yield zero known FIT paints. Evidence: slot-validity 04, 05.

### 13. Single-verb candidate: SLOT-target append timeout and network error attribution

**Current disposition:** Investigation remains: historical timeout cause is unproven; later sizing cases passed after reload. A controlled tab-activity comparison was discussed. Existing reliability fixes remain approved; no new solution is ready.

**First-pass evidence and sources:** Single-verb candidate: SLOT-target append timeout and network error attribution. [slots §2](AGENT-DX-NOTES-slots.md#2-flcmappend-into-a-slot-target-times-out--p1). **Not reproduced in reconstructed cases**: original-font controls across five histories completed append and native lookup; original 10-second failure remains unresolved. Incomplete runs recorded separately. Evidence: slot-validity 08; /tmp/figma-slot-archaeology/review.md.

## Explicitly deferred design — 2

### 25. Extending existing variant sets and retaining overrides

**Current disposition:** Deferred feature design: extending existing variant sets. See the open-questions document.

**First-pass evidence and sources:** Extending existing variant sets and retaining overrides. [notes §13](AGENT-DX-NOTES.md#13-flcmvariants-cant-add-to-an-existing-set--and-this-is-about-to-bite). **Reproduced unsupported form**: variants refuses already-member input and leaves the set intact; override migration was not replayed. Evidence: triage-first-pass 10. [Open design questions](AGENT-DX-OPEN-QUESTIONS.md#extending-existing-variant-sets).

### 31. Read payload size and script result collisions from duplicate names

**Current disposition:** Oversized-read archaeology completed. Output warning/confirmation gate dropped; compact hierarchy inspection deferred for design. Duplicate-name script-result handling remains part of this broader entry.

**First-pass evidence and sources:** Read payload size and script result collisions from duplicate names. [notes §26.7](AGENT-DX-NOTES.md#267-reading-a-section-subtree-at-depth-3-blows-the-token-limit), [slots §8](AGENT-DX-NOTES-slots.md#8-two-nodes-sharing-a-name-silently-collapse-a-result-object--p3). **Not run**: original large-subtree payload and duplicate-name audit scale not reconstructed. [Open summary-tool design](AGENT-DX-OPEN-QUESTIONS.md#compact-hierarchy-inspection-triage31).
