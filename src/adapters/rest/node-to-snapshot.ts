import type { Node as FigmaDocumentNode, Paint, Effect, Style } from "@figma/rest-api-spec";
import type {
  NodeSnapshot,
  SnapshotComponentPropertyDefinition,
  SnapshotComponentPropertyValue,
  SnapshotStyleRef,
} from "~/core/snapshot.js";
import { isCoordinateTransparentType } from "~/core/utils.js";
import { ROOT_SPACE, solveOwnBox, toParentSpacePoint, type RestParentSpace } from "./own-box.js";
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
    | "id"
    | "name"
    | "type"
    | "fills"
    | "strokes"
    | "effects"
    | "children"
    | "text"
    | "styles"
    | "componentProperties"
    | "componentPropertyDefinitions"
    | "overrides"
  >
>;

/**
 * The wire shape of component properties, as REST actually sends it — wider than
 * `@figma/rest-api-spec` 0.37.0 declares. Grounded live (file `Framelink`, 2026-09-04):
 * a SLOT property (`type: "SLOT"`, absent from the spec's union) carries a `{ guid }`
 * OBJECT as its `defaultValue` / `value`, not a scalar, and `componentPropertyReferences`
 * carries a `slotContentId` key the spec doesn't list either. Typed here so the decode
 * below is honest about what it filters.
 */
interface RawComponentProperty {
  type: string;
  value?: unknown;
  defaultValue?: unknown;
  variantOptions?: string[];
}

type RawComponentPropertyMap = Record<string, RawComponentProperty>;

/**
 * REST adapter: decode a raw Figma REST node into a plan-neutral `NodeSnapshot`
 * for `simplify`. This is where every REST-specific structure is unpacked
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
  return restSubtreeToSnapshot(node, extraStyles, ROOT_SPACE);
}

/**
 * The recursive body. `parentSpace` is walk state, not an argument any caller
 * outside this module could supply — a node's own box is only recoverable
 * relative to what its ancestors resolved to, so it threads down rather than
 * widening the entry point above.
 */
function restSubtreeToSnapshot(
  node: FigmaDocumentNode,
  extraStyles: Record<string, Style>,
  parentSpace: RestParentSpace,
): NodeSnapshot {
  const raw = node as unknown as RawStructuralFields & {
    fills?: Paint[];
    strokes?: Paint[];
    effects?: Effect[];
    children?: FigmaDocumentNode[];
    componentProperties?: RawComponentPropertyMap;
    componentPropertyDefinitions?: RawComponentPropertyMap;
    overrides?: { id: string; overriddenFields: string[] }[];
  };

  const rotation = degreesFromWireRotation(raw.rotation);

  // The node's own box, recovered from the page-space AABB (see ./own-box.ts), plus
  // the space this node's own children will be resolved against.
  //
  // The two halves of that space part company under a GROUP/BOOLEAN_OPERATION. Its
  // children's `rotation` is stated against the container ABOVE it, so they inherit
  // this node's `containerPageRotation` unchanged — adding the group's degrees again
  // would invert every descendant's AABB at twice the angle. Their `left`/`top`, on
  // the other hand, are measured in the group's OWN frame, the same frame the group's
  // own width/height are measured in. See `RestParentSpace`.
  const pageRotation = parentSpace.containerPageRotation + (rotation ?? 0);
  const own = solveOwnBox(raw.absoluteBoundingBox, pageRotation);
  const childSpace: RestParentSpace = {
    containerPageRotation: isCoordinateTransparentType(node.type)
      ? parentSpace.containerPageRotation
      : pageRotation,
    emittedParentFrame: own?.originOnPage && { originOnPage: own.originOnPage, pageRotation },
  };

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: raw.visible,
    componentPropertyReferences: raw.componentPropertyReferences,

    // Layout traits
    absoluteBoundingBox: raw.absoluteBoundingBox,
    ownSize: own?.size,
    ownOrigin:
      own?.originOnPage && parentSpace.emittedParentFrame
        ? toParentSpacePoint(own.originOnPage, parentSpace.emittedParentFrame)
        : undefined,
    layoutSizingHorizontal: raw.layoutSizingHorizontal,
    layoutSizingVertical: raw.layoutSizingVertical,
    layoutAlign: raw.layoutAlign,
    layoutGrow: raw.layoutGrow,
    layoutPositioning: raw.layoutPositioning,
    preserveRatio: raw.preserveRatio,
    rotation,
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
    componentProperties:
      raw.componentProperties && decodeComponentProperties(raw.componentProperties),
    componentPropertyDefinitions:
      raw.componentPropertyDefinitions &&
      decodePropertyDefinitions(raw.componentPropertyDefinitions),
    overrides: raw.overrides?.length
      ? raw.overrides.map((entry) => ({ id: entry.id, fields: entry.overriddenFields }))
      : undefined,

    // Wire-divergent encodings, decoded rather than carried
    fills: raw.fills && decodePaints(raw.fills),
    strokes: raw.strokes && decodePaints(raw.strokes),
    effects: raw.effects?.map(decodeEffect),

    // Text nodes: resolve the wire override tables into runs (undefined otherwise).
    text: decodeText(node),

    // Named styles: join the node's `styles` map with the top-level table into
    // per-slot resolved names; the wire shape never reaches the core.
    styles: decodeStyles(node, extraStyles),

    children: raw.children?.map((c) => restSubtreeToSnapshot(c, extraStyles, childSpace)),
  };
}

