// schema — THE single source of the agent-facing authoring surface. Every verb, every prop, its type,
// and its one-line doc live here exactly once, as zod field schemas carrying `.describe()` (the note a
// human/agent reads) and `.meta({ type })` (the displayed type label where the real TS type is looser
// than what we want to show, e.g. a `number | string` we document as `number | "Npx"`).
//
// THREE consumers, ONE source:
//   1. TYPES — flcm.ts infers its Props (`FrameProps`, `TextProps`, …) from these schemas via `z.infer`
//      and imports them as `import type` ONLY. Type-only imports are erased by esbuild, so this module's
//      zod NEVER enters the sandbox bundle (acceptance: `grep zod plugin/dist/code.js` is empty). The
//      constructors stay the sole runtime; this file is inert type + doc metadata.
//   2. DOCS — the server walks these schemas at startup to generate the execute_code quick-start and the
//      get_flcm_reference sections. A prop that isn't here can't be documented; a documented prop that's
//      deleted here also vanishes from the Props type, so flcm.ts stops compiling. Drift is structural,
//      not vigilance.
//   3. SHAPE CHECK — flcm.ts asserts its real exports `satisfies Flcm`, so the typed public surface below
//      can't drift from the functions it describes; the compile-checked example files author against it.
//
// This module imports zod (runtime, server-side) but only `import type` from ir.js (the figma-free type
// hub) — never from css/paint/effects/bridge, which speak figma.* / plugin-typings and would poison a
// server-side typecheck. It is validation-free by design: author input is validated by the sandbox
// parsers (css.ts) at runtime, so the leaf schemas here exist for their TYPE and DOC, not to re-validate.

import { z } from "zod";
import type {
  FillInput, WriteCssEffects, PaintSpec, EffectSpec, GradientStop, WriteNode, WriteChild, Handle,
  PinX, PinY,
} from "./ir.js";

// ---- Author leaf-input types the schema references but can't structurally model in zod (they're loose
// on purpose, or reference the typed currency). `z.custom<T>()` infers exactly T with no runtime check —
// perfect here, since these are never validated by zod, only inferred and documented. ----
export type LengthInput = number | string; // a number or "Npx"
export type PadInput =
  | number
  | { x?: number; y?: number; top?: number; right?: number; bottom?: number; left?: number };

export type GradientStopInput = string | { color: string; pos?: number; position?: number };
export type GradientSugar = {
  type?: "linear" | "radial";
  stops?: GradientStopInput[];
  angle?: number;
  at?: { x?: number; y?: number };
};
export type ShadowSugar =
  | true
  | { x?: number; y?: number; blur?: number; spread?: number; color?: string; inner?: boolean };
export type BlurSugar = number | { layer?: number; background?: number; radius?: number };
// Beyond-CSS effects (no CSS spelling — object form only). `true` selects all-default. All numeric values
// are raw Figma-domain (no CSS-px scaling). See ir.ts / effects.ts.
export type GlassSugar = true | { lightIntensity?: number; lightAngle?: number; refraction?: number; depth?: number; dispersion?: number; radius?: number };
export type NoiseSugar =
  | true
  | { type?: "monotone" | "duotone" | "multitone"; color?: string; secondaryColor?: string; opacity?: number; noiseSize?: number; density?: number };
export type TextureSugar = true | { noiseSize?: number; radius?: number; clipToShape?: boolean };
export type ProgressiveBlurSugar = number | { startRadius?: number; endRadius?: number; startOffset?: { x: number; y: number }; endOffset?: { x: number; y: number } };
export type EffectsSugar = {
  shadow?: ShadowSugar | ShadowSugar[];
  blur?: BlurSugar;
  backgroundBlur?: BlurSugar;
  glass?: GlassSugar;
  noise?: NoiseSugar;
  texture?: TextureSugar;
  progressiveBlur?: ProgressiveBlurSugar;
};

// The `effects` prop accepts the sugar bag, an already-typed EffectSpec[] (what flcm.effects returns), or
// a CSS-string bag.
export type EffectsInput = EffectSpec[] | WriteCssEffects | EffectsSugar;

// ---- prop() — one optional field carrying its note (.describe) and, when the shown type should differ
// from the inferred one, a display label (.meta.type). The generator reads .description + .meta().type. ----
function prop<T extends z.ZodType>(schema: T, note: string, type?: string) {
  const described = schema.optional().describe(note);
  return type ? described.meta({ type }) : described;
}

