// node-to-snapshot — the plugin adapter to `NodeSnapshot` (Invariant 2), the counterpart of the REST
// adapter (src/adapters/rest/node-to-snapshot.ts). It decodes plugin-native forms DIRECTLY onto the
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

import { isCoordinateTransparentType } from "~/core/index.js";
import type {
  NodeSnapshot,
  SnapshotColor,
  SnapshotEffect,
  SnapshotPaint,
  SnapshotPoint,
  SnapshotStyleRef,
  SnapshotText,
  SnapshotTextRun,
  SnapshotTextStyle,
  SnapshotTransform,
  SnapshotVector,
} from "../../../src/core/snapshot.js";

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

export interface SceneSolidPaint {
  type: "SOLID";
  /** Plugin solids carry alpha on the paint's `opacity`, never in the color. */
  color: SceneRGB;
  opacity?: number;
  blendMode?: string;
  visible?: boolean;
}

export interface SceneGradientPaint {
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  /** Normalized object space → gradient space (see handlesFromTransform). */
  gradientTransform: SceneTransform;
  gradientStops: ReadonlyArray<{ position: number; color: SnapshotColor }>;
  opacity?: number;
  visible?: boolean;
}

export interface SceneImagePaint {
  type: "IMAGE";
  imageHash: string | null;
  scaleMode: "FILL" | "FIT" | "CROP" | "TILE";
  scalingFactor?: number | null;
  imageTransform?: SceneTransform;
  visible?: boolean;
}

export interface ScenePatternPaint {
  type: "PATTERN";
  sourceNodeId: string;
  scalingFactor: number;
  horizontalAlignment?: "START" | "CENTER" | "END";
  verticalAlignment?: "START" | "CENTER" | "END";
  visible?: boolean;
}

export type ScenePaint = SceneSolidPaint | SceneGradientPaint | SceneImagePaint | ScenePatternPaint;

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
}

