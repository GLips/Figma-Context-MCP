# Inherited rectangle dimensions

`01-numeric-gate.js` runs one case on a new isolated page. Set `CASE` to `direct-width`, `direct-height`, `batch`, `live-override`, `creation-override`, `root-resize`, or `fill`. Replace the marker with a fresh UUID before submitting. Require the exact marker in the result and independently read the fixture IDs and page marker before accepting the observation. Stop on timeout or a missing/mismatched marker. Do not retry an ambiguous mutation.

## Current evidence

The product guard rejects numeric dimensions on inherited RECTANGLE nodes before writes, including definition overrides compiled before creation or retargeting. It preserves instance-root resizing and FILL. Other inherited node types and slot-added content remain outside this rule pending live evidence.

Offline validation passes: 24 instance-edit tests, and the full `pnpm validate` gate with 305 root tests, 114 core tests and 380 plugin tests. Tests cover direct edits, batch atomicity, live overrides, creation overrides, retarget overrides, root resizing, FILL, and editable definition geometry.

The first live `direct-width` invocation timed out after 15 seconds of execution inactivity. No result was returned. The runner stopped without retrying, so this is not live validation of the fix. Exact body and logs are `/tmp/figma-instance-dimensions/direct-width.js` and `direct-width-stderr.log`; source and bundle hashes are in `live-build-manifest.json`. The temp CLI was built from ce61b37 with the six changed preamble files overlaid from this worktree and launched from the existing 9de4 checkout for approval identity.

Live verification is paused because a preceding read-only request received a stale cancelled `flcm.component` result. A later unique read-only sentinel returned correctly, but the subsequent small mutation timed out. `/tmp/figma-response-correlation/review.md` records the source-level response-correlation investigation. No connection fix is included here.
