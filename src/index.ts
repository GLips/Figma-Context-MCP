// Canonicalize core: extractor system, built-ins, and output types
export type {
  SimplifiedDesign,
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
