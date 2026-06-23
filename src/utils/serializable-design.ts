import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import { isNoiseName } from "./node-names.js";

export function wrapForSerialization(design: SimplifiedDesign) {
  const { nodes, globalVars, elements, ...metadata } = design;
  return {
    metadata,
    nodes: nodes.map((node) => stripNoiseName(node, elements)),
    globalVars,
    elements,
  };
}

/**
 * Drop noise node names (auto-generated, or any TEXT layer name) once, here,
 * before any serializer runs — so tree/yaml/json all emit the same names without
 * each format re-deriving the rule. Returns a shallow copy rather than mutating
 * the source, since the simplified design may be read again (e.g. logs/metrics).
 *
 * A template-ref node carries no `type` of its own (it lives in the shared
 * element), so resolve it from `elements` to catch templated TEXT nodes too.
 */
function stripNoiseName(
  node: SimplifiedNode,
  elements: SimplifiedDesign["elements"],
): SimplifiedNode {
  const children = node.children?.map((child) => stripNoiseName(child, elements));
  const next: SimplifiedNode = children ? { ...node, children } : { ...node };
  const type = node.type ?? (node.template ? elements[node.template]?.type : undefined);
  if (next.name !== undefined && isNoiseName(next.name, type)) {
    delete next.name;
  }
  return next;
}

export type SerializableDesign = ReturnType<typeof wrapForSerialization>;
