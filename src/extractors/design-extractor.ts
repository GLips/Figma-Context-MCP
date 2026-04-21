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
          `Node ${nodeId} was not found in the Figma file. ` +
            `It may have been deleted or the link may be outdated. ` +
            `Try copying a fresh link from the Figma file.`,
        ),
        {
          category: "not_found",
          // Tests assert the category+template contract so a future rewording
          // ("Could not find node X", etc.) cannot silently reopen the leak:
          // `error.message` can drift freely, `safe_message` is what telemetry
          // emits and what the regression tests verify.
          safe_message:
            "Figma node was not found in the file. It may have been deleted or the link may be outdated.",
        },
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
