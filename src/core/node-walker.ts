import { isVisible } from "~/core/utils.js";
import { computeGridChildOrder } from "~/core/transformers/layout.js";
import type { NodeSnapshot } from "./snapshot.js";
import type {
  CanonicalizeContext,
  ComponentDefinitionMap,
  ExtractorFn,
  NodeCounter,
  StyleSink,
  TraversalOptions,
  SimplifiedNode,
} from "./types.js";

// Await the injected scheduler every N nodes so heartbeats, SIGINT, and other
// async work can run during large file processing — when the caller supplies
// one. The core itself never touches the event loop (Invariant 4).
const YIELD_INTERVAL = 100;

async function maybeYield(counter: NodeCounter, options: TraversalOptions): Promise<void> {
  counter.count++;
  if (options.scheduler && counter.count % YIELD_INTERVAL === 0) {
    await options.scheduler();
  }
}

/**
 * Extract data from Figma nodes using a flexible, single-pass approach.
 *
 * @param nodes - The node snapshots to process
 * @param extractors - Array of extractor functions to apply during traversal
 * @param styleSink - Where extractors send style values (the compression seam)
 * @param options - Traversal options (filtering, depth limits, scheduler, etc.)
 * @returns Processed nodes plus the component definitions found during the walk
 */
export async function extractFromDesign(
  nodes: NodeSnapshot[],
  extractors: ExtractorFn[],
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
    if (!shouldProcessNode(node, context, options)) continue;
    const result = await processNodeWithExtractors(node, extractors, context, options);
    if (result !== null) processedNodes.push(result);
  }

  return {
    nodes: processedNodes,
    componentDefs: context.componentDefs,
  };
}

/**
 * Process a single node with all provided extractors in one pass.
 */
async function processNodeWithExtractors(
  node: NodeSnapshot,
  extractors: ExtractorFn[],
  context: CanonicalizeContext,
  options: TraversalOptions,
): Promise<SimplifiedNode | null> {
  if (!shouldProcessNode(node, context, options)) {
    return null;
  }

  await maybeYield(context.nodeCounter, options);

  // Always include base metadata
  const result: SimplifiedNode = {
    id: node.id,
    name: node.name,
    type: node.type === "VECTOR" ? "IMAGE-SVG" : node.type,
  };

  // Apply all extractors to this node in a single pass
  for (const extractor of extractors) {
    extractor(node, result, context);
  }

  // Handle children recursively
  if (shouldTraverseChildren(node, context, options)) {
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

    if (node.children && node.children.length > 0) {
      // Grid containers: emit children in grid-flow (anchor) order rather than
      // Figma's z-order, so CSS auto-placement lands them in the right cells.
      // See computeGridChildOrder for details.
      const order = computeGridChildOrder(node) ?? node.children.map((_, i) => i);
      const children: SimplifiedNode[] = [];
      for (const idx of order) {
        const child = node.children[idx];
        if (!shouldProcessNode(child, childContext, options)) continue;
        const processed = await processNodeWithExtractors(child, extractors, childContext, options);
        if (processed !== null) children.push(processed);
      }

      if (children.length > 0) {
        // Allow custom logic to modify parent and control which children to include
        const childrenToInclude = options.afterChildren
          ? options.afterChildren(node, result, children)
          : children;

        if (childrenToInclude.length > 0) {
          result.children = childrenToInclude;
        }
      }
    }
  }

  return result;
}

/**
 * Determine if a node should be processed based on filters.
 */
function shouldProcessNode(
  node: NodeSnapshot,
  context: CanonicalizeContext,
  options: TraversalOptions,
): boolean {
  if (!isVisible(node)) {
    // Rescue hidden nodes controlled by a boolean property inside component definitions
    const hasVisibleRef =
      !!node.componentPropertyReferences && "visible" in node.componentPropertyReferences;
    if (!(hasVisibleRef && context.insideComponentDefinition)) {
      return false;
    }
  }

  if (options.nodeFilter && !options.nodeFilter(node)) {
    return false;
  }

  return true;
}

/**
 * Determine if we should traverse into a node's children.
 */
function shouldTraverseChildren(
  _node: NodeSnapshot,
  context: CanonicalizeContext,
  options: TraversalOptions,
): boolean {
  // Check depth limit
  if (options.maxDepth !== undefined && context.currentDepth >= options.maxDepth) {
    return false;
  }

  return true;
}
