import { projectNames } from "@framelink/core";
import type { SimplifiedDesign } from "@framelink/core";

export function wrapForSerialization(design: SimplifiedDesign) {
  const { nodes, styles, templates, ...metadata } = design;
  return {
    metadata,
    nodes: nodes.map((node) => projectNames(node, templates)),
    styles,
    templates,
  };
}

export type SerializableDesign = ReturnType<typeof wrapForSerialization>;
