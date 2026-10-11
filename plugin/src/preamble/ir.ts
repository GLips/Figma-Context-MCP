/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { WarningRecord } from "./warnings.js";
import type { NodeSpec } from "./schema.js";
// ir — the typed WriteNode currency: the ONE internal representation the whole preamble speaks. Every
// leaf is a real type (a number, a typed edge box, a discriminated paint/effect value), never a CSS
// string. The sugar (flcm.ts) compiles terse author props straight into this; the bridge (bridge.ts)
// reads it and drives the plugin API. Nothing between them parses or re-serializes a string.
//
// WHY TYPED, NOT CSS-STRING LEAVES. The IR used to carry CSS strings (gap "8px", a "t r b l" padding
// box, "linear-gradient(...)") to be a verbatim sibling of figma-mcp's read-side SimplifiedNode — the
// idea being a `get` result could be tweaked and written back unchanged. But that read↔write unity only
// matters at the AGENT I/O BOUNDARY; internally the string form forced a number→string→number round-trip
// on the only path that ships today (authoring). So strings are now quarantined to css.ts (the input
// boundary), and the currency here is typed. The read-port promise is re-framed accordingly: a future
// `get` result (a SimplifiedNode of CSS strings) REBUILDS through the flcm compilers — the one
// validated compile; render refuses IR they didn't mint — rather than being rendered string-for-string.
//
// Read-compression refs (styles/template tables) and prototype words are deliberately absent. Design
// tokens ride the currency as TokenRefs (below): a compiled name-or-id that prepare resolves to a live
// variable or style before anything is written.
//
// This module is also the figma-free type hub for the agent-facing RETURN and QUERY shapes — Identity /
// Handle (render) and SlimHandle / FindQuery (the read verbs) — so schema.ts can type the public surface
// and read.ts (which speaks figma.*) supplies only the runtime. It's not purely the write currency.

// Type-only reach into the core's canonical vocabulary, for the read shapes (SlimHandle) the locate verbs
// return. Erased at build (esbuild drops `import type`), so the figma-free type hub gains no runtime edge.
import type { WriteAnnotation } from "./annotations.js";
import type {
  SimplifiedComponentEntry, SimplifiedDimension, SimplifiedLayout, SimplifiedNode,
  SimplifiedEffects, SimplifiedFill, SimplifiedTextStyle, StyleReference, VariableReference,
} from "@framelink/core";

// The node types createable through the plugin API, enumerated explicitly. Not every figma-mcp/REST
// `type` round-trips to a create call, so the set is closed: bridge.ts's BUILDERS table is typed
// `Record<WriteType, …>` (TS enforces a builder per type) and render() rejects anything outside it with
// a specific error rather than letting a confusing plugin-API throw surface. INSTANCE is createable
// (INSTANCE stamps a component), but its content comes from the component, never from `children`.
export type WriteType = "FRAME" | "TEXT" | "RECTANGLE" | "ELLIPSE" | "LINE" | "VECTOR" | "INSTANCE";

// The node types edit has a per-type vocabulary for. A superset of WriteType on purpose: an INSTANCE
// is both, while the definition types (COMPONENT/COMPONENT_SET, and the SLOT an instance shows for a
// bound frame) are edited but never constructed — flcm.component PROMOTES a frame; no compiler
// builds one.
export type EditableType = WriteType | "COMPONENT" | "COMPONENT_SET" | "SLOT" | "POLYGON" | "STAR";

// Which schema word GROUPS compose each editable type's surface — the same compositions as the
// per-verb create key sets (flcm.ts FRAME_KEYS = shared+size+appearance+frame, etc.), named once
// so the two consumers can't drift: edit-plan.ts builds the runtime legality gate from it (via
// KNOWN_KEYS, intersected with the edit surface) and reference.ts renders the per-type doc lists
// from it (via schema.ts's FIELD_GROUPS). Both index their group tables with these literals, so a
// misspelled group name is a compile error on each side. Lives here, not in flcm.ts or schema.ts,
// because ir.ts is the one module both sides already import type-safely with no zod and no figma.
//
// INSTANCE combines frame-like root overrides with instance controls and the componentId target.
//
// `binding` (`componentPropertyReferences`) composes into every type that can BE a component's
// sublayer — the same universality it has at create, where every compiler takes it. Not onto
// COMPONENT/COMPONENT_SET: Figma has no component inside a component, so a component's own binding
// would name a property of something that can't exist. Not onto SLOT either: a slot is what an
// INSTANCE shows for a bound frame, and the binding lives on that frame back in the definition.
//
// COMPONENT and COMPONENT_SET take a FRAME's words because their root IS a frame (layout, fill,
// borderRadius, width… all land exactly as on one), plus `componentDefinition` — the two words that
// change what the component DECLARES. SLOT takes the frame surface without them [verified live:
// layoutMode, gap and fills are settable on an instance's slot].
// Annotation support follows https://developers.figma.com/docs/plugins/api/Annotation/, widened by
// what a live document answers: GROUP and SECTION carry no annotations, but a SLOT does — both the
// component's bound frame and the slot an instance shows for it take writable notes [verified live].
export const EDIT_TYPE_WORD_GROUPS = {
  FRAME: ["annotation", "shared", "size", "appearance", "frame", "binding"],
  TEXT: ["annotation", "shared", "size", "text", "binding"],
  RECTANGLE: ["annotation", "shared", "size", "appearance", "binding"],
  ELLIPSE: ["annotation", "shared", "size", "ellipse", "binding"],
  LINE: ["annotation", "shared", "line", "binding"],
  VECTOR: ["annotation", "shared", "size", "path", "binding"],
  INSTANCE: ["annotation", "shared", "size", "appearance", "frame", "instance", "swap", "binding"],
  COMPONENT: ["annotation", "shared", "size", "appearance", "frame", "componentDefinition"],
  COMPONENT_SET: ["annotation", "shared", "size", "appearance", "frame", "componentDefinition"],
  POLYGON: ["shared", "annotation"],
  STAR: ["shared", "annotation"],
  SLOT: ["annotation", "shared", "size", "appearance", "frame"],
} as const satisfies Record<EditableType, readonly string[]>;

