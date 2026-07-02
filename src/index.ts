// Canonicalize core: extractor system, built-ins, and output types
export type {
  SimplifiedDesign,
  ExtractorFn,
  CanonicalizeContext,
  CanonicalizeOptions,
  CanonicalizeResult,
  StyleSink,
  TraversalOptions,
  WalkScheduler,
  GlobalVars,
  StyleTypes,
} from "./core/index.js";

// Deliberately NOT exported: extractFromDesign and the style-sink factories.
// canonicalize is the one transform authority; publishing the walker + raw
// sinks would hand consumers the toolkit to assemble a divergent walk — the
// fork the seam exists to prevent. They stay on the in-repo core barrel only.
export {
  canonicalize,
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
