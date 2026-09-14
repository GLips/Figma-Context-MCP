# Remaining DX recommendations

[Latest slot-access resolution](AGENT-DX-SLOT-ACCESS-RESOLUTION.md): item 2 is now fixed and verified; the current triage counts supersede this earlier recommendation snapshot.

## What actually needs review

Reconciled against the conversation, 2026-09-13. The earlier seventeen were unfinished triage entries, not seventeen untouched decisions. That classification is superseded. [Triage](AGENT-DX-TRIAGE.md) now distinguishes settled decisions, delivery, investigation, and deferral.

**Five entries remain for recommendation review, grouped into three topics:**

| Review topic                                                    | Entries    | My recommendation                                                                                                                                                                       |
| --------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whole-script partial writes                                     | 14         | Accept earlier successful operations remaining after a later failure; keep the already approved single-submission and accurate outcome reporting. Do not add whole-script transactions. |
| Content selection, promotion workflow, raw API responsibilities | 20, 22, 33 | Use existing capabilities plus approved helpers; close residual feature complaints after checking for contradictory guidance.                                                           |
| Additional search filters                                       | 30         | Finish approved regex support; retain canonical predicates and defer dedicated text/component filters.                                                                                  |

These recommendations are **not yet accepted**. There is no additional decision requested for the responsive group.

**Investigation, not a decision ready tonight:** entries 1–3 (one shared slot-access investigation) and 13 (historical timeout). The access investigator has a candidate architecture with unresolved identity, scope, and ordering requirements. The historical stall is not explained by later passing tests.

**Already deferred:** entries 25 (variant-set extension design) and 31 (compact hierarchy inspection). Item 4 is closed as accepted clone behavior.

**Already settled:** 27 of the 38 original entries. Of these, 9 are resolved/accepted, 4 are in a batch completing verification, and 14 have delivery or follow-up remaining. Being near the end of decision review does not mean implementation and verification are finished.

The sections below retain their topic numbers so existing references remain understandable. Only sections 3 (item 14), 4, and 5 (item 30) contain pending recommendations. Sections 1 and 6 are investigation/deferral; section 2 is already approved work.

## 1. Slot access — investigate

**Recommendation:** let the current investigator finish an identity-preserving route before proposing product changes. The new evidence is promising: native criteria search returns readable descendant objects in fixtures where ordinary traversal and ID lookup return stale objects. Direct edits through those objects succeeded in one fixture. Independent readback and broader controls remain necessary; this is not yet a verified implementation solution.

A candidate implementation would obtain live objects through the working native route and reconstruct only the traversal information the dialect actually needs. It must demonstrate correct reads, queries, edits, geometry, overrides, and root/child identity across calls. Do not equate fresh IDs with fresh objects: the investigator found that ID lookup can return stale objects even for canonical IDs.

Item 3 follows this work: an audit encountering unreadable descendants must not claim complete coverage. Item 4 is closed as accepted clone behavior. A temporary audit copy can resize and therefore cannot establish the original’s geometry. The source-access problem belongs to items 1–3; no separate clone change is requested for item 4.

**Completion evidence:** warm/cold controls for ordinary frames, nested instances and direct instances; independent read/edit checks; query coverage; slot moves; retained content and identity. If the route fails, report its precise boundary before selecting another strategy.

**Decision now:** none. Bring back a tested recommendation, not another list of speculative workarounds.

## 2. Responsive behavior and documentation — accept behavior, verify residuals

**Recommendation:** accept fixed children staying fixed and fill children exhausting their available space. The approved bounds, overflow feedback, wrap/gap authoring, text defaults, and measurement cover the useful product work. Keep those decisions.

Finish two targeted checks together: row-to-column transitions with fixed/fill children, and equal-height children in a wrapped row. The original histories were not fully replayed, so do not declare a code bug fixed without this evidence. If a check exposes an actual mismatch with the authored sizing intent, report that precise defect for repair. Otherwise close the residual behavior claims.

For overlays, use existing authored constraints. The evidence does not justify automatic detachment or changing a main component. Structural inspection cannot establish visual design quality; screenshots remain part of verification.

