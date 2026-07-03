// Simplify core: the one transform authority and its output types
export type {
  SimplifiedDesign,
  SimplifiedNode,
  SimplifyOptions,
  SimplifyResult,
  TraversalOptions,
  WalkScheduler,
  NodeCounter,
  GlobalVars,
  StyleValue,
} from "./core/index.js";

// Deliberately NOT exported: the internal walk and the style-table factories.
// simplify is the one transform authority; publishing the walk + raw tables
// would hand consumers the toolkit to assemble a divergent walk — the fork the
// seam exists to prevent.
export { simplify } from "./core/index.js";

// REST adapter entry: raw Figma API response → canonical SimplifiedDesign
export { simplifyRestResponse } from "./adapters/rest/rest.js";
