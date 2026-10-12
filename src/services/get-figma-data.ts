import {
  readRestDesign,
  type RestDesignRequest,
  type RestDesignSource,
  type RestReadPhase,
} from "~/adapters/rest/read-rest-design.js";
import { writeLogs } from "~/utils/logger.js";
import { serializeResult, type OutputFormat } from "~/utils/serialize.js";
import { wrapForSerialization } from "~/utils/serializable-design.js";
import { runTaggedPhase, type PhaseHooks } from "~/utils/error-meta.js";
import {
  type GetFigmaDataMetrics,
  measureSimplifiedDesign,
  countNamedStyles,
  detectVariables,
} from "~/services/get-figma-data-metrics.js";

export type { GetFigmaDataMetrics } from "~/services/get-figma-data-metrics.js";

export type GetFigmaDataInput = RestDesignRequest;

export type GetFigmaDataResult = {
  formatted: string;
  metrics: GetFigmaDataMetrics;
};

export type GetFigmaDataOutcome = {
  input: GetFigmaDataInput;
  outputFormat: OutputFormat;
  durationMs: number;
  metrics?: GetFigmaDataMetrics;
  error?: unknown;
};

/**
 * Live progress reader exposed to the simplify phase so callers can render
 * heartbeats showing real-time node counts. Closes over the per-call counter
 * the walker is incrementing — no module-global state involved.
 */
export type SimplifyProgress = {
  getNodeCount: () => number;
};

export type GetFigmaDataPhase = RestReadPhase | "serialize";

export type GetFigmaDataHooks = {
  onPhaseStart?: (phase: GetFigmaDataPhase, progress: SimplifyProgress) => void | Promise<void>;
  onPhaseEnd?: (phase: GetFigmaDataPhase) => void | Promise<void>;
  /**
   * Fires exactly once per call, after the pipeline completes (success or
   * failure). Lets shells observe outcomes without embedding telemetry
   * bookkeeping in the core. Observer errors are swallowed silently — a
   * broken observer must never break the pipeline.
   */
  onComplete?: (outcome: GetFigmaDataOutcome) => void;
};

/**
 * "Get figma data": the composed REST read, then metrics and serialization.
 * Used by both the MCP `get_figma_data` tool and the `fetch` CLI command, which
 * differ only in how they wrap this pipeline (progress notifications vs. plain
 * stdout) and how they report errors (MCP envelope vs. process exit).
 *
 * Hooks are optional — the MCP tool uses them to drive progress heartbeats; the
 * CLI passes none.
 */
export async function getFigmaData(
  source: RestDesignSource,
  input: GetFigmaDataInput,
  outputFormat: OutputFormat,
  hooks: GetFigmaDataHooks = {},
): Promise<GetFigmaDataResult> {
  const startedAt = Date.now();
  let metrics: GetFigmaDataMetrics | undefined;
  let caughtError: unknown;
  // Per-call counter shared with the walker. Lives in the call closure so
  // overlapping HTTP requests each have their own — no module-global state.
  const nodeCounter = { count: 0 };
  const progress: SimplifyProgress = { getNodeCount: () => nodeCounter.count };
  const phaseHooks: PhaseHooks<GetFigmaDataPhase> = {
    onPhaseStart: (phase) => hooks.onPhaseStart?.(phase, progress),
    onPhaseEnd: hooks.onPhaseEnd,
  };

  try {
    const read = await readRestDesign(source, input, { nodeCounter, ...phaseHooks });
    const { design, response } = read;

    writeLogs("figma-simplified.json", design);

    const serializeTiming = { serializeMs: 0 };
    const formatted = await runTaggedPhase("serialize", phaseHooks, serializeTiming, () =>
      serializeResult(wrapForSerialization(design), outputFormat),
    );

    metrics = {
      rawSizeKb: read.rawSize / 1024,
      simplifiedSizeKb: Buffer.byteLength(formatted, "utf8") / 1024,
      rawNodeCount: nodeCounter.count,
      ...measureSimplifiedDesign(design),
      namedStyleCount: countNamedStyles(response),
      hasVariables: detectVariables(response),
      ...read.timings,
      ...serializeTiming,
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
