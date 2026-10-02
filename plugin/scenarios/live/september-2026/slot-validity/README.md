# Slot validity scenarios

## Original-call follow-up, 2026-09-13

Scenarios06–08 reconstruct the original tool calls and hierarchy. They supersede the initial negative results for items2 and4: pre-read FRAME→SLOT imports reproduce unreadable descendants, and HUG-slot/FILL-child clones reproduce353→1170px geometry. Cold imports and FIXED sizing distinguish the triggers. The original-font append cases still succeed. See [provenance, findings and replay details](ARCHAEOLOGY.md). Initial results below remain intact as controls and historical evidence.

## Live findings, 2026-09-13

In the initial pass, all five scenarios ran once through the production CLI with verified fixtures. The earlier run of 01 is retained separately; 02 through 05 were executed for this pass. All returned screenshot targets were exported in subsequent read-only calls and inspected. Console output includes a temporary component-placement overlap warning. No product fixes or cleanup were performed.

| Triage item | Status | Observed evidence and limit |
| --- | --- | --- |
| 1. Raw slot moves | Reproduced | In 05, inherited slot content moved raw to another slot or a frame returns normally, then the instance root's name/geometry/children throw and its original ID returns null. It still renders at the destination. In 02, direct-fill slot-to-slot moves damage only the two sublayers; direct-fill slot-to-frame moves remain readable. Both raw and flcm direct slot-to-slot operations return success. The failures persist across a separate CLI read. In the inherited cases, flcm moves error and the original content remains readable in Source afterward. |
| 2. Unreadable sublayers before moves | Not reproduced in fixtures | 01 has 3/3 readable nodes in resident and control. 04 has all 39 direct-host and 40 inherited-host nodes readable, with 12 FIT paints in each; the control has 3/3 nodes and one FIT paint. Sublayer read failure is reproduced after moves in 02, so presence in a slot alone is not the trigger established here. |
| 3. Skipped-node false clean audits | Reproduced after raw moves | In both raw inherited moves in 05, the known FIT count changes from one to zero because root reads and child enumeration fail. The deliberately lossy conclusion would claim zero FIT; the coverage-aware result is incomplete. Pixels retain the cyan/yellow image. Before moves, 04 finds all 25 expected FIT paints across its three fixtures without skips. |
| 4. Clone geometry differs from live | Not reproduced in fixture | In 03, a verified two-row grid narrowed from 1170px to 353px matches both the raw grid clone and flcm enclosing-host clone, with no measurement outside 0.5px tolerance. All nodes read in both samples, and the three screenshots match. This fixed-size local fixture does not reconstruct the original document's full responsive layout history. |

The move operations and error messages establish the failure at the live node-access boundary. Retained sublayer IDs in 02 still name the former context after a successful move, but the internal ID-path mechanism remains a hypothesis. The raw reproduction does not require flcm.move; flcm's direct move also reports success without detecting unreadable descendants. These observations do not decide a product fix. A clean fixture does not disprove an original report.

Run only in a dedicated scratch Figma file, with the production plugin connected. Each script creates and selects a new page named `FLCM scenario / <scenario> / <page ID>`. All fixtures belong to that page. Reruns create separate pages and retain earlier evidence. No existing selection or design IDs are required. The scripts create local components, so library versions and external image services are not fixture dependencies. Text creation uses flcm's font loading. The FIT probes embed a tiny generated cyan/yellow PNG; no remote image service is needed.

Submit one entire numbered `.js` file as the execution body. The environment supplies `flcm` and `figma`; top-level `await` and `return` are intentional. There are no imports or Node APIs in those files. The product CLI accepts `execute <file.js>`; consult its help for result and screenshot options. These scenarios depend on no CLI flags. The returned `screenshotTargets` are instructions for the caller, not an automatic screenshot request.

| File | Checks | Screenshots to collect after execution |
| --- | --- | --- |
| [01-readability-audit.js](01-readability-audit.js) | Before any move, compare an instance in a slot with the same component in a plain frame. Independently read each field, resolve each visited ID, count expected nodes and find the known text sentinel. Capture flcm reads alongside raw inspection. | `resident`, `control`. Both should show one magenta swatch and `SLOT SENTINEL`; the resident's Destination slot is empty. |
| [02-slot-moves.js](02-slot-moves.js) | Four fresh instances test raw `appendChild` and `flcm.move`, each from Source to Destination slot or to a plain frame. Save baseline, operation return/error, retained-handle reads, original-ID lookup, and freshly resolved source/destination trees even after a refusal. | Each case returns `*-host` and `*-frame`. Compare tile location with the reported operation. Successful slot moves leave one tile in Destination; successful frame moves leave one tile in the green frame. A refusal should preserve the original tile in Source. Check visible content even when handles cannot be read. |
| [03-clone-geometry.js](03-clone-geometry.js) | Narrow a grid from 1170px to 353px and verify it actually wraps four 144px tiles into two rows. Compare a raw clone of the donated grid moved to the page, and an flcm clone of its enclosing host. Retain both copies. Record first and second read samples and per-path geometry deltas with unavailable values explicit. | `live-host`, `raw-grid-clone`, `host-clone`, when created. Compare row count, tile sizes, text, spacing and slot bounds. Include the whole host to expose overflow or clipping. |
| [04-image-audit.js](04-image-audit.js) | Compare 12 known FIT paints across two direct slots, 12 across slots inherited through an enclosing component, and one plain-frame control. Track every field/lookup and every skipped paint or enumeration read. | `direct-host`, `nested-host`, `plain-control`; each tile has a cyan/yellow letterboxed image and FIT label. |
| [05-nested-slot-moves.js](05-nested-slot-moves.js) | Repeat the four moves on inherited slot content with a known FIT image, recording baseline and post-move readability and both lossy and coverage-aware audit conclusions. | Eight host/frame targets, as in 02; cyan/yellow images remain visible after raw failures, while flcm errors leave the images in Source. |

