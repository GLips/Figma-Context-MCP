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
import { Logger } from "~/utils/logger.js";
import type { ExtractorFn, TraversalOptions, SimplifiedDesign } from "./types.js";
import { extractFromDesign } from "./node-walker.js";
import { finalizeDesign } from "./finalize.js";

/**
 * Extract a complete SimplifiedDesign from raw Figma API response using extractors.
 */
export async function simplifyRawFigmaObject(
  apiResponse: GetFileResponse | GetFileNodesResponse,
  nodeExtractors: ExtractorFn[],
  options: TraversalOptions = {},
): Promise<SimplifiedDesign> {
  // Extract components, componentSets, and raw nodes from API response
  const { name, rawNodes, components, componentSets, extraStyles, missingNodeIds } =
    parseAPIResponse(apiResponse);

  // Partial miss: some requested ids didn't resolve but others did. We proceed
  // with what we have (see parseAPIResponse) rather than failing the whole call —
  // the caller asked for several roots and most came back. The gap is logged for
  // operators and carried into the result below so the LLM caller sees it too.
  if (missingNodeIds.length > 0) {
    Logger.log(
      `Skipped ${missingNodeIds.length} unresolved node id(s): ${missingNodeIds.join(", ")}`,
    );
  }

  // Process nodes using the flexible extractor system. The walk shares one
  // globalVars + traversalState across every root, so style/element dedup spans
  // all requested nodes — a value used once in either root is still seen twice.
  const {
    nodes: extractedNodes,
    globalVars: walkedGlobalVars,
    traversalState,
  } = await extractFromDesign(rawNodes, nodeExtractors, options, { styles: {} }, extraStyles);

  // Finalize pass: count-gate style hoisting (and, later, element dedup). Runs
  // here, after the full walk, because it needs whole-tree usage counts the
  // single-pass extractors can't see. See finalize.ts.
  const { nodes, globalVars, elements } = finalizeDesign(
    extractedNodes,
    walkedGlobalVars,
    traversalState.namedStyleKeys,
  );

  return {
    name,
    nodes,
    components: simplifyComponents(components, traversalState.componentPropertyDefinitions),
    componentSets: simplifyComponentSets(
      componentSets,
      traversalState.componentPropertyDefinitions,
    ),
    // Only present on a partial miss, so the common case pays no tokens for it.
    ...(missingNodeIds.length > 0 ? { missingNodeIds } : {}),
    globalVars,
    elements,
  };
}

/**
 * One requested-or-whole-file unit of raw design data: a set of root nodes plus
 * the component/style dictionaries that came alongside them. Both API response
 * shapes normalize to a list of these, so the rest of parsing is shape-agnostic.
 */
type RawSlice = {
  roots: FigmaDocumentNode[];
  components?: Record<string, Component>;
  componentSets?: Record<string, ComponentSet>;
  styles?: Record<string, Style>;
};

type ParsedAPIResponse = {
  name: string;
  rawNodes: FigmaDocumentNode[];
  components: Record<string, Component>;
  componentSets: Record<string, ComponentSet>;
  extraStyles: Record<string, Style>;
  /** Requested node ids the API returned as null (deleted/inaccessible/wrong file). */
  missingNodeIds: string[];
};

/** Shallow-merge a list of dictionaries; `undefined` sources are skipped. */
function mergeRecords<T>(records: Array<Record<string, T> | undefined>): Record<string, T> {
  return Object.assign({}, ...records);
}

/**
 * Parse the raw Figma API response into a flat, shape-agnostic bag of roots and
 * their associated dictionaries. The two API shapes differ only in how they
 * package roots; normalizing them up front (see normalizeResponse) lets the
 * aggregation below treat the full-file fetch and a multi-node fetch identically.
 */
function parseAPIResponse(data: GetFileResponse | GetFileNodesResponse): ParsedAPIResponse {
  const { slices, missingNodeIds } = normalizeResponse(data);

  return {
    name: data.name,
    rawNodes: slices.flatMap((slice) => slice.roots),
    components: mergeRecords(slices.map((slice) => slice.components)),
    componentSets: mergeRecords(slices.map((slice) => slice.componentSets)),
    extraStyles: mergeRecords(slices.map((slice) => slice.styles)),
    missingNodeIds,
  };
}

/**
 * Collapse either API response shape into a list of {@link RawSlice}s. The only
 * branch the rest of the pipeline can't avoid lives here:
 *   - GetFileResponse: one slice whose roots are the document's children.
 *   - GetFileNodesResponse: one slice per resolved node (the caller may have
 *     passed comma-separated ids). A null entry is a node the API couldn't
 *     resolve and is recorded in missingNodeIds, not turned into a slice. Only
 *     when NOTHING resolves do we raise the "not found" error — the case the
 *     single-node path used to handle, and the one that previously crashed with a
 *     raw TypeError on an empty `nodes` object.
 */
function normalizeResponse(data: GetFileResponse | GetFileNodesResponse): {
  slices: RawSlice[];
  missingNodeIds: string[];
} {
  if ("document" in data) {
    return {
      slices: [
        {
          roots: data.document.children,
          components: data.components,
          componentSets: data.componentSets,
          styles: data.styles,
        },
      ],
      missingNodeIds: [],
    };
  }

  const entries = Object.entries(data.nodes);
  const missingNodeIds = entries.flatMap(([id, node]) => (node === null ? [id] : []));
  const slices: RawSlice[] = entries.flatMap(([, node]) =>
    node === null
      ? []
      : [
          {
            roots: [node.document],
            components: node.components,
            componentSets: node.componentSets,
            styles: node.styles,
          },
        ],
  );

  if (slices.length === 0) {
    const requested = entries.map(([id]) => id);
    const idList = (requested.length ? requested : ["(none returned)"]).join(", ");
    tagError(
      new Error(
        `No requested nodes were found in the Figma file (${idList}). Likely causes: ` +
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

  return { slices, missingNodeIds };
}
