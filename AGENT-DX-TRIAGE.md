# Agent DX investigation triage

Reports establish friction; causes and fixes need validation against the dialect's intended behavior.

## Tier 1: high-consequence reproduction candidates

### Slot validity and audit completeness

1. Raw slot moves: node validity across slots and out to frames. [slots §1](AGENT-DX-NOTES-slots.md#1-moving-a-node-between-two-slots-corrupts-it-silently--p0), [notes §26.2a](AGENT-DX-NOTES.md#262a-footgun-moving-a-node-out-of-a-slot-destroys-it).
2. Slot instance sublayers: unreadable handles and unresolved IDs. [notes §26.2](AGENT-DX-NOTES.md#262-instances-inside-a-slot-have-unreadable-sublayers).
3. Audit scripts: skipped slot nodes reported as clean. [notes §26.2b](AGENT-DX-NOTES.md#262b-the-read-bug-silently-corrupts-audits).
4. Clone-based audits: wrapped geometry differs from live nodes. [slots §4](AGENT-DX-NOTES-slots.md#4-clone-is-the-sanctioned-read-escape-hatch-but-its-geometry-lies--p1).

### Silent edits, sizing and content

5. Instance-root layout direction: ignored writes alongside applied spacing. [notes §21](AGENT-DX-NOTES.md#21-footgun-layoutmode-on-an-instance-root-is-a-silent-no-op--through-raw-api-and-flcm), [slots §5](AGENT-DX-NOTES-slots.md#5-instance-root-layoutmode-reverts-silently--p2).
6. Instance sublayer sizing: ignored edits alongside applied styles. [mobile §9](AGENT-DX-NOTES-mobile.md#9-instance-sublayers-one-mutation-fails-silently-the-neighbouring-one-throws).
7. Raw resize clamping: hidden per-instance minimum width. [notes §26.1](AGENT-DX-NOTES.md#261-footgun-an-invisible-per-instance-minwidth-silently-clamps-resize).
8. Clone sizing: retained fill in free-form staging; explicit dimensions become fixed. [notes §9](AGENT-DX-NOTES.md#9-footgun-clone-keeps-fill-sizing-into-a-free-form-parent-and-silently-stretches), [notes §19](AGENT-DX-NOTES.md#19-smaller-things).
9. Variant cloning: missing text and visibility bindings. [slots §6](AGENT-DX-NOTES-slots.md#6-clone-drops-componentpropertyreferences--p2).
10. Property binding and deletion: default text overwrites source content. [notes §7](AGENT-DX-NOTES.md#7-footgun-an-invented-defaultvalue-permanently-overwrites-real-content).
11. Text properties: mixed-run styling loss. [notes §19](AGENT-DX-NOTES.md#19-smaller-things).
12. Container resize and axis changes: collapsed fill, stale sizing and fixed-height overlap. [mobile §2](AGENT-DX-NOTES-mobile.md#2-silent-sizing-collapse-when-a-cloned-frame-is-narrowed), [mobile §12](AGENT-DX-NOTES-mobile.md#12-things-i-got-wrong-and-why), [notes §23](AGENT-DX-NOTES.md#23-footgun-a-fixed-height-on-an-auto-layout-frame-overflows-in-total-silence).

### Operation failures and script boundaries

13. Single-verb candidate: SLOT-target append timeout and network error attribution. [slots §2](AGENT-DX-NOTES-slots.md#2-flcmappend-into-a-slot-target-times-out--p1).
14. Multi-operation scripts: earlier writes survive later errors or timeouts. [slots §3](AGENT-DX-NOTES-slots.md#3-a-failed-call-can-leave-the-document-half-mutated--p1), [notes §1](AGENT-DX-NOTES.md#1-the-font-loading-cliff-the-thing-that-actually-broke), [notes §4](AGENT-DX-NOTES.md#4-return-shape-inconsistency-across-the-creating-verbs), [notes §10](AGENT-DX-NOTES.md#10-missing-a-replace-verb), [notes §26.2a](AGENT-DX-NOTES.md#262a-footgun-moving-a-node-out-of-a-slot-destroys-it).

## Tier 2: responsive and existing-design workflows

### Responsive layout and visual review

15. Wrap, cross-axis gaps and min/max sizing coverage. [notes §12](AGENT-DX-NOTES.md#12-missing-minwidth--maxwidth--layoutwrap), [notes §26.3](AGENT-DX-NOTES.md#263-12-confirmed-and-its-worse-than-missing-props), [mobile §1](AGENT-DX-NOTES-mobile.md#1-layoutwrap-counteraxisspacing-and-minwidth-are-the-entire-mobile-toolkit-and-none-of-them-are-in-flcm).
16. Fixed-width text reflow and query-to-bulk-edit friction. [mobile §3](AGENT-DX-NOTES-mobile.md#3-fixed-width-text-does-not-reflow-and-theres-no-bulk-way-to-fix-it).
17. Free-form overlays, fixed instance children and detachment costs. [mobile §4](AGENT-DX-NOTES-mobile.md#4-free-form-overlay-children-ignore-the-resize-entirely), [mobile §9](AGENT-DX-NOTES-mobile.md#9-instance-sublayers-one-mutation-fails-silently-the-neighbouring-one-throws), [mobile §10](AGENT-DX-NOTES-mobile.md#10-detaching-was-the-only-escape-hatch-and-i-used-it-six-times).
18. Hug-content overflow and limits of structural review. [mobile §4](AGENT-DX-NOTES-mobile.md#4-free-form-overlay-children-ignore-the-resize-entirely), [mobile §11](AGENT-DX-NOTES-mobile.md#11-reading-a-layout-tells-you-almost-nothing-about-whether-it-looks-right), [notes §22](AGENT-DX-NOTES.md#22-the-review-gap-what-a-build-agent-cant-see-about-its-own-work).
19. Screenshot context: transparency, tall-frame crops, scale and photo-dependent contrast. [notes §16](AGENT-DX-NOTES.md#16-get_screenshot-renders-isolated-nodes-on-transparency--and-it-caused-a-false-alarm), [notes §22](AGENT-DX-NOTES.md#22-the-review-gap-what-a-build-agent-cant-see-about-its-own-work), [mobile §11](AGENT-DX-NOTES-mobile.md#11-reading-a-layout-tells-you-almost-nothing-about-whether-it-looks-right).
20. Instance content visibility: wrong tile selection, cloned labels and stale names. [mobile §12](AGENT-DX-NOTES-mobile.md#12-things-i-got-wrong-and-why), [notes §22](AGENT-DX-NOTES.md#22-the-review-gap-what-a-build-agent-cant-see-about-its-own-work).
21. Wrapped-row height alignment and narrowing-design guidance. [mobile §12](AGENT-DX-NOTES-mobile.md#12-things-i-got-wrong-and-why), [mobile §7](AGENT-DX-NOTES-mobile.md#7-doc-gaps-specific-to-responsive-work).

### Componentization and reuse

22. Existing-node promotion: staging, defaults, binding and library placement. [notes §6](AGENT-DX-NOTES.md#6-the-two-step-property-dance-on-the-promote-path-is-undocumented), [notes §8](AGENT-DX-NOTES.md#8-the-staging-frame-workflow-is-load-bearing-and-undiscoverable), [notes §9](AGENT-DX-NOTES.md#9-footgun-clone-keeps-fill-sizing-into-a-free-form-parent-and-silently-stretches).
23. Replacing existing nodes while retaining sizing, constraints and fills. [notes §10](AGENT-DX-NOTES.md#10-missing-a-replace-verb).
24. Existing image-fill reuse through imageRef. [notes §11](AGENT-DX-NOTES.md#11-missing-image-fills-by-imageref).
25. Extending existing variant sets and retaining overrides. [notes §13](AGENT-DX-NOTES.md#13-flcmvariants-cant-add-to-an-existing-set--and-this-is-about-to-bite).
26. Instance layout validation against inherited component layout. [notes §26.4](AGENT-DX-NOTES.md#264-flcminstance-layout-props-are-validated-against-the-spec-not-the-component).
27. Property-versus-override choice and nested property exposure. [notes §18](AGENT-DX-NOTES.md#18-guidance-the-docs-dont-give-property-vs-override), [notes §26.5](AGENT-DX-NOTES.md#265-isexposedinstance-is-the-only-nested-property-affordance-and-its-undocumented).

## Tier 3: discovery, documentation and recovery

### Read, query and handle contracts

28. Component child lookup and render handles versus keyed results. [notes §3](AGENT-DX-NOTES.md#3-flcmget-on-a-component-doesnt-return-what-a-frame-returns), [slots §7](AGENT-DX-NOTES-slots.md#7-renders-returned-node-doesnt-carry-children--p3).
29. Creation return shapes and promotion root-ID replacement. [notes §4](AGENT-DX-NOTES.md#4-return-shape-inconsistency-across-the-creating-verbs), [notes §5](AGENT-DX-NOTES.md#5-flcmcomponent-returns-a-node-with-a-new-id).
30. Find: component/text lookup, predicate spec fields and regex-name errors. [notes §15](AGENT-DX-NOTES.md#15-flcmfind-cant-filter-by-component), [notes §24](AGENT-DX-NOTES.md#24-flcmfind-cant-search-text-and-the-predicate-hides-the-fact-that-it-can).
31. Read payload size and script result collisions from duplicate names. [notes §26.7](AGENT-DX-NOTES.md#267-reading-a-section-subtree-at-depth-3-blows-the-token-limit), [slots §8](AGENT-DX-NOTES-slots.md#8-two-nodes-sharing-a-name-silently-collapse-a-result-object--p3).

### Vocabulary and workflow documentation

32. Raw/flcm vocabulary: binding names, property suffixes, clip, textStyle nesting and baseline alignment. [notes §14](AGENT-DX-NOTES.md#14-read-words-are-not-always-write-words), [notes §19](AGENT-DX-NOTES.md#19-smaller-things), [notes §25](AGENT-DX-NOTES.md#25-an-alias-table-for-figma-api-words-design-sketch), [slots working section](AGENT-DX-NOTES-slots.md#whats-working-specifically).
33. Raw escape responsibilities: font loading, bulk sublayer edits and mixed-value serialization. [notes §1](AGENT-DX-NOTES.md#1-the-font-loading-cliff-the-thing-that-actually-broke), [notes §19](AGENT-DX-NOTES.md#19-smaller-things).
34. Reference size, repeated pairing banner and duplicated cheat-sheet. [notes §2](AGENT-DX-NOTES.md#2-the-pairing-code-preamble-is-on-every-reference-call), [notes §17](AGENT-DX-NOTES.md#17-get_flcm_reference-section-granularity).
35. Layout documentation: merge semantics, missing coverage and responsive heading. [mobile §6](AGENT-DX-NOTES-mobile.md#6-what-worked-well), [mobile §7](AGENT-DX-NOTES-mobile.md#7-doc-gaps-specific-to-responsive-work).
36. Unpositioned renders repeatedly overlap existing page content. [slots working section](AGENT-DX-NOTES-slots.md#whats-working-specifically).

### Connection and approval recovery

37. Disconnect guidance: short reconnects versus prolonged outage retries. [mobile §5](AGENT-DX-NOTES-mobile.md#5-connection-and-approval-failure-modes--what-i-actually-saw), [notes §26.6](AGENT-DX-NOTES.md#266-the-disconnect-message-instructs-you-to-retry-forever).
38. Approval drops: retry cost, rotating codes and unattended-run interruption. [mobile §5](AGENT-DX-NOTES-mobile.md#5-connection-and-approval-failure-modes--what-i-actually-saw).