The move script records baseline numbers before mutation; it does not capture a pre-move PNG. Its final screenshot targets point to the retained post-operation fixtures. The untouched baseline scenario provides a separate visual control. Do not label a final PNG as “before”.

## Interpretation and review checklist

- Verify `setup.verified` before interpreting the experiment. `setup_failed` means the intended fixture was not established. A partial page may remain; inspect it using `cleanup.pageId`. Scenario 03 deliberately requires readable tile-root geometry and an already wrapped baseline. Failure at that gate says nothing about clone fidelity.
- `observations_recorded` means the code reached its observation stage. It is not a pass. `scenario_incomplete` retains evidence collected before an unexpected error. Read every `outcome: "error"`, `found: false`, and incomplete coverage result. A thrown move is recorded and followed by inspection; it cannot disappear in a catch-and-skip success.
- Every tile should contain three nodes including its root, its declared rectangle or image, and its text sentinel. An audit with unreadable fields, unresolved IDs, missing entries, or a wrong node count is incomplete. Zero text matches under incomplete coverage cannot establish absence. Scenario 01 uses text sentinels; 04 and 05 add actual FIT paints. They do not replay the original whole-artboard conversion loop.
- In the move scenario, `expectedNodes` for post-move parents describes a successful move: one source node and four destination-tree nodes. After a refusal those counts should differ. Review actual membership and readability against the saved baseline to judge whether the refusal preserved the document. Compare freshly enumerated destination handles as well as the original ID; a changed ID alone establishes no diagnosis.
- In the clone scenario, path matching is valid only while the fixture retains its declared structure and order. Compare structure and text before using geometry deltas. Root page offsets are excluded; descendant coordinates are local. The 0.5px tolerance is a review threshold, not a product guarantee. Different parent context can change layout. The second lookup is another sample, not proof that layout has settled. Unreadable live measurements stay unavailable; clone measurements cannot substitute for them.
- Save the full execution envelope, including console/errors, the returned report, and all available PNGs together. Inspect the pixels against each target's `expectedVisualCheck`. A transport timeout or missing report is an incomplete run; inspect the retained page before retrying. Do not infer that the script made no changes.
- Assess outcomes against the current flcm workflow promise. The raw cases characterize an escape path; raw/flcm parity is not the correctness criterion. A mismatch may require better docs, feedback, fixture/caller correction, wrapper changes, or investigation of Figma. These scripts assign no root cause.

## Source observations and current contract

The source notes are reports to reproduce, including their proposed causes and fixes. Their headings preserve the original wording and severity; neither is a validated diagnosis.

- [Triage: slot validity and audit completeness](../../../../AGENT-DX-TRIAGE.md#slot-validity-and-audit-completeness) defines this batch's scope.
- [Notes §26.2: slot instance sublayers](../../../../AGENT-DX-NOTES.md#262-instances-inside-a-slot-have-unreadable-sublayers) and [§26.2b: audit undercounting](../../../../AGENT-DX-NOTES.md#262b-the-read-bug-silently-corrupts-audits) motivate scenario 01 and all coverage accounting.
- [Slots §1: moves between slots](../../../../AGENT-DX-NOTES-slots.md#1-moving-a-node-between-two-slots-corrupts-it-silently--p0) and [notes §26.2a: moves out to a frame](../../../../AGENT-DX-NOTES.md#262a-footgun-moving-a-node-out-of-a-slot-destroys-it) motivate scenario 02. The ID-path explanation remains a hypothesis.
- [Slots §4: clone geometry](../../../../AGENT-DX-NOTES-slots.md#4-clone-is-the-sanctioned-read-escape-hatch-but-its-geometry-lies--p1) motivates scenario 03. This small local fixture may not reproduce the original document's layout history.
- [Mobile §1: wrapping setup](../../../../AGENT-DX-NOTES-mobile.md#1-layoutwrap-counteraxisspacing-and-minwidth-are-the-entire-mobile-toolkit-and-none-of-them-are-in-flcm) provides raw layout context; [mobile §11: visual review](../../../../AGENT-DX-NOTES-mobile.md#11-reading-a-layout-tells-you-almost-nothing-about-whether-it-looks-right) motivates checking screenshots alongside numeric observations.
- [Current tree-shape contract](../../../docs/authoring/flcm.md#tree-shape--placing-moving-removing), [slot authoring](../../../docs/authoring/flcm.md#filling-a-slot), and [existing slot syntax tests](../../../src/preamble/slot.test.ts) ground the dialect calls and fixture construction. Unit/mock tests establish syntax examples here, not live validity.

## Scoped cleanup

Nothing is removed automatically. After reviewing and saving evidence, manually remove only the exact page identified by that run's `cleanup.pageId`, after checking its name equals `cleanup.pageName`. Switch to `cleanup.previousPageId` or another retained page first. Removing the run page removes its local component definitions, fixtures and copies. Do not delete pages by a prefix search, reuse damaged fixtures, move unreadable children to salvage them, or remove shared components. If exact-page deletion fails, retain it and record the error for inspection. Each rerun owns a new page.

## Static check

From the repository root:

```sh
node plugin/scenarios/live/slot-validity/check-syntax.mjs
```

This constructs async functions to parse all five scenario bodies without invoking them. It cannot validate Figma capabilities, font availability, bridge behavior, node liveness, or pixels. This check does not change the per-scenario live status recorded above.
