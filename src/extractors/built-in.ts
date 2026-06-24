import type {
  ExtractorFn,
  GlobalVars,
  StyleTypes,
  TraversalContext,
  SimplifiedNode,
} from "./types.js";
import { buildSimplifiedLayout } from "~/transformers/layout.js";
import { buildSimplifiedStrokes, flattenSolidFills, parsePaint } from "~/transformers/style.js";
import { buildSimplifiedEffects } from "~/transformers/effects.js";
import {
  buildFormattedText,
  extractTextStyle,
  hasTextStyle,
  isTextNode,
  type SimplifiedTextStyle,
} from "~/transformers/text.js";
import {
  simplifyComponentProperties,
  simplifyPropertyDefinitions,
  simplifyPropertyReferences,
} from "~/transformers/component.js";
import { hasAutoLayout, hasValue, isRectangleCornerRadii } from "~/utils/identity.js";
import { isVisible, stableStringify } from "~/utils/common.js";
import { createHash } from "node:crypto";
import type { Node as FigmaDocumentNode } from "@figma/rest-api-spec";

// Reverse lookup cache: serialized style value → varId.
// Keyed on the GlobalVars instance so it's automatically scoped to each
// extraction run and garbage-collected when the run's context is released.
const styleCaches = new WeakMap<GlobalVars, Map<string, string>>();

// Separate cache for inline text-style override refs. Kept distinct from
// `styleCaches` so the `ts` namespace never aliases with `style_*`, `fill_*`,
// etc. — a base textStyle that happens to serialize identically to an inline
// delta would otherwise return the wrong prefix, bleeding `style_XXXXXX` IDs
// into the middle of `text` strings and vice versa.
const inlineTextStyleCaches = new WeakMap<GlobalVars, Map<string, string>>();

function getStyleCache(globalVars: GlobalVars): Map<string, string> {
  let cache = styleCaches.get(globalVars);
  if (!cache) {
    cache = new Map();
    styleCaches.set(globalVars, cache);
  }
  return cache;
}

function getInlineTextStyleCache(globalVars: GlobalVars): Map<string, string> {
  let cache = inlineTextStyleCaches.get(globalVars);
  if (!cache) {
    cache = new Map();
    inlineTextStyleCaches.set(globalVars, cache);
  }
  return cache;
}

/**
 * Find an existing global style variable with the same value, or create one.
 */
function findOrCreateVar(globalVars: GlobalVars, value: StyleTypes, prefix: string): string {
  const cache = getStyleCache(globalVars);
  const key = stableStringify(value);

  const existing = cache.get(key);
  if (existing) return existing;

  // Content-addressed id so the same value yields the same id across runs, making
  // output byte-stable (the value→id cache already dedups within a single run).
  const fullHash = createHash("sha1").update(key).digest("hex");

  // Truncated-hash collision guard. The 8-hex slice (32 bits) keeps refs short but
  // can alias two different style values. We reached here on a cache miss, so a
  // taken slot means a genuine collision — reusing the id would overwrite the
  // other value and every node referencing it would silently resolve to the wrong
  // style. Lengthen this value's id until the slot is free. Deterministic because
  // the walk order is stable, so the same file reproduces the same ids.
  let length = 8;
  let varId = `${prefix}_${fullHash.slice(0, length)}`;
  while (globalVars.styles[varId] !== undefined && length < fullHash.length) {
    length += 4;
    varId = `${prefix}_${fullHash.slice(0, length)}`;
  }

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
    // Mark as a named style so the finalize pass keeps it hoisted even if only
    // one node uses it — a named Figma style is design-system intent, not noise.
    context.traversalState.namedStyleKeys.add(styleKey);
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
 * Register an inline text-style override delta and return its short ID
 * (`ts1`, `ts2`, …). Unlike `registerStyle`, these IDs come from a sequential
 * counter on the traversal state — they appear inline in formatted text
 * (`{ts1}…{/ts1}`), where short IDs matter for token efficiency and readability.
 *
 * Uses its own dedup cache (`inlineTextStyleCaches`), separate from the
 * generic `styleCaches`. The two namespaces must not alias: if a base
 * textStyle serializes identically to an inline delta, the inline caller must
 * still get a `tsN` ID, not a `style_XXXXXX` ID that happens to be cached.
 */
function registerInlineTextStyle(context: TraversalContext, delta: SimplifiedTextStyle): string {
  const cache = getInlineTextStyleCache(context.globalVars);
  const key = stableStringify(delta);
  const existing = cache.get(key);
  if (existing) return existing;
  context.traversalState.tsCounter += 1;
  const id = `ts${context.traversalState.tsCounter}`;
  context.globalVars.styles[id] = delta;
  cache.set(key, id);
  return id;
}

/**
 * Extracts text content and text styling from a node.
 */
export const textExtractor: ExtractorFn = (node, result, context) => {
  // Extract text content — formatted with markdown + inline style refs when
  // the node has per-character overrides, otherwise just the raw string.
  if (isTextNode(node)) {
    const rich = buildFormattedText(node, (delta) => registerInlineTextStyle(context, delta));
    if (rich.text) {
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
    const visibleFills = node.fills.filter(isVisible);
    // An all-solid stack collapses to the single resolved color a viewer sees,
    // removing the layer-order ambiguity that misleads LLM consumers. Mixed
    // stacks (gradient/image/pattern or a non-normal blend) can't be folded and
    // fall back to the per-paint array, reversed into CSS top-first order.
    const flattened = flattenSolidFills(visibleFills);
    const fills = flattened
      ? [flattened]
      : visibleFills.map((fill) => parsePaint(fill, hasChildren)).reverse();
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
    if (strokes.strokeAlign) result.strokeAlign = strokes.strokeAlign;
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
  if (stableStringify(existing) === stableStringify(value)) return styleMatch.name;

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
 * When a collapsible container holds only these types, the container can be flattened to
 * IMAGE-SVG. BOOLEAN_OPERATION is in both this set and the container set below because it's
 * both collapsible AND SVG-eligible as a child (boolean ops always produce vector output).
 *
 * Tightly coupled to node-walker.ts, which renames VECTOR → IMAGE-SVG before this set is consulted.
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
 * afterChildren callback that collapses SVG-heavy containers to IMAGE-SVG.
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
  node: FigmaDocumentNode,
  result: SimplifiedNode,
  children: SimplifiedNode[],
): SimplifiedNode[] {
  if (!COLLAPSIBLE_CONTAINER_TYPES.has(node.type)) return children;
  // `type` is optional on SimplifiedNode only because post-walk template refs
  // drop it; at afterChildren time (mid-walk) every child still has a type, so
  // the `?? ""` is a type-level concession that never matches at runtime.
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
 * Only direct children need checking because afterChildren runs bottom-up:
 * if a deeper descendant has image fills, its parent won't collapse (stays FRAME),
 * and FRAME isn't SVG-eligible, so the chain breaks naturally at each level.
 */
function hasImageFillOnSelfOrDirectChildren(node: FigmaDocumentNode): boolean {
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
