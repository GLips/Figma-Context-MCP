// Re-export extractor types only
export type { SimplifiedDesign } from "./extractors/types.js";

// Flexible extractor system
export type {
  ExtractorFn,
  TraversalContext,
  TraversalOptions,
  GlobalVars,
  StyleTypes,
} from "./extractors/index.js";

export {
  extractFromDesign,
  simplifyRawFigmaObject,
  layoutExtractor,
  textExtractor,
  visualsExtractor,
  componentExtractor,
  allExtractors,
  layoutAndText,
  contentOnly,
  visualsOnly,
  layoutOnly,
} from "./extractors/index.js";
