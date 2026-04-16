import type {
  ExtractorFn,
  GlobalVars,
  StyleTypes,
  TraversalContext,
  SimplifiedNode,
} from "./types.js";
import { buildSimplifiedLayout } from "~/transformers/layout.js";
import { buildSimplifiedStrokes, parsePaint } from "~/transformers/style.js";
import { buildSimplifiedEffects } from "~/transformers/effects.js";
import {
  extractNodeText,
  extractTextStyle,
  hasTextStyle,
  isTextNode,
} from "~/transformers/text.js";
import {
  simplifyComponentProperties,
  simplifyPropertyDefinitions,
  simplifyPropertyReferences,
} from "~/transformers/component.js";
import { hasValue, isRectangleCornerRadii } from "~/utils/identity.js";
import { generateVarId, isVisible } from "~/utils/common.js";
import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";

// Reverse lookup cache: serialized style value → varId.
// Keyed on the GlobalVars instance so it's automatically scoped to each
// extraction run and garbage-collected when the run's context is released.
const styleCaches = new WeakMap<GlobalVars, Map<string, string>>();

function getStyleCache(globalVars: GlobalVars): Map<string, string> {
  let cache = styleCaches.get(globalVars);
  if (!cache) {
    cache = new Map();
    styleCaches.set(globalVars, cache);
  }
  return cache;
}

/**
 * Find an existing global style variable with the same value, or create one.
 */
function findOrCreateVar(globalVars: GlobalVars, value: StyleTypes, prefix: string): string {
  const cache = getStyleCache(globalVars);
  const key = JSON.stringify(value);

  const existing = cache.get(key);
  if (existing) return existing;

  const varId = generateVarId(prefix);
  globalVars.styles[varId] = value;
  cache.set(key, varId);
  return varId;
}

/**
 * Register a style value, preferring a Figma named style when available.
 * Falls back to an auto-generated deduplicating variable ID.
 */
function registerStyle(
  node: FigmaDocumentNode,
  context: TraversalContext,
  value: StyleTypes,
  styleKeys: string[],
  prefix: string,
): string {
  const styleMatch = getStyleMatch(node, context, styleKeys);
  if (styleMatch) {
    const styleKey = resolveStyleKey(context, styleMatch, value);
    context.globalVars.styles[styleKey] = value;
    return styleKey;
  }
  return findOrCreateVar(context.globalVars, value, prefix);
}

/**
 * Extracts layout-related properties from a node.
 */
export const layoutExtractor: ExtractorFn = (node, result, context) => {
  const layout = buildSimplifiedLayout(node, context.parent);
  if (Object.keys(layout).length > 1) {
    result.layout = findOrCreateVar(context.globalVars, layout, "layout");
  }
};

/**
 * Extracts text content and text styling from a node.
 */
export const textExtractor: ExtractorFn = (node, result, context) => {
  // Extract text content
  if (isTextNode(node)) {
    result.text = extractNodeText(node);
  }

  // Extract text style
  if (hasTextStyle(node)) {
    const textStyle = extractTextStyle(node);
    if (textStyle) {
      result.textStyle = registerStyle(node, context, textStyle, ["text", "typography"], "style");
    }
  }
};

/**
 * Extracts visual appearance properties (fills, strokes, effects, opacity, border radius).
 */
export const visualsExtractor: ExtractorFn = (node, result, context) => {
  // Check if node has children to determine CSS properties
  const hasChildren =
    hasValue("children", node) && Array.isArray(node.children) && node.children.length > 0;

  // fills
  if (hasValue("fills", node) && Array.isArray(node.fills) && node.fills.length) {
    const fills = node.fills
      .filter(isVisible)
      .map((fill) => parsePaint(fill, hasChildren))
      .reverse();
    result.fills = registerStyle(node, context, fills, ["fill", "fills"], "fill");
  }

  // strokes
  // Only the stroke color array is registered as a (potentially named) shared style.
  // Figma named styles only apply to paint, not to stroke width / dashes / per-side
  // weights, so those stay as plain sibling fields and are never deduplicated.
  const strokes = buildSimplifiedStrokes(node, hasChildren);
  if (strokes.colors.length) {
    result.strokes = registerStyle(node, context, strokes.colors, ["stroke", "strokes"], "fill");
    if (strokes.strokeWeight) result.strokeWeight = strokes.strokeWeight;
    if (strokes.strokeDashes) result.strokeDashes = strokes.strokeDashes;
    if (strokes.strokeWeights) result.strokeWeights = strokes.strokeWeights;
  }

  // effects
  const effects = buildSimplifiedEffects(node);
  if (Object.keys(effects).length) {
    result.effects = registerStyle(node, context, effects, ["effect", "effects"], "effect");
  }

  // opacity
  if (hasValue("opacity", node) && typeof node.opacity === "number" && node.opacity !== 1) {
    result.opacity = node.opacity;
  }

  // border radius
  if (hasValue("cornerRadius", node) && typeof node.cornerRadius === "number") {
    result.borderRadius = `${node.cornerRadius}px`;
  }
  if (hasValue("rectangleCornerRadii", node, isRectangleCornerRadii)) {
    result.borderRadius = `${node.rectangleCornerRadii[0]}px ${node.rectangleCornerRadii[1]}px ${node.rectangleCornerRadii[2]}px ${node.rectangleCornerRadii[3]}px`;
  }
};

/**
 * Extracts component-related properties from nodes.
 * Handles three cases: INSTANCE property values, property references on any node,
 * and property definitions on COMPONENT/COMPONENT_SET nodes.
 */
