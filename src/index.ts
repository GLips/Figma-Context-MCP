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
  interactionExtractor,
  allExtractors,
  layoutAndText,
  contentOnly,
  visualsOnly,
  layoutOnly,
  collapseSvgContainers,
} from "./extractors/index.js";