/** The schema's frame group is the authority for container-only layout words. */
export function hasContainerLayout(type: string): boolean {
  const groups: readonly string[] | undefined = Object.prototype.hasOwnProperty.call(EDIT_TYPE_WORD_GROUPS, type)
    ? EDIT_TYPE_WORD_GROUPS[type as EditableType] : undefined;
  return groups?.includes("frame") ?? false;
}

// ---- Token references. A compiled `{ variable }` / `{ style }` input: the author named a token by id,
// by name, or both (id wins), and the word it stands in for decides what kind it must be. Nothing here
// knows the live token — prepare resolves every ref (tokens.ts) and the appliers bind what it found.
//
// Negative space: variables on gradient stops, effect fields, grid gaps, `characters`/`visible` and
// fontStyle, per-run text styles, and creating variables or styles have no TokenRef — those inputs
// are refused at compile. Listing the tokens that exist is design-tokens.ts. ----
export interface VariableRef {
  token: "variable";
  id?: string;
  name?: string;
  /** The authored word, for every refusal: "fill", "layout.padding.top", "TEXT run[1].fontSize". */
  word: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING";
}
export interface StyleRef {
  token: "style";
  id?: string;
  name?: string;
  word: string;
  styleType: "PAINT" | "EFFECT" | "TEXT";
}
export type TokenRef = VariableRef | StyleRef;
// A leaf a variable can stand in for: the literal, or the variable bound in its place.
export type Bindable<T = number> = T | VariableRef;

export function isTokenRef(value: unknown): value is TokenRef {
  return typeof value === "object" && value !== null && "token" in value;
}

// Author input naming a token: a name or id string, or { id?, name? } (the read emits both; id wins).
export type TokenIdentityInput = string | { id?: string; name?: string };
export interface VariableInput { variable: TokenIdentityInput }
export interface StyleInput { style: TokenIdentityInput }

// A node's paint and effect style slots. The text style rides textStyle.style instead, beside the
// uncovered text words it keeps.
export interface WriteStyles { fill?: StyleRef; stroke?: StyleRef; effect?: StyleRef }

export interface Rgb { r: number; g: number; b: number }
export interface Rgba { r: number; g: number; b: number; a: number }

// ---- Paint currency (Figma-domain). A solid carries its alpha on `opacity` (Figma stores paint alpha
// there, not in the color). A gradient carries the computed 2x3 transform and stops — the angle→matrix
// math is already done (paint.ts), so the bridge maps straight to a plugin Paint. Every kind may carry a
// per-paint `blendMode`; absent means NORMAL. ----
// `colorVariable` binds the color; `color` is then only the placeholder the bind replaces.
export interface WriteSolid { kind: "solid"; color: Rgb; opacity: number; blendMode?: WriteBlendMode; colorVariable?: VariableRef }
export type GradientType = "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
export type Transform = [[number, number, number], [number, number, number]];
export interface GradientStop { position: number; color: Rgba }
export interface WriteGradient { kind: "gradient"; type: GradientType; transform: Transform; stops: GradientStop[]; blendMode?: WriteBlendMode }

// ---- Image paint currency. Unlike solid/gradient, an image paint is NOT self-contained: turning it into a
// plugin ImagePaint needs the raster BYTES, and the sandbox never touches the network (manifest
// allowedDomains:["none"]). So a WriteImage carries only the source url + intent, and the
// bridge resolves it to a paint at render, keyed by url, from bytes the trusted server fetched+validated
// and injected. `placeholder` records stand-in-vs-real; the bridge persists it on the node (pluginData) so
// a later read can tell them apart — the one content case whose semantics don't recover from geometry. ----
export type ImageScaleMode = "FILL" | "FIT" | "CROP" | "TILE";
// Figma's image adjustments, each -1..1 (0 = untouched). Field names are Figma's: no CSS filter maps
// onto temperature/tint/highlights/shadows, and the read emits these same names.
export interface WriteImageFilters {
  exposure?: number; contrast?: number; saturation?: number; temperature?: number;
  tint?: number; highlights?: number; shadows?: number;
}
// The paint-level adjustments both image sources share; each absent field is Figma's default.
// Figma accepts only quarter-turn rotations, so the type names them.
export interface WriteImageAdjustments {
  blendMode?: WriteBlendMode;
  opacity?: number;
  rotation?: 90 | 180 | 270;
  filters?: WriteImageFilters;
}
export interface WriteImageUrl extends WriteImageAdjustments { kind: "image"; url: string; scaleMode: ImageScaleMode; placeholder: boolean }
// ---- The OTHER image source: a paint whose bytes are already in the document, named by the
// imageHash a read shape carries (`{ type: "IMAGE", imageRef }`). Nothing needs fetching — in-plugin a
// paint can reference an existing hash directly — which is what lets a `get` result rebuild an image
// fill with no server round trip and no url the agent never had. The two forms are separate interfaces,
// not one shape with two optional sources, so "which source is this" is answered by the type
// (`"url" in paint`) and a byte collector cannot silently include a hash-backed paint. ----
export interface WriteImageHash extends WriteImageAdjustments {
  kind: "image";
  hash: string;
  scaleMode: ImageScaleMode;
  // TILE's repeat scale, carried only because the read shape does — a tile reproduced at natural size
  // is a visible divergence. Absent for every other scale mode.
  scalingFactor?: number;
}
export type WriteImage = WriteImageUrl | WriteImageHash;
export type WritePaint = WriteSolid | WriteGradient | WriteImage;

