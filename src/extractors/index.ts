// Types
export type {
  ExtractorFn,
  TraversalContext,
  TraversalOptions,
  GlobalVars,
  StyleTypes,
} from "./types.js";

// Core traversal function
export { extractFromDesign } from "./node-walker.js";

// Design-level extraction (unified nodes + components)
export { simplifyRawFigmaObject } from "./design-extractor.js";

// Built-in extractors
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
} from "./built-in.js";
