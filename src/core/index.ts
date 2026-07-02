// Types
export type {
  ExtractorFn,
  NodeCounter,
  SimplifiedNode,
  TraversalContext,
  TraversalOptions,
  TraversalState,
  GlobalVars,
  StyleTypes,
} from "./types.js";

// Core traversal function
export { extractFromDesign } from "./node-walker.js";

// Opt-in compression pass (dedup + refs), layered after the walk
export { finalizeDesign } from "./finalize.js";

// Built-in extractors and afterChildren helpers
export {
  layoutExtractor,
  textExtractor,
  visualsExtractor,
  componentExtractor,
  // Convenience combinations
  allExtractors,
  layoutAndText,
  contentOnly,
  visualsOnly,
  layoutOnly,
  // afterChildren helpers
  collapseSvgContainers,
  SVG_ELIGIBLE_TYPES,
} from "./built-in.js";
