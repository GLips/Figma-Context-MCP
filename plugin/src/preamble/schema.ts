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
  PinX, PinY, Target, RawIdRef, SlimHandle, FindQuery, ReadPredicate, InsertResult, MoveResult, CloneResult, RemoveResult,
  PageInfo,
} from "./ir.js";
// The read verbs return the canonical read shape the shared simplify core emits. Relative (not ~/) so the
// root toolchain, which imports this module for docs generation, resolves it without the plugin's paths.
import type { SimplifiedNode } from "@framelink/core";

// ---- Author leaf-input types the schema references but can't structurally model in zod (they're loose
// on purpose, or reference the typed currency). `z.custom<T>()` infers exactly T with no runtime check —
// perfect here, since these are never validated by zod, only inferred and documented. ----
export type LengthInput = number | string; // a number or "Npx"
export type PadInput =
  | number
  | string // the CSS box shorthand, in read's spelling: "12px" | "12px 16px" | "8px 8px 0px 0px"
  | { x?: LengthInput; y?: LengthInput; top?: LengthInput; right?: LengthInput; bottom?: LengthInput; left?: LengthInput };

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
// "none" is the surface-wide removal word (CSS's own absence spelling): effects:"none" clears the
// node's effects, the same way fill/stroke:"none" clear paint.
export type EffectsInput = EffectSpec[] | WriteCssEffects | EffectsSugar | "none";

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
  name: prop(z.string(), "Layer name."),
  key: prop(z.string(), "An address for this node — only keyed nodes come back in render()'s `keyed` map. Author-unique per render."),
  opacity: prop(z.number(), "Whole-node opacity, 0–1.", "number (0–1)"),
  mixBlendMode: prop(
    z.string(),
    "A CSS mix-blend-mode name. An unknown one fails loud.",
    '"normal" | "multiply" | "screen" | "overlay" | "soft-light" | … (CSS mix-blend-mode)',
  ),
  visible: prop(z.boolean(), "Layer visibility. A hidden node is invisible to find/get too, so re-target it by id."),
  locked: prop(z.boolean(), "Locks the layer against pointer edits in Figma's UI. flcm.edit still writes to it."),
};

const SIZE_FIELDS = {
  // A percent ("50%") widens the runtime type to `string`, so `"fill"`/`"hug"` no longer survive as
  // literals in the inferred type — hence an explicit .meta label to keep the doc precise.
  width: prop(
    z.union([z.number(), z.string()]),
    'A fixed size (a number or "Npx"), "N%" of the parent axis, "fill" (stretch to the parent — rejected on the root), or "hug" (shrink to content — only a row/column container or text can hug).',
    'number | "Npx" | "N%" | "fill" | "hug"',
  ),
  height: prop(
    z.union([z.number(), z.string()]),
    'Same rules as width. On TEXT the height follows the content: set `width` or use "fill"; a fixed, "hug", or percent height is rejected.',
    'number | "fill" | "hug" | "N%"',
  ),
  absolute: prop(
    z.union([
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
      z.literal("none"),
    ]),
    'Pins the node at x/y in its parent, lifting it out of auto-layout flow (badges, overlays). On a render root it is where on the PAGE the tree lands — without it every root stacks at the origin. `anchor` picks the node\'s own reference point (default { left, top }), so anchor:{ x:"center" } with x:"50%" centres it. Under edit, "none" returns the node to the flow.',
    '{ x?, y?, anchor?: { x?, y? } } | "none" — x/y number, "Npx" or "N%"',
  ),
  pin: prop(
    z.custom<{ x?: PinX; y?: PinY } | "none">(),
    'Constraint override — how the node responds when its parent resizes, replacing the automatic choice. Honored for a child of a free-form parent and for any `absolute` child; on an in-flow auto-layout child it is stored but inert (fill/hug governs there) until the node leaves the flow. Under edit, "none" restores the default near-edge pin.',
    '{ x?, y? } | "none" — x: left/center/right/stretch/scale/none, y: top/center/bottom/stretch/scale/none',
  ),
};