const color = (note: string) => prop(z.custom<FillInput>(), note, "color / gradient");
const metric = (note: string) => prop(z.union([z.number(), z.string()]), note, 'number | "Npx"');
const degrees = (note: string) => prop(z.number(), note, "number (deg)");

// ---- Field groups. Each verb schema is composed from these by spread, so a field is authored once and
// reused across every verb it appears on. The reference tables render these same groups. ----

const SHARED_FIELDS = {
  name: prop(z.string(), "The node's layer name in Figma."),
  key: prop(z.string(), "An address for this node — only keyed nodes come back in render()'s `keyed` map. Author-unique per render."),
  opacity: prop(z.number(), "Whole-node opacity, 0–1.", "number (0–1)"),
  mixBlendMode: prop(
    z.string(),
    "Blend mode — a CSS mix-blend-mode name (multiply, screen, overlay, soft-light, color-dodge, …). Composites this node against what's behind it. An unknown name fails loud.",
    '"normal" | "multiply" | "screen" | "overlay" | "soft-light" | … (CSS mix-blend-mode)',
  ),
};

const SIZE_FIELDS = {
  // A percent ("50%") widens the runtime type to `string`, so `"fill"`/`"hug"` no longer survive as
  // literals in the inferred type — hence an explicit .meta label to keep the doc precise.
  width: prop(
    z.union([z.number(), z.string()]),
    'Width. A number is fixed px; "N%" is a percent of the parent on this axis (free-form parent with a fixed size only). "fill" stretches to the parent (needs an auto-layout parent); "hug" shrinks to content. Not a "px" string.',
    'number | "fill" | "hug" | "N%"',
  ),
  height: prop(
    z.union([z.number(), z.string()]),
    "Height. Same rules as width.",
    'number | "fill" | "hug" | "N%"',
  ),
  absolute: prop(
    z.object({
      x: z.union([z.number(), z.string()]).optional(),
      y: z.union([z.number(), z.string()]).optional(),
      anchor: z
        .object({
          x: z.enum(["left", "center", "right"]).optional(),
          y: z.enum(["top", "center", "bottom"]).optional(),
        })
        .optional(),
    }),
    'Lifts the node out of its parent\'s auto-layout flow and pins it at x/y relative to the parent. Use for overlays, badges, decorations. x/y are px numbers or "N%" (percent of the parent axis). `anchor` picks which point of the node lands on x/y — x: "left"|"center"|"right", y: "top"|"center"|"bottom" (default { left, top }); e.g. anchor:{ x:"center" } with x:"50%" centres the node on the midpoint instead of offsetting it by its own width.',
    '{ x?, y?, anchor?: { x?, y? } } — x/y number or "N%"',
  ),
  pin: prop(
    z.custom<{ x?: PinX; y?: PinY }>(),
    'Constraint override — how this node responds when its parent resizes. Overrides the auto choice (w:"fill"→stretch, "N%"→scale, percent absolute position→center, else pinned to the near edge). x: "left"|"center"|"right"|"stretch"|"scale"; y: "top"|"center"|"bottom"|"stretch"|"scale". Honored for a child of a free-form parent and for any `absolute` child; ignored on an in-flow auto-layout child (which reflows via fill/hug instead).',
    '{ x?, y? } — x: left/center/right/stretch/scale, y: top/center/bottom/stretch/scale',
  ),
};

const APPEARANCE_FIELDS = {
  fill: color("Background paint — a color/gradient string, or flcm.gradient(...)."),
  stroke: color("Border paint."),
  strokeWidth: metric("Border thickness."),
  borderRadius: metric("Corner radius. Frames and rectangles only (ellipses ignore it)."),
  effects: prop(z.custom<EffectsInput>(), "Shadows / blur — flcm.effects({...}), or a CSS-string bag.", "effects value"),
  rotation: degrees("Rotation in degrees."),
};

