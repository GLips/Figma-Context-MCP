import type { GetFileResponse, GetFileNodesResponse, Node } from "@figma/rest-api-spec";
import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import type { SimplifiedFill } from "~/transformers/style.js";

export type GetFigmaDataMetrics = {
  rawSizeKb: number;
  simplifiedSizeKb: number;
  /**
   * Total Figma nodes walked in the raw API response, before extraction and
   * filtering. Reflects the complexity of the tree the user asked about.
   */
  rawNodeCount: number;
  /**
   * Total nodes in the simplified output tree (recursive, including nested
   * children). Reflects the complexity of the payload sent to the LLM.
   */
  simplifiedNodeCount: number;
  /**
   * Maximum depth of the simplified output tree. Root nodes are at depth 1.
   */
  maxDepth: number;
  /**
   * Number of named (published) styles defined on the raw Figma response —
   * i.e. reusable styles the user created in the Figma Styles panel (fills,
   * text, effects, grids). High count is a design-system maturity signal.
   */
  namedStyleCount: number;
  /** Total component + component set definitions on the simplified design. */
  componentCount: number;
  /** Simplified nodes with `type === "INSTANCE"`. */
  instanceCount: number;
  /** Simplified nodes with `type === "TEXT"`. */
  textNodeCount: number;
  /**
   * Simplified nodes whose fills or strokes reference a globalVars style
   * containing at least one image-backed fill (IMAGE or PATTERN).
   */
  imageNodeCount: number;
  /** Sum of `componentProperties` keys across all simplified nodes. */
  componentPropertyCount: number;
  /** True if any node in the raw API response has non-empty `boundVariables`. */
  hasVariables: boolean;
  /** Wall-clock ms spent on the Figma API fetch (network + parse). */
  fetchMs: number;
  /** Wall-clock ms spent on the simplification walk. */
  simplifyMs: number;
  /** Wall-clock ms spent serializing to YAML/JSON. */
  serializeMs: number;
};

/**
 * Collect globalVars style keys whose value contains at least one image-backed
 * fill (IMAGE or PATTERN). Covers both plain fill arrays and stroke objects
 * whose `colors` array holds fills. Used to classify simplified nodes as
 * "image nodes" via their `fills`/`strokes` key references.
 */
function collectImageStyleKeys(design: SimplifiedDesign): Set<string> {
  const keys = new Set<string>();
  const hasImageFill = (fills: SimplifiedFill[]): boolean =>
    fills.some(
      (fill) =>
        typeof fill === "object" &&
        fill !== null &&
        (fill.type === "IMAGE" || fill.type === "PATTERN"),
    );

  for (const [key, value] of Object.entries(design.globalVars.styles)) {
    if (Array.isArray(value)) {
      if (hasImageFill(value)) keys.add(key);
    } else if (
      typeof value === "object" &&
      value !== null &&
      "colors" in value &&
      Array.isArray(value.colors) &&
      hasImageFill(value.colors)
    ) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Walk the simplified design once to collect all shape metrics. Single-pass
 * over the tree keeps this cheap even on large files.
 */
export function measureSimplifiedDesign(design: SimplifiedDesign): {
  simplifiedNodeCount: number;
  maxDepth: number;
  instanceCount: number;
  textNodeCount: number;
  imageNodeCount: number;
  componentPropertyCount: number;
  componentCount: number;
} {
  const imageStyleKeys = collectImageStyleKeys(design);

  let simplifiedNodeCount = 0;
  let maxDepth = 0;
  let instanceCount = 0;
  let textNodeCount = 0;
  let imageNodeCount = 0;
  let componentPropertyCount = 0;

  const walk = (node: SimplifiedNode, depth: number): void => {
    simplifiedNodeCount++;
    if (depth > maxDepth) maxDepth = depth;
    if (node.type === "INSTANCE") instanceCount++;
    if (node.type === "TEXT") textNodeCount++;
    if (
      (node.fills && imageStyleKeys.has(node.fills)) ||
      (node.strokes && imageStyleKeys.has(node.strokes))
    ) {
      imageNodeCount++;
    }
    if (node.componentProperties) {
      componentPropertyCount += Object.keys(node.componentProperties).length;
    }
    if (node.children) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  for (const root of design.nodes) walk(root, 1);

  return {
    simplifiedNodeCount,
    maxDepth,
    instanceCount,
    textNodeCount,
    imageNodeCount,
    componentPropertyCount,
    componentCount:
      Object.keys(design.components).length + Object.keys(design.componentSets).length,
  };
}

/**
 * Count the named (published) styles referenced in the raw Figma response.
 * `GetFileResponse` carries the full `styles` dict at the root; `GetFileNodesResponse`
 * carries one `styles` dict per requested node entry, so we merge them by style ID
 * so a style referenced by multiple nodes counts once.
 */
export function countNamedStyles(raw: GetFileResponse | GetFileNodesResponse): number {
  if ("document" in raw) {
    return Object.keys(raw.styles ?? {}).length;
  }
  const seen = new Set<string>();
  for (const entry of Object.values(raw.nodes)) {
    for (const id of Object.keys(entry.styles ?? {})) seen.add(id);
  }
  return seen.size;
}

/**
 * Early-exiting walk over the raw Figma API response looking for any node with
 * a non-empty `boundVariables` mapping. Per the Figma REST API spec, node-level
 * `boundVariables` covers fills, strokes, size, padding, corner radii, text,
 * and component properties — a single check per node is enough for a boolean
 * presence signal. Walking inline Paint/effect structs would be redundant.
 */
export function detectVariables(raw: GetFileResponse | GetFileNodesResponse): boolean {
  const roots: Node[] =
    "document" in raw ? [raw.document] : Object.values(raw.nodes).map((entry) => entry.document);

  const visit = (node: Node): boolean => {
    if (
      "boundVariables" in node &&
      node.boundVariables &&
      Object.keys(node.boundVariables).length > 0
    ) {
      return true;
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        if (visit(child as Node)) return true;
      }
    }
    return false;
  };

  for (const root of roots) {
    if (visit(root)) return true;
  }
  return false;
}