export interface SceneNodeLike {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly visible?: boolean;
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
  readonly layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  readonly layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
  readonly layoutAlign?: "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX";
  readonly layoutGrow?: number;
  readonly layoutPositioning?: "AUTO" | "ABSOLUTE";
  /** The plugin spelling of REST's `preserveRatio`. */
  readonly constrainProportions?: boolean;
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
  readonly primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  readonly counterAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "BASELINE";
  readonly counterAxisAlignContent?: "AUTO" | "SPACE_BETWEEN";
  readonly layoutWrap?: "NO_WRAP" | "WRAP";
  readonly itemSpacing?: number;
  readonly counterAxisSpacing?: number | null;
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
    fields: ReadonlyArray<string>,
  ) => ReadonlyArray<SceneTextSegment>;

  // Named-style slots — style ids resolved to names through the injected resolver
  readonly fillStyleId?: string | symbol;
  readonly strokeStyleId?: string;
  readonly textStyleId?: string | symbol;
  readonly effectStyleId?: string;
  readonly gridStyleId?: string;

  // Component metadata. The value/defaultValue are `unknown` on purpose: a SLOT property's is a
  // `{ guid }` object on the wire (REST verified live; the plugin typings still say `string | boolean`),
  // and the decode below keeps only the scalars.
  readonly componentProperties?: {
    readonly [key: string]: { readonly type: string; readonly value: unknown };
  };
  readonly componentPropertyDefinitions?: {
    readonly [key: string]: {
      readonly type: string;
      readonly defaultValue: unknown;
      readonly variantOptions?: ReadonlyArray<string>;
    };
  };
  readonly getMainComponentAsync?: () => Promise<{ readonly id: string } | null>;
  /** INSTANCE: direct overrides on its sublayers, plugin field spellings (`NodeChangeProperty`). */
  readonly overrides?: ReadonlyArray<{ readonly id: string; readonly overriddenFields: ReadonlyArray<string> }>;
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
  const dx = own.x - parentSpace.origin.x;
  const dy = own.y - parentSpace.origin.y;
  if (!parentSpace.rotation) return { x: dx, y: dy };
  const theta = (parentSpace.rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/**
 * Resolves a style id to its published name (`figma.getStyleByIdAsync` on the live path; a fixture
 * table in the parity harness). Injected because it is the one lookup that isn't node-local, and this
 * module can't touch the `figma` global. A null resolution drops the slot — mirroring the REST
 * adapter's rule that only styles the design named survive.
 */
export type SceneStyleResolver = (styleId: string) => Promise<{ name: string } | null>;

/**
 * Plugin adapter: decode a live-shaped scene node (and its subtree) into the plan-neutral
 * `NodeSnapshot` for `simplify`. All `figma.*` liveness stays with the caller (the read walk) — by
 * the time values reach here they are plain data plus the node-local methods the view declares.
 */
export async function sceneNodeToSnapshot(
  node: SceneNodeLike,
  resolveStyle: SceneStyleResolver,
): Promise<NodeSnapshot> {
  return sceneSubtreeToSnapshot(node, resolveStyle, CONTAINER_PARENT_SPACE);
}

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

/**
 * The recursive body. `parentSpace` is walk state rather than a caller-supplied
 * argument — like the REST adapter's `RestParentSpace`, a node's parent-relative
 * origin is only knowable from what its parent resolved to.
 */
async function sceneSubtreeToSnapshot(
  node: SceneNodeLike,
  resolveStyle: SceneStyleResolver,
  parentSpace: SceneParentSpace,
): Promise<NodeSnapshot> {
  const text = node.type === "TEXT" ? decodeSceneText(node) : undefined;

  const childSpace: SceneParentSpace = isCoordinateTransparentType(node.type)
    ? { transparent: true, origin: ownXY(node), rotation: node.rotation ?? 0 }
    : CONTAINER_PARENT_SPACE;
  const children = await Promise.all(
    (node.children ?? []).map((child) => sceneSubtreeToSnapshot(child, resolveStyle, childSpace)),
  );

  return {
    id: node.id,
    name: node.name,
    type: node.type === "POLYGON" ? "REGULAR_POLYGON" : node.type,
    visible: node.visible,
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
    layoutSizingHorizontal: node.layoutSizingHorizontal,
    layoutSizingVertical: node.layoutSizingVertical,
    layoutAlign: node.layoutAlign,
    layoutGrow: node.layoutGrow === 1 ? 1 : undefined,
    layoutPositioning: node.layoutPositioning,
    preserveRatio: node.constrainProportions || undefined,
    rotation: node.rotation || undefined,
    gridColumnAnchorIndex: node.gridColumnAnchorIndex,
    gridRowAnchorIndex: node.gridRowAnchorIndex,
    gridColumnSpan: node.gridColumnSpan,
    gridRowSpan: node.gridRowSpan,
    gridChildHorizontalAlign: node.gridChildHorizontalAlign,
    gridChildVerticalAlign: node.gridChildVerticalAlign,

    // Frame / auto-layout container traits. gridColumnsSizing/gridRowsSizing (REST's track-template
    // strings) are deliberately absent — the plugin API exposes per-track objects, not the template
    // string; carrying them lands with grid-read support, not here.
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
    componentId: await mainComponentId(node),
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

    // Named styles: per-slot resolved names via the injected resolver
    styles: await decodeStyleSlots(node, resolveStyle),

    children: children.length ? children : undefined,
  };
}

// ---------------------------------------------------------------------------
// Paints
// ---------------------------------------------------------------------------

function decodeScenePaints(
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
        visible: paint.visible,
      };
    case "IMAGE":
      return {
        type: "IMAGE",
        ref: paint.imageHash ?? undefined,
        // The plugin's CROP is REST's STRETCH — same rendering, two wire words.
        scaleMode: paint.scaleMode === "CROP" ? "STRETCH" : paint.scaleMode,
        scalingFactor: paint.scalingFactor ?? undefined,
        crop: paint.imageTransform ? toSnapshotTransform(paint.imageTransform) : undefined,
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
// (src/adapters/rest/text.ts): both producers must land on the same base/delta
// split, so the run shape and merge behavior mirror that module.
// ---------------------------------------------------------------------------

/** The segment fields the decode requests — every run-diffable style the snapshot carries. */
const TEXT_SEGMENT_FIELDS: ReadonlyArray<keyof Omit<SceneTextSegment, "characters">> = [
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
    throw new Error("flcm: TEXT node without getStyledTextSegments (scene fixture missing segments?)");
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
function decodeSegmentStyle(segment: SceneTextSegment): SnapshotTextStyle {
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
  return out;
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
function styleDelta(style: SnapshotTextStyle, base: SnapshotTextStyle): SnapshotTextStyle {
  const delta: Record<string, unknown> = {};
  const baseRecord = base as Record<string, unknown>;
  for (const [key, value] of Object.entries(style)) {
    if (JSON.stringify(value) !== JSON.stringify(baseRecord[key])) delta[key] = value;
  }
  return delta as SnapshotTextStyle;
}

// ---------------------------------------------------------------------------
// Effects / per-side / per-corner scalars
// ---------------------------------------------------------------------------

function decodeSceneEffect(effect: SceneEffect): SnapshotEffect {
  // SceneEffect carries exactly SnapshotEffect's fields (base + the beyond-CSS bag, all raw Figma-domain),
  // so spread it through; only `radius` needs a default. The core reads only the fields its per-type
  // branch needs.
  return { ...effect, radius: effect.radius ?? 0 };
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

async function mainComponentId(node: SceneNodeLike): Promise<string | undefined> {
  if (node.type !== "INSTANCE" || !node.getMainComponentAsync) return undefined;
  const main = await node.getMainComponentAsync();
  return main?.id;
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
 * Every type survives, a SLOT def keeping its type and losing only its `{ guid }` default;
 * `variantOptions` rides along for VARIANT. `preferredValues` / `slotSettings` / `description` are
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
    if (isScalarPropertyValue(def.defaultValue)) decoded.defaultValue = def.defaultValue;
    if (def.variantOptions) decoded.variantOptions = [...def.variantOptions];
    out[key] = decoded;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Named styles
// ---------------------------------------------------------------------------

// Plugin per-slot style-id properties → REST's slot names, so the snapshot's `styles` map speaks one
// vocabulary. A mixed textStyleId (per-run styles) has no single node-level slot and is skipped.
const STYLE_SLOTS = [
  ["fill", "fillStyleId"],
  ["stroke", "strokeStyleId"],
  ["text", "textStyleId"],
  ["effect", "effectStyleId"],
  ["grid", "gridStyleId"],
] as const;

async function decodeStyleSlots(
  node: SceneNodeLike,
  resolveStyle: SceneStyleResolver,
): Promise<Record<string, SnapshotStyleRef> | undefined> {
  const resolved: Record<string, SnapshotStyleRef> = {};
  for (const [slot, prop] of STYLE_SLOTS) {
    const styleId = node[prop];
    if (typeof styleId !== "string" || !styleId) continue;
    const style = await resolveStyle(styleId);
    if (style?.name) resolved[slot] = { name: style.name, id: styleId };
  }
  return Object.keys(resolved).length ? resolved : undefined;
}