const APPEARANCE_FIELDS = {
  fill: color('Background paint: a color/gradient string or flcm.gradient(...). "none" removes it.'),
  stroke: color('Border paint. "none" removes it.'),
  strokeWidth: metric("Border thickness."),
  strokeAlign: prop(
    z.custom<"inside" | "outside" | "center">(),
    'Which side of the edge. Default "inside".',
    '"inside" | "outside" | "center"',
  ),
  borderRadius: metric("Corner radius. Frames and rectangles only."),
  effects: prop(z.custom<EffectsInput>(), 'Shadows / blur: flcm.effects({...}) or a CSS-string bag. "none" removes all effects.', "effects value"),
  rotation: degrees("Rotation in degrees."),
};

// Auto-layout container config. The hybrid structure (canonical vocabulary) groups it under a single
// `layout` object so a frame's container props read/author as one nested block — mirroring the read side's
// `layout: { mode, justifyContent, alignItems, gap, padding }`. Values are CSS: justify/align spell the
// realizable subset of `justify-content`/`align-items`; the sugar boundary (flcm.ts) maps them to the
// terse render intent, and rejects any valid-CSS-but-unrealizable spelling (space-around/-evenly) loud.
const LAYOUT_FIELDS = {
  mode: prop(z.enum(["row", "column", "none"]), 'Auto-layout direction. Default "none" = free-form, where the other layout words reject loud. No grid: "grid" fails loud.'),
  gap: metric("Space between children."),
  padding: prop(
    z.custom<PadInput>(),
    'A number, the CSS box shorthand ("12px 16px"), { x, y } (x→left+right, y→top+bottom), or per-edge. Edge values take a number or "Npx".',
    'number | "12px 16px" | { x?, y? } | { top?, right?, bottom?, left? }',
  ),
  justifyContent: prop(
    z.enum(["flex-start", "flex-end", "center", "space-between"]),
    'CSS justify-content, main axis. Figma has no space-around/space-evenly — those fail loud.',
  ),
  alignItems: prop(
    z.enum(["flex-start", "flex-end", "center", "stretch"]),
    'CSS align-items, cross axis. "stretch" stretches every auto-sized child (a fixed cross-axis size wins); one child alone stretches via width/height "fill".',
  ),
};

const FRAME_FIELDS = {
  layout: prop(
    z.object(LAYOUT_FIELDS),
    "Auto-layout config. Omitted or mode:\"none\" = free-form, where children position absolutely.",
    "{ mode?, gap?, padding?, justifyContent?, alignItems? }",
  ),
  clip: prop(z.boolean(), "Clip children to the frame's bounds. Default false, like CSS overflow: visible."),
};

