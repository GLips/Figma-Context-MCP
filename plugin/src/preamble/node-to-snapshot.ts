/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { serializeGridTracks } from "./grid-tracks.js";
// node-to-snapshot — the plugin adapter to `NodeSnapshot` (Invariant 2), the counterpart of the REST
// adapter (src/adapters/rest/decode/node-to-snapshot.ts). It decodes plugin-native forms DIRECTLY onto the
// plan-neutral snapshot the shared `simplify` core consumes — it never fabricates REST wire structures
// (no imageRef tables, no gradientHandlePositions arrays, no characterStyleOverrides) to feed a
// REST-shaped parser; that throwaway encode-then-decode is what ADR-0004 refuses.
//
// Deliberately typed against a STRUCTURAL view of the plugin API (SceneNodeLike below), not the
// @figma/plugin-typings ambients: the REST↔plugin parity harness (src/tests/parity/) imports this
// module into the root toolchain, where no `figma` global or plugin ambient type exists. The
// structural view doubles as documentation of exactly which plugin-API surface the read path
// consumes, and lets the harness feed committed plugin-native fixtures through the same decode the
// live read walk uses. `figma.mixed` can't be named here either — it is detected as
// `typeof value === "symbol"` (the only symbol these properties ever carry).
//
// Like the REST adapter, the snapshot is constructed field-by-field against the declared contract —
// deliberately NOT a `{...node}` spread — so undeclared plugin fields cannot ride through at runtime.

import { decodeAnnotations, type SceneAnnotation } from "./annotations.js";
import { isReadableSceneNode, readableChildren } from "./scene-readability.js";
import { isCoordinateTransparentType, rotateIntoParentFrame, type PlacementContext } from "@framelink/core";
import { FlcmError } from "./flcm-error.js";
import type {
  NodeSnapshot,
  SnapshotColor,
  SnapshotEffect,
  SnapshotImageFilters,
  SnapshotPaint,
  SnapshotNodeVariableField,
  SnapshotNodeVariables,
  SnapshotPoint,
  SnapshotStyleSlot,
  SnapshotText,
  SnapshotTextRun,
  SnapshotTextStyle,
  SnapshotTextVariableField,
  SnapshotTextVariables,
  SnapshotTokenRef,
  SnapshotTransform,
  SnapshotVector,
} from "@framelink/core/snapshot";

// ---------------------------------------------------------------------------
// The structural scene view — the plugin-API subset the adapter reads. A live
// SceneNode satisfies this; the parity harness's committed fixtures do too.
// ---------------------------------------------------------------------------

interface SceneRGB {
  r: number;
  g: number;
  b: number;
}

/** Plugin `Transform`: a 2x3 row-major affine matrix `[[a, b, tx], [c, d, ty]]`. */
type SceneTransform = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
];

/** Plugin `VariableAlias`: a binding names its variable by id only. */
interface SceneVariableAlias {
  readonly id: string;
}

interface SceneSolidPaint {
  type: "SOLID";
  /** Plugin solids carry alpha on the paint's `opacity`, never in the color. */
  color: SceneRGB;
  opacity?: number;
  blendMode?: string;
  visible?: boolean;
  /** Gradient stops can bind too; out of scope, so only the solid's binding is declared. */
  boundVariables?: { readonly color?: SceneVariableAlias };
}

interface SceneGradientPaint {
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  /** Normalized object space → gradient space (see handlesFromTransform). */
  gradientTransform: SceneTransform;
  gradientStops: ReadonlyArray<{ position: number; color: SnapshotColor }>;
  opacity?: number;
  blendMode?: string;
  visible?: boolean;
}

interface SceneImagePaint {
  type: "IMAGE";
  imageHash: string | null;
  scaleMode: "FILL" | "FIT" | "CROP" | "TILE";
  scalingFactor?: number | null;
  imageTransform?: SceneTransform;
  opacity?: number;
  blendMode?: string;
  rotation?: number;
  filters?: SnapshotImageFilters;
  visible?: boolean;
}

interface ScenePatternPaint {
  type: "PATTERN";
  sourceNodeId: string;
  scalingFactor: number;
  horizontalAlignment?: "START" | "CENTER" | "END";
  verticalAlignment?: "START" | "CENTER" | "END";
  visible?: boolean;
}

/** A paint the snapshot has no kind for. Named so the typings check sees it; the decoder drops it. */
interface SceneUndecodedPaint {
  type: "VIDEO" | "SHADER";
  visible?: boolean;
}

export type ScenePaint =
  | SceneSolidPaint
  | SceneGradientPaint
  | SceneImagePaint
  | ScenePatternPaint
  | SceneUndecodedPaint;

export interface SceneEffect {
  type: string;
  visible?: boolean;
  color?: SnapshotColor;
  offset?: SnapshotVector;
  radius?: number;
  spread?: number;

  // Beyond-CSS effect fields the live plugin carries (GLASS / NOISE / TEXTURE / PROGRESSIVE layer blur).
  // REST never sees these; the read walk decodes them straight onto the snapshot's beyond-CSS fields so
  // the core can emit the flcm.effects({...}) object form. `radius`/`color` above are reused.
  lightIntensity?: number;
  lightAngle?: number;
  refraction?: number;
  depth?: number;
  dispersion?: number;
  noiseType?: string;
  noiseSize?: number;
  density?: number;
  secondaryColor?: SnapshotColor;
  opacity?: number;
  clipToShape?: boolean;
  blurType?: string;
  startRadius?: number;
  startOffset?: SnapshotVector;
  endOffset?: SnapshotVector;
}

/**
 * One styled range from `getStyledTextSegments` — the plugin's resolved
 * equivalent of REST's override tables. Every style field is optional so
 * committed fixtures can stay as sparse as the synthetic REST fixtures they
 * must reduce identically to; a live segment carries every requested field.
 */
export interface SceneTextSegment {
  characters: string;
  /** `family` is the CSS font-family; `style` is the variant name ("Bold Italic"). */
  fontName?: { family?: string; style?: string };
  /** Unlike `fontName.style`, a two-value italic discriminator. */
  fontStyle?: "REGULAR" | "ITALIC";
  fontWeight?: number;
  fontSize?: number;
  textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  textCase?: string;
  lineHeight?: { unit: "PIXELS" | "PERCENT" | "AUTO"; value?: number };
  letterSpacing?: { unit: "PIXELS" | "PERCENT"; value: number };
  fills?: ReadonlyArray<ScenePaint>;
  hyperlink?: { type: "URL" | "NODE"; value: string } | null;
  openTypeFeatures?: { readonly [feature: string]: boolean };
  listOptions?: { type?: "ORDERED" | "UNORDERED" | "NONE" };
  indentation?: number;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  listSpacing?: number;
  /** This range's own bindings, keyed by text field; requested as the `boundVariables` segment field. */
  boundVariables?: { readonly [field: string]: SceneVariableAlias | undefined };
}

