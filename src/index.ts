// Re-export extractor types only
export type { SimplifiedDesign } from "./core/types.js";

// Flexible extractor system
export type {
  ExtractorFn,
  TraversalContext,
  TraversalOptions,
  GlobalVars,
  StyleTypes,
} from "./core/index.js";

export {
  extractFromDesign,
  layoutExtractor,
  textExtractor,
  visualsExtractor,
  componentExtractor,
  allExtractors,
  layoutAndText,
  contentOnly,
  visualsOnly,
  layoutOnly,
  collapseSvgContainers,
} from "./core/index.js";

// REST adapter entry: raw Figma API response → canonical SimplifiedDesign
export { simplifyRawFigmaObject } from "./adapters/rest/design-extractor.js";
