/**
 * `NodeSnapshot` — the plan-neutral, core-owned INPUT to `simplify`.
 *
 * This is the raw structural form the transform consumes: the wire encodings are
 * decoded (text as runs, uniform image ref, normalized gradient, resolved
 * style/component metadata, no top-level tables), but the values are still raw
 * (RGBA floats, numeric sizes, raw layout traits) — CSS conversion + dedup is
 * `simplify`'s sole job, never an adapter's (Invariant 5). One core, two
 * producers: `restNodeToSnapshot` (server) and `sceneNodeToSnapshot` (plugin,
 * out of scope here) both feed this identical shape (Invariant 2).
 *
 * IMPORTANT: this type is deliberately a *structural subset* of a Figma
 * `Node` for the ~1:1 fields (same names, compatible value types), so raw Figma
 * nodes remain assignable during the incremental carve. It carries NO
 * `@figma/rest-api-spec` import — the core module graph must stay Figma-free
 * (Invariant 2 / Phase 1 Done-when). The type grows one concern at a time as
 * each transformer migrates off Figma types onto the snapshot.
 */
/** A node's own width/height in px (Figma plugin `node.width`/`node.height`). */
export interface SnapshotSize {
  width: number;
  height: number;
}

/** A point in px within some node's coordinate space (Figma plugin `node.x`/`node.y`). */
export interface SnapshotPoint {
  x: number;
  y: number;
}

/**
 * Axis-aligned box in absolute coordinates (Figma `Rectangle`, decoupled). Its
 * two halves are the vocabulary above, declared rather than restated: a producer
 * that can supply only one half (`ownSize` without `ownOrigin`, say) still hands
 * the core a value the same call sites accept.
 */
export interface SnapshotRect extends SnapshotPoint, SnapshotSize {}

/** Per-side stroke weights (Figma `StrokeWeights`, decoupled). */
export interface SnapshotStrokeWeights {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Straight-alpha RGBA, channels 0..1 (Figma `RGBA`, decoupled). */
export interface SnapshotColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 2D point in normalized (0..1) paint space (Figma `Vector`, decoupled). */
export interface SnapshotVector {
  x: number;
  y: number;
}

/**
 * 2x3 affine image-crop matrix, row-major
 * (`[[scaleX, skewX, translateX], [skewY, scaleY, translateY]]`). Mirrors Figma's
 * `Transform` (`number[][]`) exactly so the value passes through to the image
 * download path (which still speaks `Transform`) without conversion.
 */
export type SnapshotTransform = number[][];

// ---------------------------------------------------------------------------
// Paints — DECODED from the wire: solid/pattern map ~1:1, but the image ref is
// uniform (`ref`, not REST's `imageRef`) and the gradient is normalized to
// {stops, handles} (not REST's gradientHandlePositions). This is a decode the
// adapter owns; the plugin adapter (out of scope) derives the same shape from
// its own wire form. See ADR/plan: {stops, handles} keeps simplify's
// gradient math (which works off handle vectors) behavior-identical.
// ---------------------------------------------------------------------------
export interface SnapshotSolidPaint {
  type: "SOLID";
  color: SnapshotColor;
  opacity?: number;
  /** Figma BlendMode; the core only distinguishes NORMAL/PASS_THROUGH from the rest. */
  blendMode?: string;
  visible?: boolean;
}

export interface SnapshotGradientPaint {
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  stops: { position: number; color: SnapshotColor }[];
  /** Gradient line/handle vectors in normalized paint space (REST gradientHandlePositions). */
  handles: SnapshotVector[];
  opacity?: number;
  visible?: boolean;
}

export interface SnapshotImagePaint {
  type: "IMAGE";
  /** Uniform image asset ref (REST `imageRef`). */
  ref?: string;
  /** Animated-GIF ref (REST `gifRef`). */
  gifRef?: string;
  scaleMode: "FILL" | "FIT" | "TILE" | "STRETCH";
  scalingFactor?: number;
  /** Crop transform matrix (REST `imageTransform`), present when the image is cropped. */
  crop?: SnapshotTransform;
  visible?: boolean;
}

export interface SnapshotPatternPaint {
  type: "PATTERN";
  sourceNodeId: string;
  scalingFactor: number;
  horizontalAlignment?: "START" | "CENTER" | "END";
  verticalAlignment?: "START" | "CENTER" | "END";
  visible?: boolean;
}

export type SnapshotPaint =
  | SnapshotSolidPaint
  | SnapshotGradientPaint
  | SnapshotImagePaint
  | SnapshotPatternPaint;

/** A visual effect (shadow/blur), raw values (Figma `Effect` subset, decoupled). */
export interface SnapshotEffect {
  type: string;
  visible?: boolean;
  color?: SnapshotColor;
  offset?: SnapshotVector;
  radius: number;
  spread?: number;

