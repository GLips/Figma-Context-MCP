// Re-export the server and its types
export { createServer } from "./mcp/index.js";
export type { SimplifiedDesign } from "./extractors/types.js";
export type { FigmaService } from "./services/figma.js";
export { getServerConfig } from "./config.js";
export { startServer } from "./cli.js";

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
