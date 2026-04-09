import type { GetFileResponse, GetFileNodesResponse, Node } from "@figma/rest-api-spec";
import { FigmaService } from "~/services/figma.js";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
  getNodesProcessed,
} from "~/extractors/index.js";
import type { SimplifiedDesign, SimplifiedNode } from "~/extractors/types.js";
import type { SimplifiedFill } from "~/transformers/style.js";
import { writeLogs } from "~/utils/logger.js";
import { serializeResult } from "~/utils/serialize.js";

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
  /** Number of deduplicated style entries in `globalVars.styles`. */
  styleCount: number;
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
function measureSimplifiedDesign(design: SimplifiedDesign): {
  simplifiedNodeCount: number;
  maxDepth: number;
  instanceCount: number;
  textNodeCount: number;
  imageNodeCount: number;
  componentPropertyCount: number;
  styleCount: number;
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
    styleCount: Object.keys(design.globalVars.styles).length,
    componentCount:
      Object.keys(design.components).length + Object.keys(design.componentSets).length,
  };
}

/**
 * Early-exiting walk over the raw Figma API response looking for any node with
 * a non-empty `boundVariables` mapping. Per the Figma REST API spec, node-level
 * `boundVariables` covers fills, strokes, size, padding, corner radii, text,
 * and component properties — a single check per node is enough for a boolean
 * presence signal. Walking inline Paint/effect structs would be redundant.
 */
function detectVariables(raw: GetFileResponse | GetFileNodesResponse): boolean {
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

export type GetFigmaDataInput = {
  fileKey: string;
  nodeId?: string;
  depth?: number;
};

export type GetFigmaDataResult = {
  formatted: string;
  metrics: GetFigmaDataMetrics;
};

export type GetFigmaDataOutcome = {
  input: GetFigmaDataInput;
  outputFormat: "yaml" | "json";
  durationMs: number;
  metrics?: GetFigmaDataMetrics;
  error?: unknown;
};

export type GetFigmaDataHooks = {
  onFetchStart?: () => void | Promise<void>;
  onFetchComplete?: () => void;
  onSimplifyStart?: () => void | Promise<void>;
  onSimplifyComplete?: () => void;
  onSerializeStart?: () => void | Promise<void>;
  /**
   * Fires exactly once per call, after the pipeline completes (success or
   * failure). Lets shells observe outcomes without embedding telemetry
   * bookkeeping in the core. Observer errors are swallowed silently — a
   * broken observer must never break the pipeline.
   */
  onComplete?: (outcome: GetFigmaDataOutcome) => void;
};

/**
 * Shared pipeline for "get figma data": fetch raw response, simplify, serialize.
 * Used by both the MCP `get_figma_data` tool and the `fetch` CLI command, which
 * differ only in how they wrap this pipeline (progress notifications vs. plain
 * stdout) and how they report errors (MCP envelope vs. process exit).
 *
 * Hooks are optional — the MCP tool uses them to drive progress heartbeats; the
 * CLI passes none.
 */
export async function getFigmaData(
  figmaService: FigmaService,
  input: GetFigmaDataInput,
  outputFormat: "yaml" | "json",
  hooks: GetFigmaDataHooks = {},
): Promise<GetFigmaDataResult> {
  const { fileKey, nodeId, depth } = input;
  const startedAt = Date.now();
  let metrics: GetFigmaDataMetrics | undefined;
  let caughtError: unknown;

  try {
    await hooks.onFetchStart?.();
    let rawResult: { data: GetFileResponse | GetFileNodesResponse; rawSize: number };
    try {
      if (nodeId) {
        rawResult = await figmaService.getRawNode(fileKey, nodeId, depth);
      } else {
        rawResult = await figmaService.getRawFile(fileKey, depth);
      }
    } finally {
      hooks.onFetchComplete?.();
    }
    const rawApiResponse = rawResult.data;
    const rawSizeKb = rawResult.rawSize / 1024;

    await hooks.onSimplifyStart?.();
    let simplifiedDesign;
    try {
      simplifiedDesign = await simplifyRawFigmaObject(rawApiResponse, allExtractors, {
        maxDepth: depth,
        afterChildren: collapseSvgContainers,
      });
    } finally {
      hooks.onSimplifyComplete?.();
    }

    writeLogs("figma-simplified.json", simplifiedDesign);

    // Capture raw node count immediately after simplification while the
    // walker's module-level counter still reflects this call.
    const rawNodeCount = getNodesProcessed();
    const hasVariables = detectVariables(rawApiResponse);
    const measured = measureSimplifiedDesign(simplifiedDesign);

    await hooks.onSerializeStart?.();
    const { nodes, globalVars, ...metadata } = simplifiedDesign;
    const result = { metadata, nodes, globalVars };
    const formatted = serializeResult(result, outputFormat);
    const simplifiedSizeKb = Buffer.byteLength(formatted, "utf8") / 1024;

    metrics = {
      rawSizeKb,
      simplifiedSizeKb,
      rawNodeCount,
      simplifiedNodeCount: measured.simplifiedNodeCount,
      maxDepth: measured.maxDepth,
      styleCount: measured.styleCount,
      componentCount: measured.componentCount,
      instanceCount: measured.instanceCount,
      textNodeCount: measured.textNodeCount,
      imageNodeCount: measured.imageNodeCount,
      componentPropertyCount: measured.componentPropertyCount,
      hasVariables,
    };
    return { formatted, metrics };
  } catch (error) {
    caughtError = error;
    throw error;
  } finally {
    if (hooks.onComplete) {
      // Observer errors must never break the pipeline — e.g. a telemetry
      // failure should not mask the tool's real result or its original error.
      try {
        hooks.onComplete({
          input,
          outputFormat,
          durationMs: Date.now() - startedAt,
          metrics,
          error: caughtError,
        });
      } catch {
        // intentionally empty
      }
    }
  }
}