  // Beyond-CSS effects (GLASS / NOISE / TEXTURE, and the PROGRESSIVE variant of a LAYER_BLUR) — the
  // newest Figma effects, which have no CSS spelling and read back as the flcm.effects({...}) object
  // form. Only the plugin adapter (`sceneNodeToSnapshot`) populates these; REST can't see them, so
  // `restNodeToSnapshot` leaves them absent. All values are raw Figma-domain — `radius` here is a Figma
  // radius, NOT halved the way a plain LAYER_BLUR/BACKGROUND_BLUR radius is (there is no CSS px to scale
  // from). Fields are grouped by the effect that carries them; `radius`/`color` above are reused.
  // glass
  lightIntensity?: number;
  lightAngle?: number;
  refraction?: number;
  depth?: number;
  dispersion?: number;
  // noise (MONOTONE / DUOTONE / MULTITONE); `color` above is the primary grain color
  noiseType?: string;
  noiseSize?: number;
  density?: number;
  secondaryColor?: SnapshotColor;
  opacity?: number;
  // texture reuses `noiseSize` + `radius`
  clipToShape?: boolean;
  // progressive layer-blur: `radius` above is the END radius, ramped from `startRadius` along the
  // `startOffset`→`endOffset` axis (offsets normalized to the node's 0–1 object space)
  blurType?: string;
  startRadius?: number;
  startOffset?: SnapshotVector;
  endOffset?: SnapshotVector;
}

// ---------------------------------------------------------------------------
// Text — DECODED from the wire. The REST override tables
// (characterStyleOverrides + styleOverrideTable) are resolved by the adapter
// into per-line runs, each carrying its own style delta against the base; the
// core only classifies + renders these. The wire tables never reach the core
// (Invariant 2) — the plugin adapter derives the same runs from its own form
// rather than faking a REST override table.
// ---------------------------------------------------------------------------

/** Link on a text run/style (Figma `Hyperlink`, decoupled). */
export interface SnapshotHyperlink {
  type: "URL" | "NODE";
  url?: string;
  nodeID?: string;
}

/**
 * A text style — the subset of Figma `TypeStyle` the text transform reads,
 * decoupled from the wire type. Used both as a text node's base style and (as a
 * per-run delta) for the properties a run overrides. `fills` is decoded to
 * `SnapshotPaint` so the core never touches REST paints. Values are raw (numeric
 * weights/sizes, enum tags); CSS conversion is the core's job.
 */
export interface SnapshotTextStyle {
  fontFamily?: string;
  fontStyle?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  lineHeightUnit?: string;
  lineHeightPercent?: number;
  lineHeightPercentFontSize?: number;
  letterSpacing?: number;
  textCase?: string;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  italic?: boolean;
  textDecoration?: string;
  hyperlink?: SnapshotHyperlink;
  opentypeFlags?: Record<string, number>;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  listSpacing?: number;
  fills?: SnapshotPaint[];
}

/** A run of characters sharing one style delta against the node's base style. */
export interface SnapshotTextRun {
  text: string;
  /** Only the properties that differ from the base style. */
  delta: SnapshotTextStyle;
}

/**
 * Decoded text content of a TEXT node. `lines` holds the merged runs per line
 * (line boundaries at `\n` / paragraph separator), aligned index-for-index with
 * `lineTypes` / `lineIndentations`. `lines` is empty when the node has no base
 * style (the core then emits the characters as plain escaped text).
 */
export interface SnapshotText {
  characters: string;
  style: SnapshotTextStyle;
  lines: SnapshotTextRun[][];
  lineTypes: Array<"NONE" | "ORDERED" | "UNORDERED">;
  lineIndentations: number[];
}

// ---------------------------------------------------------------------------
// Named styles — DECODED from the wire. REST scatters this across two places:
// the node's `styles` map (style-slot → styleId) and the top-level `styles`
// table (styleId → { name, ... }). The adapter joins them into per-slot resolved
// names folded on-node; the top-level table never reaches the core (Invariant 2).
// ---------------------------------------------------------------------------

/** A resolved named-style reference (Figma named style), folded on-node by the adapter. */
export interface SnapshotStyleRef {
  name: string;
  id: string;
}

// ---------------------------------------------------------------------------
// Component metadata — ~1:1 structural records (Figma component traits), typed
// snapshot-locally so the core reads them without a REST import. The top-level
// components/componentSets *tables* are a separate adapter concern (decoded in
// src/adapters/rest/rest.ts); these are the per-node fields the walk reads.
// ---------------------------------------------------------------------------

/**
 * An INSTANCE's resolved component-property value (Figma `ComponentPropertyValue` subset).
 * `type` is BOOLEAN / TEXT / INSTANCE_SWAP / VARIANT. An INSTANCE_SWAP value is the main
 * component's node id on both producers (REST verified live; the plugin's `setProperties`
 * takes the same id).
 *
 * SLOT entries never reach the snapshot: the wire value is a `{ guid }` object naming the
 * slot's content container, and the SLOT node in the instance's subtree already IS that
 * content. Both adapters drop them.
 */
export interface SnapshotComponentPropertyValue {
  type: string;
  value: boolean | string;
}

/**
 * A COMPONENT/COMPONENT_SET property definition (Figma `ComponentPropertyDefinition` subset).
 * `type` is BOOLEAN / TEXT / INSTANCE_SWAP / VARIANT / SLOT. Figma keeps these on the SET for
 * a variant's properties — a variant COMPONENT under a set carries none on either producer.
 */
export interface SnapshotComponentPropertyDefinition {
  type: string;
  /**
   * Absent on SLOT: the wire default is a `{ guid }` object (REST) that names no value an
   * agent can set. Present on every other type.
   */
  defaultValue?: boolean | string;
  /** VARIANT only: every value this axis can take. */
  variantOptions?: string[];
}

/**
 * One sublayer of an INSTANCE that the designer changed by hand, and which of its
 * wire fields differ from the main component (Figma `Overrides`, decoupled). Field
 * names are the PRODUCER's spelling — REST says `characterStyleOverrides`, the plugin
 * says `styledTextSegments` — the core maps them onto output fields.
 */
export interface SnapshotOverride {
  /** The overridden node's id — the instance itself, or a descendant (`I<inst>;<child>`). */
  id: string;
  fields: string[];
}

export interface NodeSnapshot {
  id: string;
  name: string;
  /** Raw Figma node type (e.g. FRAME, TEXT, VECTOR). The walker maps VECTOR→IMAGE-SVG. */
  type: string;
  visible?: boolean;
  /**
   * Component-property references, node field → property name
   * (e.g. `{ visible: "Show Badge#341:0" }`). Four fields occur on the wire:
   * `visible`, `characters`, `mainComponent` (a nested INSTANCE driven by an
   * INSTANCE_SWAP prop) and `slotContentId` (a SLOT node → its SLOT prop; on both
   * producers live, though neither spec lists it). The walker reads `visible` to
   * rescue hidden nodes inside component definitions; the component extractor
   * renames the rest onto the output fields they drive.
   */
  componentPropertyReferences?: Record<string, string>;
  children?: NodeSnapshot[];

