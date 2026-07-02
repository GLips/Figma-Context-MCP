// ir — the typed WriteNode currency: the ONE internal representation the whole preamble speaks. Every
// leaf is a real type (a number, a typed edge box, a discriminated paint/effect spec), never a CSS
// string. The sugar (flcm.ts) compiles terse author props straight into this; the bridge (bridge.ts)
// reads it and drives the plugin API. Nothing between them parses or re-serializes a string.
//
// WHY TYPED, NOT CSS-STRING LEAVES. The IR used to carry CSS strings (gap "8px", a "t r b l" padding
// box, "linear-gradient(...)") to be a verbatim sibling of figma-mcp's read-side SimplifiedNode — the
// idea being a `get` result could be tweaked and written back unchanged. But that read↔write unity only
// matters at the AGENT I/O BOUNDARY; internally the string form forced a number→string→number round-trip
// on the only path that ships today (authoring). So strings are now quarantined to css.ts (the input
// boundary), and the currency here is typed. The read-port promise is re-framed accordingly: a future
// `get` result (a SimplifiedNode of CSS strings) NORMALIZES through css.ts into this typed WriteNode
// before render — mechanically, in one place — rather than being rendered string-for-string.
//
// Phase-1 scope: only create/render fields. Read-compression refs (globalVars/template/styles),
// components, prototype, variables, images, and rich text are deliberately absent.

// The node types createable through the plugin API, enumerated explicitly. Not every figma-mcp/REST
// `type` round-trips to a create call, so the set is closed: bridge.ts's BUILDERS table is typed
// `Record<WriteType, …>` (TS enforces a builder per type) and render() rejects anything outside it with
// a specific error rather than letting a confusing plugin-API throw surface.
export type WriteType = "FRAME" | "TEXT" | "RECTANGLE" | "ELLIPSE" | "LINE" | "VECTOR";

export interface Rgb { r: number; g: number; b: number }
export interface Rgba { r: number; g: number; b: number; a: number }

// ---- Paint currency (Figma-domain). A solid carries its alpha on `opacity` (Figma stores paint alpha
// there, not in the color). A gradient carries the computed 2x3 transform and stops — the angle→matrix
// math is already done (paint.ts), so the bridge maps straight to a plugin Paint. ----
export interface SolidSpec { kind: "solid"; color: Rgb; opacity: number }
export type GradientType = "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
export type Transform = [[number, number, number], [number, number, number]];
export interface GradientStop { position: number; color: Rgba }
export interface GradientSpec { kind: "gradient"; type: GradientType; transform: Transform; stops: GradientStop[] }

// ---- Image paint currency. Unlike solid/gradient, an image spec is NOT self-contained: turning it into a
// plugin ImagePaint needs the raster BYTES, and the sandbox never touches the network (manifest
// allowedDomains:["none"]). So an ImageSpec is INERT — it carries only the source url + intent — and the
// bridge resolves it to a paint at render, keyed by url, from bytes the trusted server fetched+validated
// and injected. `placeholder` records stand-in-vs-real; the bridge persists it on the node (pluginData) so
// a later read can tell them apart — the one content case whose semantics don't recover from geometry. ----
export type ImageScaleMode = "FILL" | "FIT" | "CROP" | "TILE";
export interface ImageSpec { kind: "image"; url: string; scaleMode: ImageScaleMode; placeholder: boolean }
export type PaintSpec = SolidSpec | GradientSpec | ImageSpec;

// ---- Author input shapes for a fill/stroke leaf. An author passes a CSS color/gradient string, the
// read-form { type, gradient } object, OR an already-typed PaintSpec (what flcm.gradient() returns).
// These live here (the figma-free type hub) rather than in css.ts so the schema module can source them
// via `import type` without dragging css.ts's parsers — and their Figma-typings — into a typecheck. ----
export interface WriteGradientFill { type: GradientType; gradient: string }
export type FillInput = string | WriteGradientFill | PaintSpec;

