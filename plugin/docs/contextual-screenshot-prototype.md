# Contextual screenshot prototype

`get_screenshot({ nodeId, context: true, margin: 80 })` exports a temporary page-level slice around the target's absolute bounding box. A key may replace nodeId. The target must be on the current page. Existing calls without `context:true` retain isolated node/page export.

The provisional omitted-margin policy is 10% of the longer bounding-box side, clamped to 24–160px on every side. Explicit margin is a finite nonnegative pixel value; zero captures precisely the bounding rectangle. Scale retains its existing 1–4 range. These defaults are prototype values, not a settled product policy.

The slice is removed in `finally`, including resize/export failures and cancellation detected after export returns. Native export has no abort hook here: cancellation during an unresolved native export cannot clean the slice until that export settles. A plugin crash/forced close likewise cannot guarantee cleanup. No selection, viewport or undo API is called; that does not establish imperceptibility or undo neutrality.

The [official createSlice example](https://developers.figma.com/docs/plugins/api/properties/figma-createslice/) establishes canvas-region export. Backgrounds, ancestor clipping, overlapping siblings, strokes/effects outside the bounding box, visible flicker, selection effects, repeated captures and undo history still need live verification. An updated host must be rebuilt and reopened. Older hosts' unmarked isolated replies are refused for contextual requests, without changing compatibility for existing screenshot calls.

Offline checks cover margin math, placement, success/failure/cancellation cleanup, unchanged isolated exports, invalid targets/options and the tool-to-bridge opt-in/old-host boundary. They do not establish image fidelity. No Figma capture images have been produced for this prototype yet.