// A node's (or run's) paint for ONE slot: an ordered stack, TOP FIRST — index 0 paints over index 1 —
// which is CSS order and exactly the order a read emits, so a `get` result pastes straight back. A
// single paint is the one-element stack; an EMPTY stack is the compiled removal word ("none"), distinct
// from an absent one ("don't touch it"). Figma stores a stack the other way up (last element on top);
// bridge.ts's toFigmaPaintStack is the ONE place that flip is known.
export type WritePaintStack = WritePaint[];

// ---- Author input shapes for a fill/stroke leaf. An author passes a CSS color/gradient string, the
// read-form { type, gradient } / { type: "SOLID", color, blendMode } objects, OR an already-typed
// WritePaint (what flcm.gradient() returns). `blendMode` on a read-form leaf is a CSS blend keyword.
// These live here (the figma-free type hub) rather than in css.ts so the schema module can source them
// via `import type` without dragging css.ts's parsers — and their Figma-typings — into a typecheck. ----
export interface WriteGradientFill { type: GradientType; gradient: string; blendMode?: string }
// The read's spelling of a solid that doesn't blend normally — a normal solid is a bare color string.
export interface ReadSolidFill { type: "SOLID"; color: string; blendMode?: string }
// The read shape's image-fill leaf. Named here (rather than sniffed inline at the parser) so the
// normalizer can type what it hands back; the extra read-only keys it carries (css hints,
// imageDownloadArguments) are irrelevant to the parse and deliberately unnamed.
export interface ReadImageFill {
  type: "IMAGE"; imageRef?: string; gifRef?: string; scaleMode?: string; scalingFactor?: number;
  blendMode?: string; opacity?: number; rotation?: number; filters?: WriteImageFilters;
}
// A solid whose color is a variable — the read's spelling when a bound solid carries its own opacity or blend.
export interface BoundSolidFill { type: "SOLID"; color: VariableInput; opacity?: number; blendMode?: string }
export type FillLeaf = string | WriteGradientFill | ReadSolidFill | BoundSolidFill | ReadImageFill | VariableInput | WritePaint;
// A paint slot takes one leaf, or an ARRAY of them — a paint stack, top first, the same order a read
// emits (WritePaintStack). The composite this exists for is a photograph under a legibility scrim:
// `fill: [flcm.gradient({...}), flcm.image(url)]`.
export type FillInput = FillLeaf | FillLeaf[] | StyleInput;

// ---- Effect currency (Figma-domain). A blur's radius is ALREADY the Figma radius — the ×2 CSS-blur
// factor (see effects.ts) is applied when the effect is built, never here and never in the bridge, so a
// Figma-radius value can't be double-doubled. A shadow's radius is 1:1 with CSS. ----
export interface WriteShadow { kind: "shadow"; inner: boolean; color: Rgba; offset: { x: number; y: number }; radius: number; spread: number }
export interface WriteBlur { kind: "blur"; type: "LAYER_BLUR" | "BACKGROUND_BLUR"; radius: number }
// Beyond-CSS effects (plugin-typings@1.130.0). No CSS spelling exists, so these are object-form only and
// carry raw Figma-domain values — no CSS-px scaling (the ×2 blur factor never touches them). radius/offset
// units are Figma's own. See effects.ts:toFigmaEffects for the plugin-Effect mapping and the live-runtime
// notes (notably: the running runtime rejects NOISE.blendMode despite the typing listing it).
export interface WriteGlass { kind: "glass"; lightIntensity: number; lightAngle: number; refraction: number; depth: number; dispersion: number; radius: number }
export interface WriteNoise { kind: "noise"; noiseType: "MONOTONE" | "DUOTONE" | "MULTITONE"; color: Rgba; noiseSize: number; density: number; secondaryColor?: Rgba; opacity?: number }
export interface WriteTexture { kind: "texture"; noiseSize: number; radius: number; clipToShape: boolean }
// A progressive blur of either kind (as WriteBlur's `type`): radius is the END radius; the blur ramps
// startRadius→radius along the startOffset→endOffset axis (offsets normalized to the node's 0–1 object space).
export interface WriteProgressiveBlur { kind: "progressiveBlur"; type: "LAYER_BLUR" | "BACKGROUND_BLUR"; startRadius: number; radius: number; startOffset: { x: number; y: number }; endOffset: { x: number; y: number } }
// An effect list is top-first (CSS order); toFigmaEffects reverses it into Figma's bottom-first storage.
export type WriteEffect = WriteShadow | WriteBlur | WriteGlass | WriteNoise | WriteTexture | WriteProgressiveBlur;

// Author input shape for CSS-string effects: the { boxShadow, filter, backdropFilter, textShadow } bag.
// Here (not css.ts) for the same reason as FillInput — the schema sources it without pulling in parsers.
export interface WriteCssEffects { boxShadow?: string; filter?: string; backdropFilter?: string; textShadow?: string }

