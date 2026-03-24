import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";
import { isVisible } from "~/utils/common.js";
import { hasValue } from "~/utils/identity.js";
import type {
  ExtractorFn,
  TraversalContext,
  TraversalOptions,
  GlobalVars,
  SimplifiedNode,
} from "./types.js";

// Yield the event loop every N nodes so heartbeats, SIGINT, and
// other async work can run during large file processing.
const YIELD_INTERVAL = 500;
let nodesProcessed = 0;

async function maybeYield(): Promise<void> {
  nodesProcessed++;
  if (nodesProcessed % YIELD_INTERVAL === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Extract data from Figma nodes using a flexible, single-pass approach.
 *
 * @param nodes - The Figma nodes to process
 * @param extractors - Array of extractor functions to apply during traversal
 * @param options - Traversal options (filtering, depth limits, etc.)
 * @param globalVars - Global variables for style deduplication
 * @returns Object containing processed nodes and updated global variables
 */
export async function extractFromDesign(
  nodes: FigmaDocumentNode[],
  extractors: ExtractorFn[],
  options: TraversalOptions = {},
  globalVars: GlobalVars = { styles: {} },
): Promise<{ nodes: SimplifiedNode[]; globalVars: GlobalVars }> {
  const context: TraversalContext = {
    globalVars,
    currentDepth: 0,
  };

  nodesProcessed = 0;

  const processedNodes: SimplifiedNode[] = [];
  for (const node of nodes) {
    if (!shouldProcessNode(node, options)) continue;
    const result = await processNodeWithExtractors(node, extractors, context, options);
    if (result !== null) processedNodes.push(result);
  }

  return {
    nodes: processedNodes,
    globalVars: context.globalVars,
  };
}

/**
 * Process a single node with all provided extractors in one pass.
 */
async function processNodeWithExtractors(
  node: FigmaDocumentNode,
  extractors: ExtractorFn[],
  context: TraversalContext,
  options: TraversalOptions,
): Promise<SimplifiedNode | null> {
  if (!shouldProcessNode(node, options)) {
    return null;
  }

  await maybeYield();

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
    const childContext: TraversalContext = {
      ...context,
      currentDepth: context.currentDepth + 1,
      parent: node,
    };

    // Use the same pattern as the existing parseNode function
    if (hasValue("children", node) && node.children.length > 0) {
      const children: SimplifiedNode[] = [];
      for (const child of node.children) {
        if (!shouldProcessNode(child, options)) continue;
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
function shouldProcessNode(node: FigmaDocumentNode, options: TraversalOptions): boolean {
  // Skip invisible nodes
  if (!isVisible(node)) {
    return false;
  }

  // Apply custom node filter if provided
  if (options.nodeFilter && !options.nodeFilter(node)) {
    return false;
  }

  return true;
}

/**
 * Determine if we should traverse into a node's children.
 */
function shouldTraverseChildren(
  node: FigmaDocumentNode,
  context: TraversalContext,
  options: TraversalOptions,
): boolean {
  // Check depth limit
  if (options.maxDepth !== undefined && context.currentDepth >= options.maxDepth) {
    return false;
  }

  return true;
}
