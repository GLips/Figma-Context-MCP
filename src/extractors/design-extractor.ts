import type {
  GetFileResponse,
  GetFileNodesResponse,
  Node as FigmaDocumentNode,
  Component,
  ComponentSet,
  Style,
} from "@figma/rest-api-spec";
import { simplifyComponents, simplifyComponentSets } from "~/transformers/component.js";
import { tagError } from "~/utils/error-meta.js";
import type { ExtractorFn, TraversalOptions, SimplifiedDesign } from "./types.js";
import { extractFromDesign } from "./node-walker.js";

/**
 * Extract a complete SimplifiedDesign from raw Figma API response using extractors.
 */
export async function simplifyRawFigmaObject(
  apiResponse: GetFileResponse | GetFileNodesResponse,
  nodeExtractors: ExtractorFn[],
  options: TraversalOptions = {},
): Promise<SimplifiedDesign> {
  // Extract components, componentSets, and raw nodes from API response
  const { metadata, rawNodes, components, componentSets, extraStyles } =
    parseAPIResponse(apiResponse);

  // Process nodes using the flexible extractor system
  const {
    nodes: extractedNodes,
    globalVars: finalGlobalVars,
    traversalState,
  } = await extractFromDesign(rawNodes, nodeExtractors, options, { styles: {} }, extraStyles);

  return {
    ...metadata,
    nodes: extractedNodes,
    components: simplifyComponents(components, traversalState.componentPropertyDefinitions),
    componentSets: simplifyComponentSets(
      componentSets,
      traversalState.componentPropertyDefinitions,
    ),
    globalVars: { styles: finalGlobalVars.styles },
  };
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