// ---- Text style currency (plugin-domain units). The boundary coerces author CSS ("32px", "-0.02em")
// into these {value,unit} forms; the bridge applies them with no further work. ----
export type WriteLineHeight = { value: number; unit: "PIXELS" | "PERCENT" } | { unit: "AUTO" };
export type WriteLetterSpacing = { value: number; unit: "PIXELS" | "PERCENT" };
export type TextAlign = "left" | "center" | "right" | "justify";
// CSS text-decoration-line, the realizable subset. "none" is a per-run INVERSE override only
// (clearing an inherited base decoration) — the base omits it; the bridge maps each to Figma's
// TextDecoration enum (UNDERLINE/STRIKETHROUGH/NONE).
export type TextDecoration = "underline" | "line-through" | "none";
// Figma conflates CSS `text-transform` and `font-variant-caps` into ONE `textCase` enum, so the
// author's two words (`textTransform`, `fontVariant`) resolve to this single Figma-domain field at
// the css/sugar boundary — the same shape `blend` → `blendMode` takes. Resolving there is what makes
// "both named at once" unrepresentable in the currency instead of a rule the bridge re-checks.
export type WriteTextCase = "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED";
// The seven variable-bindable words take a VariableRef in place of their literal.
export interface WriteTextStyle {
  fontFamily?: Bindable<string>;
  fontWeight?: Bindable<number | string>;
  fontSize?: Bindable;
  // CSS font-style. Resolved into the loaded font's italic variant (fonts.ts keys on it, the bridge
  // applies it via setRangeFontName — italic is a font-name concern in Figma, not a separate call).
  // "normal" appears only as a per-run inverse override on an italic base.
  fontStyle?: "italic" | "normal";
  lineHeight?: Bindable<WriteLineHeight>;
  letterSpacing?: Bindable<WriteLetterSpacing>;
  // Applied as a separate Figma call (node.textDecoration / setRangeTextDecoration), independent of
  // the font name — so a run carrying only a decoration change needs no per-range font.
  textDecoration?: TextDecoration;
  // CSS-named to match its siblings (fontStyle/textDecoration and WriteLayout.justifyContent/alignItems):
  // IR field NAMES mirror CSS; only the VALUES stay terse where a terse form exists — here the CSS values
  // (left/center/right/justify) already are the canonical spelling, so name and value both align.
  textAlign?: TextAlign;
  // Applied per range (setRangeTextCase), so a run carries it too. Requires the font loaded — the
  // reason a delta naming any text word preloads (fonts.ts textEditReflows).
  textCase?: WriteTextCase;
  // Vertical alignment inside the text box. Node-level in Figma — there is no setRangeTextAlignVertical
  // — so this is a BASE word only; a run delta naming it would have nowhere to land.
  textAlignVertical?: "top" | "center" | "bottom";
  // Paragraph metrics in px. Per-range in Figma (setRangeParagraph*/setRangeListSpacing), which is
  // why the read side surfaces them on run deltas and why runs carry them here.
  paragraphSpacing?: Bindable;
  paragraphIndent?: Bindable;
  listSpacing?: number;
  // A URL link over the whole node (setRangeHyperlink across every character). A RUN's own link lives
  // on WriteTextRun.hyperlink instead — there the span already IS the range, so it isn't a style leaf.
  hyperlink?: string;
  // The node's text style. A BASE word only (per-run text styles are out of scope), and the compiler
  // refuses it beside the words it covers — only textAlign, textAlignVertical and hyperlink ride along.
  style?: StyleRef;
}

// THE presence predicate behind "presence-gated" font writes, surface-wide: whether a style names any
// of the (family, weight, slant) triple — the trigger for writing a base/range fontName, enriching an
// edit delta from the live node, and preloading authored triples. One name so the three-field check
// can't decay into partial copies at its call sites.
export function namesFontIdentity(style: WriteTextStyle | undefined): style is WriteTextStyle {
  return !!style && (style.fontFamily !== undefined || style.fontWeight !== undefined || style.fontStyle !== undefined);
}

// ---- Rich text: a styled span within one text node. A `runs` array on a TEXT WriteNode carries the
// per-span content + overrides; the bridge concatenates the run texts into the node's characters and
// applies each run's style/fills over its slice via Figma's setRange* API. Omitted style fields inherit
// the node-level textStyle (the base), so a run only carries what it changes. `textAlign` is deliberately
// unused per-run — horizontal alignment is a paragraph (node) property in Figma, not per-range. ----
export interface WriteTextRun {
  text: string;
  style?: WriteTextStyle;
  fills?: WritePaintStack;
  // URL hyperlink over this span (author `[text](url)` markdown, or a run delta's `hyperlink`).
  // Applied via setRangeHyperlink({ type: "URL" }); NODE links are a read-only artifact with no
  // authored form, so only the URL string is carried here.
  hyperlink?: string;
}

// ---- Layout currency. Alignment and sizing are stored as terse INTENT, not plugin enums: which plugin
// axis a `justifyContent`/`alignItems`/`fill`/`hug` maps to depends on the frame's direction and
// parent/child context, so the bridge resolves it. One terse→plugin map lives there; the IR stays
// plugin-agnostic. The field names mirror CSS (justifyContent/alignItems), but the VALUES stay terse
// render intent — the CSS-total value spellings (flex-start/space-between) are an LLM-edge concern the
// sugar boundary (flcm.ts) maps in, never pushed through the render layer. ----
export type Justify = "start" | "center" | "end" | "between";
export type Align = "start" | "center" | "end" | "stretch" | "baseline";
export type Sizing = "fixed" | "fill" | "hug";
export interface Edges<T = number> { top: T; right: T; bottom: T; left: T }
// Corner radii in Figma's own corner order (its four per-corner properties), which is also CSS's
// 4-value border-radius order. A uniform radius is four equal values, never a separate shape — one
// case for the bridge to apply and one for a round-trip to compare.
export interface CornerRadii<T = number> { topLeft: T; topRight: T; bottomRight: T; bottomLeft: T }