// Text style — the base every run layers over. The hybrid structure groups these under a `textStyle`
// object (canonical names: fontFamily/fontWeight/fontSize/textAlign), mirroring the read side. Node-level
// text `color` is NOT here — it's a top-level sugar prop compiling to the node's `fills`, like every other
// node's color (see TEXT_FIELDS).
const TEXTSTYLE_FIELDS = {
  fontFamily: prop(z.string(), "An unknown family falls back to Inter."),
  fontWeight: prop(
    z.union([z.number(), z.string()]),
    "Snapped to the nearest available style. Numbers 100–900, or CSS names (light, normal, medium, semibold, bold, black, …).",
    "number (100–900) | name",
  ),
  fontSize: prop(z.number(), "Font size in px."),
  fontStyle: prop(
    z.enum(["italic", "normal"]),
    'CSS font-style, no oblique. Snaps to the family\'s italic variant. On the base only "italic" means anything; "normal" is a run delta clearing an italic base.',
  ),
  lineHeight: prop(
    z.union([z.number(), z.string()]),
    'Line height. "auto"/"normal" = the font default.',
    'number(px) | "Npx" | "N%" | "Nem" | "auto"',
  ),
  letterSpacing: prop(
    z.union([z.number(), z.string()]),
    "Tracking.",
    'number(px) | "Npx" | "N%" | "Nem"',
  ),
  textDecoration: prop(
    z.enum(["underline", "line-through", "none"]),
    'CSS text-decoration-line. On the base "none" means nothing; it is a run delta clearing an inherited decoration. Strikethrough is also inline: ~~text~~.',
  ),
  textAlign: prop(z.enum(["left", "center", "right", "justify"]), "CSS text-align."),
  textAlignVertical: prop(
    z.enum(["top", "center", "bottom"]),
    'Vertical alignment in the text box. Whole-node only, never a run delta.',
  ),
  textTransform: prop(
    z.enum(["uppercase", "lowercase", "capitalize", "none"]),
    'CSS text-transform — re-cases the glyphs, not the characters. "none" restores the original casing and clears a fontVariant (same Figma slot).',
  ),
  fontVariant: prop(
    z.enum(["small-caps", "all-small-caps"]),
    'CSS font-variant-caps. Shares one Figma slot with `textTransform`, so naming both fails loud.',
  ),
  paragraphSpacing: metric("Space between paragraphs."),
  paragraphIndent: metric("First-line indent."),
  listSpacing: metric("Space between list items."),
  hyperlink: prop(
    z.custom<string | { type: "URL"; url: string }>(),
    'A URL over the whole text node — a url string, or the read form { type: "URL", url }. Links to a NODE are read-only and fail loud.',
    'string (url) | { type: "URL", url }',
  ),
  boldWeight: prop(
    z.union([z.number(), z.string()]),
    'What `**bold**` resolves to in this node. Default 700 — pass back the `boldWeight` a `get` reports and the copy emphasizes like the original. Same spellings as fontWeight.',
    "number (100–900) | name",
  ),
  lineClamp: prop(
    z.union([z.number(), z.literal("none")]),
    'Truncate to at most N lines with an ellipsis. Needs a bounded `width` so the text wraps — on a hugging text it fails loud. `"none"` removes a clamp.',
    'number (≥1) | "none"',
  ),
};

const TEXT_FIELDS = {
  textStyle: prop(
    z.object(TEXTSTYLE_FIELDS),
    "The text style base. Runs layer over it.",
    "{ fontFamily?, fontWeight?, fontSize?, fontStyle?, lineHeight?, letterSpacing?, textDecoration?, textTransform?, fontVariant?, textAlign?, textAlignVertical?, paragraphSpacing?, paragraphIndent?, listSpacing?, hyperlink?, boldWeight?, lineClamp? }",
  ),
  color: color("Text color — the node-level spelling of the text's fill."),
};

// At create, text CONTENT is the positional first arg of flcm.text — this group exists for edit,
// where the delta is one object and the content needs a prop name. Same input shape and the same
// markdown/run parser as the positional arg; a whole-content replacement, never a splice.
const TEXTCONTENT_FIELDS = {
  content: prop(
    z.custom<string | TextRunInput[]>(),
    "Replacement text — the same string-or-runs input flcm.text takes first. Replaces the whole content.",
    "string | run[]",
  ),
};

