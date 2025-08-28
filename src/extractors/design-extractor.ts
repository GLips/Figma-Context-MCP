import type {
  GetFileResponse,
  GetFileNodesResponse,
  Node as FigmaDocumentNode,
  Component,
  ComponentSet,
  Style,
} from "@figma/rest-api-spec";
import { simplifyComponents, simplifyComponentSets } from "~/transformers/component.js";
import { isVisible } from "~/utils/common.js";
import type { ExtractorFn, TraversalOptions, SimplifiedDesign, TraversalContext } from "./types.js";
import { extractFromDesign } from "./node-walker.js";

/**
 * Extract a complete SimplifiedDesign from raw Figma API response using extractors.
 */
export function simplifyRawFigmaObject(
  apiResponse: GetFileResponse | GetFileNodesResponse,
  nodeExtractors: ExtractorFn[],
  options: TraversalOptions = {},
): SimplifiedDesign {
  // Extract components, componentSets, and raw nodes from API response
  const { metadata, rawNodes, components, componentSets, extraStyles } =
    parseAPIResponse(apiResponse);

  // Process nodes using the flexible extractor system
  const globalVars: TraversalContext["globalVars"] = { styles: {}, extraStyles };
  const { nodes: extractedNodes, globalVars: finalGlobalVars } = extractFromDesign(
    rawNodes,
    nodeExtractors,
    options,
    globalVars,
  );

  // Return complete design
  return {
    ...metadata,
    nodes: extractedNodes,
    components: simplifyComponents(components),
    componentSets: simplifyComponentSets(componentSets),
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
    const nodeResponses = Object.values(data.nodes);
    nodeResponses.forEach((nodeResponse) => {
      if (nodeResponse.components) {
        Object.assign(aggregatedComponents, nodeResponse.components);
      }
      if (nodeResponse.componentSets) {
        Object.assign(aggregatedComponentSets, nodeResponse.componentSets);
      }
      if (nodeResponse.styles) {
        Object.assign(extraStyles, nodeResponse.styles);
      }
    });
    nodesToParse = nodeResponses.map((n) => n.document).filter(isVisible);
  } else {
    // GetFileResponse
    Object.assign(aggregatedComponents, data.components);
    Object.assign(aggregatedComponentSets, data.componentSets);
    if (data.styles) {
      extraStyles = data.styles;
    }
    nodesToParse = data.document.children.filter(isVisible);
  }

  const { name, lastModified, thumbnailUrl } = data;

  return {
    metadata: {
      name,
      lastModified,
      thumbnailUrl: thumbnailUrl || "",
    },
    rawNodes: nodesToParse,
    extraStyles,
    components: aggregatedComponents,
    componentSets: aggregatedComponentSets,
  };
}
