import { hasAutoLayout, isRectangleCornerRadii, isVisible } from "./utils.js";
import { buildSimplifiedLayout, computeGridChildOrder } from "./transformers/layout.js";
import { buildSimplifiedStrokes, flattenSolidFills, parsePaint } from "./transformers/style.js";
import { buildSimplifiedEffects } from "./transformers/effects.js";
import {
  buildFormattedText,
  extractTextStyle,
  hasTextStyle,
  isTextNode,
} from "./transformers/text.js";
import {
  simplifyComponentProperties,
  simplifyPropertyDefinitions,
  simplifyPropertyReferences,
} from "./transformers/component.js";
import { compressDesign } from "./compress.js";
import { createInlineStyleTable, createRefStyleTable } from "./style-table.js";
import type { NodeSnapshot } from "./snapshot.js";
import type {
  ComponentDefinitionMap,
  NodeCounter,
  SimplifiedNode,
  StyleTable,
  StyleValue,
  TemplateBody,
  TraversalOptions,
  WalkScheduler,
} from "./types.js";

export interface SimplifyOptions extends TraversalOptions {
  /**
   * Opt into the egress compression pass: styles intern under deduplicating
   * refs during the walk, then `compressDesign` count-gates hoisting and
   * templates repeated bodies. Off by default — expanded output emits every
   * value inline and never touches the content hash (Invariant 3).
   */
  compress?: boolean;
}

