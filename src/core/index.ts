// Types
export type {
  ComponentDefinitionMap,
  NodeCounter,
  SimplifiedDesign,
  SimplifiedNode,
  StyleTable,
  TraversalOptions,
  WalkScheduler,
  GlobalVars,
  StyleValue,
} from "./types.js";

// The core entry: NodeSnapshot[] → canonical SimplifiedNodes (expanded by
// default; compression opt-in via { compress: true })
export { simplify } from "./simplify.js";
export type { SimplifyOptions, SimplifyResult } from "./simplify.js";