/**
 * The node-field bindings this adapter reads: the snapshot's own field names, plus the two
 * whole-node bindings that stand for every side or corner. Paint bindings are read off each
 * paint (node-level `fills`/`strokes` arrays would duplicate them), text bindings off segments.
 */
type SceneNodeVariables = {
  readonly [K in SnapshotNodeVariableField | "strokeWeight" | "cornerRadius"]?: SceneVariableAlias;
};

export interface SceneNodeLike {
  readonly annotations?: readonly SceneAnnotation[];
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly visible?: boolean;
  readonly locked?: boolean;
  readonly blendMode?: string;
  readonly constraints?: { horizontal: string; vertical: string };
  readonly vectorPaths?: ReadonlyArray<{ data: string; windingRule: "NONZERO" | "EVENODD" | "NONE" }>;
  /** Only the parent's type is read — to know whether a COMPONENT is a set variant. */
  readonly parent?: { readonly type: string } | null;
  readonly children?: ReadonlyArray<SceneNodeLike>;
  readonly componentPropertyReferences?: { readonly [key: string]: string } | null;

  // Layout traits
  readonly absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  /** The node's own size — unchanged by rotation, unlike absoluteBoundingBox. */
  readonly width?: number;
  readonly height?: number;
  /** The node's own top-left corner in its parent's frame (relativeTransform's translation). */
  readonly x?: number;
  readonly y?: number;
  readonly minWidth?: number | null;
  readonly maxWidth?: number | null;
  readonly minHeight?: number | null;
  readonly maxHeight?: number | null;
  readonly layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  readonly layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
  readonly layoutAlign?: "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX";
  readonly layoutGrow?: number;
  readonly layoutPositioning?: "AUTO" | "ABSOLUTE";
  readonly textAutoResize?: "NONE" | "HEIGHT" | "WIDTH_AND_HEIGHT" | "TRUNCATE";
  /** The locked width:height vector, null when unlocked — the plugin spelling of REST's `preserveRatio`. */
  readonly targetAspectRatio?: { readonly x: number; readonly y: number } | null;
  /** Degrees, counterclockwise-positive — the same raw convention the snapshot carries. */
  readonly rotation?: number;
  readonly gridColumnAnchorIndex?: number;
  readonly gridRowAnchorIndex?: number;
  readonly gridColumnSpan?: number;
  readonly gridRowSpan?: number;
  readonly gridChildHorizontalAlign?: "AUTO" | "MIN" | "CENTER" | "MAX";
  readonly gridChildVerticalAlign?: "AUTO" | "MIN" | "CENTER" | "MAX";

  // Frame / auto-layout container traits
  readonly clipsContent?: boolean;
  readonly layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  /** Plugin overflow words, mapped to REST's *_SCROLLING. */
  readonly overflowDirection?: "NONE" | "HORIZONTAL" | "VERTICAL" | "BOTH";
  readonly paddingTop?: number;
  readonly paddingRight?: number;
  readonly paddingBottom?: number;
  readonly paddingLeft?: number;
  readonly primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" | "SPACE_AROUND" | "SPACE_EVENLY";
  readonly counterAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "BASELINE";
  readonly counterAxisAlignContent?: "AUTO" | "SPACE_BETWEEN";
  readonly layoutWrap?: "NO_WRAP" | "WRAP";
  readonly itemSpacing?: number;
  readonly counterAxisSpacing?: number | null;
  readonly gridColumnSizes?: ReadonlyArray<{ type: "FIXED" | "FLEX" | "HUG"; value?: number }>;
  readonly gridRowSizes?: ReadonlyArray<{ type: "FIXED" | "FLEX" | "HUG"; value?: number }>;
  readonly gridRowGap?: number;
  readonly gridColumnGap?: number;

  // Visuals — `symbol` is figma.mixed (TEXT with per-run fills; per-side/corner values)
  readonly fills?: ReadonlyArray<ScenePaint> | symbol;
  readonly strokes?: ReadonlyArray<ScenePaint>;
  readonly strokeWeight?: number | symbol;
  readonly strokeTopWeight?: number;
  readonly strokeRightWeight?: number;
  readonly strokeBottomWeight?: number;
  readonly strokeLeftWeight?: number;
  readonly dashPattern?: ReadonlyArray<number>;
  readonly strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";
  readonly effects?: ReadonlyArray<SceneEffect>;
  readonly opacity?: number;
  readonly cornerRadius?: number | symbol;
  readonly topLeftRadius?: number;
  readonly topRightRadius?: number;
  readonly bottomRightRadius?: number;
  readonly bottomLeftRadius?: number;

  // Text traits (TEXT nodes). The run-diffable styles come through
  // getStyledTextSegments; only the properties that cannot vary per run stay
  // node-level. paragraphSpacing/paragraphIndent/listSpacing CAN be mixed
  // node-level, so they are read per-segment instead.
  readonly characters?: string;
  readonly textAlignHorizontal?: string;
  readonly textAlignVertical?: string;
  readonly getStyledTextSegments?: (
    fields: Array<keyof Omit<SceneTextSegment, "characters">>,
  ) => ReadonlyArray<SceneTextSegment>;

  // Tokens — variable bindings, and style ids resolved to names through the injected resolver
  readonly boundVariables?: SceneNodeVariables;
  readonly fillStyleId?: string | symbol;
  readonly strokeStyleId?: string;
  readonly textStyleId?: string | symbol;
  readonly effectStyleId?: string;
  readonly gridStyleId?: string;

  /** COMPONENT / COMPONENT_SET: the definition's own publish key and description. */
  readonly key?: string;
  readonly description?: string;