/**
 * REST states `rotation` in RADIANS. The plugin API states it in degrees, and so does
 * `NodeSnapshot` — so this is the adapter's job, and it has to happen before anything
 * reads the angle (Invariant 2: no wire convention past this file).
 *
 * The wire spec says only "The rotation of the node, if not 0" and names no unit, so
 * this is grounded in live data rather than docs (file `Framelink`, page `0:1`,
 * fetched 2026-09-04):
 *   - a LINE with `rotation: 0.54774` and a 300x183 AABB. A LINE is 0 tall by
 *     construction; inverting at 0.54774 RAD gives 351.41 x 0 — exactly
 *     sqrt(300^2 + 183^2), the diagonal it is drawn along. At 0.54774 DEG it gives
 *     298.29 x 180.16, a shape no LINE can have.
 *   - an icon INSTANCE with `rotation: 0.7853981633974483` — pi/4 to every digit —
 *     and a square 33.9411 AABB, which is 24 x sqrt(2): a 24x24 icon turned 45deg.
 *   - icon VECTORs at exactly pi/2 and pi, sitting axis-aligned in their AABBs.
 * Read as degrees, all of those are sub-degree nudges that no AABB in the file agrees
 * with.
 */
function degreesFromWireRotation(radians: number | undefined): number | undefined {
  return radians === undefined ? undefined : (radians * 180) / Math.PI;
}

function isScalarPropertyValue(value: unknown): value is boolean | string {
  return typeof value === "boolean" || typeof value === "string";
}

/**
 * An instance's property values, minus SLOT entries: their `{ guid }` value names the
 * slot's content container, which is already the SLOT node in this instance's subtree
 * (see `SnapshotComponentPropertyValue`).
 */
function decodeComponentProperties(
  wire: RawComponentPropertyMap,
): Record<string, SnapshotComponentPropertyValue> | undefined {
  const out: Record<string, SnapshotComponentPropertyValue> = {};
  for (const [name, prop] of Object.entries(wire)) {
    if (isScalarPropertyValue(prop.value)) out[name] = { type: prop.type, value: prop.value };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Property definitions, field-by-field. Every type survives (a SLOT def keeps its
 * type and loses only its `{ guid }` default); `variantOptions` rides along for VARIANT.
 * `preferredValues` (a picker palette) is deliberately not carried — nothing downstream
 * needs it to reproduce or modify an instance.
 */
function decodePropertyDefinitions(
  wire: RawComponentPropertyMap,
): Record<string, SnapshotComponentPropertyDefinition> | undefined {
  const out: Record<string, SnapshotComponentPropertyDefinition> = {};
  for (const [name, def] of Object.entries(wire)) {
    const decoded: SnapshotComponentPropertyDefinition = { type: def.type };
    if (isScalarPropertyValue(def.defaultValue)) decoded.defaultValue = def.defaultValue;
    if (def.variantOptions) decoded.variantOptions = def.variantOptions;
    out[name] = decoded;
  }
  return Object.keys(out).length ? out : undefined;
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