// ---- Effect currency (Figma-domain). A blur's radius is ALREADY the Figma radius — the ×2 CSS-blur
// factor (see effects.ts) is applied when the spec is built, never here and never in the bridge, so a
// Figma-radius value can't be double-doubled. A shadow's radius is 1:1 with CSS. ----
export interface ShadowSpec { kind: "shadow"; inner: boolean; color: Rgba; offset: { x: number; y: number }; radius: number; spread: number }
export interface BlurSpec { kind: "blur"; type: "LAYER_BLUR" | "BACKGROUND_BLUR"; radius: number }
// Beyond-CSS effects (plugin-typings@1.130.0). No CSS spelling exists, so these are object-form only and
// carry raw Figma-domain values — no CSS-px scaling (the ×2 blur factor never touches them). radius/offset
// units are Figma's own. See effects.ts:toFigmaEffects for the plugin-Effect mapping and the live-runtime
// notes (notably: the running runtime rejects NOISE.blendMode despite the typing listing it).
export interface GlassSpec { kind: "glass"; lightIntensity: number; lightAngle: number; refraction: number; depth: number; dispersion: number; radius: number }
export interface NoiseSpec { kind: "noise"; noiseType: "MONOTONE" | "DUOTONE" | "MULTITONE"; color: Rgba; noiseSize: number; density: number; secondaryColor?: Rgba; opacity?: number }
export interface TextureSpec { kind: "texture"; noiseSize: number; radius: number; clipToShape: boolean }
// The progressive LAYER_BLUR variant: radius is the END radius; the blur ramps startRadius→radius along the
// startOffset→endOffset axis (offsets normalized to the node's 0–1 object space).
export interface ProgressiveBlurSpec { kind: "progressiveBlur"; startRadius: number; radius: number; startOffset: { x: number; y: number }; endOffset: { x: number; y: number } }
export type EffectSpec = ShadowSpec | BlurSpec | GlassSpec | NoiseSpec | TextureSpec | ProgressiveBlurSpec;

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
export interface WriteTextStyle {
  fontFamily?: string;
  fontWeight?: number | string;
  fontSize?: number;
  // CSS font-style. Resolved into the loaded font's italic variant (fonts.ts keys on it, the bridge
  // applies it via setRangeFontName — italic is a font-name concern in Figma, not a separate call).
  // "normal" appears only as a per-run inverse override on an italic base.
  fontStyle?: "italic" | "normal";
  lineHeight?: WriteLineHeight;
  letterSpacing?: WriteLetterSpacing;
  // Applied as a separate Figma call (node.textDecoration / setRangeTextDecoration), independent of
  // the font name — so a run carrying only a decoration change needs no per-range font.
  textDecoration?: TextDecoration;
  // CSS-named to match its siblings (fontStyle/textDecoration and WriteLayout.justifyContent/alignItems):
  // IR field NAMES mirror CSS; only the VALUES stay terse where a terse form exists — here the CSS values
  // (left/center/right/justify) already are the canonical spelling, so name and value both align.
  textAlign?: TextAlign;
}