  // Component metadata. The value is `unknown` on purpose: a SLOT property's is a
  // `{ guid }` object on the wire (REST verified live; the plugin typings still say `string | boolean`),
  // and the decode below keeps only the scalars.
  readonly isExposedInstance?: boolean;
  readonly componentProperties?: {
    readonly [key: string]: { readonly type: string; readonly value: unknown };
  };
  readonly componentPropertyDefinitions?: {
    readonly [key: string]: {
      readonly type: string;
      readonly variantOptions?: ReadonlyArray<string>;
    };
  };
  /**
   * INSTANCE: the live main component. Read for its PROVENANCE as well as its id — `key`, `name`
   * and the enclosing variant set are exactly what REST reads out of its response tables, and the
   * plugin has no envelope to put a table in. This one call is what lets a plugin read name a
   * component at all, and therefore what makes an instance's variant recoverable here.
   */
  readonly getMainComponentAsync?: () => Promise<MainComponentLike | null>;
  /** INSTANCE: direct overrides on the instance itself and its sublayers, plugin field spellings (`NodeChangeProperty`). */
  readonly overrides?: ReadonlyArray<{ readonly id: string; readonly overriddenFields: ReadonlyArray<string> }>;
}

/**
 * An instance's main component: a node the adapter reads like any other (an off-tree definition is
 * decoded from it), plus the enclosing variant set's provenance off its parent.
 */
interface MainComponentLike extends SceneNodeLike {
  readonly parent?: {
    readonly id: string;
    readonly type: string;
    readonly key?: string;
    readonly name?: string;
    readonly description?: string;
  } | null;
}

/** The node's own top-left corner as the live node states it, or undefined if it has none. */
function ownXY(node: SceneNodeLike): SnapshotPoint | undefined {
  return typeof node.x === "number" && typeof node.y === "number"
    ? { x: node.x, y: node.y }
    : undefined;
}

/**
 * A node's own corner expressed against the parent the snapshot emits.
 *
 * `node.x`/`node.y` are stated in the CONTAINER parent, which is the emitted parent
 * everywhere except under a group or boolean operation. There, the child and the group
 * are siblings in one space, so the group's corner has to subtract out — without this
 * the snapshot hands the core a container-relative number that it reads as an offset
 * from the group, and every group child lands at its frame-relative position.
 *
 * The delta is then turned into the group's OWN frame, because that is the frame the
 * group's emitted width/height are measured in: a child of a group tilted 25° belongs
 * inside its box, not beside it. Undoing Figma's `[[cos, sin], [-sin, cos]]` is a
 * multiply by its transpose. An unrotated group — the common case — leaves the delta
 * exactly as it is.
 */
function ownOriginIn(node: SceneNodeLike, parentSpace: SceneParentSpace): SnapshotPoint | undefined {
  const own = ownXY(node);
  if (!own || !parentSpace.transparent) return own;
  if (!parentSpace.origin) return undefined;
  return rotateIntoParentFrame(own, parentSpace.origin, parentSpace.rotation ?? 0);
}

/**
 * Resolves a style or variable id to its name (`figma.getStyleByIdAsync` /
 * `figma.variables.getVariableByIdAsync` on the live path; fixture tables in the parity harness).
 * Injected because these are the only lookups that aren't node-local, and this module can't touch
 * the `figma` global. A null resolution keeps the token, id only. A style also answers its `key`.
 * `nameSuffices` says the write side resolves the name alone back to this token, so the read may
 * drop the id.
 */
export type SceneTokenResolver = (
  kind: "style" | "variable",
  id: string,
) => Promise<{ name: string; key?: string; nameSuffices?: boolean } | null>;

/**
 * Plugin adapter: decode a live-shaped scene node (and its subtree) into the plan-neutral
 * `NodeSnapshot` for `simplify`. All `figma.*` liveness stays with the caller (the read walk) — by
 * the time values reach here they are plain data plus the node-local methods the view declares.
 */
export async function sceneNodeToSnapshot(
  node: SceneNodeLike,
  resolveToken: SceneTokenResolver,
  mainComponents?: MainComponentSink,
  annotationCategories: ReadonlyMap<string, string> = new Map(),
  unreadable?: UnreadableSink,
  parent?: SceneNodeLike,
): Promise<NodeSnapshot> {
  const space = parent ? spaceUnder(parent) : CONTAINER_PARENT_SPACE;
  return sceneSubtreeToSnapshot(node, resolveToken, space, mainComponents, annotationCategories, unreadable);
}

/**
 * A targeted read's parent as layout context (simplify's `placement`): only the fields the core
 * reads to place a child, never paints or tokens, so it costs no style or variable lookup. Siblings
 * are listed only under a GRID, the one parent whose placement reads them.
 */
export function scenePlacement(parent: SceneNodeLike): PlacementContext {
  if (parent.layoutMode !== "GRID") return { parent: placementTraits(parent) };
  const siblings = (readableChildren(parent) ?? []).filter(isReadableSceneNode);
  return { parent: placementTraits(parent), siblings: siblings.map(placementTraits) };
}

function placementTraits(node: SceneNodeLike): NodeSnapshot {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    absoluteBoundingBox: node.absoluteBoundingBox ?? undefined,
    layoutMode: node.layoutMode,
    layoutPositioning: node.layoutPositioning,
    gridColumnAnchorIndex: node.gridColumnAnchorIndex,
    gridRowAnchorIndex: node.gridRowAnchorIndex,
    gridColumnSpan: node.gridColumnSpan,
    gridRowSpan: node.gridRowSpan,
  };
}

/** Where the caller collects ids the walk omitted: unreadable nodes, and containers whose children Figma cannot list. */
export type UnreadableSink = Set<string>;

/**
 * Where the caller collects every main component this walk resolved, keyed by id. Offered because
 * the walk ALREADY awaits `getMainComponentAsync` on every instance to learn its `componentId`:
 * a caller that needs those component nodes (to publish their definitions) would otherwise ask the
 * document for each one a second time.
 */
export type MainComponentSink = Map<string, MainComponentLike>;

/**
 * Where a node's `x`/`y` are measured from, relative to the parent the snapshot
 * EMITS. They are the same point whenever the emitted parent is a container parent
 * — which is the common case, and what `CONTAINER_PARENT_SPACE` says.
 *
 * They part company under a coordinate-transparent parent (see
 * `isCoordinateTransparentType`): a group child's `x`/`y` are stated in the
 * container above the group, so they are a SIBLING of the group's own `x`/`y`
 * rather than an offset from it, and the group's corner has to come out.
 */
interface SceneParentSpace {
  /** Whether the emitted parent is coordinate-transparent. */
  readonly transparent: boolean;
  /**
   * A transparent parent's own corner, in the space it shares with its children.
   * Absent when that parent carried no `x`/`y` at all — the corner is unknown, so
   * children withhold `ownOrigin` and the core falls back to the AABB delta rather
   * than emitting an unsubtracted, container-relative number.
   */
  readonly origin?: SnapshotPoint;
  /** That parent's own rotation in degrees, the frame its children's offsets land in. */
  readonly rotation: number;
}