// ---- Constraint override (author `constraints`). Directional per axis so the axis is unambiguous at the boundary
// (x names an edge on the horizontal axis, y on the vertical); the bridge maps each to Figma's per-axis
// constraint enum. Governs how a positioned child reflows when its parent resizes — a free-form parent's
// children and an absolute child of any parent; inert on an in-flow auto-layout child. ----
// "none" is edit's per-axis clearing word: it restores MIN (Figma's default, pinned to the near
// edge) — the auto-derived constraint create chose isn't stored anywhere live, so the default is
// the stated inverse, not a recovered intent.
export type ConstraintX = "left" | "center" | "right" | "stretch" | "scale" | "none";
export type ConstraintY = "top" | "center" | "bottom" | "stretch" | "scale" | "none";

// ---- Blend mode (node `mixBlendMode`, paint `blendMode`). The CSS mix-blend-mode names normalize to
// Figma's BlendMode enum at the css.ts boundary; this is the resolved Figma-domain currency. A SUBSET of
// Figma's BlendMode — only the CSS-reachable modes (LINEAR_BURN/LINEAR_DODGE are CSS plus-darker/
// plus-lighter) — so PASS_THROUGH (frame-grouping only) is deliberately absent.
export type WriteBlendMode =
  | "NORMAL" | "DARKEN" | "MULTIPLY" | "LINEAR_BURN" | "COLOR_BURN" | "LIGHTEN" | "SCREEN"
  | "LINEAR_DODGE" | "COLOR_DODGE" | "OVERLAY" | "SOFT_LIGHT" | "HARD_LIGHT" | "DIFFERENCE"
  | "EXCLUSION" | "HUE" | "SATURATION" | "COLOR" | "LUMINOSITY";

export interface WriteLayout {
  bounds?: Partial<Record<"minWidth" | "maxWidth" | "minHeight" | "maxHeight", Bindable | "none">>;
  mode?: "none" | "row" | "column" | "grid";
  gridTemplateColumns?: import("./grid-tracks.js").GridTrack[];
  gridTemplateRows?: import("./grid-tracks.js").GridTrack[];
  gridColumn?: { anchor?: number; span: number };
  gridRow?: { anchor?: number; span: number };
  // "stretch" is an ALIAS that never survives childLayout — it is rewritten to sizing.horizontal
  // "fill" (input-aliases normalizeChildLayoutAliases) before any applier sees the bag.
  justifySelf?: "MIN" | "CENTER" | "MAX" | "AUTO" | "stretch";
  alignSelf?: "center" | "stretch" | "start" | "end" | "auto";
  zIndex?: number;
  justifyContent?: Justify; // primary-axis distribution (author `layout.justifyContent`)
  alignItems?: Align;       // counter-axis alignment (author `layout.alignItems`)
  gap?: Bindable | { row: Bindable; column: Bindable };
  wrap?: boolean;
  padding?: Edges<Bindable>;
  sizing?: { horizontal?: Sizing; vertical?: Sizing };
  // A bound size sizes "fixed" and carries its variable here; the bind lands the number.
  dimensions?: { width?: Bindable; height?: Bindable };
  // Percent INTENT — a `width`/`height`/`left`/`top` written as "N%" (0–100), resolved to pixels
  // against the parent's *realized* axis size in a post-walk pass (bridge.resolvePercents): the node is
  // built at a provisional size first, then resized once the whole tree is assembled and every parent's
  // fill/hug size is readable off the canvas — the parent size isn't known at construction, and reading it
  // at walk time would predate the fill/hug pin. A percent SIZE also sets sizing.horizontal/vertical =
  // "fixed" (post-resolution it IS a fixed px); percent POSITION rides on the existing `position:"absolute"`.
  // Absent unless the author wrote a percent.
  percentSize?: { width?: number; height?: number };
  percentPos?: { x?: number; y?: number };
  // The px a read root's `"fill"` axis measured where it was read (its `designedWidth`/`designedHeight`).
  // Inert under a frame, where fill still means fill; a page has no size to fill, so a root landing on
  // one takes this as a fixed size instead (foldDesignedSizeForPage). Present only beside a fill axis.
  designedSize?: { width?: number; height?: number };
  // Explicit Figma-constraint override for a positioned child — how it responds when the parent resizes.
  // Overrides the constraint the bridge auto-derives from the child's size/position intent (fill→STRETCH,
  // "N%"→SCALE, percent position→CENTER, else pinned to the near edge). Absent unless the author wrote
  // `constraints`. Honored for a free-form parent's child and an absolute child; inert on an in-flow auto-layout
  // child (which reflows via fill/hug instead).
  constraints?: { x?: ConstraintX; y?: ConstraintY };
  // "absolute" is the out-of-flow flag: the author's own `position: "absolute"`, or implied by a
  // `left`/`top`. "none" is edit's return-to-flow word: the node rejoins its auto-layout parent's flow
  // (layoutPositioning AUTO). Create only ever sets "absolute".
  position?: "absolute" | "none";
  // Offset from the parent's top-left corner — the author's `left`/`top`, the read shape's words.
  // Presence-preserving per axis: an axis the author didn't name (or spelled as "N%" — see percentPos)
  // is absent, and the bridge leaves/reads the live coordinate.
  left?: number;
  top?: number;
}

