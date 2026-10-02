import type { GetFileResponse, GetFileNodesResponse } from "@figma/rest-api-spec";
import { FigmaService } from "~/services/figma.js";
import {
  simplifyRawFigmaObject,
  allExtractors,
  collapseSvgContainers,
} from "~/extractors/index.js";
import { writeLogs } from "~/utils/logger.js";
import { serializeResult, type OutputFormat } from "~/utils/serialize.js";
import { wrapForSerialization } from "~/utils/serializable-design.js";
import { tagError } from "~/utils/error-meta.js";
import {
  type GetFigmaDataMetrics,
  measureSimplifiedDesign,
  countNamedStyles,
  detectVariables,
} from "~/services/get-figma-data-metrics.js";
import { figmaDataCacheKey, type ResponseCache } from "~/services/response-cache.js";

export type { GetFigmaDataMetrics } from "~/services/get-figma-data-metrics.js";

export type GetFigmaDataInput = {
  fileKey: string;
  nodeId?: string;
  depth?: number;
};

/** What a cache entry stores. The age annotation is added at read time, not stored. */
export type CachedFigmaData = {
  formatted: string;
  metrics: GetFigmaDataMetrics;
};

export type GetFigmaDataResult = CachedFigmaData & {
  /** Set only when this result was served from the response cache. */
  cache?: { ageMs: number; ttlMs: number };
};

export type GetFigmaDataOutcome = {
  input: GetFigmaDataInput;
  outputFormat: OutputFormat;
  durationMs: number;
  metrics?: GetFigmaDataMetrics;
  error?: unknown;
  cacheHit: boolean;
  cacheAgeMs?: number;
};

/**
 * Live progress reader exposed to onSimplifyStart so callers can render
 * heartbeats showing real-time node counts. Closes over the per-call counter
 * the walker is incrementing — no module-global state involved.
 */
export type SimplifyProgress = {
  getNodeCount: () => number;
};

export type GetFigmaDataHooks = {
  onFetchStart?: () => void | Promise<void>;
  onFetchComplete?: () => void | Promise<void>;
  onSimplifyStart?: (progress: SimplifyProgress) => void | Promise<void>;
  onSimplifyComplete?: () => void | Promise<void>;
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
  outputFormat: OutputFormat,
  hooks: GetFigmaDataHooks = {},
  cache?: ResponseCache<CachedFigmaData>,
): Promise<GetFigmaDataResult> {
  const { fileKey, nodeId, depth } = input;
  const startedAt = Date.now();
  let metrics: GetFigmaDataMetrics | undefined;
  let caughtError: unknown;
  let cacheHit = false;
  let cacheAgeMs: number | undefined;
  // Computed up front so a hit and the later store use the same identity.
  // Absent when caching is off — every call goes to the API.
  const cacheKey = cache
    ? figmaDataCacheKey({
        authFingerprint: figmaService.authFingerprint(),
        fileKey,
        nodeId,
        depth,
        outputFormat,
      })
    : undefined;
  // Per-call counter shared with the walker. Lives in the call closure so
  // overlapping HTTP requests each have their own — no module-global state.
  const nodeCounter = { count: 0 };

  try {
    if (cache && cacheKey) {
      const hit = cache.get(cacheKey);
      if (hit) {
        // Skip fetch/simplify hooks. They describe a network round-trip that
        // did not happen; progress that says "Fetching" on a hit would be a lie.
        cacheHit = true;
        cacheAgeMs = hit.ageMs;
        metrics = hit.value.metrics;
        return {
          formatted: hit.value.formatted,
          metrics: hit.value.metrics,
          cache: { ageMs: hit.ageMs, ttlMs: cache.ttlMs },
        };
      }
    }

    await hooks.onFetchStart?.();
    let rawResult: { data: GetFileResponse | GetFileNodesResponse; rawSize: number };
    const fetchStart = Date.now();
    try {
      if (nodeId) {
        rawResult = await figmaService.getRawNode(fileKey, nodeId, depth);
      } else {
        rawResult = await figmaService.getRawFile(fileKey, depth);
      }
    } catch (error) {
      tagError(error, { phase: "fetch" });
    } finally {
      await hooks.onFetchComplete?.();
    }
    const fetchMs = Date.now() - fetchStart;
    const rawApiResponse = rawResult.data;
    const rawSizeKb = rawResult.rawSize / 1024;

    await hooks.onSimplifyStart?.({ getNodeCount: () => nodeCounter.count });
    let simplifiedDesign;
    const simplifyStart = Date.now();
    try {
      simplifiedDesign = await simplifyRawFigmaObject(rawApiResponse, allExtractors, {
        maxDepth: depth,
        afterChildren: collapseSvgContainers,
        nodeCounter,
      });
    } catch (error) {
      tagError(error, { phase: "simplify" });
    } finally {
      await hooks.onSimplifyComplete?.();
    }
    const simplifyMs = Date.now() - simplifyStart;

    writeLogs("figma-simplified.json", simplifiedDesign);

    const rawNodeCount = nodeCounter.count;
    const hasVariables = detectVariables(rawApiResponse);
    const namedStyleCount = countNamedStyles(rawApiResponse);
    const measured = measureSimplifiedDesign(simplifiedDesign);

    await hooks.onSerializeStart?.();
    const serializeStart = Date.now();
    let formatted: string;
    try {
      formatted = serializeResult(wrapForSerialization(simplifiedDesign), outputFormat);
    } catch (error) {
      tagError(error, { phase: "serialize" });
    }
    const simplifiedSizeKb = Buffer.byteLength(formatted, "utf8") / 1024;
    const serializeMs = Date.now() - serializeStart;

    metrics = {
      rawSizeKb,
      simplifiedSizeKb,
      rawNodeCount,
      simplifiedNodeCount: measured.simplifiedNodeCount,
      maxDepth: measured.maxDepth,
      namedStyleCount,
      componentCount: measured.componentCount,
      instanceCount: measured.instanceCount,
      textNodeCount: measured.textNodeCount,
      imageNodeCount: measured.imageNodeCount,
      componentPropertyCount: measured.componentPropertyCount,
      hasVariables,
      fetchMs,
      simplifyMs,
      serializeMs,
    };
    // Failures throw before this point, so an error response is never stored.
    if (cache && cacheKey) {
      cache.set(cacheKey, { formatted, metrics });
    }
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
          cacheHit,
          cacheAgeMs,
        });
      } catch {
        // intentionally empty
      }
    }
  }
}
