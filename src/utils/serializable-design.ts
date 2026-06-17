import type { SimplifiedDesign } from "~/extractors/types.js";

export function wrapForSerialization(design: SimplifiedDesign) {
  const { nodes, globalVars, elements, ...metadata } = design;
  return { metadata, nodes, globalVars, elements };
}

export type SerializableDesign = ReturnType<typeof wrapForSerialization>;