  // ------------------------------------------------------------------------
  // Layout traits — a node's own box and how it sits in its parent's layout.
  // Field names/unions mirror Figma's HasLayoutTrait so raw REST nodes stay
  // structurally assignable during the carve; the values are raw (px numbers,
  // enum tags), and the CSS mapping is simplify's job (Invariant 5).
  // ------------------------------------------------------------------------
  absoluteBoundingBox?: SnapshotRect | null;
  /**
   * The node's OWN size, in its own (pre-rotation) frame — what it was authored
   * at. Distinct from `absoluteBoundingBox`, which is the page-space
   * axis-aligned box: for a rotated node that box is the node's shadow, wider
   * and taller than the node itself. This is the canonical source for the
   * emitted `width`/`height` (see `NodeGeometry`); the AABB stays the source for
   * page-space questions like grid child-overlap.
   *
   * Optional because the REST producer has to SOLVE for it — the wire carries no
   * `size` without `geometry=paths`, and that inversion has no answer near every
   * odd multiple of 45° (see `DEGENERATE_DETERMINANT`, `adapters/rest/own-box.ts`).
   * The plugin producer reads it straight off the live node. Absent → consumers
   * fall back to the AABB.
   */
  ownSize?: SnapshotSize;
  /**
   * The node's own top-left corner in its PARENT's frame — the plugin API's
   * `node.x`/`node.y`. Like `ownSize`, this names the node rather than its
   * shadow: the page-space AABB delta puts a rotated node's `left`/`top` at a
   * corner the node doesn't have. Absent → consumers fall back to the AABB
   * delta.
   */
  ownOrigin?: SnapshotPoint;
  layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
  layoutAlign?: "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX";
  layoutGrow?: 0 | 1;
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  preserveRatio?: boolean;
  /**
   * Degrees, counterclockwise-positive (the plugin API's convention; absent, not 0,
   * when unrotated). The REST WIRE states this in radians — the REST adapter converts
   * on the way in (`degreesFromWireRotation`), so nothing downstream sees two units.
   */
  rotation?: number;
  gridColumnAnchorIndex?: number;
  gridRowAnchorIndex?: number;
  gridColumnSpan?: number;
  gridRowSpan?: number;
  gridChildHorizontalAlign?: "AUTO" | "MIN" | "CENTER" | "MAX";
  gridChildVerticalAlign?: "AUTO" | "MIN" | "CENTER" | "MAX";