// Auto-layout container config. The hybrid structure (canonical vocabulary) groups it under a single
// `layout` object so a frame's container props read/author as one nested block — mirroring the read side's
// `layout: { mode, justifyContent, alignItems, gap, padding }`. Values are CSS: justify/align spell the
// realizable subset of `justify-content`/`align-items`; the sugar boundary (flcm.ts) maps them to the
// terse render intent, and rejects any valid-CSS-but-unrealizable spelling (space-around/-evenly) loud.
const LAYOUT_FIELDS = {
  mode: prop(z.enum(["row", "column", "none"]), 'Auto-layout direction. Default "none" (free-form; gap/padding/justifyContent/alignItems then do nothing). flcm cannot author grid — a "grid" attempt fails loud.'),
  gap: metric("Space between children."),
  padding: prop(
    z.custom<PadInput>(),
    "Padding, in numbers (not \"px\" strings). { x, y } is shorthand: x→left+right, y→top+bottom.",
    "number | { x?, y? } | { top?, right?, bottom?, left? }",
  ),
  justifyContent: prop(
    z.enum(["flex-start", "flex-end", "center", "space-between"]),
    'Distribution along the main axis (CSS justify-content). Realizable subset: "flex-start" (default) | "flex-end" | "center" | "space-between". Figma auto-layout has no space-around/space-evenly — those fail loud.',
  ),
  alignItems: prop(
    z.enum(["flex-start", "flex-end", "center", "stretch"]),
    'Alignment on the cross axis (CSS align-items). "stretch" stretches every auto-sized child across the cross axis; a child with a fixed cross-axis size keeps it. (You can also stretch a single child by setting its width/height to "fill".)',
  ),
};

const FRAME_FIELDS = {
  layout: prop(
    z.object(LAYOUT_FIELDS),
    "Auto-layout container config (mode/gap/padding/justifyContent/alignItems). Omitted or mode:\"none\" = free-form (children position absolutely).",
    "{ mode?, gap?, padding?, justifyContent?, alignItems? }",
  ),
  clip: prop(z.boolean(), "Clip children to the frame's bounds (clipsContent). Default false — like CSS, overflow is visible unless you set clip:true."),
};

// Text style — the base every run layers over. The hybrid structure groups these under a `textStyle`
// object (canonical names: fontFamily/fontWeight/fontSize/textAlign), mirroring the read side. Node-level
// text `color` is NOT here — it's a top-level sugar prop compiling to the node's `fills`, like every other
// node's color (see TEXT_FIELDS).
const TEXTSTYLE_FIELDS = {
  fontFamily: prop(z.string(), "Font family. An unknown family falls back to Inter."),
  fontWeight: prop(
    z.union([z.number(), z.string()]),
    "Font weight, snapped to the nearest available style. Numbers 100–900, or names: thin/hairline, extralight/ultralight, light, normal/regular/book, medium, semibold/demibold, bold, extrabold/ultrabold, black/heavy.",
    "number (100–900) | name",
  ),
  fontSize: prop(z.number(), "Font size in px."),
  fontStyle: prop(
    z.enum(["italic", "normal"]),
    'CSS font-style — "italic" or "normal" (no oblique). Snaps to the family\'s italic variant. On the base only "italic" is meaningful; "normal" is a run-delta inverse override on an italic base.',
  ),
  lineHeight: prop(
    z.union([z.number(), z.string()]),
    'Line height. "auto"/"normal" = the font default. em/% are relative to font size.',
    'number(px) | "Npx" | "N%" | "Nem" | "auto"',
  ),
  letterSpacing: prop(
    z.union([z.number(), z.string()]),
    "Tracking. em/% are relative to font size.",
    'number(px) | "Npx" | "N%" | "Nem"',
  ),
  textDecoration: prop(
    z.enum(["underline", "line-through", "none"]),
    'CSS text-decoration-line — "underline" | "line-through" | "none". On the base only "underline"/"line-through"; "none" is a run-delta inverse override clearing an inherited decoration. (Strikethrough is also authorable inline as ~~text~~.)',
  ),
  textAlign: prop(z.enum(["left", "center", "right", "justify"]), "Horizontal text alignment (CSS text-align)."),
  lineClamp: prop(
    z.number(),
    'Clamp the text to at most N lines, truncating with an ellipsis (…). Needs a bounded width — a fixed/`"fill"`/`"N%"` `width` — so the text wraps; on a width-hugging text there is nothing to truncate and it fails loud. N must be a whole number ≥ 1.',
    "number (≥1)",
  ),
};

const TEXT_FIELDS = {
  textStyle: prop(
    z.object(TEXTSTYLE_FIELDS),
    "Text style base (fontFamily/fontWeight/fontSize/fontStyle/lineHeight/letterSpacing/textDecoration/textAlign/lineClamp). Runs layer over it.",
    "{ fontFamily?, fontWeight?, fontSize?, fontStyle?, lineHeight?, letterSpacing?, textDecoration?, textAlign?, lineClamp? }",
  ),
  color: color("Text color (a solid color, normally) — a node-level sugar prop compiling to the text node's fill."),
};

