import type { GetFileResponse } from "@figma/rest-api-spec";
import { project, simplify, type NodeCounter, type SimplifiedDesign } from "@framelink/core";
import { compressDesign } from "@framelink/core/compress";
import type { FigmaService } from "~/services/figma.js";
import { tagError, type ErrorPhase } from "~/utils/error-meta.js";
import { fetchComponentDefinitions } from "./component-definitions.js";
import { parseRestResponse } from "./decode/response.js";
import { withGridSiblings } from "./grid-siblings.js";

/**
 * The Figma calls a REST read makes. A structural slice of `FigmaService`, so tests, benchmarks and
 * replays can serve a recorded response without a network client.
 */
export type RestDesignSource = Pick<
  FigmaService,
  "getRawFile" | "getRawNodeInContext" | "getRawNodes" | "getPublishedComponentSite"
>;

export interface RestDesignRequest {
  fileKey: string;
  nodeId?: string;
  depth?: number;
}

/** A read's stages, in order. Each is timed and tags the errors it throws. */
export type RestReadPhase = Extract<ErrorPhase, "fetch" | "decode" | "enrich" | "simplify">;

export interface RestReadOptions {
  /** Counts nodes as the walk visits them, for a caller's progress reports. */
  nodeCounter?: NodeCounter;
  onPhaseStart?: (phase: RestReadPhase) => void | Promise<void>;
  onPhaseEnd?: (phase: RestReadPhase) => void | Promise<void>;
}

export interface RestDesignRead {
  design: SimplifiedDesign;
  /** The primary response, as Figma sent it, and its size in bytes. */
  response: GetFileResponse;
  rawSize: number;
  timings: Record<`${RestReadPhase}Ms`, number>;
}

// Yield to the Node event loop between walk batches so progress heartbeats, SIGINT, and
// overlapping HTTP requests stay live during large files. Injected here — not hardcoded in the
// walk — because the core must stay free of Node builtins (Invariant 4).
const eventLoopYield = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The REST producer's one composed read: fetch, decode, enrich, simplify. Enrichment meets the
 * core's preconditions a single response can't — the real definitions of components the read
 * references but doesn't contain, and a GRID parent's full sibling list — and never fails the
 * read: each falls back to what the response alone gives.
 */
export async function readRestDesign(
  source: RestDesignSource,
  { fileKey, nodeId, depth }: RestDesignRequest,
  options: RestReadOptions = {},
): Promise<RestDesignRead> {
  const timings = { fetchMs: 0, decodeMs: 0, enrichMs: 0, simplifyMs: 0 };
  const phase = async <T>(name: RestReadPhase, run: () => Promise<T>): Promise<T> => {
    await options.onPhaseStart?.(name);
    const startedAt = Date.now();
    try {
      return await run();
    } catch (error) {
      tagError(error, { phase: name });
    } finally {
      timings[`${name}Ms`] = Date.now() - startedAt;
      await options.onPhaseEnd?.(name);
    }
  };

  const { data: response, rawSize } = await phase("fetch", () =>
    nodeId ? source.getRawNodeInContext(fileKey, nodeId) : source.getRawFile(fileKey, depth),
  );

  // Decoded once; discovery, the sibling fetch and the walk all read this.
  const parsed = await phase("decode", async () => parseRestResponse(response, nodeId));

  const [componentDefinitions, placement] = await phase("enrich", () =>
    Promise.all([
      fetchComponentDefinitions(source, fileKey, parsed, depth),
      withGridSiblings(source, fileKey, parsed.placement),
    ]),
  );

  const design = await phase("simplify", async (): Promise<SimplifiedDesign> => {
    const full = await simplify(parsed.snapshots, {
      componentDefinitions,
      placement,
      nodeCounter: options.nodeCounter,
      scheduler: eventLoopYield,
    });
    // The shipped REST output is compressed: shared styles hoisted, repeated bodies templated.
    const { nodes, styles, templates, components, elided } = compressDesign(
      project(full, { maxDepth: depth }),
    );
    return {
      name: parsed.name,
      nodes,
      components,
      styles,
      templates,
      ...(elided ? { elided } : {}),
    };
  });

  return { design, response, rawSize, timings };
}