// ---- Rich text: a styled span within one text node. A `runs` array on a TEXT WriteNode carries the
// per-span content + overrides; the bridge concatenates the run texts into the node's characters and
// applies each run's style/fills over its slice via Figma's setRange* API. Omitted style fields inherit
// the node-level textStyle (the base), so a run only carries what it changes. `textAlign` is deliberately
// unused per-run — horizontal alignment is a paragraph (node) property in Figma, not per-range. ----
export interface WriteTextRun {
  text: string;
  style?: WriteTextStyle;
  fills?: PaintSpec[];
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
export type Align = "start" | "center" | "end" | "stretch";
export type Sizing = "fixed" | "fill" | "hug";
export interface Edges { top: number; right: number; bottom: number; left: number }

// ---- Constraint override (author `pin`). Directional per axis so the axis is unambiguous at the boundary
// (x names an edge on the horizontal axis, y on the vertical); the bridge maps each to Figma's per-axis
// constraint enum. Governs how a positioned child reflows when its parent resizes — a free-form parent's
// children and an absolute child of any parent; inert on an in-flow auto-layout child. ----
export type PinX = "left" | "center" | "right" | "stretch" | "scale";
export type PinY = "top" | "center" | "bottom" | "stretch" | "scale";

// ---- Blend mode (author `blend`). The CSS mix-blend-mode names normalize to Figma's BlendMode enum at
// the css.ts boundary; this is the resolved Figma-domain currency. A SUBSET of Figma's BlendMode — only the
// CSS-reachable modes — so PASS_THROUGH (frame-grouping only) and LINEAR_BURN/LINEAR_DODGE (no CSS
// mix-blend-mode spelling) are deliberately absent. Every SceneNode carries blendMode, so it's a shared prop.
export type WriteBlendMode =
  | "NORMAL" | "DARKEN" | "MULTIPLY" | "COLOR_BURN" | "LIGHTEN" | "SCREEN" | "COLOR_DODGE"
  | "OVERLAY" | "SOFT_LIGHT" | "HARD_LIGHT" | "DIFFERENCE" | "EXCLUSION" | "HUE"
  | "SATURATION" | "COLOR" | "LUMINOSITY";

// ---- Anchor (author `absolute.anchor`). Which point of an absolute child lands on the resolved x/y.
// Reuses `pin`'s directional edge words (no stretch/scale — an anchor is a point, not a resize rule).
// Default {left, top} is back-compatible: the child's top-left sits at x/y, the pre-anchor behavior. ----
export type AnchorX = "left" | "center" | "right";
export type AnchorY = "top" | "center" | "bottom";
export interface WriteLayout {
  mode?: "none" | "row" | "column";
  justifyContent?: Justify; // primary-axis distribution (author `layout.justifyContent`)
  alignItems?: Align;       // counter-axis alignment (author `layout.alignItems`)
  gap?: number;
  padding?: Edges;
  sizing?: { horizontal?: Sizing; vertical?: Sizing };
  dimensions?: { width?: number; height?: number };
  // Percent INTENT — a `w`/`h`/`absolute.x`/`absolute.y` written as "N%" (0–100), resolved to pixels
  // against the parent's *realized* axis size in a post-walk pass (bridge.resolvePercents): the node is
  // built at a provisional size first, then resized once the whole tree is assembled and every parent's
  // fill/hug size is readable off the canvas — the parent size isn't known at construction, and reading it
  // at walk time would predate the fill/hug pin. A percent SIZE also sets sizing.horizontal/vertical =
  // "fixed" (post-resolution it IS a fixed px); percent POSITION rides on the existing `position:"absolute"`.
  // Absent unless the author wrote a percent.
  percentSize?: { width?: number; height?: number };
  percentPos?: { x?: number; y?: number };
  // Anchor point for an absolute child (author `absolute.anchor`) — which corner/edge of the child lands on
  // the resolved x/y. Applied in the same post-walk pass as percent position (it needs the child's realized
  // size to offset by). Absent → {left, top} (top-left on x/y), the back-compatible default.
  anchor?: { x?: AnchorX; y?: AnchorY };
  // Explicit Figma-constraint override for a positioned child — how it responds when the parent resizes.
  // Overrides the constraint the bridge auto-derives from the child's size/position intent (fill→STRETCH,
  // "N%"→SCALE, percent position→CENTER, else pinned to the near edge). Absent unless the author wrote a
  // `pin`. Honored for a free-form parent's child and an absolute child; inert on an in-flow auto-layout
  // child (which reflows via fill/hug instead).
  pin?: { x?: PinX; y?: PinY };
  position?: "absolute";
  locationRelativeToParent?: { x: number; y: number };
}

export interface WriteNode {
  type: WriteType;
  name?: string;
  // Our pluginData('flcm/key') identity — the one field write ADDS over read. Optional in v1
  // (reconcile deferred): key the nodes you'll address, leave the rest anonymous.
  key?: string;
  text?: string;
  // Vector content. A VECTOR WriteNode carries EXACTLY ONE of these two, and they drive two different
  // plugin calls — the two vector verbs are not interchangeable (see flcm.svg / flcm.path):
  //   • `svg`      — raw SVG markup → figma.createNodeFromSvg, which returns a FRAME of vectors with its
  //                  colors baked in. So a VECTOR-typed node can render a FrameNode; the handle reports the
  //                  real created type. Appearance props don't apply (color lives in the markup).
  //   • `pathData` — a single `d` path string → figma.createVector() + vectorPaths, one vector node that
  //                  takes our appearance props (fill/stroke/…) directly, so it themes like any primitive.
  svg?: string;
  pathData?: string;
  // Styled spans for a TEXT node. Mutually exclusive with a bare `text` string at the author boundary;
  // when present the bridge builds `characters` from the runs and `textStyle` is the base the runs layer
  // over. Absent for the plain-string form.
  runs?: WriteTextRun[];
  textStyle?: WriteTextStyle;
  // TEXT only: clamp the node to at most N lines, truncating with an ending ellipsis (textTruncation:
  // "ENDING" + maxLines:N in the bridge). The author boundary (flcm.text) rejects it on a width-hugging
  // text — truncation needs a bounded width to wrap against — so a value here always has a wrap to bite.
  maxLines?: number;
  fills?: PaintSpec[];
  strokes?: PaintSpec[];
  strokeWeight?: number;
  effects?: EffectSpec[];
  opacity?: number;
  blendMode?: WriteBlendMode; // author `blend` (CSS mix-blend-mode → Figma BlendMode); applied in buildNode (shared: every node has one)
  borderRadius?: number;
  clip?: boolean;     // clipsContent
  rotation?: number;  // degrees (write-add; read does not surface it)
  layout?: WriteLayout;
  children?: WriteChild[];
}

// A child slot may be falsy so `cond && flcm.text(...)` composes; the bridge skips falsy entries.
export type WriteChild = WriteNode | null | false | undefined;

// A node's resolved geometry, in figma-mcp's read-side { x, y, width, height } shape — deliberately NOT
// the author-sugar w/h names — so an authoring handle and a future read/edit round-trip speak one currency
// (a divergence here would force a migration when the read path lands). x/y are parent-relative, like
// Figma's node.x/node.y.
export interface BoundingBox { x: number; y: number; width: number; height: number }

// A Handle is the JSON-safe reference render() returns for a node: what crosses the bridge back to the
// agent in place of a live (unserializable) Figma node. Defined here so the schema module can type
// render()'s return without importing bridge.ts (which speaks figma.*). `boundingBox` is the node's
// resolved geometry, settled by render()'s post-walk read-back (see bridge.readBackGeometry).
export interface Handle { id: string; type: string; name: string; key?: string; text?: string; boundingBox: BoundingBox }