// Where a VECTOR's art comes from. The two forms are NOT interchangeable spellings of one thing —
// they answer different questions, and the union keeps that in the type rather than in a
// "exactly one of three fields" convention every consumer has to re-check:
//   • `path` — bare geometry. The node's box IS the paths' bounding box; `scale` is the only word
//              that changes it (uniform by construction). One real VECTOR, so the shared appearance
//              props (fill/stroke/…) land on it directly, like any primitive.
//   • `svg`  — a CANVAS of art. figma.createNodeFromSvg parses the markup into a FRAME of vectors,
//              so a VECTOR-typed spec can render a FrameNode and the handle reports that real type.
//              Sizing words apply to the canvas; fills/strokes repaint the vectors INSIDE it.
// Both arms are normalized at compile time (path data is already Figma's absolute M/L/C/Q/Z subset
// by the time it reaches the bridge), so the render side never re-parses author input.
export type WriteVectorSource =
  | { kind: "path"; paths: Readonly<NonNullable<SimplifiedNode["vectorPaths"]>>; scale?: number }
  | { kind: "svg"; markup: string };

// A WriteNode's props without the `type` discriminant — the shape edit's partial delta compiles to
// (a delta nudges an existing node, so it never carries a createable type), and what the prop
// appliers/walkers consume (they read fields, never dispatch on type).
export interface WriteProps {
  annotations?: WriteAnnotation[];
  name?: string;
  // Our pluginData('flcm/key') identity — the one field write ADDS over read. Optional in v1
  // (reconcile deferred): key the nodes you'll address, leave the rest anonymous.
  key?: string;
  text?: string;
  // Vector content, as ONE value rather than a set of optional fields where exactly one may be set —
  // the two authoring forms are different domains, not variants of each other (WriteVectorSource).
  vector?: WriteVectorSource;
  // Styled spans for a TEXT node. Mutually exclusive with a bare `text` string at the author boundary;
  // when present the bridge builds `characters` from the runs and `textStyle` is the base the runs layer
  // over. Absent for the plain-string form.
  runs?: WriteTextRun[];
  textStyle?: WriteTextStyle;
  // TEXT only: clamp the node to at most N lines, truncating with an ending ellipsis (textTruncation:
  // "ENDING" + maxLines:N in the bridge). The author boundary (TEXT) rejects it on a width-hugging
  // text — truncation needs a bounded width to wrap against — so a value here always has a wrap to bite.
  // "none" is edit's removal spelling: truncation DISABLED, maxLines null (create never compiles it).
  maxLines?: number | "none";
  fills?: WritePaintStack;
  strokes?: WritePaintStack;
  // A number is one weight for every side; Edges only when sides differ, and only on a type with
  // per-side weights (the compiler's gate) — the bridge writes strokeTop/Right/Bottom/LeftWeight.
  strokeWeight?: Bindable | Edges<Bindable>;
  strokeAlign?: "INSIDE" | "OUTSIDE" | "CENTER";
  effects?: WriteEffect[];
  // A style IS the slot's word (`fill: { style }`), so a styled slot carries no literal stack beside it.
  // The appliers land the style's own values in the sealed span; the link itself is queued for the lock.
  styles?: WriteStyles;
  opacity?: Bindable;
  blendMode?: WriteBlendMode; // author `blend` (CSS mix-blend-mode → Figma BlendMode); applied in buildNode (shared: every node has one)
  borderRadius?: CornerRadii<Bindable>;
  clip?: boolean;     // clipsContent
  rotation?: number;  // degrees (write-add; read does not surface it)
  // On every SceneNode, like blendMode — part of the shared vocabulary edit allows even on node
  // types flcm can't create (GROUP/INSTANCE/…). The read side never surfaces either: find/get
  // cover the RENDERED document, so a hidden node is invisible to reads by design.
  visible?: boolean;
  locked?: boolean;
  layout?: WriteLayout;
  children?: WriteChild[];
  // INSTANCE only — the three component words, carried RAW rather than compiled. A component
  // reference and a property value can only be resolved against the live document (which
  // definition owns the property, what the variant axes are, which node a swap target names),
  // and an override delta compiles against the TYPE of the sublayer it targets — none of which
  // a document-blind compiler can see. The compiler validates their SHAPE (an object, known delta
  // words); render's gate resolves and compiles them (instance.ts) before any write.
  exposed?: boolean;
  component?: Target;
  componentProperties?: Record<string, ComponentPropertyInput>;
  overrides?: Record<string, OverrideDeltaInput>;
  // The BINDING half of the component words, kept raw for the same reason: which property a name
  // reaches is decided by the flcm.component call that declares them, not by the compiler. The
  // compiler judges the bag's SHAPE and which fields ITS node type can bind; the verb's prepare
  // resolves each name against that call's `propertyDefinitions`. Any other verb refuses a tree
  // carrying one (flcm.assertNoComponentPropertyBindings) — a binding with no declaring call is a
  // name pointing at nothing.
  componentPropertyReferences?: ComponentPropertyBinding;
}

// Which component property drives which of a node's fields — the read shape's own word, and its
// own field spellings (`text`, not Figma's wire key `characters`). Each value is a property NAME
// declared in the same flcm.component call. Per-node legality is the compiler's (`text` only on
// TEXT, `componentId` only on INSTANCE, `slot` only on FRAME, `visible` anywhere).
export interface ComponentPropertyBinding {
  visible?: string;
  text?: string;
  componentId?: string;
  slot?: string;
}

// One property an flcm.component call declares, in the read's own lowercase words. It carries no
// default: a property's default IS its bound layer's content (its text, its visibility, its
// instance's component), so every property is bound in the same call and read off that layer.
export interface ComponentPropertyDefinitionInput {
  type: "boolean" | "text" | "instance_swap" | "slot";
}

export type ComponentPropertyDefinitions = Record<string, ComponentPropertyDefinitionInput>;

