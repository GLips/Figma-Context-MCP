import type { ExtractorFn, GlobalVars, StyleTypes, TraversalContext } from "./types.js";
import { buildSimplifiedLayout } from "~/transformers/layout.js";
import { buildSimplifiedStrokes, parsePaint } from "~/transformers/style.js";
import { buildSimplifiedEffects } from "~/transformers/effects.js";
import {
  extractNodeText,
  extractTextStyle,
  hasTextStyle,
  isTextNode,
} from "~/transformers/text.js";
import { hasValue, isRectangleCornerRadii } from "~/utils/identity.js";
import { generateVarId } from "~/utils/common.js";
import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";

/**
 * Helper function to find or create a global variable.
 */
function findOrCreateVar(globalVars: GlobalVars, value: StyleTypes, prefix: string): string {
  // Check if the same value already exists
  const [existingVarId] =
    Object.entries(globalVars.styles).find(
      ([_, existingValue]) => JSON.stringify(existingValue) === JSON.stringify(value),
    ) ?? [];

  if (existingVarId) {
    return existingVarId;
  }

  // Create a new variable if it doesn't exist
  const varId = generateVarId(prefix);
  globalVars.styles[varId] = value;
  return varId;
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
      // Prefer Figma named style when available
      const styleName = getStyleName(node, context, ["text", "typography"]);
      if (styleName) {
        context.globalVars.styles[styleName] = textStyle;
        result.textStyle = styleName;
      } else {
        result.textStyle = findOrCreateVar(context.globalVars, textStyle, "style");
      }
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
    const fills = node.fills.map((fill) => parsePaint(fill, hasChildren)).reverse();
    const styleName = getStyleName(node, context, ["fill", "fills"]);
    if (styleName) {
      context.globalVars.styles[styleName] = fills;
      result.fills = styleName;
    } else {
      result.fills = findOrCreateVar(context.globalVars, fills, "fill");
    }
  }

  // strokes
  const strokes = buildSimplifiedStrokes(node, hasChildren);
  if (strokes.colors.length) {
    const styleName = getStyleName(node, context, ["stroke", "strokes"]);
    if (styleName) {
      // Only colors are stylable; keep other stroke props on the node
      context.globalVars.styles[styleName] = strokes.colors;
      result.strokes = styleName;
      if (strokes.strokeWeight) result.strokeWeight = strokes.strokeWeight;
      if (strokes.strokeDashes) result.strokeDashes = strokes.strokeDashes;
      if (strokes.strokeWeights) result.strokeWeights = strokes.strokeWeights;
    } else {
      result.strokes = findOrCreateVar(context.globalVars, strokes, "stroke");
    }
  }

  // effects
  const effects = buildSimplifiedEffects(node);
  if (Object.keys(effects).length) {
    const styleName = getStyleName(node, context, ["effect", "effects"]);
    if (styleName) {
      // Effects styles store only the effect values
      context.globalVars.styles[styleName] = effects;
      result.effects = styleName;
    } else {
      result.effects = findOrCreateVar(context.globalVars, effects, "effect");
    }
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
 * Extracts component-related properties from INSTANCE nodes.
 */
export const componentExtractor: ExtractorFn = (node, result, _context) => {
  if (node.type === "INSTANCE") {
    if (hasValue("componentId", node)) {
      result.componentId = node.componentId;
    }

    // Add specific properties for instances of components
    if (hasValue("componentProperties", node)) {
      result.componentProperties = Object.entries(node.componentProperties ?? {}).map(
        ([name, { value, type }]) => ({
          name,
          value: value.toString(),
          type,
        }),
      );
    }
  }
};

// Helper to fetch a Figma style name for specific style keys on a node
function getStyleName(
  node: FigmaDocumentNode,
  context: TraversalContext,
  keys: string[],
): string | undefined {
  if (!hasValue("styles", node)) return undefined;
  const styleMap = node.styles as Record<string, string>;
  for (const key of keys) {
    const styleId = styleMap[key];
    if (styleId) {
      const meta = context.globalVars.extraStyles?.[styleId];
      if (meta?.name) return meta.name;
    }
  }
  return undefined;
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
