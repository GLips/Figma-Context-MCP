// Types
export type {
  ComponentDefinitionMap,
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

// The core entry: NodeSnapshot[] → canonical SimplifiedNodes (expanded by
// default; compression opt-in via { compress: true })
export { simplify } from "./simplify.js";
export type { SimplifyOptions, SimplifyResult } from "./simplify.js";