// The rich-text run's style delta — the second element of a `[text, style]` run tuple (the array form of
// flcm.text). Every field overrides the node-level `textStyle` base for just that span, so a run carries
// only what it changes. Canonical StyleDelta field names (fontWeight, not weight), reusing the TEXTSTYLE
// entries so a run styles exactly like the base and the two can't drift. `textAlign`,
// `textAlignVertical` and `lineClamp` are absent: alignment and clamping are whole-node properties in
// Figma (no setRange* exists for them), not per-run. `color` is the one delta-only field the base
// lacks — base color lives in the node's `fills`, like every other node's.
const RUN_FIELDS = {
  fontWeight: TEXTSTYLE_FIELDS.fontWeight,
  fontSize: TEXTSTYLE_FIELDS.fontSize,
  fontFamily: TEXTSTYLE_FIELDS.fontFamily,
  fontStyle: TEXTSTYLE_FIELDS.fontStyle,
  lineHeight: TEXTSTYLE_FIELDS.lineHeight,
  letterSpacing: TEXTSTYLE_FIELDS.letterSpacing,
  textDecoration: TEXTSTYLE_FIELDS.textDecoration,
  textTransform: TEXTSTYLE_FIELDS.textTransform,
  fontVariant: TEXTSTYLE_FIELDS.fontVariant,
  paragraphSpacing: TEXTSTYLE_FIELDS.paragraphSpacing,
  paragraphIndent: TEXTSTYLE_FIELDS.paragraphIndent,
  listSpacing: TEXTSTYLE_FIELDS.listSpacing,
  color: color("Per-span text color."),
  // NOT TEXTSTYLE_FIELDS.hyperlink: `prop()` couples type and prose, and the base's prose says "over the
  // whole text node" — the opposite of what a run delta does (the bridge ranges it over this span alone).
  hyperlink: prop(
    z.custom<string | { type: "URL"; url: string }>(),
    'A URL over THIS span — inline `[text](url)` is usually simpler. Links to a NODE are read-only and fail loud.',
    'string (url) | { type: "URL", url }',
  ),
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
  stroke: color("The line's paint. Wins over `color`."),
  color: color("The line's paint (alias for stroke)."),
  strokeWidth: metric("Thickness. Defaults to 1."),
  length: prop(z.number(), "The line's length in px.", "number"),
  w: prop(z.number(), "Alias for `length`, which wins if both are set.", "number"),
  rotation: degrees("Degrees — 90° makes a horizontal line vertical."),
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
      'SVG path data, e.g. "M12 2 L22 20 L2 20 Z". Every standard command works (relative/shorthand are ' +
        "normalized); only malformed data fails. Required.",
    ),
  fill: APPEARANCE_FIELDS.fill,
  stroke: APPEARANCE_FIELDS.stroke,
  strokeWidth: APPEARANCE_FIELDS.strokeWidth,
  strokeAlign: APPEARANCE_FIELDS.strokeAlign,
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

// The flcm.edit(target, changes) delta — the ONE authoring vocabulary (no second dialect,
// invariant: same spellings, same parsers as create). Entries REUSE the create field objects (the
// RUN_FIELDS pattern), so a prop can't mean something different under edit. Which words apply to
// which node type is the runtime's per-type gate (edit.ts DELTA_KEYS_BY_TYPE, composed from the
// same KNOWN_KEYS atoms) — this schema is the flat closed set an unknown key fails loud against.
// One absence is the contract, not an oversight: `key` is immutable under edit (a delta naming it
// fails loud — re-keying could mint a duplicate address). `content` is the one edit-only spelling:
// at create the same input is flcm.text's positional first argument.
const EDIT_FIELDS = {
  name: SHARED_FIELDS.name,
  opacity: SHARED_FIELDS.opacity,
  mixBlendMode: SHARED_FIELDS.mixBlendMode,
  visible: SHARED_FIELDS.visible,
  locked: SHARED_FIELDS.locked,
  fill: APPEARANCE_FIELDS.fill,
  stroke: APPEARANCE_FIELDS.stroke,
  strokeWidth: APPEARANCE_FIELDS.strokeWidth,
  strokeAlign: APPEARANCE_FIELDS.strokeAlign,
  borderRadius: APPEARANCE_FIELDS.borderRadius,
  effects: APPEARANCE_FIELDS.effects,
  rotation: APPEARANCE_FIELDS.rotation,
  clip: FRAME_FIELDS.clip,
  width: SIZE_FIELDS.width,
  height: SIZE_FIELDS.height,
  absolute: SIZE_FIELDS.absolute,
  pin: SIZE_FIELDS.pin,
  layout: FRAME_FIELDS.layout,
  length: LINE_FIELDS.length,
  w: LINE_FIELDS.w,
  content: TEXTCONTENT_FIELDS.content,
  textStyle: TEXT_FIELDS.textStyle,
  color: TEXT_FIELDS.color,
};
export const EditSchema = z.object(EDIT_FIELDS);
export type EditDelta = z.infer<typeof EditSchema>;

