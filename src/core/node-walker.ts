import { isVisible } from "~/core/utils.js";
import { computeGridChildOrder } from "~/core/transformers/layout.js";
import type { NodeSnapshot } from "./snapshot.js";
import {
  layoutExtractor,
  textExtractor,
  visualsExtractor,
  componentExtractor,
  collapseSvgContainers,
} from "./built-in.js";
import type {
  CanonicalizeContext,
  ComponentDefinitionMap,
  NodeCounter,
  StyleSink,
  TraversalOptions,
  SimplifiedNode,
  WalkScheduler,
} from "./types.js";

// Await the injected scheduler every N nodes so heartbeats, SIGINT, and other
// async work can run during large file processing — when the caller supplies
// one. The core itself never touches the event loop (Invariant 4).
const YIELD_INTERVAL = 100;

async function maybeYield(
  counter: NodeCounter,
  scheduler: WalkScheduler | undefined,
): Promise<void> {
  counter.count++;
  if (scheduler && counter.count % YIELD_INTERVAL === 0) {
    await scheduler();
  }
}

/**
 * The single-pass walk: geometry/layout, text, visuals, and component data are
 * extracted from every visible node, depth-first, writing style values through
 * the injected sink (the compression seam).
 *
 * @param nodes - The node snapshots to process
 * @param styleSink - Where style values are sent (the compression seam)
 * @param options - Traversal options (depth limit, scheduler, progress counter)
 * @returns Processed nodes plus the component definitions found during the walk
 */
export async function extractFromDesign(
  nodes: NodeSnapshot[],
  styleSink: StyleSink,
  options: TraversalOptions = {},
): Promise<{
  nodes: SimplifiedNode[];
  componentDefs: ComponentDefinitionMap;
}> {
  const context: CanonicalizeContext = {
    styles: styleSink,
    componentDefs: {},
    currentDepth: 0,
    nodeCounter: options.nodeCounter ?? { count: 0 },
  };

  const processedNodes: SimplifiedNode[] = [];
  for (const node of nodes) {
    if (!shouldProcessNode(node, context)) continue;
    processedNodes.push(await processNode(node, context, options));
  }

  return {
    nodes: processedNodes,
    componentDefs: context.componentDefs,
  };
}

/**
 * Extract one node: base metadata, then the four domain extractions in
 * sequence, then children.
 */
async function processNode(
  node: NodeSnapshot,
  context: CanonicalizeContext,
  options: TraversalOptions,
): Promise<SimplifiedNode> {
  await maybeYield(context.nodeCounter, options.scheduler);

  const result: SimplifiedNode = {
    id: node.id,
    name: node.name,
    type: node.type === "VECTOR" ? "IMAGE-SVG" : node.type,
  };

  layoutExtractor(node, result, context);
  textExtractor(node, result, context);
  visualsExtractor(node, result, context);
  componentExtractor(node, result, context);

  // Handle children recursively, unless the depth limit cuts traversal here.
  const atDepthLimit = options.maxDepth !== undefined && context.currentDepth >= options.maxDepth;
  if (!atDepthLimit && node.children && node.children.length > 0) {
    const childContext: CanonicalizeContext = {
      ...context,
      currentDepth: context.currentDepth + 1,
      parent: node,
      // COMPONENT nodes define properties; INSTANCE nodes resolve them
      insideComponentDefinition:
        node.type === "COMPONENT" || node.type === "COMPONENT_SET"
          ? true
          : node.type === "INSTANCE"
            ? false
            : context.insideComponentDefinition,
    };

    // Grid containers: emit children in grid-flow (anchor) order rather than
    // Figma's z-order, so CSS auto-placement lands them in the right cells.
    // See computeGridChildOrder for details.
    const order = computeGridChildOrder(node) ?? node.children.map((_, i) => i);
    const children: SimplifiedNode[] = [];
    for (const idx of order) {
      const child = node.children[idx];
      if (!shouldProcessNode(child, childContext)) continue;
      children.push(await processNode(child, childContext, options));
    }

    if (children.length > 0) {
      // Runs bottom-up (children already processed), so nested SVG containers
      // collapse innermost-first.
      const childrenToInclude = collapseSvgContainers(node, result, children);
      if (childrenToInclude.length > 0) {
        result.children = childrenToInclude;
      }
    }
  }

  return result;
}

/**
 * Determine if a node should be processed: visible nodes only, except hidden
 * nodes controlled by a boolean property inside component definitions.
 */
function shouldProcessNode(node: NodeSnapshot, context: CanonicalizeContext): boolean {
  if (isVisible(node)) return true;
  const hasVisibleRef =
    !!node.componentPropertyReferences && "visible" in node.componentPropertyReferences;
  return hasVisibleRef && !!context.insideComponentDefinition;
}