// One `propertyDefinitions` entry as an EDIT names it, keyed by the property's CURRENT name. Three
// shapes in one: a name the component doesn't have yet ADDS (create's own rules — bound by another
// entry of the same editMany), a name it has RENAMES (`name`), and `null` DELETES. `name` is the one
// word here with no read spelling: a read reports a property's name as the key, so renaming needs a
// word of its own. `type` and `variantOptions` may restate what a read reports, as a no-op.
export interface ComponentPropertyDefinitionEdit {
  type?: "boolean" | "text" | "instance_swap" | "slot" | "variant";
  variantOptions?: string[];
  name?: string;
}

export type ComponentPropertyDefinitionEdits = Record<string, ComponentPropertyDefinitionEdit | null>;

// The binding bag under EDIT: the same fields, plus `null` per field to UNBIND it — the field stops
// tracking the property and keeps whatever value it has. (At create there is nothing to unbind, so
// ComponentPropertyBinding above carries no null.)
export interface ComponentPropertyBindingEdit {
  visible?: string | null;
  text?: string | null;
  componentId?: string | null;
  slot?: string | null;
}

// The COMPONENT-side words an EDIT delta may carry, kept RAW for the same reason the INSTANCE words
// are: which definition a bare property name reaches, which component owns a sublayer's binding, and
// what an instance-swap default resolves to are all live-document facts. Split off the compiled patch
// by edit's stage 2 and resolved by the verb's prepare (component-edit.ts). `description` /
// `propertyDefinitions` reach a COMPONENT or COMPONENT_SET; `componentPropertyReferences` reaches any
// sublayer of one.
export interface ComponentEditWords {
  description?: string;
  propertyDefinitions?: ComponentPropertyDefinitionEdits;
  componentPropertyReferences?: ComponentPropertyBindingEdit;
}

// One member of an flcm.variants call: the standalone COMPONENT, and which member of the set it IS
// in the set's axes. One entry shape — the axes are what a set is made of, so there is no
// bare-component form to guess a name from.
export interface VariantEntryInput { component: Target; variant: Record<string, string> }

// A component property value as authored: the read shape's own scalar (`Record<name, boolean |
// string>`), plus a Target for an instance-swap property — the read reports a swap value as the
// component's node id, and a handle from `find` names the same thing.
export type ComponentPropertyInput = boolean | string | RawIdRef | Handle | SlimHandle;

// One sublayer's override delta as authored — the read's `overrides` entry (a partial node whose
// fields may be `null`) or an edit delta in the same words. Typed open here because the words a
// sublayer takes depend on ITS type, judged when the component resolves.
export type OverrideDeltaInput = Record<string, unknown>;

// The INSTANCE words an EDIT delta may carry, kept raw for exactly the reason WriteProps keeps them
// raw: which component a target names, which definition owns a property, and which sublayer a path
// reaches are all live-document facts. Split out of the compiled patch by edit's stage 2; the verb
// resolves their targets in prepare and plans them in its gate (instance.planInstanceEdit).
// componentId selects the destination component for a live instance swap.
export interface InstanceEditWords {
  exposed?: boolean;
  componentId?: Target;
  componentProperties?: Record<string, ComponentPropertyInput>;
  overrides?: Record<string, OverrideDeltaInput>;
}

export type WriteNode = WriteProps & {
  ignoredSize?: { width?: unknown; height?: unknown };
  source?: NodeSpec;
  sourcePath?: string;
} & (
  | { type: WriteType; liveId?: never; authoring?: never }
  // Live types come from the document, including node kinds that cannot be created here.
  | { type: string; liveId: string; authoring: Record<string, unknown> }
);

// Compiled children are private IR nodes; author input is validated before the walk.
export type WriteChild = WriteNode;

// A node's stable identity — the fields every returned reference shares, pulled out of the live node by
// identity.identityOf so render's Handle and the read verbs' SlimHandle can't drift on how they read
// name/key/text. `key` is our pluginData flcm/key (only on nodes stamped with one); `text` is present for
// TEXT nodes. Deliberately NO `removed` field beside id/type — safeSerialize's live-node collapse keys on
// `"removed" in value`, so a read shape that exposed it would be wrongly collapsed in transit.
export interface Identity { warnings?: WarningRecord[]; id: string; type: string; name: string; key?: string; text?: string }

// Edit and clone return measured handles. Tree verbs return authored data with ids.
export interface Handle extends Identity {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;

  // MEASURED px, always. render() just laid the tree out, so the settled number is ground truth and the
  // whole reason to look: a 35%-wide bar's real width, a hugged frame's real height. Always a number so the
  // obvious reach — `bar.width + 8` — is always right; the sizing RULE behind it lives in `intent`, where it
  // can't be mistaken for a measurement (the same split the read side makes with width vs designedWidth).
  width: number;
  height: number;
  // The sizing rule on an axis the LAYOUT owns, so an agent can tell a measurement it may reuse from one it
  // would be freezing: a "fill"/"hug" axis re-measures whenever its parent or content changes, and pinning
  // this number is how a responsive design becomes a fixed one. Absent on an axis that is plainly fixed —
  // there the measurement IS the intent, and a second field would only cost context.
  //
  // The words are the read side's own (core SimplifiedDimension), taken from the same mapper `find` uses
  // (core convertSizing), so `render`'s intent and `find`'s width/height can't disagree. Numbers and
  // "contextual" are excluded: a number is what `width` above already carries, and "contextual" describes a
  // root the read path SEVERED from its parent — a rendered root is a real page child, never that.
  intent?: { width?: Extract<SimplifiedDimension, "fill" | "hug">; height?: Extract<SimplifiedDimension, "fill" | "hug"> };
  position?: "absolute";
  left?: number;
  top?: number;
}

