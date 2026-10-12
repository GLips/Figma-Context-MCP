import type { Node as FigmaDocumentNode, Paint, Effect, Style } from "@figma/rest-api-spec";
import type {
  NodeSnapshot,
  SnapshotComponentPropertyDefinition,
  SnapshotComponentPropertyValue,
  SnapshotNodeVariableField,
  SnapshotNodeVariables,
  SnapshotStyleSlot,
} from "@framelink/core/snapshot";
import { isCoordinateTransparentType } from "@framelink/core";
import { ROOT_SPACE, solveOwnBox, type RestParentSpace } from "./own-box.js";
import { rotateIntoParentFrame } from "@framelink/core";
import { decodePaints, decodeEffect, restVariableRef, type RestVariableAlias } from "./paint.js";
import { decodeText } from "./text.js";
import { definitionEntry, mainComponentOf, type RestComponentTables } from "./component-tables.js";

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
    | "textAutoResize"
    | "styles"
    | "boundVariables"
    | "componentProperties"
    | "componentPropertyDefinitions"
    | "overrides"
  >
>;

/**
 * The wire shape of component properties, as REST actually sends it — wider than
 * `@figma/rest-api-spec` 0.42.0 declares. Grounded live (file `Framelink`, 2026-09-04):
 * a SLOT property (`type: "SLOT"`, absent from the spec's union) carries a `{ guid }`
 * OBJECT as its `value`, not a scalar, and `componentPropertyReferences`
 * carries a `slotContentId` key the spec doesn't list either. Typed here so the decode
 * below is honest about what it filters.
 */
