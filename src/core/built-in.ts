import type { CanonicalizeContext, SimplifiedNode } from "./types.js";
import { buildSimplifiedLayout } from "~/core/transformers/layout.js";
import {
  buildSimplifiedStrokes,
  flattenSolidFills,
  parsePaint,
} from "~/core/transformers/style.js";
import { buildSimplifiedEffects } from "~/core/transformers/effects.js";
import {
  buildFormattedText,
  extractTextStyle,
  hasTextStyle,
  isTextNode,
} from "~/core/transformers/text.js";
import {
  simplifyComponentProperties,
  simplifyPropertyDefinitions,
  simplifyPropertyReferences,
} from "~/core/transformers/component.js";
import { hasAutoLayout, isRectangleCornerRadii } from "~/core/identity.js";
import { isVisible } from "~/core/utils.js";
import type { NodeSnapshot } from "./snapshot.js";

/**
 * Extracts layout-related properties from a node: per-node geometry onto the
 * node top level (hybrid structure) and container config as the `layout` group.
 */
export function layoutExtractor(
  node: NodeSnapshot,
  result: SimplifiedNode,
  context: CanonicalizeContext,
): void {
  const { layout, geometry } = buildSimplifiedLayout(node, context.parent);
  Object.assign(result, geometry);
  if (Object.keys(layout).length > 1) {
    // Layout can't be a Figma named style, so no style slots to check.
    result.layout = context.styles.register(node, layout, [], "layout");
  }
}

/**
 * Extracts text content and text styling from a node.
 */
export function textExtractor(
  node: NodeSnapshot,
  result: SimplifiedNode,
  context: CanonicalizeContext,
): void {
  // Extract text content — markdown for the common styled cases, `[text, style]`
  // run tuples for the arbitrary-style residual. Run deltas register through the
  // ordinary style sink (no special namespace), so the finalize pass count-gates
  // them like every other style: single-use inlines, shared becomes a ref. The
  // wire override tables are already resolved into `node.text` by the adapter.
  if (isTextNode(node)) {
    const rich = buildFormattedText(node, (delta) =>
      context.styles.register(node, delta, [], "style"),
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
      result.textStyle = context.styles.register(node, textStyle, ["text", "typography"], "style");
    }
  }
}

/**
 * Extracts visual appearance properties (fills, strokes, effects, opacity, border radius).
 */
export function visualsExtractor(
  node: NodeSnapshot,
  result: SimplifiedNode,
  context: CanonicalizeContext,
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
    result.fills = context.styles.register(node, fills, ["fill", "fills"], "fill");
  }

  // strokes
  // Only the stroke color array is registered as a (potentially named) shared style.
  // Figma named styles only apply to paint, not to stroke width / dashes / per-side
  // weights, so those stay as plain sibling fields and are never deduplicated.
  const strokes = buildSimplifiedStrokes(node, hasChildren);
  if (strokes.colors.length) {
    result.strokes = context.styles.register(node, strokes.colors, ["stroke", "strokes"], "fill");
    if (strokes.strokeWidth) result.strokeWidth = strokes.strokeWidth;
    if (strokes.strokeDashes) result.strokeDashes = strokes.strokeDashes;
    if (strokes.strokeAlign) result.strokeAlign = strokes.strokeAlign;
  }

  // effects
  const effects = buildSimplifiedEffects(node);
  if (Object.keys(effects).length) {
    result.effects = context.styles.register(node, effects, ["effect", "effects"], "effect");
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
export function componentExtractor(
  node: NodeSnapshot,
  result: SimplifiedNode,
  context: CanonicalizeContext,
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

// -------------------- SVG CONTAINER COLLAPSE --------------------

/**
 * Node types that can be exported as SVG images.
 * When a collapsible container holds only these types, the container can be flattened to
 * IMAGE-SVG. BOOLEAN_OPERATION is in both this set and the container set below because it's
 * both collapsible AND SVG-eligible as a child (boolean ops always produce vector output).
 *
 * Tightly coupled to node-walker.ts, which renames VECTOR → IMAGE-SVG before this set is consulted.
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
 * Collapse SVG-heavy containers to IMAGE-SVG. Called by the walker after a
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
export function collapseSvgContainers(
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
