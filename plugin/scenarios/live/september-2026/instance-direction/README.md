# Instance direction gate

`01-direction-gate.js` is an async production Figma body for the existing `execute` CLI. It creates one isolated page and retains it as evidence. Run the CLI built from this fix, using the already-approved CLI working directory to preserve connection identity.

The body checks rejection before root writes, whole-batch rejection, explicitly matching direction, incoming component swaps and variants, and nested instance overrides on both live and incoming trees. Each rejection compares before/after state. The result includes retained page and screenshot target IDs.

Validation: `pnpm validate` passed (305 root tests, 114 core tests, 377 plugin tests; one root test skipped). The five new behavioral tests all fail when the direction guard is disabled, and pass with it enabled. Source was restored after that check.

Live verification passed on 2026-09-13: all nine observations, page `4934:5544`. Raw evidence: `/tmp/figma-instance-direction/execution.json`. Rejected direct, batch, swap, variant and nested override edits preserved measured before/after state. Matching row and incoming column directions applied gap 6 successfully.

This worktree predates the standalone execute command. The live run therefore used a temporary checkout of CLI commit `ce61b37` with these five changed preamble files overlaid: `bridge.ts`, `edit.ts`, `edit-many.ts`, `edit-plan.ts`, `instance.ts`. Those files have no baseline differences between this worktree's HEAD and that CLI commit. The temporary build embeds the new gate; overlay byte equality and bundle hashes are recorded in `/tmp/figma-instance-direction/live-build-manifest.json`. The executed binary was `/tmp/figma-instance-direction/cli/dist/bin.js`, launched from the existing `9de4` working directory. It bound port 9876 and Graham explicitly approved session 4955. This approval is separate from the earlier port-9877 connection tests.

No existing design page was modified. The isolated page is retained; delete only that exact page if cleanup is wanted.

Two subsequent read-only CLI captures were inspected: `matching-row.png` shows the accepted 6px gap; `rejected-batch-row.png` shows the original 12px gap. Both remain horizontal. Files are under `/tmp/figma-instance-direction/`; approval was reused for both capture calls.
