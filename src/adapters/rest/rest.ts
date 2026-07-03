import type {
  GetFileResponse,
  GetFileNodesResponse,
  Node as FigmaDocumentNode,
  Component,
  ComponentSet,
  Style,
} from "@figma/rest-api-spec";
import { tagError } from "~/utils/error-meta.js";
import type { TraversalOptions, SimplifiedDesign } from "~/core/types.js";
import type { NodeSnapshot } from "~/core/snapshot.js";
import { simplify } from "~/core/simplify.js";
import { restNodeToSnapshot } from "./node-to-snapshot.js";
import type {
  SimplifiedComponentDefinition,
  SimplifiedComponentSetDefinition,
  SimplifiedPropertyDefinition,
} from "~/core/transformers/component.js";

// Yield to the Node event loop between walk batches so progress heartbeats,
// SIGINT, and overlapping HTTP requests stay live during large files. Injected
// here — not hardcoded in the walk — because the core must stay free of Node
// builtins (Invariant 4).
const eventLoopYield = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The REST adapter entry: a complete SimplifiedDesign from a raw Figma API
 * response.
 */
export async function simplifyRestResponse(
  apiResponse: GetFileResponse | GetFileNodesResponse,
  options: TraversalOptions = {},
): Promise<SimplifiedDesign> {
  // Decode the response into plan-neutral snapshots + the REST-table metadata
  // the output assembly still needs (component/componentSet tables).
  const { name, snapshots, components, componentSets } = restResponseToSnapshots(apiResponse);

  // Run the core with egress compression on: this is the shipped REST tool's
  // output form (ref-deduplicated styles + templates).
  const { nodes, styles, templates, componentDefinitions } = await simplify(snapshots, {
    ...options,
    compress: true,
    scheduler: eventLoopYield,
  });

  return {
    name,
    nodes,
    components: simplifyComponents(components, componentDefinitions),
    componentSets: simplifyComponentSets(componentSets, componentDefinitions),
    styles,
    templates,
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
 * Split out from `simplifyRestResponse` so the parity harness and its snapshot
 * regenerator feed the identical decode the shipped tool uses, rather than
 * re-deriving it and drifting.
 */
export function restResponseToSnapshots(apiResponse: GetFileResponse | GetFileNodesResponse): {
  name: string;
  snapshots: NodeSnapshot[];
  components: Record<string, Component>;
  componentSets: Record<string, ComponentSet>;
} {
  const { name, rawNodes, components, componentSets, extraStyles } = parseAPIResponse(apiResponse);

  // restNodeToSnapshot is the single place REST wire encodings are unpacked,
  // including the named-style join against the top-level `styles` table.
  const snapshots = rawNodes.map((node) => restNodeToSnapshot(node, extraStyles));

  return { name, snapshots, components, componentSets };
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

  return {
    name: data.name,
    rawNodes: nodesToParse,
    extraStyles,
    components: aggregatedComponents,
    componentSets: aggregatedComponentSets,
  };
}

/*
 * Decode the top-level `components` / `componentSets` tables into the
 * simplified definition maps the output carries. These tables are a
 * REST-specific coupling spot (Invariant 2) — they live outside the node tree
 * in the API response, so they're parsed here rather than in the core walk. The
 * per-node component simplifiers stay in core/transformers/component.ts
 * (Figma-free).
 */

/**
 * Remove unnecessary component properties and convert to simplified format.
 */
function simplifyComponents(
  aggregatedComponents: Record<string, Component>,
  propertyDefinitions?: Record<string, Record<string, SimplifiedPropertyDefinition>>,
): Record<string, SimplifiedComponentDefinition> {
  return Object.fromEntries(
    Object.entries(aggregatedComponents).map(([id, comp]) => [
      id,
      {
        id,
        key: comp.key,
        name: comp.name,
        componentSetId: comp.componentSetId,
        ...(propertyDefinitions?.[id] && {
          propertyDefinitions: propertyDefinitions[id],
        }),
      },
    ]),
  );
}

/**
 * Remove unnecessary component set properties and convert to simplified format.
 */
function simplifyComponentSets(
  aggregatedComponentSets: Record<string, ComponentSet>,
  propertyDefinitions?: Record<string, Record<string, SimplifiedPropertyDefinition>>,
): Record<string, SimplifiedComponentSetDefinition> {
  return Object.fromEntries(
    Object.entries(aggregatedComponentSets).map(([id, set]) => [
      id,
      {
        id,
        key: set.key,
        name: set.name,
        description: set.description,
        ...(propertyDefinitions?.[id] && {
          propertyDefinitions: propertyDefinitions[id],
        }),
      },
    ]),
  );
}
