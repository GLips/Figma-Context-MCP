# Triage first-pass probes

These async JavaScript bodies run through the existing production CLI with `flcm` and `figma`. Each creates a new scenario-owned page and retains it. Live runs used the CLI build at commit `ce61b37`; every final portable probe has a completed live run, with the partial sizing attempts and exposure precondition correction distinguished below. No product fixes are included. Run one file at a time in the authorized scratch context; preserve JSON stdout, stderr, the execution result and subsequent explicit-ID screenshot exports. Never repeat mutation merely to collect a screenshot.

`setup.verified` confirms the initial fixture. Later case-specific checks can still fail; read `status`, `failure`, every captured operation and the before/after fields. Returned operations are not implicit passes. Private document IDs, logs and PNGs belong in local evidence, not this directory. Cleanup is manual and scoped to the exact returned page ID and name after review, never a prefix search.

The [triage index](../../../../AGENT-DX-TRIAGE.md) retains the original reports and source links. The [slot batch](../slot-validity/README.md) covers items 1 through 4. The table below is a bounded first pass, not a ruling on every original document state.

## Live findings, 2026-09-13

| Probe | Triage items | Result |
| --- | --- | --- |
| [06-sizing-layout.js](06-sizing-layout.js) | 5, 6 | Reproduced. Raw and flcm direction writes return normally, retain HORIZONTAL, and change gap to 6. Sublayer resize to 72×72 returns normally but stays 40×40; the green fill applies and raw x assignment throws. Completed after the original broader sizing batch was split. |
| [07-properties-clones.js](07-properties-clones.js) | 9 through 11, 29 | Invented default replaces the original title on binding and remains after property deletion. Price binding collapses two styled runs to one 12px unstruck run. Standalone component clones preserve text/visibility references; the variant-member case is separate. Promotion replaces the root ID and retains the child ID. |
| [08-operation-boundaries.js](08-operation-boundaries.js) | 13, 14 | Slot-target append completed with all four nodes readable and matching pixels. An earlier successful edit survives an intentionally invalid later edit. This shows the script boundary, not a defect in rejection of invalid input. |
| [09-sizing-constraints.js](09-sizing-constraints.js) | 7, 8, 12 | Reproduced: requesting 145px realizes 160px because minWidth is 160px; FILL clone changes 180×100 to staging bounds 220×250; narrowing reduces the FILL sibling from 140px to 1px; fixed-height content extends to 118px while the next section starts at 60px. Clone raw sizing modes read FIXED in free-form staging, so the observed problem is geometry rather than a retained raw FILL enum. |
| [10-variant-contracts.js](10-variant-contracts.js) | 9, 25, 26, 29 | Variant cloning loses both bindings through raw and flcm paths, unlike standalone clones. The raw clone was inspected before explicit reparenting; its actual initial parent was not recorded. Existing-set input is refused. Instance spacing without restating the master's column mode is refused. `variants` returns a handle without `.node`. |
| [11-responsive-queries.js](11-responsive-queries.js) | 15 through 17, 23, 24, 30, 32, 35 | Fixed text stays 380×30 after parent narrowing, then explicit FILL makes it 204×60. Free-form child stays 350px wide. Wrap/min-width and text/component query keys are rejected. `characters` predicate throws rather than returning zero; `text` predicate finds the node. Regex name crashes. `replace` is absent. `imageRef` construction is accepted; 13 verifies actual reuse. Gap-only edit preserves mode/padding. |
| [12-read-contracts.js](12-read-contracts.js) | 19, 27, 28, 33 | Frame children inline, component children in components map, and render handles lack children. Mixed-size Symbol concatenation throws; naive JSON drops it. Transparent export omits the parent backdrop. Positive exposure was inconclusive because the component had no bound property; 14 corrects that precondition. |
| [13-image-ref-reuse.js](13-image-ref-reuse.js) | 24 | Not reproduced as a missing capability. Actual imageRef rendering succeeds with the source image hash and matching pixels. |
| [14-nested-exposure.js](14-nested-exposure.js) | 27 | With the required bound property, nested exposure succeeds; outside-component exposure rejects. This verifies the raw capability and its preconditions, not the proposed forwarding API. |

The original broader sizing batch had three cancelled attempts with no final report. The first inspected page was empty; a later inspected attempt retained the direction, sublayer and min-width fixtures. These partial attempts cannot establish complete outcomes. The portable sizing scripts now separate the groups; no timed-out run is labelled a successful validation.

## Review and limits

- Export each returned `screenshotTargets` entry with its explicit `nodeId` in a subsequent read-only CLI invocation. The CLI captures one PNG per invocation. Record its `expectedVisualCheck`; inspect whole parents for overflow and isolated children for transparency.
- For 06, compare horizontal layouts and green 40px rectangles with the requested edits. For 07, metadata establishes binding preservation; identical default labels alone cannot. For 08, verify the appended text/swatch and inspect the rejected second call alongside the marker's retained name.
- For 09, compare realized sizes and sizing modes before and after clone, resize and explicit dimensions. Its PNG shows the clone after the explicit height edit back to 100px; the earlier 250px stretch is preserved numerically, not in that final PNG. For 10, distinguish standalone component copies from cloned variant members. For 11, distinguish unsupported vocabulary from ignored writes and caller predicate mistakes. For 12, compare component/read shapes, mixed-value errors and transparent-child exports with their parent context.
- Component defaults, instance restrictions and parent-dependent sizing can be intentional platform behavior. Reproducing a surprising outcome does not decide whether the remedy is documentation, feedback, caller changes or product behavior.
- These probes do not restart the plugin, revoke consent, disrupt connections, or edit existing designs. Approval recovery, original-design scale and subjective usability need separate review where indicated in the index.

## Static checks

```sh
node plugin/scenarios/live/triage-first-pass/check-syntax.mjs
```

This parses async bodies without executing them. It is not live validation. Each file's runtime evidence and remaining limits are recorded above.