// One entry of an flcm.editMany batch. An ARRAY of { target, changes } rather than the sketch's
// string-keyed map, because each `target` takes the full target grammar — a key, a node id,
// flcm.id(), or a handle straight from find/selection (the main edit on-ramp) — and a map's string
// keys could carry only the first two. Structural ops deliberately never fold in here: mixing
// tree-shape and prop ops in one list is the `flcm.change` non-goal.
export interface EditEntry { target: Target; changes: EditDelta }

// editMany's optional second argument. Named (not a bare positional target) because every other
// verb's second target argument means WHERE something goes — `within` is a search scope, and the
// read verbs already spell it as a named field on their query.
export interface EditManyScope { within?: Target }

// flcm.image(src, opts?) options — the second, optional arg to the image paint constructor. `src` (an
// https url or a local file path under the server's asset root) is the positional first arg (like text's
// `content` / svg's `markup`), so it isn't a prop field here.
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
    'Grain overlay — object form only. `true` for a default monotone grain, or { type: "monotone"|"duotone"|"multitone", color, secondaryColor, opacity, noiseSize, density }. Two fields are scoped to one `type` and are REJECTED on any other: `secondaryColor` is **duotone only**, and `opacity` is **multitone only** — on the default monotone grain it fails, so vary `density`/`color` alpha instead. Note: the running runtime does not accept a per-noise blendMode (typing-ahead-of-runtime), so it is not exposed.',
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
  // Every constructor also takes a `get` result (SimplifiedNode) as its props: the read shape's own
  // spellings fold onto the constructor's (read-spellings.ts), so `{ ...spec, width: 320 }` authors as-is.
  frame(props?: FrameProps | SimplifiedNode, children?: WriteChild | WriteChild[]): WriteNode;
  // A plain string, or an array of styled runs (rich text — per-span color/weight/size in one node).
  text(content: string | TextRunInput[], props?: TextProps): WriteNode;
  // The spec-first form: a read spec carries its content in `text`.
  text(spec: SimplifiedNode): WriteNode;
  rect(props?: ShapeProps | SimplifiedNode): WriteNode;
  ellipse(props?: ShapeProps | SimplifiedNode): WriteNode;
  line(props?: LineProps | SimplifiedNode): WriteNode;
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
  // Nudge an existing node: apply a partial delta (same vocabulary as create — node-local props in
  // this slice) to the resolved target and return its updated Handle with fresh geometry. Atomic per
  // call: the whole delta validates before the first write, and a post-validation Figma refusal
  // rolls the verb back (commit-then-undo) — the canvas is never half-a-verb.
  edit(target: Target, changes: EditDelta | Partial<SimplifiedNode>): Promise<Handle>;
  // The atomic batch form: every target resolves and every delta validates before the first write,
  // so one invalid entry leaves the canvas untouched and the rejection names EVERY failing entry.
  // The whole set is one undo step, and cross-entry order doesn't matter (a parent turned
  // auto-layout settles before a child set to "fill", whichever way round they were written).
  editMany(entries: EditEntry[], scope?: EditManyScope): Promise<Handle[]>;
  // Tree shape, DOM-style — position is the verb, and the thing placed is either a constructor
  // spec (built there) or a target naming a live node (MOVED there, like the DOM). append/prepend
  // take the parent; insertBefore/insertAfter take a sibling and infer the parent from it. A spec
  // returns render's `{ root, keyed }` plus the attach point; a live node returns
  // `{ node, from, to }`.
  append(parent: Target, thing: WriteNode | Target): Promise<InsertResult | MoveResult>;
  prepend(parent: Target, thing: WriteNode | Target): Promise<InsertResult | MoveResult>;
  insertBefore(sibling: Target, thing: WriteNode | Target): Promise<InsertResult | MoveResult>;
  insertAfter(sibling: Target, thing: WriteNode | Target): Promise<InsertResult | MoveResult>;
  // The plain reparent: the node lands as `parent`'s last child.
  move(target: Target, parent: Target): Promise<MoveResult>;
  remove(target: Target): Promise<RemoveResult>;
  // A faithful live duplicate — the copy path for subtrees a spec rebuild can't reproduce (anything
  // holding an INSTANCE). Lands at the end of `parent`, beside the original when omitted, and comes
  // back key-less: a raw node.clone() would copy the flcm/key and mint a duplicate address.
  clone(target: Target, parent?: Target): Promise<CloneResult>;
  // Re-author a `get` result — a whole SUBTREE — as a constructor-built spec: the constructor is picked
  // by each spec's `type`, and `children` (read specs, not built nodes) recurse. Explicit (not folded
  // into the structural verbs) because a read spec carries a live `id` exactly as a handle does: only
  // the author can say whether it means "copy this" or "move this". Anything the read shape carries
  // that flcm has no word for fails loud by name, pointing at flcm.clone.
  fromRead(spec: SimplifiedNode): WriteNode;
  // Full inspect: the node's styling as the EXPANDED canonical read shape — the same vocabulary
  // figma-mcp's REST read emits, every value inline (no styles refs), for any node type.
  get(target: Target): Promise<SimplifiedNode>;
  // Locate: every node matching the query, as slim handles (identity + a cheap layout world-model). May be
  // empty; AND-combines type/name/key/within (default scope: current page). The query is a FILTER, not an
  // address — only `within` takes a target (id/key/handle); the other facets are match conditions, and a
  // bare string is rejected rather than guessed at. Dive into a hit with `get`. An
  // optional predicate filters by anything in the full read shape (values inline: `n.fills?.[0] === '#FFF'`);
  // the query pre-filters cheaply, only survivors are materialized (a predicate-only find has a hard cap).
  find(query?: FindQuery, predicate?: ReadPredicate): Promise<SlimHandle[]>;
  // Locate exactly one — throws on 0 or >1, naming the count (a blind agent must never silently act on the
  // first of several fuzzy-name matches). Same query+predicate as find.
  findOne(query?: FindQuery, predicate?: ReadPredicate): Promise<SlimHandle>;
  // The user's current selection, as slim handles (same shape as find) — the on-ramp for "edit the selected …".
  selection(): Promise<SlimHandle[]>;
  // The target escape hatch: wraps a raw node id so target resolution treats it as an id, never an flcm/key.
  id(nodeId: string): RawIdRef;
  // The document verbs — the only words about which PAGE the other verbs act on. Every other verb works
  // on the current page, so this is how an agent finds out where it is and moves.
  page: {
    // Where am I: the file name, the current page, and every page in the file.
    current(): Promise<PageInfo>;
    // Switch to a page that already exists, by id or name. A miss lists the file's pages; it never creates.
    use(target: string): Promise<PageInfo>;
    // Make a page and switch to it. Refuses a name the file already uses (so a retry can't mint a twin).
    new: (name: string) => Promise<PageInfo>;
  };
}