// The rich-text run's style delta — the second element of a `[text, style]` run tuple (the array form of
// flcm.text). Every field overrides the node-level `textStyle` base for just that span, so a run carries
// only what it changes. Canonical StyleDelta field names (fontWeight, not weight), reusing the TEXTSTYLE
// entries so a run styles exactly like the base and the two can't drift. `textAlign`/`lineClamp` are absent:
// alignment and clamping are whole-node properties, not per-run. `color` and `hyperlink` are the delta-only
// fields the base lacks (base color lives in the node's fill; base links are a read-only artifact).
const RUN_FIELDS = {
  fontWeight: TEXTSTYLE_FIELDS.fontWeight,
  fontSize: TEXTSTYLE_FIELDS.fontSize,
  fontFamily: TEXTSTYLE_FIELDS.fontFamily,
  fontStyle: TEXTSTYLE_FIELDS.fontStyle,
  lineHeight: TEXTSTYLE_FIELDS.lineHeight,
  letterSpacing: TEXTSTYLE_FIELDS.letterSpacing,
  textDecoration: TEXTSTYLE_FIELDS.textDecoration,
  color: color("Per-span text color."),
  hyperlink: prop(z.string(), "URL hyperlink over this span. The inline form [text](url) is usually simpler; this sets it explicitly on a tuple. URL only (a design's NODE links are read-only).", "string (url)"),
};

const RunStyleSchema = z.object(RUN_FIELDS);
export type StyleDeltaInput = z.infer<typeof RunStyleSchema>;

// A run is a bare string (a plain segment) or a `[text, style]` tuple (a styled span) — the canonical run
// model, identical to the read side's `Run = string | [text, style]`. The tuple's style is always an inline
// StyleDelta (never a styles-table ref — refs are read-only).
export type TextRunInput = string | [text: string, style: StyleDeltaInput];

// A line sizes ONLY along its length: the constructor honors numeric `length`/`w` and `absolute`, and
// ignores `h`/`"fill"`/`"hug"`. So LineSchema does NOT spread the full SIZE_FIELDS — typing props the
// constructor drops would let a compile-checked example pass while rendering wrong (a real hole, since the
// example's whole job is to fail the build on API mismatch). It carries exactly what `line` reads.
const LINE_FIELDS = {
  stroke: color("The line's paint. stroke wins if both stroke and color are set."),
  color: color("The line's paint (alias for stroke)."),
  strokeWidth: metric("Thickness. Defaults to 1."),
  length: prop(z.number(), "The line's length in px.", "number"),
  w: prop(z.number(), "The line's length in px — alias for `length` (`length` wins if both are set).", "number"),
  rotation: degrees("Degrees. A horizontal line rotated 90° becomes vertical."),
  absolute: SIZE_FIELDS.absolute,
  pin: SIZE_FIELDS.pin,
};

// A single themeable vector (flcm.path): the shared appearance vocabulary MINUS `radius` (a vector has no
// corner radius — accepting it would be a documented no-op, which ADR-0003 forbids) plus the required `d`.
// Reuses the APPEARANCE_FIELDS entries so a path themes exactly like a rect and the docs can't drift.
const PATH_FIELDS = {
  d: z
    .string()
    .describe(
      'SVG path data — the `d` attribute string, e.g. "M12 2 L22 20 L2 20 Z". Any standard command works ' +
        "(H V S T A and relative/lowercase are auto-normalized); only genuinely malformed data fails. Required.",
    ),
  fill: APPEARANCE_FIELDS.fill,
  stroke: APPEARANCE_FIELDS.stroke,
  strokeWidth: APPEARANCE_FIELDS.strokeWidth,
  effects: APPEARANCE_FIELDS.effects,
  rotation: APPEARANCE_FIELDS.rotation,
};

// ---- Composed verb schemas → inferred Props. flcm.ts imports these types (import type only). The Base/
// Size/Appearance sub-schemas exist so flcm.ts's shared compilers (base/applySizing/appearance) type
// against the same fields the verbs are built from. ----
export const BaseSchema = z.object(SHARED_FIELDS);
export const SizeSchema = z.object(SIZE_FIELDS);
// Appearance carries the shared base fields too (name/key/opacity) — flcm.ts's appearance() compiler runs
// base() over the same value, so the type it accepts must include them.
export const AppearanceSchema = z.object({ ...SHARED_FIELDS, ...APPEARANCE_FIELDS });
export type BaseProps = z.infer<typeof BaseSchema>;
export type SizeProps = z.infer<typeof SizeSchema>;
export type AppearanceProps = z.infer<typeof AppearanceSchema>;