export interface SimplifyResult {
  nodes: SimplifiedNode[];
  /**
   * Hoisted styles. Compressed: shared + named styles under ref keys.
   * Expanded: always empty — every value (run deltas included) emits inline.
   */
  styles: Record<string, StyleValue>;
  /** Deduplicated node bodies (compression only; empty when expanded). */
  templates: Record<string, TemplateBody>;
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
 * Deliberately async: the walk awaits an injected cooperative-yield
 * scheduler (`options.scheduler`) so the REST server can keep heartbeats and
 * SIGINT live on large files. Callers without that need (the plugin sandbox)
 * simply omit the scheduler and await the promise — QuickJS supports
 * microtasks; there is no sync variant to drift from.
 */
export async function simplify(
  snapshots: NodeSnapshot[],
  options: SimplifyOptions = {},
): Promise<SimplifyResult> {
  const { compress = false, ...traversal } = options;

  if (compress) {
    const table = createRefStyleTable();
    const { nodes, componentDefs } = await walkNodes(snapshots, table, traversal);
    return {
      ...compressDesign(nodes, table.styles, table.namedStyleKeys),
      componentDefinitions: componentDefs,
    };
  }

  const table = createInlineStyleTable();
  const { nodes, componentDefs } = await walkNodes(snapshots, table, traversal);
  return {
    nodes,
    styles: table.styles,
    templates: {},
    componentDefinitions: componentDefs,
  };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** Walker state threaded through the recursion. */
interface SimplifyContext {
  /** Style-interning table — the compression seam (see StyleTable). */
  styles: StyleTable;
  /** Sink for COMPONENT/COMPONENT_SET property definitions found in the tree. */
  componentDefs: ComponentDefinitionMap;
  currentDepth: number;
  parent?: NodeSnapshot;
  insideComponentDefinition?: boolean;
  /**
   * Per-call mutable counter shared with the caller. Lives on the context so
   * the recursion can increment it without touching module-global state —
   * concurrent walks (e.g. overlapping HTTP requests) each own their counter
   * and never collide.
   */
  nodeCounter: NodeCounter;
}

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
 * the injected table (the compression seam). `simplify` is the public wrapper;
 * this seam is exported for tests that need to observe the pre-compression
 * walk output.
 *
 * @param nodes - The node snapshots to process
 * @param styleTable - Where style values are interned (the compression seam)
 * @param options - Traversal options (depth limit, scheduler, progress counter)
 * @returns Processed nodes plus the component definitions found during the walk
 */
export async function walkNodes(
  nodes: NodeSnapshot[],
  styleTable: StyleTable,
  options: TraversalOptions = {},
): Promise<{
  nodes: SimplifiedNode[];
  componentDefs: ComponentDefinitionMap;
}> {
  const context: SimplifyContext = {
    styles: styleTable,
    componentDefs: {},
    currentDepth: 0,
    nodeCounter: options.nodeCounter ?? { count: 0 },
  };

  const processedNodes: SimplifiedNode[] = [];
  for (const node of nodes) {
    if (!shouldProcessNode(node, context)) continue;
    processedNodes.push(await extractNode(node, context, options));
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
async function extractNode(
  node: NodeSnapshot,
  context: SimplifyContext,
  options: TraversalOptions,
): Promise<SimplifiedNode> {
  await maybeYield(context.nodeCounter, options.scheduler);

  const result: SimplifiedNode = {
    id: node.id,
    name: node.name,
    type: node.type === "VECTOR" ? "IMAGE-SVG" : node.type,
  };

  extractLayout(node, result, context);
  extractText(node, result, context);
  extractVisuals(node, result, context);
  extractComponent(node, result, context);

  // Handle children recursively, unless the depth limit cuts traversal here.
  const atDepthLimit = options.maxDepth !== undefined && context.currentDepth >= options.maxDepth;
  if (!atDepthLimit && node.children && node.children.length > 0) {
    const childContext: SimplifyContext = {
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
      children.push(await extractNode(child, childContext, options));
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
function shouldProcessNode(node: NodeSnapshot, context: SimplifyContext): boolean {
  if (isVisible(node)) return true;
  const hasVisibleRef =
    !!node.componentPropertyReferences && "visible" in node.componentPropertyReferences;
  return hasVisibleRef && !!context.insideComponentDefinition;
}

// ---------------------------------------------------------------------------
// The four domain extractions
// ---------------------------------------------------------------------------

/**
 * Extracts layout-related properties from a node: per-node geometry onto the
 * node top level (hybrid structure) and container config as the `layout` group.
 */
function extractLayout(node: NodeSnapshot, result: SimplifiedNode, context: SimplifyContext): void {
  const { layout, geometry } = buildSimplifiedLayout(node, context.parent);
  Object.assign(result, geometry);
  if (Object.keys(layout).length > 1) {
    // Layout can't be a Figma named style, so no style slots to check.
    result.layout = context.styles.intern(node, layout, [], "layout");
  }
}

/**
 * Extracts text content and text styling from a node.
 */
function extractText(node: NodeSnapshot, result: SimplifiedNode, context: SimplifyContext): void {
  // Extract text content — markdown for the common styled cases, `[text, style]`
  // run tuples for the arbitrary-style residual. Run deltas intern through the
  // ordinary style table (no special namespace), so the compression pass
  // count-gates them like every other style: single-use inlines, shared becomes
  // a ref. The wire override tables are already resolved into `node.text` by
  // the adapter.
  if (isTextNode(node)) {
    const rich = buildFormattedText(node, (delta) =>
      context.styles.intern(node, delta, [], "style"),
    );
    if (rich.text !== undefined) {
      result.text = rich.text;
    }
    if (rich.boldWeight !== undefined) {
      result.boldWeight = rich.boldWeight;
    }
  }

  // Extract text style
  if (hasTextStyle(node)) {
    const textStyle = extractTextStyle(node);
    if (textStyle) {
      result.textStyle = context.styles.intern(node, textStyle, ["text", "typography"], "style");
    }
  }
}

/**
 * Extracts visual appearance properties (fills, strokes, effects, opacity, border radius).
 */
function extractVisuals(
  node: NodeSnapshot,
  result: SimplifiedNode,
  context: SimplifyContext,
): void {
  // Check if node has children to determine CSS properties
  const hasChildren = !!node.children && node.children.length > 0;

  // fills
  if (node.fills && node.fills.length) {
    const visibleFills = node.fills.filter(isVisible);
    // An all-solid stack collapses to the single resolved color a viewer sees,
    // removing the layer-order ambiguity that misleads LLM consumers. Mixed
    // stacks (gradient/image/pattern or a non-normal blend) can't be folded and
    // fall back to the per-paint array, reversed into CSS top-first order.
    const flattened = flattenSolidFills(visibleFills);
    const fills = flattened
      ? [flattened]
      : visibleFills.map((fill) => parsePaint(fill, hasChildren)).reverse();
    result.fills = context.styles.intern(node, fills, ["fill", "fills"], "fill");
  }

  // strokes
  // Only the stroke color array is interned as a (potentially named) shared style.
  // Figma named styles only apply to paint, not to stroke width / dashes / per-side
  // weights, so those stay as plain sibling fields and are never deduplicated.
  const strokes = buildSimplifiedStrokes(node, hasChildren);
  if (strokes.colors.length) {
    result.strokes = context.styles.intern(node, strokes.colors, ["stroke", "strokes"], "fill");
    if (strokes.strokeWidth) result.strokeWidth = strokes.strokeWidth;
    if (strokes.strokeDashes) result.strokeDashes = strokes.strokeDashes;
    if (strokes.strokeAlign) result.strokeAlign = strokes.strokeAlign;
  }

  // effects
  const effects = buildSimplifiedEffects(node);
  if (Object.keys(effects).length) {
    result.effects = context.styles.intern(node, effects, ["effect", "effects"], "effect");
  }

  // opacity
  if (typeof node.opacity === "number" && node.opacity !== 1) {
    result.opacity = node.opacity;
  }

  // border radius — zero is the CSS default, so a literal cornerRadius: 0 (or
  // all-zero per-corner radii) is omitted rather than emitted as "0px".
  if (typeof node.cornerRadius === "number" && node.cornerRadius !== 0) {
    result.borderRadius = `${node.cornerRadius}px`;
  }
  if (
    isRectangleCornerRadii(node.rectangleCornerRadii) &&
    node.rectangleCornerRadii.some(Boolean)
  ) {
    result.borderRadius = `${node.rectangleCornerRadii[0]}px ${node.rectangleCornerRadii[1]}px ${node.rectangleCornerRadii[2]}px ${node.rectangleCornerRadii[3]}px`;
  }
}

/**
 * Extracts component-related properties from nodes.
 * Handles three cases: INSTANCE property values, property references on any node,
 * and property definitions on COMPONENT/COMPONENT_SET nodes.
 */
function extractComponent(
  node: NodeSnapshot,
  result: SimplifiedNode,
  context: SimplifyContext,
): void {
  // Instance nodes: componentId + simplified componentProperties
  if (node.type === "INSTANCE") {
    if (node.componentId) {
      result.componentId = node.componentId;
    }
    if (node.componentProperties) {
      const props = simplifyComponentProperties(node.componentProperties);
      if (Object.keys(props).length > 0) {
        result.componentProperties = props;
      }
    }
  }

  // Any node with property references: annotate with simplified refs
  if (node.componentPropertyReferences) {
    const refs = simplifyPropertyReferences(node.componentPropertyReferences);
    if (Object.keys(refs).length > 0) {
      result.componentPropertyReferences = refs;
    }
  }

  // Component/ComponentSet definitions: collect property definitions
  if (
    (node.type === "COMPONENT" || node.type === "COMPONENT_SET") &&
    node.componentPropertyDefinitions
  ) {
    const defs = simplifyPropertyDefinitions(node.componentPropertyDefinitions);
    if (Object.keys(defs).length > 0) {
      context.componentDefs[node.id] = defs;
    }
  }
}

// ---------------------------------------------------------------------------
// SVG container collapse
// ---------------------------------------------------------------------------

/**
 * Node types that can be exported as SVG images.
 * When a collapsible container holds only these types, the container can be flattened to
 * IMAGE-SVG. BOOLEAN_OPERATION is in both this set and the container set below because it's
 * both collapsible AND SVG-eligible as a child (boolean ops always produce vector output).
 *
 * Tightly coupled to the walk above, which renames VECTOR → IMAGE-SVG before this set is
 * consulted.
 */
const SVG_ELIGIBLE_TYPES = new Set([
  "IMAGE-SVG", // VECTOR nodes are converted to IMAGE-SVG, or containers that were collapsed
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "ELLIPSE",
  "REGULAR_POLYGON",
  "RECTANGLE",
]);

/** Container node types eligible to collapse into a single IMAGE-SVG. */
const COLLAPSIBLE_CONTAINER_TYPES = new Set(["FRAME", "GROUP", "INSTANCE", "BOOLEAN_OPERATION"]);

/**
 * Auto-layout signals authored structure — the spacing/arrangement of children is
 * intentional, so we normally preserve the container even when all its children are
 * SVG-eligible (charts, toolbars, layout test frames, swatch grids, tile mosaics).
 * Above this many children, though, we assume the container is a decorative pattern
 * (dotted backgrounds, noise grids) where the payload cost of preserving every leaf
 * outweighs the structural value, and we collapse anyway.
 *
 * Applies to both flex (HORIZONTAL/VERTICAL) and GRID auto-layout, since both signal
 * authored intent.
 *
 * Pivot point chosen empirically: real charts and structural displays rarely exceed ~10
 * primitives; decorative patterns typically have many dozens. Tune if real-world output
 * shows either category mis-classified.
 */
const SVG_COLLAPSE_AUTOLAYOUT_THRESHOLD = 10;

/**
 * Collapse SVG-heavy containers to IMAGE-SVG. Called by the walk after a
 * node's children are processed (bottom-up), so nested containers collapse
 * innermost-first.
 *
 * Collapses when:
 *   - container is a FRAME, GROUP, INSTANCE, or BOOLEAN_OPERATION
 *   - all children are SVG-eligible types
 *   - neither the node nor any direct child has an image fill
 *   - container is NOT auto-layout, OR child count is past the decorative-pattern threshold
 *
 * The auto-layout carve-out preserves authored layouts (bar charts, button rows, swatch
 * grids) that happen to bottom out in shape primitives. The count threshold reclaims
 * payload for decorative patterns built with auto-layout (e.g., grids of dots).
 *
 * @param node - Original Figma node
 * @param result - SimplifiedNode being built
 * @param children - Processed children
 * @returns Children to include (empty array if collapsed)
 */
function collapseSvgContainers(
  node: NodeSnapshot,
  result: SimplifiedNode,
  children: SimplifiedNode[],
): SimplifiedNode[] {
  if (!COLLAPSIBLE_CONTAINER_TYPES.has(node.type)) return children;
  // `type` is optional on SimplifiedNode only because post-walk template refs
  // drop it; mid-walk every child still has a type, so the `?? ""` is a
  // type-level concession that never matches at runtime.
  if (!children.every((child) => SVG_ELIGIBLE_TYPES.has(child.type ?? ""))) return children;
  if (hasImageFillOnSelfOrDirectChildren(node)) return children;

  if (hasAutoLayout(node) && children.length < SVG_COLLAPSE_AUTOLAYOUT_THRESHOLD) {
    return children;
  }

  result.type = "IMAGE-SVG";
  return [];
}

/**
 * Check whether a node or its direct children have image fills.
 *
 * Only direct children need checking because the collapse runs bottom-up:
 * if a deeper descendant has image fills, its parent won't collapse (stays FRAME),
 * and FRAME isn't SVG-eligible, so the chain breaks naturally at each level.
 */
function hasImageFillOnSelfOrDirectChildren(node: NodeSnapshot): boolean {
  if (node.fills?.some((fill) => fill.type === "IMAGE")) {
    return true;
  }
  if (node.children) {
    return node.children.some((child) => child.fills?.some((fill) => fill.type === "IMAGE"));
  }
  return false;
}