export const componentExtractor: ExtractorFn = (node, result, context) => {
  // Instance nodes: componentId + simplified componentProperties
  if (node.type === "INSTANCE") {
    if (hasValue("componentId", node)) {
      result.componentId = node.componentId;
    }
    if (hasValue("componentProperties", node)) {
      const props = simplifyComponentProperties(
        node.componentProperties as Record<string, { type: string; value: boolean | string }>,
      );
      if (Object.keys(props).length > 0) {
        result.componentProperties = props;
      }
    }
  }

  // Any node with property references: annotate with simplified refs
  if (
    "componentPropertyReferences" in node &&
    node.componentPropertyReferences &&
    typeof node.componentPropertyReferences === "object"
  ) {
    const refs = simplifyPropertyReferences(
      node.componentPropertyReferences as Record<string, string>,
    );
    if (Object.keys(refs).length > 0) {
      result.componentPropertyReferences = refs;
    }
  }

  // Component/ComponentSet definitions: collect property definitions
  if (
    (node.type === "COMPONENT" || node.type === "COMPONENT_SET") &&
    "componentPropertyDefinitions" in node &&
    node.componentPropertyDefinitions &&
    typeof node.componentPropertyDefinitions === "object"
  ) {
    const defs = simplifyPropertyDefinitions(
      node.componentPropertyDefinitions as Record<
        string,
        { type: string; defaultValue: boolean | string }
      >,
    );
    if (Object.keys(defs).length > 0) {
      context.traversalState.componentPropertyDefinitions[node.id] = defs;
    }
  }
};

type StyleMatch = { name: string; id: string };

// Helper to fetch a Figma style name for specific style keys on a node
function getStyleMatch(
  node: FigmaDocumentNode,
  context: TraversalContext,
  keys: string[],
): StyleMatch | undefined {
  if (!hasValue("styles", node)) return undefined;
  const styleMap = node.styles as Record<string, string>;
  for (const key of keys) {
    const styleId = styleMap[key];
    if (styleId) {
      const meta = context.extraStyles?.[styleId];
      if (meta?.name) return { name: meta.name, id: styleId };
    }
  }
  return undefined;
}

// Figma style names aren't unique — a file can use a local style and an imported
// library style that share a name (e.g., "Heading / Large"). Collapse same-name
// same-value entries; disambiguate same-name different-value by appending the id.
function resolveStyleKey(
  context: TraversalContext,
  styleMatch: StyleMatch,
  value: StyleTypes,
): string {
  const existing = context.globalVars.styles[styleMatch.name];
  if (!existing) return styleMatch.name;
  if (JSON.stringify(existing) === JSON.stringify(value)) return styleMatch.name;

  return `${styleMatch.name} (${styleMatch.id})`;
}

// -------------------- CONVENIENCE COMBINATIONS --------------------

/**
 * All extractors - replicates the current parseNode behavior.
 */
export const allExtractors = [layoutExtractor, textExtractor, visualsExtractor, componentExtractor];

/**
 * Layout and text only - useful for content analysis and layout planning.
 */
export const layoutAndText = [layoutExtractor, textExtractor];

/**
 * Text content only - useful for content audits and copy extraction.
 */
export const contentOnly = [textExtractor];

/**
 * Visuals only - useful for design system analysis and style extraction.
 */
export const visualsOnly = [visualsExtractor];

/**
 * Layout only - useful for structure analysis.
 */
export const layoutOnly = [layoutExtractor];

// -------------------- AFTER CHILDREN HELPERS --------------------

/**
 * Node types that can be exported as SVG images.
 * When a FRAME, GROUP, INSTANCE, or BOOLEAN_OPERATION contains only these types, we can collapse
 * it to IMAGE-SVG. BOOLEAN_OPERATION is included because it's both a collapsible container AND
 * SVG-eligible as a child (boolean ops always produce vector output).
 */
export const SVG_ELIGIBLE_TYPES = new Set([
  "IMAGE-SVG", // VECTOR nodes are converted to IMAGE-SVG, or containers that were collapsed
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "ELLIPSE",
  "REGULAR_POLYGON",
  "RECTANGLE",
]);

/**
 * afterChildren callback that collapses SVG-heavy containers to IMAGE-SVG.
 *
 * If a FRAME, GROUP, INSTANCE, or BOOLEAN_OPERATION contains only SVG-eligible children, the parent
 * is marked as IMAGE-SVG and children are omitted, reducing payload size.
 *
 * @param node - Original Figma node
 * @param result - SimplifiedNode being built
 * @param children - Processed children
 * @returns Children to include (empty array if collapsed)
 */
export function collapseSvgContainers(
  node: FigmaDocumentNode,
  result: SimplifiedNode,
  children: SimplifiedNode[],
): SimplifiedNode[] {
  const allChildrenAreSvgEligible = children.every((child) => SVG_ELIGIBLE_TYPES.has(child.type));

  if (
    (node.type === "FRAME" ||
      node.type === "GROUP" ||
      node.type === "INSTANCE" ||
      node.type === "BOOLEAN_OPERATION") &&
    allChildrenAreSvgEligible &&
    !hasImageFillInChildren(node)
  ) {
    // Collapse to IMAGE-SVG and omit children
    result.type = "IMAGE-SVG";
    return [];
  }

  // Include all children normally
  return children;
}

/**
 * Check whether a node or its direct children have image fills.
 *
 * Only direct children need checking because afterChildren runs bottom-up:
 * if a deeper descendant has image fills, its parent won't collapse (stays FRAME),
 * and FRAME isn't SVG-eligible, so the chain breaks naturally at each level.
 */
function hasImageFillInChildren(node: FigmaDocumentNode): boolean {
  if (hasValue("fills", node) && node.fills.some((fill) => fill.type === "IMAGE")) {
    return true;
  }
  if (hasValue("children", node)) {
    return node.children.some(
      (child) => hasValue("fills", child) && child.fills.some((fill) => fill.type === "IMAGE"),
    );
  }
  return false;
}
