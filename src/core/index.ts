// Types
export type {
  CanonicalizeContext,
  ComponentDefinitionMap,
  NodeCounter,
  SimplifiedDesign,
  SimplifiedNode,
  StyleSink,
  TraversalOptions,
  WalkScheduler,
  GlobalVars,
  StyleTypes,
} from "./types.js";

// The core entry: NodeSnapshot[] → canonical SimplifiedNodes (expanded by
// default; compression opt-in via { compress: true })
export { canonicalize } from "./canonicalize.js";
export type { CanonicalizeOptions, CanonicalizeResult } from "./canonicalize.js";

// Composable lower layers: the single-pass walker, the style sinks it writes
// through, and the opt-in compression pass layered after the walk
export { extractFromDesign } from "./node-walker.js";
export { createInlineStyleSink, createRefStyleSink } from "./style-sink.js";
export type { RefStyleSink } from "./style-sink.js";
export { finalizeDesign } from "./finalize.js";