/** The ordinary case: the emitted parent IS the container parent, so `x`/`y` need no fixup. */
const CONTAINER_PARENT_SPACE: SceneParentSpace = { transparent: false, rotation: 0 };

/** The space a node's children are stated in. */
function spaceUnder(node: SceneNodeLike): SceneParentSpace {
  return isCoordinateTransparentType(node.type)
    ? { transparent: true, origin: ownXY(node), rotation: node.rotation ?? 0 }
    : CONTAINER_PARENT_SPACE;
}

/**
 * The recursive body. `parentSpace` is walk state rather than a caller-supplied
 * argument — like the REST adapter's `RestParentSpace`, a node's parent-relative
 * origin is only knowable from what its parent resolved to.
 */
async function sceneSubtreeToSnapshot(
  node: SceneNodeLike,
  resolveToken: SceneTokenResolver,
  parentSpace: SceneParentSpace,
  mainComponents?: MainComponentSink,
  annotationCategories: ReadonlyMap<string, string> = new Map(),
  unreadable?: UnreadableSink,
): Promise<NodeSnapshot> {
  const text = node.type === "TEXT" ? decodeSceneText(node) : undefined;
  const main = await mainComponentOf(node);
  if (main && mainComponents && !mainComponents.has(main.id)) {
    mainComponents.set(main.id, main);
  }

  const childSpace = spaceUnder(node);
  const listed = readableChildren(node);
  if (!listed) unreadable?.add(node.id);
  const readable = (listed ?? []).filter((child) => {
    if (isReadableSceneNode(child)) return true;
    unreadable?.add(child.id);
    return false;
  });
  const children = await Promise.all(
    readable.map((child) =>
      sceneSubtreeToSnapshot(child, resolveToken, childSpace, mainComponents, annotationCategories, unreadable),
    ),
  );

  const snapshot: NodeSnapshot = {
    annotations: decodeAnnotations(node.annotations, annotationCategories),
    id: node.id,
    name: node.name,
    type: node.type === "POLYGON" ? "REGULAR_POLYGON" : node.type,
    visible: node.visible,
    locked: node.locked,
    blendMode: node.blendMode,
    constraints: node.constraints ? { ...node.constraints } : undefined,
    vectorPaths: node.vectorPaths?.map(path => ({ data: path.data, windingRule: path.windingRule })),
    componentPropertyReferences: node.componentPropertyReferences ?? undefined,

    // Layout traits
    absoluteBoundingBox: node.absoluteBoundingBox,
    // The node's own geometry, straight off the live node — the read side's answer to
    // width/height/left/top, and the same numbers `geometryOf` writes back (bridge.ts).
    // No inversion needed here: rotation lives in relativeTransform, not in these. The
    // origin is the one value that needs a parent to interpret it — see `ownOriginIn`.
    ownSize:
      typeof node.width === "number" && typeof node.height === "number"
        ? { width: node.width, height: node.height }
        : undefined,
    ownOrigin: ownOriginIn(node, parentSpace),
    minWidth: node.minWidth,
    maxWidth: node.maxWidth,
    minHeight: node.minHeight,
    maxHeight: node.maxHeight,
    layoutSizingHorizontal: node.layoutSizingHorizontal,
    layoutSizingVertical: node.layoutSizingVertical,
    layoutAlign: node.layoutAlign,
    layoutGrow: node.layoutGrow === 1 ? 1 : undefined,
    layoutPositioning: node.layoutPositioning,
    // Never read the boolean `constrainProportions` for this: Figma logs a deprecation warning on
    // every access, once per node, which floods the plugin console during a tree read.
    preserveRatio: node.targetAspectRatio ? true : undefined,
    textAutoResize: node.type === "TEXT" ? node.textAutoResize : undefined,
    // Group children report a container-relative angle; normalize it like their origin.
    rotation: (node.rotation ?? 0) - parentSpace.rotation || undefined,
    gridColumnAnchorIndex: node.gridColumnAnchorIndex,
    gridRowAnchorIndex: node.gridRowAnchorIndex,
    gridColumnSpan: node.gridColumnSpan,
    gridRowSpan: node.gridRowSpan,
    gridChildHorizontalAlign: node.gridChildHorizontalAlign,
    gridChildVerticalAlign: node.gridChildVerticalAlign,

    // Convert plugin track objects to the same template strings supplied by REST.
    clipsContent: node.clipsContent,
    layoutMode: node.layoutMode,
    overflowDirection: decodeOverflow(node.overflowDirection),
    paddingTop: node.paddingTop,
    paddingRight: node.paddingRight,
    paddingBottom: node.paddingBottom,
    paddingLeft: node.paddingLeft,
    primaryAxisAlignItems: node.primaryAxisAlignItems,
    counterAxisAlignItems: node.counterAxisAlignItems,
    counterAxisAlignContent: node.counterAxisAlignContent,
    layoutWrap: node.layoutWrap,
    itemSpacing: node.itemSpacing,
    counterAxisSpacing: node.counterAxisSpacing ?? undefined,
    gridColumnsSizing: node.layoutMode === "GRID" ? (node.gridColumnSizes && serializeGridTracks(node.gridColumnSizes)) : undefined,
    gridRowsSizing: node.layoutMode === "GRID" ? (node.gridRowSizes && serializeGridTracks(node.gridRowSizes)) : undefined,
    gridRowGap: node.gridRowGap,
    gridColumnGap: node.gridColumnGap,

    // Scalar appearance
    strokeWeight: typeof node.strokeWeight === "number" ? node.strokeWeight : undefined,
    strokeDashes: node.dashPattern?.length ? [...node.dashPattern] : undefined,
    strokeAlign: node.strokeAlign,
    individualStrokeWeights:
      typeof node.strokeWeight === "symbol" ? decodePerSideWeights(node) : undefined,
    opacity: node.opacity,
    cornerRadius: typeof node.cornerRadius === "number" ? node.cornerRadius : undefined,
    rectangleCornerRadii:
      typeof node.cornerRadius === "symbol" ? decodePerCornerRadii(node) : undefined,

    // Component metadata
    componentId: main?.id,
    mainComponent: mainComponentRef(main),
    componentKey:
      node.type === "COMPONENT" || node.type === "COMPONENT_SET" ? node.key || undefined : undefined,
    componentDescription:
      node.type === "COMPONENT" || node.type === "COMPONENT_SET" ? node.description || undefined : undefined,
    isExposedInstance: node.type === "INSTANCE" ? node.isExposedInstance : undefined,
    componentProperties: decodeComponentProps(node),
    componentPropertyDefinitions: decodePropertyDefinitions(node),
    overrides:
      node.type === "INSTANCE" && node.overrides?.length
        ? node.overrides.map((entry) => ({ id: entry.id, fields: [...entry.overriddenFields] }))
        : undefined,

    // Wire-divergent encodings, decoded rather than carried. Mixed TEXT fills
    // (per-run colors) fall back to the base run's fills — REST does the same,
    // carrying the base color on the node and the divergent runs as overrides.
    fills:
      typeof node.fills === "symbol" ? text?.style.fills : decodeScenePaints(node.fills),
    strokes: decodeScenePaints(node.strokes),
    effects: node.effects?.length ? node.effects.map(decodeSceneEffect) : undefined,

    // Text — override tables have no plugin spelling; the resolved segments
    // decode straight into per-line runs (Invariant 2)
    text,

    // Tokens: style slots named through the injected resolver; variable names are filled in below,
    // once every binding on this node (node fields, paints, text runs) has been decoded.
    styles: await decodeStyleSlots(node, resolveToken),
    boundVariables: decodeNodeVariables(node.boundVariables),

    // A container that HAS a child list keeps it even when it is empty — `[]` and `undefined` mean
    // different things downstream: core's `emptiedContainers` only records a node whose snapshot
    // had children and whose simplified output has none, which is how an emptied slot reads back
    // as emptied instead of as untouched. The REST adapter's `raw.children?.map(...)` preserves the
    // same distinction; collapsing `[]` to `undefined` here would split the two producers.
    children: "children" in node ? children : undefined,
  };
  await nameVariables(snapshot, resolveToken);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Paints
// ---------------------------------------------------------------------------

export function decodeScenePaints(
  paints: ReadonlyArray<ScenePaint> | symbol | undefined,
): SnapshotPaint[] | undefined {
  // Mixed fills only occur on TEXT nodes whose runs disagree; the caller falls
  // back to the text decode's base fills for that case.
  if (!paints || typeof paints === "symbol" || !paints.length) return undefined;
  const decoded: SnapshotPaint[] = [];
  for (const paint of paints) {
    const p = decodeScenePaint(paint);
    if (p) decoded.push(p);
  }
  return decoded;
}

/**
 * Decode a plugin `Paint` into a `SnapshotPaint`. A solid's alpha lives on the paint's `opacity`
 * (the color is RGB), so the snapshot color gets `a: 1` and the opacity rides along — the core
 * multiplies them, which is also how it treats REST's split. A paint kind outside the union is
 * dropped, mirroring the REST decoder's boundary rule for a runtime newer than the pinned typings.
 */
function decodeScenePaint(paint: ScenePaint): SnapshotPaint | undefined {
  switch (paint.type) {
    case "SOLID":
      return {
        type: "SOLID",
        color: { r: paint.color.r, g: paint.color.g, b: paint.color.b, a: 1 },
        colorVariable: variableRef(paint.boundVariables?.color),
        opacity: paint.opacity,
        blendMode: paint.blendMode,
        visible: paint.visible,
      };
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND":
      return {
        type: paint.type,
        stops: paint.gradientStops.map((stop) => ({ position: stop.position, color: stop.color })),
        handles: handlesFromTransform(paint.type, paint.gradientTransform),
        opacity: paint.opacity,
        blendMode: paint.blendMode,
        visible: paint.visible,
      };
    case "IMAGE":
      return {
        type: "IMAGE",
        ref: paint.imageHash ?? undefined,
        // The plugin's CROP is REST's STRETCH — same rendering, two wire words.
        scaleMode: paint.scaleMode === "CROP" ? "STRETCH" : paint.scaleMode,
        // The plugin stamps `scalingFactor: 1` and an identity `imageTransform` on every image
        // paint; REST carries each only for the mode it applies to (TILE, STRETCH). Passing the
        // stamps through would emit a scale and a crop the paint doesn't have.
        scalingFactor: paint.scaleMode === "TILE" ? (paint.scalingFactor ?? undefined) : undefined,
        crop:
          paint.scaleMode === "CROP" && paint.imageTransform
            ? toSnapshotTransform(paint.imageTransform)
            : undefined,
        opacity: paint.opacity,
        blendMode: paint.blendMode,
        rotation: paint.rotation,
        filters: paint.filters,
        visible: paint.visible,
      };
    case "PATTERN":
      return {
        type: "PATTERN",
        sourceNodeId: paint.sourceNodeId,
        scalingFactor: paint.scalingFactor,
        horizontalAlignment: paint.horizontalAlignment,
        verticalAlignment: paint.verticalAlignment,
        visible: paint.visible,
      };
    case "VIDEO":
    case "SHADER":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Plugin `gradientTransform` → REST-style handle positions, the snapshot's normalized gradient form.
 *
 * The transform maps normalized object space into gradient space, where each gradient type has
 * canonical handle homes: a linear runs x 0→1 along the centerline (start (0,.5), end (1,.5), width
 * point (0,1)); radial/angular/diamond center at (.5,.5) with the radius handle at (1,.5) and the
 * width handle at (.5,1). The object-space handles are those points pulled back through the INVERSE
 * transform — the same convention the community figma-plugin-helpers extractors use. A singular
 * transform has no defined pull-back; the canonical points themselves are returned, which the core's
 * degenerate-gradient path (zero-length line) renders benignly.
 */
function handlesFromTransform(
  type: SceneGradientPaint["type"],
  transform: SceneTransform,
): SnapshotVector[] {
  const probes: SnapshotVector[] =
    type === "GRADIENT_LINEAR"
      ? [
          { x: 0, y: 0.5 },
          { x: 1, y: 0.5 },
          { x: 0, y: 1 },
        ]
      : [
          { x: 0.5, y: 0.5 },
          { x: 1, y: 0.5 },
          { x: 0.5, y: 1 },
        ];

  const [[a, b, tx], [c, d, ty]] = transform;
  const det = a * d - b * c;
  if (det === 0) return probes;

  return probes.map(({ x, y }) => ({
    x: (d * (x - tx) - b * (y - ty)) / det,
    y: (-c * (x - tx) + a * (y - ty)) / det,
  }));
}

function toSnapshotTransform(transform: SceneTransform): SnapshotTransform {
  return transform.map((row) => [...row]);
}

// ---------------------------------------------------------------------------
// Text — getStyledTextSegments → per-line runs with deltas against a base.
// The counterpart of the REST adapter's override-table resolution
// (src/adapters/rest/decode/text.ts): both producers must land on the same base/delta
// split, so the run shape and merge behavior mirror that module.
// ---------------------------------------------------------------------------

/** The segment fields the decode requests — every run-diffable style the snapshot carries. */
const TEXT_SEGMENT_FIELDS: Array<keyof Omit<SceneTextSegment, "characters">> = [
  "fontName",
  "fontStyle",
  "fontWeight",
  "fontSize",
  "textDecoration",
  "textCase",
  "lineHeight",
  "letterSpacing",
  "fills",
  "hyperlink",
  "openTypeFeatures",
  "listOptions",
  "indentation",
  "paragraphSpacing",
  "paragraphIndent",
  "listSpacing",
  "boundVariables",
];

const LINE_BREAKS = /[\n\u2029]/;

/**
 * Decode a TEXT node's styled segments into `SnapshotText`.
 *
 * Base choice: the FIRST segment's style. When a node-level property isn't
 * `figma.mixed` every segment agrees with it, so this reads the same values as
 * the node; when it IS mixed there is no node-level truth, and the first run is
 * the deterministic stand-in (its delta is always empty) — matching how REST's
 * base style relates to override id 0 in the committed parity fixtures. The
 * properties that cannot vary per run (alignment) join the base from the node.
 */
function decodeSceneText(node: SceneNodeLike): SnapshotText {
  if (!node.getStyledTextSegments) {
    throw new FlcmError("internal", "this text layer's styled text runs couldn't be read.", { node: { type: node.type, name: node.name, id: node.id } });
  }
  const characters = node.characters ?? "";
  const segments = node.getStyledTextSegments(TEXT_SEGMENT_FIELDS);

  const base: SnapshotTextStyle = segments.length ? decodeSegmentStyle(segments[0]) : {};
  if (node.textAlignHorizontal !== undefined) base.textAlignHorizontal = node.textAlignHorizontal;
  if (node.textAlignVertical !== undefined) base.textAlignVertical = node.textAlignVertical;

  // Accumulated per line, projected onto SnapshotText's parallel arrays at the end.
  interface SceneLine {
    runs: SnapshotTextRun[];
    type: SnapshotText["lineTypes"][number];
    indentation: number;
    /** Whether a segment has already claimed this line's list membership. */
    hasMeta: boolean;
  }
  const newLine = (): SceneLine => ({ runs: [], type: "NONE", indentation: 0, hasMeta: false });
  const lines: SceneLine[] = [newLine()];

  for (const segment of segments) {
    const delta = styleDelta(decodeSegmentStyle(segment), base);
    const parts = segment.characters.split(LINE_BREAKS);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push(newLine());
      const part = parts[i];
      const line = lines[lines.length - 1];
      // A line's list membership comes from the segment covering its first
      // character — list options only change at paragraph boundaries, so that
      // segment speaks for the whole line. An EMPTY line's first character is
      // its own terminating newline, which this segment covers whenever more
      // parts follow (i < last); that keeps an empty list item's bullet, which
      // REST reads off the wire's per-line arrays. A trailing empty final
      // paragraph has no characters at all, so its membership is unknowable
      // from segments and keeps the NONE/0 defaults.
      if (!line.hasMeta && (part !== "" || i < parts.length - 1)) {
        line.type = segment.listOptions?.type ?? "NONE";
        line.indentation = segment.indentation ?? 0;
        line.hasMeta = true;
      }
      if (!part) continue;
      const previous = line.runs[line.runs.length - 1];
      if (previous && JSON.stringify(previous.delta) === JSON.stringify(delta)) {
        previous.text += part;
      } else {
        line.runs.push({ text: part, delta });
      }
    }
  }

  return {
    characters,
    style: base,
    lines: lines.map((line) => line.runs),
    lineTypes: lines.map((line) => line.type),
    lineIndentations: lines.map((line) => line.indentation),
  };
}

/**
 * Decode one segment's plugin-native fields into the snapshot's raw text style.
 * Only fields the segment carries are emitted (the REST decode's present-keys
 * rule — the delta diff and the core's run classifier iterate present keys).
 */
export function decodeSegmentStyle(segment: SceneTextSegment): SnapshotTextStyle {
  const out: SnapshotTextStyle = {};
  if (segment.fontName?.family !== undefined) out.fontFamily = segment.fontName.family;
  // The variant name ("Bold Italic") is what REST calls `fontStyle`; the
  // segment's own two-value `fontStyle` is REST's `italic` boolean. `false` is
  // emitted too — a regular run inside an italic base needs the explicit
  // `italic: false` delta to trigger the core's inverse-italic override.
  if (segment.fontName?.style !== undefined) out.fontStyle = segment.fontName.style;
  if (segment.fontStyle !== undefined) out.italic = segment.fontStyle === "ITALIC";
  if (segment.fontWeight !== undefined) out.fontWeight = segment.fontWeight;
  if (segment.fontSize !== undefined) out.fontSize = segment.fontSize;
  if (segment.lineHeight) {
    // Plugin LineHeight → REST's spelling the core's formatter reads. AUTO is
    // REST's INTRINSIC_% (follow the font's metrics), which formats to nothing.
    if (segment.lineHeight.unit === "PIXELS") {
      out.lineHeightPx = segment.lineHeight.value;
      out.lineHeightUnit = "PIXELS";
    } else if (segment.lineHeight.unit === "PERCENT") {
      out.lineHeightPercentFontSize = segment.lineHeight.value;
      out.lineHeightUnit = "FONT_SIZE_%";
    } else {
      out.lineHeightUnit = "INTRINSIC_%";
    }
  }
  if (segment.letterSpacing) {
    // REST letter-spacing is absolute px; PERCENT is relative to the segment's
    // own font size.
    out.letterSpacing =
      segment.letterSpacing.unit === "PERCENT"
        ? ((segment.fontSize ?? 0) * segment.letterSpacing.value) / 100
        : segment.letterSpacing.value;
  }
  if (segment.textCase !== undefined) out.textCase = segment.textCase;
  if (segment.textDecoration !== undefined) out.textDecoration = segment.textDecoration;
  if (segment.hyperlink) {
    out.hyperlink =
      segment.hyperlink.type === "URL"
        ? { type: "URL", url: segment.hyperlink.value }
        : { type: "NODE", nodeID: segment.hyperlink.value };
  }
  if (segment.openTypeFeatures) {
    const flags = decodeOpenTypeFeatures(segment.openTypeFeatures);
    if (flags) out.opentypeFlags = flags;
  }
  if (segment.paragraphSpacing !== undefined) out.paragraphSpacing = segment.paragraphSpacing;
  if (segment.paragraphIndent !== undefined) out.paragraphIndent = segment.paragraphIndent;
  if (segment.listSpacing !== undefined) out.listSpacing = segment.listSpacing;
  const fills = segment.fills ? decodeScenePaints(segment.fills) : undefined;
  if (fills) out.fills = fills;
  const boundVariables = decodeTextVariables(segment.boundVariables);
  if (boundVariables) out.boundVariables = boundVariables;
  return out;
}

/** Text fields the snapshot carries bindings for; fontStyle has no vocabulary word to bind. */
const TEXT_VARIABLE_FIELDS: ReadonlyArray<SnapshotTextVariableField> = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "paragraphSpacing",
  "paragraphIndent",
];

function decodeTextVariables(
  bound: SceneTextSegment["boundVariables"],
): SnapshotTextVariables | undefined {
  if (!bound) return undefined;
  const out: SnapshotTextVariables = {};
  for (const field of TEXT_VARIABLE_FIELDS) {
    const ref = variableRef(bound[field]);
    if (ref) out[field] = ref;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * REST spells enabled OpenType features as numeric flags. Only enabled features
 * are carried (the core drops zero flags), and keys are sorted so two segments'
 * flag objects stringify identically for the delta compare.
 */
function decodeOpenTypeFeatures(features: {
  readonly [feature: string]: boolean;
}): Record<string, number> | undefined {
  const enabled = Object.keys(features)
    .filter((feature) => features[feature])
    .sort();
  if (!enabled.length) return undefined;
  const flags: Record<string, number> = {};
  for (const feature of enabled) flags[feature] = 1;
  return flags;
}

/**
 * A run's delta: the segment-style keys whose value differs from the base.
 * JSON.stringify equality is sound here because both sides come from
 * `decodeSegmentStyle`, which emits keys in one fixed order.
 */
// The literal keys each bindable text field reads from.
const TEXT_VARIABLE_LITERAL_KEYS: Record<SnapshotTextVariableField, readonly (keyof SnapshotTextStyle)[]> = {
  fontFamily: ["fontFamily"],
  fontSize: ["fontSize"],
  fontWeight: ["fontWeight"],
  lineHeight: ["lineHeightPx", "lineHeightUnit", "lineHeightPercentFontSize"],
  letterSpacing: ["letterSpacing"],
  paragraphSpacing: ["paragraphSpacing"],
  paragraphIndent: ["paragraphIndent"],
};

function styleDelta(style: SnapshotTextStyle, base: SnapshotTextStyle): SnapshotTextStyle {
  const delta: Record<string, unknown> = {};
  const baseRecord = base as Record<string, unknown>;
  for (const [key, value] of Object.entries(style)) {
    if (JSON.stringify(value) !== JSON.stringify(baseRecord[key])) delta[key] = value;
  }
  // A segment unbound where the base is bound differs even at an equal value: its literal rides in
  // the delta, or the run would merge into its bound neighbour and read back bound.
  for (const field of TEXT_VARIABLE_FIELDS) {
    if (!base.boundVariables?.[field] || style.boundVariables?.[field]) continue;
    for (const key of TEXT_VARIABLE_LITERAL_KEYS[field]) if (style[key] !== undefined) delta[key] = style[key];
  }
  return delta as SnapshotTextStyle;
}

// ---------------------------------------------------------------------------
// Effects / per-side / per-corner scalars
// ---------------------------------------------------------------------------

export function decodeSceneEffect(effect: SceneEffect): SnapshotEffect {
  // Field by field like the node itself: a live Effect also carries `boundVariables`, `blendMode`,
  // `showShadowBehindNode`, which the contract doesn't declare and REST has no counterpart for.
  // Only `radius` needs a default; every other value is raw Figma-domain already.
  return {
    type: effect.type,
    visible: effect.visible,
    color: effect.color,
    offset: effect.offset,
    radius: effect.radius ?? 0,
    spread: effect.spread,
    lightIntensity: effect.lightIntensity,
    lightAngle: effect.lightAngle,
    refraction: effect.refraction,
    depth: effect.depth,
    dispersion: effect.dispersion,
    noiseType: effect.noiseType,
    noiseSize: effect.noiseSize,
    density: effect.density,
    secondaryColor: effect.secondaryColor,
    opacity: effect.opacity,
    clipToShape: effect.clipToShape,
    blurType: effect.blurType,
    startRadius: effect.startRadius,
    startOffset: effect.startOffset,
    endOffset: effect.endOffset,
  };
}

function decodePerSideWeights(node: SceneNodeLike): NodeSnapshot["individualStrokeWeights"] {
  return {
    top: node.strokeTopWeight ?? 0,
    right: node.strokeRightWeight ?? 0,
    bottom: node.strokeBottomWeight ?? 0,
    left: node.strokeLeftWeight ?? 0,
  };
}

function decodePerCornerRadii(node: SceneNodeLike): number[] {
  // REST/CSS order: top-left, top-right, bottom-right, bottom-left.
  return [
    node.topLeftRadius ?? 0,
    node.topRightRadius ?? 0,
    node.bottomRightRadius ?? 0,
    node.bottomLeftRadius ?? 0,
  ];
}

function decodeOverflow(
  direction: SceneNodeLike["overflowDirection"],
): NodeSnapshot["overflowDirection"] {
  switch (direction) {
    case "HORIZONTAL":
      return "HORIZONTAL_SCROLLING";
    case "VERTICAL":
      return "VERTICAL_SCROLLING";
    case "BOTH":
      return "HORIZONTAL_AND_VERTICAL_SCROLLING";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Component metadata
// ---------------------------------------------------------------------------

async function mainComponentOf(node: SceneNodeLike): Promise<MainComponentLike | null> {
  if (node.type !== "INSTANCE" || !node.getMainComponentAsync) return null;
  return await node.getMainComponentAsync();
}

/** The live main component as plan-neutral provenance — the plugin's answer to REST's tables. */
function mainComponentRef(main: MainComponentLike | null): NodeSnapshot["mainComponent"] {
  if (!main) return undefined;
  const ref: NonNullable<NodeSnapshot["mainComponent"]> = { name: main.name ?? main.id };
  if (main.key) ref.key = main.key;
  const parent = main.parent;
  if (parent && parent.type === "COMPONENT_SET") {
    ref.set = {
      id: parent.id,
      key: parent.key || undefined,
      name: parent.name ?? parent.id,
      description: parent.description || undefined,
    };
  }
  return ref;
}

function isScalarPropertyValue(value: unknown): value is boolean | string {
  return typeof value === "boolean" || typeof value === "string";
}

/**
 * An instance's property values, minus SLOT entries: their `{ guid }` value names the slot's content
 * container, which is already the SLOT node in this instance's subtree — the REST adapter drops them
 * the same way.
 */
function decodeComponentProps(node: SceneNodeLike): NodeSnapshot["componentProperties"] {
  if (node.type !== "INSTANCE" || !node.componentProperties) return undefined;
  const out: Record<string, { type: string; value: boolean | string }> = {};
  for (const [key, { type, value }] of Object.entries(node.componentProperties)) {
    if (isScalarPropertyValue(value)) out[key] = { type, value };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Property definitions live on a COMPONENT_SET or a standalone COMPONENT — reading the property on a
 * set's variant COMPONENT throws in the live API (the set owns them), so the variant case is skipped
 * by parent check before the access. REST agrees: a variant carries none on the wire either.
 *
 * Every type survives, keeping its type; `variantOptions` rides along for VARIANT. No default:
 * in a main component it is always the bound layer's own content, which the tree carries. `preferredValues` / `slotSettings` / `description` are
 * deliberately not carried — nothing downstream needs them to reproduce or modify an instance.
 */
function decodePropertyDefinitions(node: SceneNodeLike): NodeSnapshot["componentPropertyDefinitions"] {
  const owns =
    node.type === "COMPONENT_SET" ||
    (node.type === "COMPONENT" && node.parent?.type !== "COMPONENT_SET");
  if (!owns || !node.componentPropertyDefinitions) return undefined;
  const out: NonNullable<NodeSnapshot["componentPropertyDefinitions"]> = {};
  for (const [key, def] of Object.entries(node.componentPropertyDefinitions)) {
    const decoded: (typeof out)[string] = { type: def.type };
    if (def.variantOptions) decoded.variantOptions = [...def.variantOptions];
    out[key] = decoded;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Tokens — named styles and variable bindings
// ---------------------------------------------------------------------------

// Plugin per-slot style-id properties → the snapshot's slot names. A mixed textStyleId (per-run
// styles) has no single node-level slot and is skipped: per-run text styles are out of scope.
const STYLE_SLOTS = [
  ["fill", "fillStyleId"],
  ["stroke", "strokeStyleId"],
  ["text", "textStyleId"],
  ["effect", "effectStyleId"],
  ["grid", "gridStyleId"],
] as const satisfies ReadonlyArray<readonly [SnapshotStyleSlot, keyof SceneNodeLike]>;

async function decodeStyleSlots(
  node: SceneNodeLike,
  resolveToken: SceneTokenResolver,
): Promise<NodeSnapshot["styles"]> {
  const resolved: NonNullable<NodeSnapshot["styles"]> = {};
  for (const [slot, prop] of STYLE_SLOTS) {
    const styleId = node[prop];
    if (typeof styleId !== "string" || !styleId) continue;
    const style = await resolveToken("style", styleId);
    // A style's KEY is its id in the read: REST knows a style only by key (its node-local styleId
    // is a REST-only number), and the write side resolves a key as well as a plugin `S:` id.
    const id = style?.key || styleId;
    resolved[slot] = style?.name ? namedRef(id, style) : { id };
  }
  return Object.keys(resolved).length ? resolved : undefined;
}

function namedRef(id: string, token: { name: string; nameSuffices?: boolean }): SnapshotTokenRef {
  return token.nameSuffices ? { id, name: token.name, nameSuffices: true } : { id, name: token.name };
}

function variableRef(alias: SceneVariableAlias | undefined): SnapshotTokenRef | undefined {
  return alias?.id ? { id: alias.id } : undefined;
}

const NODE_VARIABLE_FIELDS = [
  "width",
  "height",
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
  "strokeTopWeight",
  "strokeRightWeight",
  "strokeBottomWeight",
  "strokeLeftWeight",
  "opacity",
] as const satisfies ReadonlyArray<SnapshotNodeVariableField>;

/** The per-part fields a whole-node binding stands for. */
const WHOLE_NODE_BINDING: Partial<Record<SnapshotNodeVariableField, "strokeWeight" | "cornerRadius">> = {
  strokeTopWeight: "strokeWeight",
  strokeRightWeight: "strokeWeight",
  strokeBottomWeight: "strokeWeight",
  strokeLeftWeight: "strokeWeight",
  topLeftRadius: "cornerRadius",
  topRightRadius: "cornerRadius",
  bottomRightRadius: "cornerRadius",
  bottomLeftRadius: "cornerRadius",
};

/**
 * Node-field bindings in the snapshot's field names. A whole-node `strokeWeight` / `cornerRadius`
 * binding stands for every side / corner without a binding of its own — REST only ever states the
 * per-part form, so this keeps the two producers' snapshots alike.
 */
function decodeNodeVariables(bound: SceneNodeVariables | undefined): SnapshotNodeVariables | undefined {
  if (!bound) return undefined;
  const out: SnapshotNodeVariables = {};
  for (const field of NODE_VARIABLE_FIELDS) {
    const whole = WHOLE_NODE_BINDING[field];
    const ref = variableRef(bound[field] ?? (whole && bound[whole]));
    if (ref) out[field] = ref;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Name every variable ref this node's own snapshot carries — node fields, paints, the text base and
 * each run. Runs after the decode because paints and segments decode synchronously; the refs are the
 * ones this node just built, so filling in `name` mutates nothing anyone else holds.
 */
async function nameVariables(snapshot: NodeSnapshot, resolveToken: SceneTokenResolver): Promise<void> {
  const paintRefs = (paints: SnapshotPaint[] | undefined) =>
    (paints ?? []).flatMap((paint) => (paint.type === "SOLID" && paint.colorVariable ? [paint.colorVariable] : []));
  const textRefs = (style: SnapshotTextStyle) => [
    ...Object.values(style.boundVariables ?? {}),
    ...paintRefs(style.fills),
  ];
  const refs = [
    ...Object.values(snapshot.boundVariables ?? {}),
    ...paintRefs(snapshot.fills),
    ...paintRefs(snapshot.strokes),
    ...(snapshot.text
      ? [snapshot.text.style, ...snapshot.text.lines.flat().map((run) => run.delta)].flatMap(textRefs)
      : []),
  ];
  for (const ref of refs) {
    const variable = await resolveToken("variable", ref.id);
    if (variable?.name) Object.assign(ref, namedRef(ref.id, variable));
  }
}