export const FrameSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS, ...APPEARANCE_FIELDS, ...FRAME_FIELDS });
export const TextSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS, ...TEXT_FIELDS });
export const ShapeSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS, ...APPEARANCE_FIELDS });
export const LineSchema = z.object({ ...SHARED_FIELDS, ...LINE_FIELDS });
export const PathSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS, ...PATH_FIELDS });
// svg pastes opaque markup: size/position only, no appearance (colors are baked into the markup). `markup`
// is the positional first arg, like text's `content`, so it isn't a prop field here.
export const SvgSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS });

export type FrameProps = z.infer<typeof FrameSchema>;
export type TextProps = z.infer<typeof TextSchema>;
export type ShapeProps = z.infer<typeof ShapeSchema>;
export type LineProps = z.infer<typeof LineSchema>;
export type PathProps = z.infer<typeof PathSchema>;
export type SvgProps = z.infer<typeof SvgSchema>;

// flcm.image(url, opts?) options — the second, optional arg to the image paint constructor. `url` is the
// positional first arg (like text's `content` / svg's `markup`), so it isn't a prop field here.
const IMAGE_FIELDS = {
  scaleMode: prop(
    z.enum(["FILL", "FIT", "CROP", "TILE"]),
    'How the image maps into the node box. Default "FILL" (cover). "FIT" contains it, "CROP" uses the crop transform, "TILE" repeats it.',
  ),
  placeholder: prop(
    z.boolean(),
    "Mark this as a stand-in, not a real asset. Persisted on the node so a later read can tell a placeholder from a real image (and not hardcode the stand-in url as the real src). Default false.",
  ),
};
export const ImageSchema = z.object(IMAGE_FIELDS);
export type ImageOpts = z.infer<typeof ImageSchema>;

// ---- gradient() / effects() sugar, documented as their own field tables. ----
export const GradientSchema = z.object({
  type: prop(z.enum(["linear", "radial"]), 'Gradient type. Default "linear".'),
  stops: prop(
    z.custom<GradientStopInput[]>(),
    'Color stops. Each is a color string ("#0B1020") or { color, pos } where pos is a percentage. With no pos, stops spread evenly. Required, non-empty.',
    "array of color strings or { color, pos }",
  ),
  angle: prop(z.number(), "Linear only. Degrees; 180 = top→bottom (default).", "number (deg)"),
  at: prop(z.object({ x: z.number().optional(), y: z.number().optional() }), "Radial only — the center, in percent. Default { x: 50, y: 50 }.", "{ x?, y? } percent"),
});

export const EffectsSchema = z.object({
  shadow: prop(
    z.custom<ShadowSugar | ShadowSugar[]>(),
    "A drop (or inner) shadow. `true` for the default, or { x?, y?, blur?, spread?, color?, inner? }. Defaults: x:0, y:4, blur:8, spread:0, color:\"rgba(0,0,0,0.25)\". `blur` is 1:1 with CSS.",
    "true | object | array",
  ),
  blur: prop(z.custom<BlurSugar>(), "A layer blur (blurs the node itself), in CSS px.", "number | { layer? }"),
  backgroundBlur: prop(z.custom<BlurSugar>(), "A background blur (frosted glass — blurs what's behind), in CSS px.", "number | { background? }"),
  glass: prop(
    z.custom<GlassSugar>(),
    "Native glass (refractive frosted pane) — no CSS equivalent, so object form only. `true` for a usable default pane, or { lightIntensity 0–1, lightAngle°, refraction 0–1, depth ≥1, dispersion 0–1, radius (frost px) }. Values are raw Figma units (not CSS-scaled).",
    "true | object",
  ),
  noise: prop(
    z.custom<NoiseSugar>(),
    'Grain overlay — object form only. `true` for a default monotone grain, or { type: "monotone"|"duotone"|"multitone", color, secondaryColor (duotone), opacity (multitone), noiseSize, density }. Note: the running runtime does not accept a per-noise blendMode (typing-ahead-of-runtime), so it is not exposed.',
    "true | object",
  ),
  texture: prop(
    z.custom<TextureSugar>(),
    "Textured surface — object form only. `true` for a default, or { noiseSize, radius, clipToShape }.",
    "true | object",
  ),
  progressiveBlur: prop(
    z.custom<ProgressiveBlurSugar>(),
    "A layer blur that ramps across the node — object form only. A number is the end radius; or { startRadius, endRadius, startOffset, endOffset }. Offsets are normalized 0–1 object space (default fade top→bottom: {x:0,y:0}→{x:0,y:1}). Raw Figma radii (not CSS-scaled).",
    "number | object",
  ),
});

