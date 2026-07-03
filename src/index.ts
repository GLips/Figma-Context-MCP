// Canonicalize core: the simplify entry and its output types
export type {
  SimplifiedDesign,
  SimplifiedNode,
  CanonicalizeOptions,
  CanonicalizeResult,
  TraversalOptions,
  WalkScheduler,
  NodeCounter,
  GlobalVars,
  StyleTypes,
} from "./core/index.js";

// Deliberately NOT exported: extractFromDesign and the style-sink factories.
// canonicalize is the one transform authority; publishing the walker + raw
// sinks would hand consumers the toolkit to assemble a divergent walk — the
// fork the seam exists to prevent. They stay on the in-repo core barrel only.
export { canonicalize } from "./core/index.js";

// REST adapter entry: raw Figma API response → canonical SimplifiedDesign
export { simplifyRawFigmaObject } from "./adapters/rest/design-extractor.js";
