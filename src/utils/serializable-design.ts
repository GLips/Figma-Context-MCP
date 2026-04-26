import type { SimplifiedDesign } from "~/extractors/types.js";

export function wrapForSerialization(design: SimplifiedDesign) {
  const { nodes, globalVars, ...metadata } = design;
  return { metadata, nodes, globalVars };
}

export type SerializableDesign = ReturnType<typeof wrapForSerialization>;
