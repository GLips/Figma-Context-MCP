import type { Node as FigmaDocumentNode, Paint, Effect, Style } from "@figma/rest-api-spec";
import type { NodeSnapshot, SnapshotStyleRef } from "~/core/snapshot.js";
import { decodePaints, decodeEffect } from "./paint.js";
import { decodeText } from "./text.js";

/**
 * The ~1:1 structural fields carried from a REST node onto the snapshot. The
 * REST node union doesn't expose these uniformly (they exist only on some node
 * types), so the adapter reads them off a single permissive view — this is the
 * one place allowed to know the wire shape (Invariant 2). Value types match
 * `NodeSnapshot`'s because the snapshot was designed as a structural subset of
 * the Figma node for exactly these fields.
 */
type RawStructuralFields = Partial<
  Omit<
    NodeSnapshot,
    "id" | "name" | "type" | "fills" | "strokes" | "effects" | "children" | "text" | "styles"
  >
>;

/**
 * REST adapter: decode a raw Figma REST node into a plan-neutral `NodeSnapshot`
 * for `canonicalize`. This is where every REST-specific structure is unpacked
 * (top-level tables, `imageRef`, override tables, `gradientHandlePositions`,
 * `node.styles` lookups) so none of it reaches the core (Invariant 2).
 *
 * The snapshot is constructed field-by-field against the declared contract —
 * deliberately NOT a `{...node}` spread — so undeclared raw REST fields cannot
 * ride through at runtime. The seam is value-clean, not just import-clean: a
 * core change that starts reading a field the contract doesn't declare sees
 * `undefined` here and fails its tests, instead of silently coupling to the
 * REST wire shape through a spread.
 *
 * The whole subtree is decoded eagerly: children are mapped recursively so the
 * walker only ever sees decoded snapshots and never reaches back into REST
 * shapes.
 */
export function restNodeToSnapshot(
  node: FigmaDocumentNode,
  extraStyles: Record<string, Style> = {},
): NodeSnapshot {
  const raw = node as unknown as RawStructuralFields & {
    fills?: Paint[];
    strokes?: Paint[];
    effects?: Effect[];
    children?: FigmaDocumentNode[];
  };

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: raw.visible,
    componentPropertyReferences: raw.componentPropertyReferences,

    // Layout traits
    absoluteBoundingBox: raw.absoluteBoundingBox,
    layoutSizingHorizontal: raw.layoutSizingHorizontal,
    layoutSizingVertical: raw.layoutSizingVertical,
    layoutAlign: raw.layoutAlign,
    layoutGrow: raw.layoutGrow,
    layoutPositioning: raw.layoutPositioning,
    preserveRatio: raw.preserveRatio,
    gridColumnAnchorIndex: raw.gridColumnAnchorIndex,
    gridRowAnchorIndex: raw.gridRowAnchorIndex,
    gridColumnSpan: raw.gridColumnSpan,
    gridRowSpan: raw.gridRowSpan,
    gridChildHorizontalAlign: raw.gridChildHorizontalAlign,
    gridChildVerticalAlign: raw.gridChildVerticalAlign,

    // Frame / auto-layout container traits
    clipsContent: raw.clipsContent,
    layoutMode: raw.layoutMode,
    overflowDirection: raw.overflowDirection,
    paddingTop: raw.paddingTop,
    paddingRight: raw.paddingRight,
    paddingBottom: raw.paddingBottom,
    paddingLeft: raw.paddingLeft,
    primaryAxisAlignItems: raw.primaryAxisAlignItems,
    counterAxisAlignItems: raw.counterAxisAlignItems,
    counterAxisAlignContent: raw.counterAxisAlignContent,
    layoutWrap: raw.layoutWrap,
    itemSpacing: raw.itemSpacing,
    counterAxisSpacing: raw.counterAxisSpacing,
    gridColumnsSizing: raw.gridColumnsSizing,
    gridRowsSizing: raw.gridRowsSizing,
    gridRowGap: raw.gridRowGap,
    gridColumnGap: raw.gridColumnGap,

    // Scalar appearance
    strokeWeight: raw.strokeWeight,
    strokeDashes: raw.strokeDashes,
    strokeAlign: raw.strokeAlign,
    individualStrokeWeights: raw.individualStrokeWeights,
    opacity: raw.opacity,
    cornerRadius: raw.cornerRadius,
    rectangleCornerRadii: raw.rectangleCornerRadii,

    // Component metadata
    componentId: raw.componentId,
    componentProperties: raw.componentProperties,
    componentPropertyDefinitions: raw.componentPropertyDefinitions,

    // Wire-divergent encodings, decoded rather than carried
    fills: raw.fills && decodePaints(raw.fills),
    strokes: raw.strokes && decodePaints(raw.strokes),
    effects: raw.effects?.map(decodeEffect),

    // Text nodes: resolve the wire override tables into runs (undefined otherwise).
    text: decodeText(node),

    // Named styles: join the node's `styles` map with the top-level table into
    // per-slot resolved names; the wire shape never reaches the core.
    styles: decodeStyles(node, extraStyles),

    children: raw.children?.map((c) => restNodeToSnapshot(c, extraStyles)),
  };
}

/**
 * Resolve a node's REST `styles` map (style-slot → styleId) against the
 * top-level `styles` table (styleId → { name }) into per-slot resolved refs.
 * Only slots whose styleId carries a name survive; an unnamed or unknown styleId
 * is dropped, so `getStyleMatch` never surfaces a style the design didn't name.
 */
function decodeStyles(
  node: FigmaDocumentNode,
  extraStyles: Record<string, Style>,
): Record<string, SnapshotStyleRef> | undefined {
  const styleMap = (node as unknown as { styles?: Record<string, string> }).styles;
  if (!styleMap) return undefined;

  const resolved: Record<string, SnapshotStyleRef> = {};
  for (const [slot, styleId] of Object.entries(styleMap)) {
    const name = extraStyles[styleId]?.name;
    if (name) resolved[slot] = { name, id: styleId };
  }
  return Object.keys(resolved).length ? resolved : undefined;
}