interface RawComponentProperty {
  type: string;
  value?: unknown;
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
  tables: RestComponentTables = {},
): NodeSnapshot {
  return restSubtreeToSnapshot(node, extraStyles, ROOT_SPACE, tables);
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
  tables: RestComponentTables,
): NodeSnapshot {
  const raw = node as unknown as RawStructuralFields & {
    fills?: Paint[];
    strokes?: Paint[];
    effects?: Effect[];
    children?: FigmaDocumentNode[];
    componentProperties?: RawComponentPropertyMap;
    componentPropertyDefinitions?: RawComponentPropertyMap;
    overrides?: { id: string; overriddenFields: string[] }[];
    boundVariables?: RawNodeVariables;
    /** REST carries a TEXT's auto-resize on its base style; the plugin has it on the node. */
    style?: { textAutoResize?: NodeSnapshot["textAutoResize"] };
  };

  const containerRotation = degreesFromWireRotation(raw.rotation) ?? 0;

  // The node's own box, recovered from the page-space AABB (see ./own-box.ts), plus
  // the space this node's own children will be resolved against.
  //
  // The two halves of that space part company under a GROUP/BOOLEAN_OPERATION. Its
  // children's `rotation` is stated against the container ABOVE it, so they inherit
  // this node's `containerPageRotation` unchanged — adding the group's degrees again
  // would invert every descendant's AABB at twice the angle. Their `left`/`top`, on
  // the other hand, are measured in the group's OWN frame, the same frame the group's
  // own width/height are measured in. See `RestParentSpace`.
  const pageRotation = parentSpace.containerPageRotation + containerRotation;
  const own = solveOwnBox(raw.absoluteBoundingBox, pageRotation);
  const childSpace: RestParentSpace = {
    containerPageRotation: isCoordinateTransparentType(node.type)
      ? parentSpace.containerPageRotation
      : pageRotation,
    emittedParentFrame: { originOnPage: own?.originOnPage, pageRotation },
  };

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: raw.visible,
    locked: raw.locked,
    blendMode: raw.blendMode,
    constraints: raw.constraints,
    componentPropertyReferences: raw.componentPropertyReferences,

    // Layout traits
    absoluteBoundingBox: raw.absoluteBoundingBox,
    ownSize: own?.size,
    ownOrigin:
      own?.originOnPage && parentSpace.emittedParentFrame.originOnPage
        ? rotateIntoParentFrame(
            own.originOnPage,
            parentSpace.emittedParentFrame.originOnPage,
            parentSpace.emittedParentFrame.pageRotation,
          )
        : undefined,
    minWidth: raw.minWidth,
    maxWidth: raw.maxWidth,
    minHeight: raw.minHeight,
    maxHeight: raw.maxHeight,
    layoutSizingHorizontal: raw.layoutSizingHorizontal,
    layoutSizingVertical: raw.layoutSizingVertical,
    layoutAlign: raw.layoutAlign,
    layoutGrow: raw.layoutGrow,
    layoutPositioning: raw.layoutPositioning,
    preserveRatio: raw.preserveRatio,
    textAutoResize: node.type === "TEXT" ? raw.style?.textAutoResize : undefined,
    // Keep page/container angles local to the solve; the snapshot composes with its parent.
    rotation: pageRotation - parentSpace.emittedParentFrame.pageRotation || undefined,
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
    isExposedInstance: raw.isExposedInstance,
    mainComponent: node.type === "INSTANCE" ? mainComponentOf(raw.componentId, tables) : undefined,
    componentKey: definitionEntry(node, tables)?.key || undefined,
    componentDescription: definitionEntry(node, tables)?.description || undefined,
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

    // Tokens: join the node's `styles` map with the top-level table into per-slot
    // refs, and normalize variable bindings onto snapshot field names.
    styles: decodeStyles(node, extraStyles),
    boundVariables: raw.boundVariables && decodeNodeVariables(raw.boundVariables),

    children: raw.children?.map((c) => restSubtreeToSnapshot(c, extraStyles, childSpace, tables)),
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
 * Property definitions, field-by-field. Every type survives; `variantOptions` rides along
 * for VARIANT. No default: in a main component it is always the bound layer's own content.
 * `preferredValues` (a picker palette) is deliberately not carried — nothing downstream
 * needs it to reproduce or modify an instance.
 */
function decodePropertyDefinitions(
  wire: RawComponentPropertyMap,
): Record<string, SnapshotComponentPropertyDefinition> | undefined {
  const out: Record<string, SnapshotComponentPropertyDefinition> = {};
  for (const [name, def] of Object.entries(wire)) {
    const decoded: SnapshotComponentPropertyDefinition = { type: def.type };
    if (def.variantOptions) decoded.variantOptions = def.variantOptions;
    out[name] = decoded;
  }
  return Object.keys(out).length ? out : undefined;
}

// REST spells some slots in the plural; the snapshot speaks the singular slot names.
const STYLE_SLOTS: Record<string, SnapshotStyleSlot> = {
  fill: "fill",
  fills: "fill",
  stroke: "stroke",
  strokes: "stroke",
  text: "text",
  effect: "effect",
  effects: "effect",
  grid: "grid",
};

/**
 * Resolve a node's REST `styles` map (style-slot → styleId) against the top-level
 * `styles` table (styleId → { name }) into per-slot refs. A styleId the table doesn't
 * name (a file response without that entry) keeps its id with no name.
 */
function decodeStyles(
  node: FigmaDocumentNode,
  extraStyles: Record<string, Style>,
): NodeSnapshot["styles"] {
  const styleMap = (node as unknown as { styles?: Record<string, string> }).styles;
  if (!styleMap) return undefined;

  const resolved: NonNullable<NodeSnapshot["styles"]> = {};
  for (const [wireSlot, styleId] of Object.entries(styleMap)) {
    const slot = STYLE_SLOTS[wireSlot];
    if (!slot) continue;
    // The style's publish KEY is its id in the read — the one identifier REST and the plugin share
    // (a styleId here is a REST-local number the plugin can't resolve). Without a table entry the
    // styleId is all there is.
    const entry = extraStyles[styleId];
    const id = entry?.key || styleId;
    resolved[slot] = entry?.name ? { id, name: entry.name } : { id };
  }
  return Object.keys(resolved).length ? resolved : undefined;
}

/**
 * The node-field bindings this adapter reads, as REST nests them. Text-field arrays and paint
 * arrays on the node are skipped on purpose: text bindings are read off the TypeStyle (per run),
 * and paint bindings off each paint's own `boundVariables.color`.
 */
type RawNodeVariables = Partial<Record<SnapshotNodeVariableField, RestVariableAlias>> & {
  size?: { x?: RestVariableAlias; y?: RestVariableAlias };
  // The published spec types these sides top/right/bottom/left; the live wire (2026-10-10) sends
  // BORDER_*_WEIGHT. Both are read so neither spelling drops the binding.
  individualStrokeWeights?: Partial<
    Record<
      | "top"
      | "right"
      | "bottom"
      | "left"
      | "BORDER_TOP_WEIGHT"
      | "BORDER_RIGHT_WEIGHT"
      | "BORDER_BOTTOM_WEIGHT"
      | "BORDER_LEFT_WEIGHT",
      RestVariableAlias
    >
  >;
  rectangleCornerRadii?: Partial<
    Record<
      | "RECTANGLE_TOP_LEFT_CORNER_RADIUS"
      | "RECTANGLE_TOP_RIGHT_CORNER_RADIUS"
      | "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS"
      | "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS",
      RestVariableAlias
    >
  >;
};

/** REST names fields that share the snapshot's spelling as-is; the rest are nested and renamed. */
const DIRECT_VARIABLE_FIELDS = [
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "itemSpacing",
  "counterAxisSpacing",
  "topLeftRadius",
  "topRightRadius",
  "bottomRightRadius",
  "bottomLeftRadius",
  "opacity",
] as const satisfies ReadonlyArray<SnapshotNodeVariableField>;

function decodeNodeVariables(wire: RawNodeVariables): SnapshotNodeVariables | undefined {
  type Pair = [SnapshotNodeVariableField, RestVariableAlias | undefined];
  const sides = wire.individualStrokeWeights;
  const pairs: Pair[] = [
    ...DIRECT_VARIABLE_FIELDS.map((field): Pair => [field, wire[field]]),
    ["width", wire.size?.x],
    ["height", wire.size?.y],
    ["topLeftRadius", wire.rectangleCornerRadii?.RECTANGLE_TOP_LEFT_CORNER_RADIUS],
    ["topRightRadius", wire.rectangleCornerRadii?.RECTANGLE_TOP_RIGHT_CORNER_RADIUS],
    ["bottomRightRadius", wire.rectangleCornerRadii?.RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS],
    ["bottomLeftRadius", wire.rectangleCornerRadii?.RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS],
    ["strokeTopWeight", sides?.BORDER_TOP_WEIGHT ?? sides?.top],
    ["strokeRightWeight", sides?.BORDER_RIGHT_WEIGHT ?? sides?.right],
    ["strokeBottomWeight", sides?.BORDER_BOTTOM_WEIGHT ?? sides?.bottom],
    ["strokeLeftWeight", sides?.BORDER_LEFT_WEIGHT ?? sides?.left],
  ];
  const out: SnapshotNodeVariables = {};
  for (const [field, alias] of pairs) {
    const ref = restVariableRef(alias);
    if (ref) out[field] = ref;
  }
  return Object.keys(out).length ? out : undefined;
}