  // ------------------------------------------------------------------------
  // Frame / auto-layout container traits (Figma HasFramePropertiesTrait).
  // ------------------------------------------------------------------------
  clipsContent?: boolean;
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  overflowDirection?:
    | "HORIZONTAL_SCROLLING"
    | "VERTICAL_SCROLLING"
    | "HORIZONTAL_AND_VERTICAL_SCROLLING"
    | "NONE";
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "BASELINE";
  counterAxisAlignContent?: "AUTO" | "SPACE_BETWEEN";
  layoutWrap?: "NO_WRAP" | "WRAP";
  itemSpacing?: number;
  counterAxisSpacing?: number;
  gridColumnsSizing?: string;
  gridRowsSizing?: string;
  gridRowGap?: number;
  gridColumnGap?: number;

  // ------------------------------------------------------------------------
  // Visuals — paints/effects are decoded (see SnapshotPaint/SnapshotEffect);
  // the scalar appearance fields are raw ~1:1 structural values.
  // ------------------------------------------------------------------------
  fills?: SnapshotPaint[];
  strokes?: SnapshotPaint[];
  strokeWeight?: number;
  strokeDashes?: number[];
  strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";
  individualStrokeWeights?: SnapshotStrokeWeights;
  effects?: SnapshotEffect[];
  opacity?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];

  // ------------------------------------------------------------------------
  // Text — present on TEXT nodes; the override tables are already resolved
  // into runs (see SnapshotText). Absent on every other node type.
  // ------------------------------------------------------------------------
  text?: SnapshotText;

  // ------------------------------------------------------------------------
  // Named styles — the adapter joins the node's REST `styles` map with the
  // top-level styles table into per-slot resolved names (fill/text/effect/…).
  // Only slots whose style resolved to a name appear here.
  // ------------------------------------------------------------------------
  styles?: Record<string, SnapshotStyleRef>;

  // ------------------------------------------------------------------------
  // Component metadata — raw structural records; present on INSTANCE /
  // COMPONENT / COMPONENT_SET nodes, absent elsewhere.
  // ------------------------------------------------------------------------
  componentId?: string;
  componentProperties?: Record<string, SnapshotComponentPropertyValue>;
  componentPropertyDefinitions?: Record<string, SnapshotComponentPropertyDefinition>;
  /**
   * INSTANCE only: the direct overrides Figma reports at this instance level, on the
   * instance itself and its sublayers. The core folds every enclosing level's list
   * together and hands each entry to the node it names, so it does not matter which
   * level a nested instance's edit is reported on.
   */
  overrides?: SnapshotOverride[];
}
