import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import { FigmaService } from "~/services/figma.js";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
} from "~/extractors/index.js";
import { writeLogs } from "~/utils/logger.js";
import { serializeResult } from "~/utils/serialize.js";

export type GetFigmaDataMetrics = {
  rawSizeKb: number;
  simplifiedSizeKb: number;
  nodeCount: number;
};

export type GetFigmaDataInput = {
  fileKey: string;
  nodeId?: string;
  depth?: number;
};

export type GetFigmaDataResult = {
  formatted: string;
  metrics: GetFigmaDataMetrics;
};

export type GetFigmaDataHooks = {
  onFetchStart?: () => void | Promise<void>;
  onFetchComplete?: () => void;
  onSimplifyStart?: () => void | Promise<void>;
  onSimplifyComplete?: () => void;
  onSerializeStart?: () => void | Promise<void>;
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

  const nodeCount = simplifiedDesign.nodes.length;

  await hooks.onSerializeStart?.();
  const { nodes, globalVars, ...metadata } = simplifiedDesign;
  const result = { metadata, nodes, globalVars };
  const formatted = serializeResult(result, outputFormat);
  const simplifiedSizeKb = Buffer.byteLength(formatted, "utf8") / 1024;

  return {
    formatted,
    metrics: { rawSizeKb, simplifiedSizeKb, nodeCount },
  };
}
