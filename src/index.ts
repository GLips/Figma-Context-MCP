// Simplify core: the one transform authority and its output types
export type {
  SimplifiedDesign,
  SimplifiedNode,
  SimplifyOptions,
  SimplifyResult,
  ProjectOptions,
  Elision,
  TraversalOptions,
  WalkScheduler,
  NodeCounter,
  StyleValue,
  TemplateBody,
} from "@framelink/core";

// The public stages own their invariants; raw walk and style-table factories stay internal.
export { simplify, project } from "@framelink/core";

// REST adapter entry: raw Figma API response → canonical SimplifiedDesign
export { simplifyRestResponse } from "./adapters/rest/rest.js";