// ---- The typed public surface. flcm.ts's real exports are asserted `satisfies Flcm`, so this can't
// drift from them; the example files author against it and fail the build if a signature moves. ----
export interface Flcm {
  frame(props?: FrameProps, children?: WriteChild | WriteChild[]): WriteNode;
  // A plain string, or an array of styled runs (rich text — per-span color/weight/size in one node).
  text(content: string | TextRunInput[], props?: TextProps): WriteNode;
  rect(props?: ShapeProps): WriteNode;
  ellipse(props?: ShapeProps): WriteNode;
  line(props?: LineProps): WriteNode;
  // Two vector verbs, two contracts. svg pastes opaque markup (colors baked in); path is a single themeable
  // vector taking our appearance props. `d` is required on path.
  svg(markup: string, props?: SvgProps): WriteNode;
  path(props: PathProps): WriteNode;
  gradient(spec: GradientSugar): PaintSpec;
  gradient(type: "linear" | "radial", stops: GradientStopInput[], angle?: number): PaintSpec;
  // A raster image fill value — like flcm.gradient, a paint you pass to any node's `fill`. The bytes are
  // fetched server-side (the sandbox reaches nothing); an unfetchable/blocked/invalid url fails loud.
  image(url: string, opts?: ImageOpts): PaintSpec;
  effects(spec: EffectsSugar): EffectSpec[];
  render(tree: WriteNode): Promise<{ root: Handle; keyed: Record<string, Handle> }>;
}

// ---- Verb registry — the canonical verb list, for the verb table and the quick-start signatures.
// `schema` links a verb to the prop schema whose fields the reference renders under it. ----
export interface VerbDoc {
  signature: string;
  builds: string;
  args: string;
  schema?: z.ZodObject;
}

export const VERBS: VerbDoc[] = [
  { signature: "flcm.frame(props?, children?)", builds: "a FRAME (container)", args: "props object, then an array of children", schema: FrameSchema },
  { signature: "flcm.text(content, props?)", builds: "a TEXT node", args: "content (a string or a runs array) first, then props", schema: TextSchema },
  { signature: "flcm.rect(props?)", builds: "a RECTANGLE", args: "props object", schema: ShapeSchema },
  { signature: "flcm.ellipse(props?)", builds: "an ELLIPSE", args: "props object", schema: ShapeSchema },
  { signature: "flcm.line(props?)", builds: "a LINE", args: "props object", schema: LineSchema },
  { signature: "flcm.svg(markup, props?)", builds: "a VECTOR from SVG markup", args: "SVG markup string first, then size/position props", schema: SvgSchema },
  { signature: "flcm.path(props)", builds: "a themeable VECTOR", args: "props object including `d` (path data)", schema: PathSchema },
  { signature: "flcm.gradient(...)", builds: "a gradient fill value", args: "object or positional form", schema: GradientSchema },
  { signature: "flcm.image(url, opts?)", builds: "an image fill value", args: "the image url first, then { scaleMode?, placeholder? }", schema: ImageSchema },
  { signature: "flcm.effects({...})", builds: "an effects value", args: "an { shadow, blur, backgroundBlur } bag", schema: EffectsSchema },
  { signature: "await flcm.render(tree)", builds: "live nodes", args: "returns { root, keyed }" },
];

// ---- Field-group registry — how the reference groups props into tables. Each verb's full schema drives
// its TYPE; these groups drive its DOC layout (shared/size tables once, verb-specific tables per verb). ----
export const FIELD_GROUPS = {
  shared: SHARED_FIELDS,
  size: SIZE_FIELDS,
  appearance: APPEARANCE_FIELDS,
  frame: FRAME_FIELDS,
  layout: LAYOUT_FIELDS,
  text: TEXT_FIELDS,
  textStyle: TEXTSTYLE_FIELDS,
  run: RUN_FIELDS,
  line: LINE_FIELDS,
  path: PATH_FIELDS,
  image: IMAGE_FIELDS,
  gradient: GradientSchema.shape,
  effects: EffectsSchema.shape,
} as const;
