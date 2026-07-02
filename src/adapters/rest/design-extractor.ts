import type {
  GetFileResponse,
  GetFileNodesResponse,
  Node as FigmaDocumentNode,
  Component,
  ComponentSet,
  Style,
} from "@figma/rest-api-spec";
import { tagError } from "~/utils/error-meta.js";
import type { ExtractorFn, TraversalOptions, SimplifiedDesign } from "~/core/types.js";
import type { NodeSnapshot } from "~/core/snapshot.js";
import { canonicalize } from "~/core/canonicalize.js";
import { restNodeToSnapshot } from "./node-to-snapshot.js";
import { simplifyComponents, simplifyComponentSets } from "./component.js";

// Yield to the Node event loop between walk batches so progress heartbeats,
// SIGINT, and overlapping HTTP requests stay live during large files. Injected
// here — not hardcoded in the walker — because the core must stay free of Node
// builtins (Invariant 4).
const eventLoopYield = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Extract a complete SimplifiedDesign from raw Figma API response using extractors.
 */
export async function simplifyRawFigmaObject(
  apiResponse: GetFileResponse | GetFileNodesResponse,
  nodeExtractors: ExtractorFn[],
  options: TraversalOptions = {},
): Promise<SimplifiedDesign> {
  // Decode the response into plan-neutral snapshots + the REST-table metadata
  // the output assembly still needs (component/componentSet tables).
  const { name, snapshots, components, componentSets } = restResponseToSnapshots(apiResponse);

  // Run the core with egress compression on: this is the shipped REST tool's
  // output form (ref-deduplicated styles + element templates).
  const { nodes, globalVars, elements, componentDefinitions } = await canonicalize(snapshots, {
    ...options,
    extractors: nodeExtractors,
    compress: true,
    scheduler: eventLoopYield,
  });

  return {
    name,
    nodes,
    components: simplifyComponents(components, componentDefinitions),
    componentSets: simplifyComponentSets(componentSets, componentDefinitions),
    globalVars,
    elements,
  };
}

/**
 * The REST producer's adapter half: a raw API response in, plan-neutral
 * `NodeSnapshot`s out (plus the REST-only component tables the output assembly
 * still consults). This is the one seam where REST wire encodings are unpacked —
 * `restNodeToSnapshot` decodes each node's structures, and `parseAPIResponse`
 * unwraps the response envelope and the top-level `styles`/component tables — so
 * nothing REST-shaped reaches the core (Invariant 2).
 *
 * Split out from `simplifyRawFigmaObject` so the parity harness and its snapshot
 * regenerator feed the identical decode the shipped tool uses, rather than
 * re-deriving it and drifting.
 */
export function restResponseToSnapshots(apiResponse: GetFileResponse | GetFileNodesResponse): {
  name: string;
  snapshots: NodeSnapshot[];
  components: Record<string, Component>;
  componentSets: Record<string, ComponentSet>;
} {
  const { metadata, rawNodes, components, componentSets, extraStyles } =
    parseAPIResponse(apiResponse);

  // restNodeToSnapshot is the single place REST wire encodings are unpacked,
  // including the named-style join against the top-level `styles` table.
  const snapshots = rawNodes.map((node) => restNodeToSnapshot(node, extraStyles));

  return { name: metadata.name, snapshots, components, componentSets };
}

/**
 * Parse the raw Figma API response to extract metadata, nodes, and components.
 */
function parseAPIResponse(data: GetFileResponse | GetFileNodesResponse) {
  const aggregatedComponents: Record<string, Component> = {};
  const aggregatedComponentSets: Record<string, ComponentSet> = {};
  let extraStyles: Record<string, Style> = {};
  let nodesToParse: Array<FigmaDocumentNode>;

  if ("nodes" in data) {
    // GetFileNodesResponse
    const [nodeId, nodeData] = Object.entries(data.nodes)[0];
    if (nodeData === null) {
      tagError(
        new Error(
          `Node ${nodeId} was not found in the Figma file. Likely causes: ` +
            `(1) The source URL was a /proto/, /figjam/, /slides/, /board/, or /deck/ link — ` +
            `only /design/ and /file/ URLs are supported by the Figma REST API. ` +
            `(2) The node is inside a Figma branch — branches have their own fileKey ` +
            `(the value after /branch/ in the URL), use that instead of the parent file's key. ` +
            `(3) The link is stale or the node was deleted. ` +
            `Ask the user for a fresh /design/ URL pointing to the specific frame.`,
        ),
        { category: "not_found" },
      );
    }

    Object.assign(aggregatedComponents, nodeData.components);
    Object.assign(aggregatedComponentSets, nodeData.componentSets);
    if (nodeData.styles) {
      Object.assign(extraStyles, nodeData.styles);
    }
    nodesToParse = [nodeData.document];
  } else {
    // GetFileResponse
    Object.assign(aggregatedComponents, data.components);
    Object.assign(aggregatedComponentSets, data.componentSets);
    if (data.styles) {
      extraStyles = data.styles;
    }
    nodesToParse = data.document.children;
  }

  const { name } = data;

  return {
    metadata: {
      name,
    },
    rawNodes: nodesToParse,
    extraStyles,
    components: aggregatedComponents,
    componentSets: aggregatedComponentSets,
  };
}
