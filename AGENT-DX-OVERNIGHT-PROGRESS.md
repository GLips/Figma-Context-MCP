# Overnight DX progress

**The approved fixes are built and saved in commits. Automated checks pass. We still need to test the new work in Figma before calling it finished.**

## What this should make easier

- **Build layouts that adapt to available space.** Agents can make rows wrap, set separate spacing between rows and columns, and use minimum and maximum sizes. New text in a column with a defined width wraps within that space by default. Sizing warnings help explain when content overflows or a requested size gets constrained.
- **Reuse designs with less manual repair.** Agents can measure a node, copy it with changes to its size or appearance, and replace an existing node while retaining its placement and sizing. Duplicated variants restore their supported text, visibility, and component-swap bindings so their controls keep working.
- **Make components easier to use.** Nested component controls can be exposed in the enclosing component’s panel. Already-approved sessions stop receiving repeated pairing instructions when requesting reference material.
- **See a design in context.** A screenshot prototype can include space around a node, showing the background and neighboring content that an isolated export misses. It is optional and still needs visual testing.

## What we know works

Automated checks passed for both implementation batches and the screenshot prototype. The earlier sizing fixes also passed live checks before being brought into the main branch. Promotion’s old-node references passed Undo and Redo checks earlier.

**That does not yet prove the new combined build works correctly in Figma.** We still need to check the new layout and component behavior, replacement recovery, references after reopening or moving between pages, and actual screenshot output. We have not produced live example captures yet.

## What remains unresolved

**Reading content after a slot move:** we found a way to read and edit affected content without replacing it. We have not yet proved that this approach covers all the nodes we need, preserves ordering and identity, or performs well on larger designs. The main access code has not been changed.

**Screenshot side effects:** we need to watch for flicker, selection changes, and Undo behavior. The prototype temporarily creates a capture region and removes it afterward. If export stalls, cleanup waits for it to finish; forced plugin shutdown could leave that temporary region behind.

## What happens next

The plugin and Codex have now been restarted. A fresh read-only live check succeeded, and slot-access correctness/performance investigation has resumed. Re-enabling scheduled follow-ups was still rejected by Codex’s automatic approval review with the checkpoint-compatibility error; the running investigation is unaffected.

The slot investigator currently has the exclusive live queue. Finish the slot-access proof and a tested resolution, then run the prepared authoring/structural checks one batch at a time and review contextual screenshots with you watching. Scheduled follow-ups remain paused; do not treat that as an active monitor.

## Saved progress and supporting detail

- `2713b86` — earlier fixes and decisions.
- `6491609` — responsive layouts, component workflows, and integrated sizing fixes.
- `d0ac434` — contextual screenshot prototype.

Detailed test results and prepared checks: [layouts and controls](/tmp/figma-responsive-authoring-implementation.md), [copying and replacement](/tmp/figma-structural-live/checkpoint.md), [screenshots](/tmp/figma-contextual-screenshot-prototype/report.md), and [slot-access investigation](/tmp/figma-scene-access-proof/status.md).

## Subsequent slot-access resolution

The primary slot descendant-read/edit issue is now implemented and live-verified. [Resolution, performance and remaining limits](AGENT-DX-SLOT-ACCESS-RESOLUTION.md). Native remapped-root movement out of slots and the historical connection/page-switch stall remain open.
