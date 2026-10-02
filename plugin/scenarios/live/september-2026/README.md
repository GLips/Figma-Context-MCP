# September 2026 live investigation archive

Recovered October 2 from detached worktree `b44d`, including unique commit `2ad6d94` and its uncommitted diagnostic scenarios. Source text is preserved apart from required license headers. These are evidence/reproduction scripts, not current API acceptance tests. The current data-tree authoring surface replaced constructor calls such as `flcm.frame`, and changed return shapes; migrate a specific scenario before running it. Do not execute the whole archive against a user document.

The old runtime edits are already represented or superseded in the current branch: size bounds and diagnostics, inherited rectangle guards, incoming instance direction validation, and shared scene access. In particular, the six added instance-edit regressions are present in current `instance-edit.test.ts`. No old implementation was copied over newer code.

The archive retains slot readability/moves/clone geometry and archaeology (including warm versus cold import), sizing, instance dimensions/direction, and the original triage probes. Historical relative document links refer to the former worktree layout; original notes and full dirty-worktree backups are in `.scratch/worktree-recovery-2026-10-02`. Reported results belong to the September runtime and are not assertions about the current host.

The remaining remapped-instance-root move-out issue needs a fresh current-runtime reproduction. Descendant readability was fixed separately; the original `/tmp` proof artifacts no longer exist. Syntax checks only parse JavaScript and do not establish Figma validity or behavioral success.

Reconciliation checks also found all 8 old sizing test names, all 22 old instance-edit test names, and the old REST size-bounds test in the current tree. Current snapshot/read adapters include all four size-bound fields. Historical probes remain useful evidence; those implementation/test changes do not require transplanting.
