# Sizing bounds and overflow

Each body owns a new isolated page. Run only the relevant case, never the full live scenario collection. Replace `MARKER` with a fresh UUID before submission. A returned result must match that exact marker. Stop on a timeout or mismatch; an ambiguous mutation must not be retried.

- `01-bounds.js`, `CASE = "same-edit"`: set all four bounds beside a constrained resize, read them canonically, then clear them and resize again. Expect successful writes plus clamp warnings for width 145 → 160 with minWidth 160 and height 95 → 80 with maxHeight 80.
- `01-bounds.js`, `CASE = "instance-only"`: the same dimensions under preexisting instance-only bounds. Expect the master to retain null bounds.
- `02-overflow.js`: one batch includes existing clipped/unclipped and nested overflow. Expect exactly one overflow console warning containing all three expected IDs once, grouped by clipping. The unrelated overflowing sibling must be absent.

After each successful result, run a separate read-only body using its exact page/node IDs. Check the page's `sizing-marker`, final dimensions/bounds or child geometry, and the master where applicable. Give that readback its own unique marker. Inspect screenshots for visual quality; the warning checks child bounds, not subjective appearance.

## Verification status

These probes have not run. Live execution remains blocked by the earlier missing/stale response evidence and subsequent 15-second inactivity timeout. The implementation does not repair that connection issue.

Automated checks live in `plugin/src/preamble/sizing.test.ts` and `src/tests/size-bounds.test.ts`. The mock exercises clamping deterministically; it does not substitute for live Figma verification.
