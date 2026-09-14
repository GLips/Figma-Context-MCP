# Overnight DX progress

Live checks resumed and found two clone-binding bugs plus incomplete failure cleanup. Those are now fixed and live-verified. All 430 plugin tests pass.

## What now works in Figma

- Rows wrap, support separate gaps, and reject unsupported direction changes before editing the design. New text wraps within bounded columns; hug-sized text retains its sizing behavior.
- Nested component controls can be exposed, read back, hidden, and exposed again.
- Measurement matches the live node's parent-relative position and dimensions. Replacement preserves placement and fill sizing. Clones accept fixed-size overrides. A standalone clone's text control works.
- Content moved into a slot can be read, found, measured, and edited using its original reference. Healthy-design comparisons preserved hierarchy and query results. See the [slot-access resolution](AGENT-DX-SLOT-ACCESS-RESOLUTION.md).
- Earlier sizing fixes passed all ten live cases. Promotion references passed Undo and Redo earlier.

The first authoring and measurement assertions had invalid test fixtures. Corrected fixtures passed those checks. A valid native control established two component-set cloning failures; both were fixed and verified.

## Latest verification results

- Clones into the same set, another set, and standalone destinations pass TEXT, BOOLEAN, and INSTANCE_SWAP control tests. Collision-adjusted property names retain identity.
- Saved promotion references passed after plugin reopening and movement between pages.
- Contextual captures passed default, 80-pixel, and zero margins with expected image sizes, clipping, and surrounding content. All captures left no temporary slices and preserved selection and viewport. Visual flicker and manual Undo checks still require observation.
- A deliberate clone failure leaves no copy or added properties. Separate readback confirms the destination retains its definitions, ordered children, positions, dimensions, existing overrides, and earlier successful edit.

Evidence and individual results: [live verification report](/tmp/figma-luna-live-verification.md). Real screenshot artifacts are saved under `/tmp/figma-final-live/`. Clone repair evidence is in [the live investigation report](/tmp/figma-variant-binding-diagnosis/report.md).

## Remaining limits

The historical execution stall has not reproduced consistently. Added tracing records native page and font waits and late replies without resubmitting code. The latest controlled creation completed in 1.35 seconds; that does not explain the earlier stalls.

Moving a remapped instance root out of a slot remains a separate native issue. The verified slot read/edit fix does not resolve it.

Contextual screenshots remain a prototype. Cleanup waits for native export to settle; forced plugin shutdown can leave the temporary slice behind. Browser-generated connection errors also remain noisy while unused WebSocket ports are probed.

## Saved work

- `2713b86`: earlier fixes and decisions.
- `6491609`: responsive layouts, component workflows, and sizing integration.
- `d0ac434`: contextual screenshot prototype.
- `4a295eb`: shared scene access and slot readability.
- `6a869b2`: native-wait and late-reply tracing.

Scheduled follow-ups remain paused. Current verification is being driven in this task.