For documentation, correct inaccurate capability statements after the approved writes land and replace the misleading “Responsive by default” heading if it remains. Reuse the brief sizing guidance already agreed. No new bulk-text example or broad responsive tutorial.

**Decision:** already settled. Complete the approved work and its verification; do not request another approval. Any newly demonstrated defect should be reported as new evidence, not treated as an unresolved product choice by default.

## 3. Historical timeout and script boundaries — distinguish the two

**Recommendation:** retain item 13 as an unexplained historical incident until one controlled active-file versus inactive-file comparison is possible. The later ten sizing cases passed after reload. That establishes a successful run, not the historical cause. Avoid repeated full probe runs seeking the old stall.

For item 14, accept that earlier successful operations remain after a later operation fails. Keep the approved single-submission and truthful outcome reporting. Do not add a transaction system for arbitrary scripts. The new replacement operation should have its own specified failure behavior, as already agreed.

Check that execution guidance does not promise whole-script rollback. If it is already accurate, no documentation addition is needed.

**Decision requested (item 14 only):** accept the broader script partial-write boundary. This residual recommendation has not yet been accepted. Keep all previously approved execution-reliability decisions. The historical timeout stays tracked separately, without blocking unrelated verified changes.

## 4. Content selection, promotion and raw API responsibilities — accept existing capabilities

**Recommendation:** close the feature requests in this group without another runtime abstraction, after a focused check for contradictory guidance.

- Item 20: instance property values are already readable. Wrong tile selection and copied labels are agent workflow errors; identify content by node ID and inspect the selected content. Slot audit incompleteness remains covered by group 1.
- Item 22: promotion defaults are accepted behavior. The approved aliases, measurement, clone overrides and replacement helper address the concrete conveniences. Keep library placement explicit. Do not add a staging wizard or automatic content migration.
- Item 33: raw font loading and mixed-value handling remain responsibilities of raw API scripts. Canonical text reads already decode styled segments. Investigate a remaining dialect failure if demonstrated; the existing evidence does not justify new font-loading or serialization infrastructure.

**Decision requested (items 20, 22, 33):** accept these proposed dispositions. They have not yet been accepted. Correct an actual misleading instruction if found, without adding general-purpose recipes.

## 5. Search and compact inspection — finish existing fix, defer expansion

**Recommendation:** finish the already implemented actual-RegExp support and use the existing predicate over canonical read data for text/component filtering. The review reports a canonical text predicate succeeded where a raw-field predicate failed. Check that the predicate contract is described accurately; correct a concrete gap if necessary.

Defer dedicated text/component search facets until evidence shows predicates cannot express the task conveniently. The oversized result came from the agent’s custom recursive script. Keep the compact hierarchy tool as an open design question, as agreed. Duplicate names in a caller-created map do not require unique layer names or changed read results; callers can use IDs or arrays.

**Decision requested:** accept no additional search API in this batch. Compact inspection remains explicitly deferred.

## 6. Extending variant sets — defer broader design

**Recommendation:** deliver the approved binding-preserving clone first. It covers the demonstrated sibling-variant workflow. Broader set extension still needs an axis/value contract and preservation rules; keep it in the open-questions document.

**Decision now:** none. Do not dispatch the broader feature as a small error-message correction.

## Execution plan after review

Review only the three topics listed at the top. Already approved responsive checks do not need another approval. Update triage when a pending recommendation is accepted. Keep the slot investigator on its existing task. Dispatch the already approved workflow implementation separately; its provisional screenshot experiment retains the user-observed test requirement.

A deferred item is an intentional product decision, not an implementation task waiting for an agent. A partially addressed item closes only when its residual scope is explicitly accepted, deferred, or verified.

## Evidence

- [Current triage](AGENT-DX-TRIAGE.md)
- [Open design questions](AGENT-DX-OPEN-QUESTIONS.md)
- [Layout and inspection review](/tmp/figma-layout-inspection-fix-review.md)
- [Components and content review](/tmp/figma-components-content-fix-review.md)
- [Execution and recovery review](/tmp/figma-execution-recovery-fix-review.md)
- [Approved next-batch decisions](/tmp/figma-responsive-workflow-decisions.md)

The slot findings above include the active investigator’s latest reports; its final report is still pending. Temporary evidence paths refer to this workstation.
