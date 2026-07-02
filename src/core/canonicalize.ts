import type { NodeSnapshot } from "./snapshot.js";
import type {
  ComponentDefinitionMap,
  ElementBody,
  ExtractorFn,
  GlobalVars,
  SimplifiedNode,
  TraversalOptions,
} from "./types.js";
import { extractFromDesign } from "./node-walker.js";
import { finalizeDesign } from "./finalize.js";
import { allExtractors } from "./built-in.js";
import { createInlineStyleSink, createRefStyleSink } from "./style-sink.js";

export interface CanonicalizeOptions extends TraversalOptions {
  /** Extractors to apply per node. Defaults to all built-ins. */
  extractors?: ExtractorFn[];
  /**
   * Opt into the egress compression pass: styles register under deduplicating
   * refs during the walk, then `finalize` count-gates hoisting and templates
   * repeated bodies. Off by default — expanded output emits every value inline
   * and never touches the content hash (Invariant 3).
   */
  compress?: boolean;
}

export interface CanonicalizeResult {
  nodes: SimplifiedNode[];
  /**
   * Hoisted styles. Compressed: shared + named styles under ref keys.
   * Expanded: always empty — every value (run deltas included) emits inline.
   */
  globalVars: GlobalVars;
  /** Deduplicated element bodies (compression only; empty when expanded). */
  elements: Record<string, ElementBody>;
  /** Property definitions from COMPONENT/COMPONENT_SET nodes in the tree. */
  componentDefinitions: ComponentDefinitionMap;
}

/**
 * The core entry: `NodeSnapshot`s in, canonical `SimplifiedNode`s out.
 *
 * One transform authority for every producer — the REST adapter feeds it
 * `restNodeToSnapshot` output, the plugin adapter feeds it
 * `sceneNodeToSnapshot` output — so the raw→CSS conversion can never fork.
 *
 * Deliberately async: the walker awaits an injected cooperative-yield
 * scheduler (`options.scheduler`) so the REST server can keep heartbeats and
 * SIGINT live on large files. Callers without that need (the plugin sandbox)
 * simply omit the scheduler and await the promise — QuickJS supports
 * microtasks; there is no sync variant to drift from.
 */
export async function canonicalize(
  snapshots: NodeSnapshot[],
  options: CanonicalizeOptions = {},
): Promise<CanonicalizeResult> {
  const { extractors = allExtractors, compress = false, ...traversal } = options;

  if (compress) {
    const sink = createRefStyleSink();
    const { nodes, componentDefs } = await extractFromDesign(
      snapshots,
      extractors,
      sink,
      traversal,
    );
    return {
      ...finalizeDesign(nodes, { styles: sink.styles }, sink.namedStyleKeys),
      componentDefinitions: componentDefs,
    };
  }

  const sink = createInlineStyleSink();
  const { nodes, componentDefs } = await extractFromDesign(snapshots, extractors, sink, traversal);
  return {
    nodes,
    globalVars: { styles: sink.styles },
    elements: {},
    componentDefinitions: componentDefs,
  };
}
