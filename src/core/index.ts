// Types
export type {
  NodeCounter,
  SimplifiedDesign,
  SimplifiedNode,
  StyleRefPrefix,
  StyleTable,
  TraversalOptions,
  WalkScheduler,
  StyleValue,
  TemplateBody,
} from "./types.js";
// Canonical layout vocabulary — the flattened per-axis sizing union and the
// container-config shape. Re-exported here so consumers (the plugin's slim
// read projection) source them from the core barrel, not a deep path.
export type { SimplifiedDimension, SimplifiedLayout } from "./transformers/layout.js";
// Beyond-CSS effect object forms — re-exported so the plugin sources them from the barrel for the
// read↔create symmetry guard (see plugin effects.test.ts).
export type {
  SimplifiedGlass,
  SimplifiedNoise,
  SimplifiedTexture,
  SimplifiedProgressiveBlur,
} from "./transformers/effects.js";

// The rounding every emitted number passes through. Exported from the barrel so the plugin's write side
// (render's handle geometry) rounds identically to the read side — one numeric currency at the agent edge.
export { pixelRound } from "./utils.js";

// Figma's "container parent" exception, exported from the barrel for the same reason:
// the plugin adapter and the REST adapter must agree on which node types their children's
// coordinates skip, or the two producers place every group child differently.
export { isCoordinateTransparentType } from "./utils.js";

// Figma's per-axis sizing flag → the canonical fill/hug/fixed word. Exported for the plugin's write side,
// which reports a rendered node's sizing intent (bridge.intentOf) off the live node: resolveAxisDimension
// takes the fill/hug word straight from this mapper, so sourcing it here rather than re-deriving it is what
// makes render's `intent` and find's `width`/`height` the same answer by construction.
export { convertSizing } from "./transformers/layout/common.js";

// The core entry: NodeSnapshot[] → canonical SimplifiedNodes (expanded by
// default; compression opt-in via { compress: true })
export { simplify } from "./simplify.js";
export type { SimplifyOptions, SimplifyResult } from "./simplify.js";
