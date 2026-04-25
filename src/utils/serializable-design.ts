import type {
  SimplifiedComponentDefinition,
  SimplifiedComponentSetDefinition,
} from "~/transformers/component.js";
import type { SimplifiedDesign, SimplifiedNode, GlobalVars } from "~/extractors/types.js";

/**
 * Wrapped shape consumed by `serializeResult`. A `SimplifiedDesign` carries
 * `name`/`components`/`componentSets` flat at the top, but every serializer
 * sees the design with metadata pulled into its own sub-object so structural
 * fields (`nodes`, `globalVars`) sit alongside a single `metadata` block in
 * the YAML/JSON output. Tree format reads from the same wrapped shape so all
 * serializers share one input contract — earlier the tree renderer expected
 * the unwrapped shape and silently broke on the production path.
 */
export interface SerializableDesign {
  metadata: {
    name: string;
    components: Record<string, SimplifiedComponentDefinition>;
    componentSets: Record<string, SimplifiedComponentSetDefinition>;
  };
  nodes: SimplifiedNode[];
  globalVars: GlobalVars;
}

export function wrapForSerialization(design: SimplifiedDesign): SerializableDesign {
  const { nodes, globalVars, ...metadata } = design;
  return { metadata, nodes, globalVars };
}