// ---- Verb registry — the canonical verb list, for the verb table and the quick-start signatures.
// `schema` links a verb to the prop schema whose fields the reference renders under it. ----
// `category` groups verbs for the quick-start's compact per-group rendering (the ≤2KB budget can't afford a
// line per verb). The verb TABLE still lists each verb in full — only the quick-start groups.
export type VerbCategory = "build" | "value" | "render" | "edit" | "structure" | "read" | "page" | "target";

export interface VerbDoc {
  signature: string;
  builds: string;
  args: string;
  category: VerbCategory;
  schema?: z.ZodObject;
  // The ≤2KB quick-start spelling, when the full signature doesn't fit its budget — written in the
  // same `flcm.`-prefixed form as `signature`, since the renderer strips the prefix from both.
  // `null` means "folded into the PREVIOUS entry's combined spelling": verbs that differ only in
  // where they place (append/prepend, insertBefore/insertAfter) print as one line. The verb TABLE
  // is unaffected — it always renders the full `signature`.
  quickStart?: string | null;
}

export const VERBS: VerbDoc[] = [
  { category: "build", signature: "flcm.frame(props?, children?)", builds: "a FRAME (container)", args: "props object, then an array of children", schema: FrameSchema },
  { category: "build", signature: "flcm.text(content, props?)", builds: "a TEXT node", args: "content (a string or a runs array) first, then props", schema: TextSchema },
  { category: "build", signature: "flcm.rect(props?)", builds: "a RECTANGLE", args: "props object", schema: ShapeSchema },
  { category: "build", signature: "flcm.ellipse(props?)", builds: "an ELLIPSE", args: "props object", schema: ShapeSchema },
  { category: "build", signature: "flcm.line(props?)", builds: "a LINE", args: "props object", schema: LineSchema },
  { category: "build", signature: "flcm.svg(markup, props?)", builds: "a VECTOR from SVG markup", args: "SVG markup string first, then size/position props", schema: SvgSchema },
  { category: "build", signature: "flcm.path(props)", builds: "a themeable VECTOR", args: "props object including `d` (path data)", schema: PathSchema },
  { category: "value", signature: "flcm.gradient(...)", builds: "a gradient fill value", args: "object or positional form", schema: GradientSchema },
  { category: "value", signature: "flcm.image(src, opts?)", builds: "an image fill value", args: "an https url or a local file path (under the server's asset root) first, then { scaleMode?, placeholder? }", schema: ImageSchema },
  { category: "value", signature: "flcm.effects({...})", builds: "an effects value", args: "an { shadow, blur, backgroundBlur } bag", schema: EffectsSchema },
  { category: "render", signature: "await flcm.render(tree)", builds: "live nodes", args: "returns { root, keyed }" },
  { category: "edit", signature: "await flcm.edit(target, changes)", builds: "a nudged existing node (returns its updated Handle)", args: "target (an flcm/key, node id, flcm.id(id), or handle), then a partial delta in the same vocabulary as create", schema: EditSchema, quickStart: "await flcm.edit(target, changes) / flcm.editMany([{ target, changes }, …])" },
  { category: "edit", signature: "await flcm.editMany(entries, scope?)", builds: "a whole set of nudges, applied atomically (returns a Handle per entry, in order)", args: "an array of { target, changes } — the same delta vocabulary as flcm.edit — and optionally { within } to scope key resolution. One invalid entry rejects the batch naming every offender, and nothing is applied", quickStart: null },
  { category: "structure", signature: "await flcm.append(parent, thing)", builds: "`thing` placed as the LAST child of `parent`", args: "a parent target, then either a constructor spec (built there → { root, keyed, parent }) or a target naming a live node (MOVED there → { node, from, to })", quickStart: "await flcm.append/prepend(parent, spec|target)" },
  { category: "structure", signature: "await flcm.prepend(parent, thing)", builds: "the same, placed FIRST", args: "same as append", quickStart: null },
  { category: "structure", signature: "await flcm.insertBefore(sibling, thing)", builds: "`thing` placed just before `sibling`", args: "a SIBLING target (the parent is inferred from it), then a spec or a live target", quickStart: "await flcm.insertBefore/insertAfter(sibling, spec|target)" },
  { category: "structure", signature: "await flcm.insertAfter(sibling, thing)", builds: "`thing` placed just after `sibling`", args: "same as insertBefore", quickStart: null },
  { category: "structure", signature: "await flcm.move(target, parent)", builds: "the node reparented as `parent`'s last child", args: "a live target, then a parent target. Creating is append's job — a spec here fails loud", quickStart: "await flcm.move(target, parent)" },
  { category: "structure", signature: "await flcm.remove(target)", builds: "nothing — deletes the node and its subtree", args: "a target; returns { removedId, parent }", quickStart: "await flcm.remove(target)" },
  { category: "structure", signature: "await flcm.clone(target, parent?)", builds: "a faithful live duplicate (key-less)", args: "a target, and optionally where the copy lands (default: beside the original). The copy path for subtrees a spec rebuild can't reproduce — anything holding an INSTANCE", quickStart: "await flcm.clone(target, parent?)" },
  { category: "build", signature: "flcm.fromRead(spec)", builds: "a `get` result re-authored as a buildable spec", args: "a spec from flcm.get, subtree and all — the constructor is picked by each node's `type` and `children` recurse. Returns a constructor-built node — render it, or place it with append/prepend/insertBefore/insertAfter. (A single node's spec can also spread straight into its constructor: flcm.rect({ ...spec, width: 320 }).) Anything the read shape carries that flcm has no word for (an INSTANCE, a paint stack, a grid) fails loud by name; flcm.clone is the faithful copy for those", quickStart: "flcm.fromRead(spec)" },
  { category: "read", signature: "await flcm.get(target)", builds: "a node's full read spec (values inline)", args: "target: an flcm/key, a node id, flcm.id(id), or a handle" },
  { category: "read", signature: "await flcm.find(query?, predicate?)", builds: "matching nodes as slim handles", args: "query { type?, name?, key?, within? } AND-combined — a filter, not an address; only `within` takes a target. Optional predicate over the full read shape (n => n.fills?.[0] === '#FFF')" },
  { category: "read", signature: "await flcm.findOne(query?, predicate?)", builds: "exactly one slim handle (throws on 0 or >1)", args: "same query + predicate as find" },
  { category: "read", signature: "await flcm.selection()", builds: "the current selection as slim handles", args: "no args" },
  { category: "page", signature: "await flcm.page.current()", builds: "where you are — { fileName, page, pages }", args: "no args. The orientation call: the file's name, the page every other verb acts on, and the file's other pages", quickStart: "await flcm.page.current() / .use(nameOrId) / .new(name)" },
  { category: "page", signature: "await flcm.page.use(nameOrId)", builds: "the switched-to page's info", args: "a page name or page id. Never creates: a miss fails loud listing the file's pages", quickStart: null },
  { category: "page", signature: "await flcm.page.new(name)", builds: "a new page, switched to", args: "a page name the file doesn't already use (a taken name fails loud and creates nothing, so a retry can't mint a twin)", quickStart: null },
  { category: "target", signature: "flcm.id(nodeId)", builds: "a raw-id target ref", args: "a node id string — resolved as an id, never scanned as an flcm/key" },
];

// Re-exported for the doc generator: which FIELD_GROUPS compose each node type's edit surface —
// the same table edit.ts builds its runtime legality gate from, so the per-type doc lists and the
// gate cannot drift. (A runtime value, but from zod-free ir.ts — the purity gate is unaffected.)
export { EDIT_TYPE_WORD_GROUPS } from "./ir.js";

// ---- Field-group registry — how the reference groups props into tables. Each verb's full schema drives
// its TYPE; these groups drive its DOC layout (shared/size tables once, verb-specific tables per verb). ----
export const FIELD_GROUPS = {
  shared: SHARED_FIELDS,
  size: SIZE_FIELDS,
  appearance: APPEARANCE_FIELDS,
  frame: FRAME_FIELDS,
  layout: LAYOUT_FIELDS,
  text: TEXT_FIELDS,
  textContent: TEXTCONTENT_FIELDS,
  textStyle: TEXTSTYLE_FIELDS,
  run: RUN_FIELDS,
  line: LINE_FIELDS,
  path: PATH_FIELDS,
  edit: EDIT_FIELDS,
  image: IMAGE_FIELDS,
  gradient: GradientSchema.shape,
  effects: EffectsSchema.shape,
} as const;
