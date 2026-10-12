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

// The public stages own their invariants; the raw walk stays internal.
export { simplify, project } from "@framelink/core";
export { compressDesign } from "@framelink/core/compress";

// No REST entry here: a REST read is only complete with the off-tree definitions and grid siblings
// its own Figma calls fetch, so it lives behind the read tools (`figma-developer-mcp/read`).