// A SlimHandle is what the locate verbs (find/findOne/selection) return: the identity core plus a cheap
// layout world-model, so an agent gets the lay of the land (containers, sizing intent, out-of-flow
// positioning) without paying for a full `get`. It is a SPARSE PROJECTION of the same canonical read shape
// `get` emits (Invariant 1) — every field's name and leaf format is the core's own: width/height are the
// vocabulary's SimplifiedDimension (a px number ONLY on an authored-fixed axis; "fill"/"hug"/"contextual"
// carry intent, never a misleading computed px), layout carries just the container mode, and
// position/left/top mirror NodeGeometry, emitted only when the node is out of its parent's auto-layout flow.
// Same geometry spelling as the write-side Handle, on the same emission rules. Where they part is the SHAPE
// of a size: slim folds intent and px into one field (a hugging axis reports "hug" and no number, because a
// computed px would mislead a codegen consumer into pinning it), while a Handle splits them — always a
// measured number in width/height, the rule beside it in `intent`. A render just measured what it built, so
// it can hand over both; a locate has only the design's own intent to report (see Handle above).
export interface SlimHandle extends Identity {
  visible?: false;
  // The same words `get` emits, so a bound size reads as its `{ variable }` here too.
  minWidth?: SimplifiedNode["minWidth"];
  maxWidth?: SimplifiedNode["maxWidth"];
  minHeight?: SimplifiedNode["minHeight"];
  maxHeight?: SimplifiedNode["maxHeight"];

  annotations?: SimplifiedNode["annotations"];
  /** Unresolved comment threads pointing at this node; read them with get_figma_comments. */
  comments?: number;
  width?: SimplifiedNode["width"];
  height?: SimplifiedNode["height"];
  layout?: { mode: SimplifiedLayout["mode"] };
  position?: "absolute";
  left?: number;
  top?: number;
  childCount?: number;
}

// What `get` hands back. An ENVELOPE rather than a bare node because `components` is keyed by
// component id and is RESPONSE data, not node data: a component's children are the same bytes for
// every instance of it, so they are emitted here once and each INSTANCE carries only its
// `overrides` diff. Absent when the subtree touched no component. This is the shape REST already
// serves, so the two read edges stay one vocabulary.
export interface GetResult { node: SimplifiedNode; components?: Record<string, SimplifiedComponentEntry> }

// `remove` can't hand back a handle for a node that no longer exists, so it names the id it
// deleted — enough for the agent to scrub any handle it was still holding.
export interface RemoveResult { removedId: string; from?: Handle }

// A page, named the two ways anything addresses one. NOT a Handle: a page is not a SceneNode, has no
// geometry, and can't be a `target` — every verb acts on the CURRENT page, which is what the page
// verbs move.
export interface PageSummary { id: string; name: string }

// What every page verb answers with: the file, where you are, and what else is in the document.
export interface PageInfo { fileName: string; page: PageSummary; pages: PageSummary[] }

// flcm.designTokens — the tokens a write can bind. Each entry's `reference` is the exact value a read
// emits for a prop bound to that token, so it pastes into a write as-is. Values use the read's
// spellings: hex/rgba colors, rounded numbers, and an alias as the reference to the variable it points at.
export type DesignTokenVariableValue = string | number | boolean | VariableReference;
export interface DesignTokenVariable {
  reference: VariableReference;
  collection: string;
  type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  /** By mode name, in the collection's mode order. */
  values: Record<string, DesignTokenVariableValue>;
  /** Omitted when the variable may be used everywhere (Figma's ALL_SCOPES). */
  scopes?: string[];
  /** Present (true) when the variable comes from a library rather than this file. */
  remote?: true;
}
export interface DesignTokenStyle {
  reference: StyleReference;
  type: "PAINT" | "EFFECT" | "TEXT";
  /** Absent for a style with nothing visible in it (an empty or all-hidden paint or effect stack). */
  value?: SimplifiedFill | SimplifiedFill[] | SimplifiedEffects | SimplifiedTextStyle;
  remote?: true;
}
export interface DesignTokens { variables: DesignTokenVariable[]; styles: DesignTokenStyle[] }

// A locate query: the declarative facets find/findOne match, AND-combined. `type` and `key` are exact;
// `name` is a case-insensitive substring (layer names are fuzzy — findOne's cardinality guard catches an
// over-broad match). `within` scopes the scan to a subtree (target-by-shape, default: current page).
export interface FindQuery { type?: string; name?: string | RegExp; key?: string; within?: Target; hasAnnotations?: boolean }

// find's optional second arg: a caller closure over a candidate's FULL EXPANDED read shape — the same
// SimplifiedNode `get` returns, with values inline (Invariant 3), so `n.fill` is a value (a hex like
// "#FFFFFF") and never a "fill_…" styles ref. It runs in-sandbox; the query pre-filter narrows what reaches
// it, and only candidates the core actually materialized are passed (a dropped/collapsed node never is).
// Returns anything truthy — an ordinary JS predicate, never shipped anywhere.
export type ReadPredicate = (node: SimplifiedNode) => unknown;

// An explicit raw-id target — the escape hatch flcm.id(id) returns. Tagged (not a bare string) so the
// resolver treats it as a live-node id and NEVER as an flcm/key: the one way to force id resolution when a
// string could be read either way. Plain data, like a WriteNode.
export interface RawIdRef { __flcmId: string }

// What any target-taking verb (get/find/edit) accepts, resolved by shape (read.resolveTarget):
// a bare string (auto-detected node id or flcm/key), an explicit id via flcm.id(id), or any
// handle-shaped object carrying an `id` — a render Handle, a find/selection SlimHandle, a read
// POJO. SlimHandle is named in the union (not just assignable) because it's what the locate verbs
// actually return, and the runtime accepts any `{ id }` regardless.
export type Target = string | RawIdRef | { id: string };
