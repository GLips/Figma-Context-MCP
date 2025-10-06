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
