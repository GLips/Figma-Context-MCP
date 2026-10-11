/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { WarningRecord } from "./warnings.js";
// schema — THE single source of the agent-facing authoring surface. Every verb, every prop, its type,
// and its one-line doc live here exactly once, as zod field schemas carrying `.describe()` (the note a
// human/agent reads) and `.meta({ type })` (the displayed type label where the real TS type is looser
// than what we want to show, e.g. a `number | string` we document as `number | "Npx"`).
//
// THREE consumers, ONE source:
//   1. TYPES — flcm.ts infers its Props (`FrameProps`, `TextProps`, …) from these schemas via `z.infer`
//      and imports them as `import type` ONLY. Type-only imports are erased by esbuild, so this module's
//      zod NEVER enters the sandbox bundle (acceptance: `grep zod plugin/dist/code.js` is empty). The
//      compilers stay the sole runtime; this file is type + doc metadata only.
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
import { INPUT_ALIASES } from "./input-aliases.js";
export { INPUT_ALIASES };
import type {
  FillInput, WriteCssEffects, WritePaint, WriteEffect, GradientStop, WriteNode, WriteChild, Handle,
  PinX, PinY, Target, RawIdRef, SlimHandle, FindQuery, ReadPredicate, RemoveResult, GetResult,
  PageInfo, ComponentPropertyInput, OverrideDeltaInput, ComponentPropertyDefinitions, VariantEntryInput,
  ComponentPropertyDefinitionEdits, ComponentPropertyBindingEdit,
  VariableInput, StyleInput, TokenIdentityInput,
} from "./ir.js";
// The read verbs return the canonical read shape the shared simplify core emits. Relative (not ~/) so the
// root toolchain, which imports this module for docs generation, resolves it without the plugin's paths.
import type { SimplifiedNode } from "@framelink/core";

// ---- Author leaf-input types the schema references but can't structurally model in zod (they're loose
// on purpose, or reference the typed currency). `z.custom<T>()` infers exactly T with no runtime check —
// perfect here, since these are never validated by zod, only inferred and documented. ----
export type LengthInput = number | string; // a number or "Npx"
// A length a variable may stand in for: the read emits `{ variable: { id, name } }` in a bound word's place.
export type BindableLength = LengthInput | VariableInput;
export type PadInput =
  | number
  | string // the CSS box shorthand, in read's spelling: "12px" | "12px 16px" | "8px 8px 0px 0px"
  | VariableInput
  | { x?: BindableLength; y?: BindableLength; top?: BindableLength; right?: BindableLength; bottom?: BindableLength; left?: BindableLength };
export type GapInput = number | string | VariableInput | { row: BindableLength; column: BindableLength };
export type SidesInput = { top: BindableLength; right: BindableLength; bottom: BindableLength; left: BindableLength };
export type CornersInput = { topLeft: BindableLength; topRight: BindableLength; bottomRight: BindableLength; bottomLeft: BindableLength };

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
  progressiveBackgroundBlur?: ProgressiveBlurSugar;
};

// The `effects` prop accepts the sugar bag, an already-typed WriteEffect[] (what flcm.effects returns), or
// a CSS-string bag.
// "none" is the surface-wide removal word (CSS's own absence spelling): effects:"none" clears the
// node's effects, the same way fill/stroke:"none" clear paint.
export type EffectsInput = WriteEffect[] | WriteCssEffects | EffectsSugar | "none";

// ---- prop() — one optional field carrying its note (.describe) and, when the shown type should differ
// from the inferred one, a display label (.meta.type). The generator reads .description + .meta().type. ----
function prop<T extends z.ZodType>(schema: T, note: string, type?: string) {
  const described = schema.optional().describe(note);
  return type ? described.meta({ type }) : described;
}

// Input conveniences remain typed, but only canonical words belong in prop tables.
// Their documentation is generated once from INPUT_ALIASES.
function inputAlias<T extends z.ZodType>(schema: T) {
  return schema.optional().meta({ inputOnly: true });
}

// A paint slot. Every one of them takes a STACK as well as a single paint — an array, top first, the
// same order a read returns — so the note here only has to say what the slot paints.
// A paint leaf may be a color variable ({ variable }); a node's own fill/stroke may instead be a whole
// paint style ({ style }), which the slot-level label adds.
const color = (note: string, type = "paint | paint[]") => prop(z.custom<FillInput>(), note, type);
const metric = (note: string) => prop(z.union([z.number(), z.string()]), note, 'number | "Npx"');
const variable = z.custom<VariableInput>();
const bindableMetric = (note: string) => prop(z.union([z.number(), z.string(), variable]), note, 'number | "Npx" | { variable }');
const degrees = (note: string) => prop(z.number(), note, "number (deg)");

// ---- Field groups. Each verb schema is composed from these by spread, so a field is authored once and
// reused across every verb it appears on. The reference tables render these same groups. ----

const ANNOTATION_FIELDS = {
  annotations: prop(z.array(z.object({
    text: z.string().optional(),
    category: z.string().trim().min(1).optional(),
    properties: z.array(z.string()).optional(),
  })), "Native annotations. Omitted leaves annotations untouched; a supplied array replaces the whole collection; [] clears every one.", "{ text?: string; category?: string; properties?: string[] }[]"),
};

const SHARED_FIELDS = {
  name: prop(z.string(), "Layer name."),
  key: prop(z.string(), "Persistent metadata for find/findOne. Unique within one authored tree; id alone decides live identity."),
  opacity: prop(z.union([z.number(), variable]), "", "number (0–1) | { variable }"),
  mixBlendMode: prop(
    z.string(),
    "",
    '"normal" | "multiply" | "screen" | "overlay" | "soft-light" | … (CSS mix-blend-mode)',
  ),
  visible: prop(z.boolean(), "get and find still return hidden nodes, with their annotations."),
  locked: prop(z.boolean(), "Locks against pointer edits in Figma's UI; flcm.edit still writes to it."),
};

// Native aliases describe the same authored values; normalization removes them before compilation.
const GRID_CHILD_ALIASES = {
  gridColumnAnchorIndex: inputAlias(z.number()),
  gridRowAnchorIndex: inputAlias(z.number()),
  gridColumnSpan: inputAlias(z.number()),
  gridRowSpan: inputAlias(z.number()),
  gridChildHorizontalAlign: inputAlias(z.enum(["AUTO", "MIN", "CENTER", "MAX"])),
  gridChildVerticalAlign: inputAlias(z.enum(["AUTO", "MIN", "CENTER", "MAX"])),
};
const NATIVE_GRID_TRACK = z.union([
  z.object({ type: z.literal("HUG"), value: z.number().optional() }),
  z.object({ type: z.literal("FLEX"), value: z.number().optional() }),
  z.object({ type: z.literal("FIXED"), value: z.number() }),
]);
const GRID_CONTAINER_ALIASES = {
  gridColumnsSizing: inputAlias(z.string()),
  gridRowsSizing: inputAlias(z.string()),
  gridColumnSizes: inputAlias(z.array(NATIVE_GRID_TRACK)),
  gridRowSizes: inputAlias(z.array(NATIVE_GRID_TRACK)),
};

// One read layout bag combines the node's own container settings and its placement in its parent.
// Leaves take only child fields; frame-like types compose both groups. Parent mode decides cell vs flow.
const CHILD_LAYOUT_FIELDS = {
  ...GRID_CHILD_ALIASES,
  gridColumn: prop(z.string(), 'Only "N", "span N" or "N / span N", 1-based. Omitted, Figma auto-places. A grid child sizes in px, "fill" (the cell) or "hug", never "N%".'),
  gridRow: prop(z.string(), 'As gridColumn. Rows the grid did not name grow to hold the placement.'),
  justifySelf: prop(z.enum(["start", "center", "end", "auto", "stretch"]), 'Grid children only. "stretch" is rewritten to width: "fill" (Figma has no stretch alignment); "auto" restores Figma\'s.'),
  alignSelf: prop(z.enum(["center", "stretch", "start", "end", "auto"]), 'In a grid, as justifySelf but vertical ("stretch" → height: "fill"). Flow children take only "stretch" (counter-axis fill): Figma has no other per-child alignment, so set the parent\'s alignItems or wrap the child in a fill-sized frame.'),
  zIndex: prop(z.number(), 'Not stacking order: a grid child\'s sibling index (a non-negative integer). Named indices reserve slots; the rest keep their relative order.'),
};

const CONTAINER_LAYOUT_FIELDS = {
  ...GRID_CONTAINER_ALIASES,
  gridTemplateColumns: prop(z.string(), "Tracks are Npx, Nfr, auto or fit-content(100%); repeat() and minmax(0, Nfr) expand to native tracks, which is what reads return. Required to create a grid. Fr tracks divide this frame's own width, so give it a number or \"fill\" in the same call; a hugging width is refused."),
  gridTemplateRows: prop(z.string(), 'Same track syntax. Omitted, rows are implicit hug tracks that grow as children are added; named rows are fixed and stop growing.'),
  mode: prop(z.enum(["row", "column", "grid", "none"]), '"row" and "column" are flex directions, "grid" is CSS grid, "none" (default) is free-form. The other container words need a mode. A new grid needs gridTemplateColumns.'),
  gap: prop(
    z.custom<GapInput>(),
    'Unequal "row-gap column-gap" (or { row, column }) needs grid or wrap. A variable binds a row or column gap, not a grid\'s.',
    'number | "Npx" | "Npx Npx" | { variable } | { row, column }',
  ),
  wrap: prop(z.boolean(), "Rows only."),
  padding: prop(
    z.custom<PadInput>(),
    'Also { x, y } (x = left and right, y = top and bottom) or per-edge; each edge takes a { variable } too.',
    'number | "12px 16px" | { variable } | { x?, y? } | { top?, right?, bottom?, left? }',
  ),
  justifyContent: prop(
    z.enum(["flex-start", "flex-end", "center", "space-between"]),
    'Figma has no space-around or space-evenly: use space-between, or gap and padding, never spacer nodes.',
  ),
  alignItems: prop(
    z.enum(["flex-start", "flex-end", "center", "stretch", "baseline"]),
    '"baseline" needs a row. "stretch" leaves a fixed cross-axis size alone.',
  ),
};

const LAYOUT_FIELDS = { ...CONTAINER_LAYOUT_FIELDS, ...CHILD_LAYOUT_FIELDS };

// One note for all four bounds: they differ only in axis and direction.
const SIZE_BOUND_NOTE =
  'Positive px. Applies to auto-layout containers and their direct children. "none" clears it. A size the bound clamps still succeeds, with a warning.';

const SIZE_FIELDS = {
  ...GRID_CHILD_ALIASES,
  layout: prop(z.object(CHILD_LAYOUT_FIELDS), 'Placement under an auto-layout parent: grid cell words, or alignSelf "stretch" in flow.', '{ gridColumn?, gridRow?, justifySelf?, alignSelf?, zIndex? }'),
  minWidth: prop(z.union([z.number(), z.literal("none"), variable]), SIZE_BOUND_NOTE, 'number | "none" | { variable }'),
  maxWidth: prop(z.union([z.number(), z.literal("none"), variable]), SIZE_BOUND_NOTE, 'number | "none" | { variable }'),
  minHeight: prop(z.union([z.number(), z.literal("none"), variable]), SIZE_BOUND_NOTE, 'number | "none" | { variable }'),
  maxHeight: prop(z.union([z.number(), z.literal("none"), variable]), SIZE_BOUND_NOTE, 'number | "none" | { variable }'),

  // A percent ("50%") widens the runtime type to `string`, so `"fill"`/`"hug"` no longer survive as
  // literals in the inferred type — hence an explicit .meta label to keep the doc precise.
  width: prop(
    z.union([z.number(), z.string(), variable]),
    '"N%" is of the parent\'s realized size. The root takes neither "N%" nor "fill" (the page is unbounded); "N%" is also refused on in-flow grid children and on an in-flow child whose parent hugs that axis. Only text and a container with a layout mode can "hug".',
    'number | "Npx" | "N%" | "fill" | "hug" | { variable }',
  ),
  height: prop(
    z.union([z.number(), z.string(), variable]),
    'As width. TEXT hugs its content by default; a fixed or "N%" height needs a width that doesn\'t hug.',
    'number | "fill" | "hug" | "N%" | { variable }',
  ),
  // Placement is the read shape's own words: `left`/`top` are the offset in the parent, and naming
  // either lifts the node out of an auto-layout parent's flow (read reports that as `position:
  // "absolute"`). Under a free-form parent they are just the coordinates. `position` on its own lifts
  // without moving, or ("none", edit only) returns the node to the flow; `anchor` says which point of
  // the node lands on the coordinate it accompanies.
  left: prop(
    z.union([z.number(), z.string()]),
    'Naming `left` or `top` takes the node out of an auto-layout flow, like position: absolute. On a render root it is the page position; without it every root stacks at the origin.',
    'number | "Npx" | "N%"',
  ),
  top: prop(z.union([z.number(), z.string()]), "As `left`.", 'number | "Npx" | "N%"'),
  position: prop(
    z.enum(["absolute", "none"]),
    '"absolute" leaves the flow where the node stands. Under edit, "none" returns it to the flow and can\'t sit beside `left`/`top`/`anchor`.',
  ),
  anchor: prop(
    z.object({
      x: z.enum(["left", "center", "right"]).optional(),
      y: z.enum(["top", "center", "bottom"]).optional(),
    }),
    'Which point of the node sits at `left`/`top` (default top-left): anchor: { x: "center" } with left: "50%" centres it. Each axis needs its coordinate in the same call.',
    "{ x?: left/center/right, y?: top/center/bottom }",
  ),
  pin: prop(
    z.custom<{ x?: PinX; y?: PinY } | "none">(),
    'Figma constraint: how the node follows a parent resize, overriding the automatic one. Applies under a free-form parent or out of flow; stored but inert on an in-flow child. Under edit, "none" restores the default. Never takes a node out of flow.',
    '{ x?, y? } | "none" — x: left/center/right/stretch/scale/none, y: top/center/bottom/stretch/scale/none',
  ),
};

// The placement words alone — what a LINE takes beside its width, and what edit compiles for one.
const PLACEMENT_FIELDS = {
  ...GRID_CHILD_ALIASES,
  layout: SIZE_FIELDS.layout,
  left: SIZE_FIELDS.left,
  top: SIZE_FIELDS.top,
  position: SIZE_FIELDS.position,
  anchor: SIZE_FIELDS.anchor,
  pin: SIZE_FIELDS.pin,
};

const APPEARANCE_FIELDS = {
  fill: color('A CSS color or gradient string, flcm.gradient() or flcm.image(), a color { variable }, or an array stacked top first (see the values section). A paint { style } takes the whole slot. "none" removes it.', "paint | paint[] | { style }"),
  stroke: color('Border paint, or a stack. A paint { style } takes the whole slot. "none" removes it.', "paint | paint[] | { style }"),
  strokeWidth: prop(
    z.union([z.number(), z.string(), variable, z.custom<SidesInput>()]),
    'Per-side widths (the shorthand, or { top, right, bottom, left } whose sides may be variables) work on frames, rectangles, components and instances only; other types take one value.',
    'number | "Npx" | CSS shorthand | { variable } | { top, right, bottom, left }',
  ),
  strokeAlign: prop(
    z.custom<"inside" | "outside" | "center">(),
    'Default "inside", like a CSS border.',
    '"inside" | "outside" | "center"',
  ),
  borderRadius: prop(
    z.union([z.number(), z.string(), variable, z.custom<CornersInput>()]),
    'Frames and rectangles only. Corners are circular, so the elliptical "x / y" form is refused. Per-corner { topLeft, topRight, bottomRight, bottomLeft } takes variables per corner.',
    'number | "Npx" | CSS shorthand | { variable } | { topLeft, topRight, bottomRight, bottomLeft }',
  ),
  effects: prop(z.custom<EffectsInput | StyleInput>(), 'flcm.effects() or a bag of CSS strings (see the values section), or an effect { style }. An effect\'s own fields don\'t bind variables. "none" removes all.', "effects value | { style }"),
  rotation: degrees("Applied after layout sizing, about the centre: it turns the box, never resizes it."),
};

// An ELLIPSE has no corners, so its appearance vocabulary is the shared one minus `borderRadius` — a
// separate group (not a runtime filter) so the edit gate and the per-type doc list both compose it.
const ELLIPSE_FIELDS = {
  fill: APPEARANCE_FIELDS.fill,
  stroke: APPEARANCE_FIELDS.stroke,
  strokeWidth: APPEARANCE_FIELDS.strokeWidth,
  strokeAlign: APPEARANCE_FIELDS.strokeAlign,
  effects: APPEARANCE_FIELDS.effects,
  rotation: APPEARANCE_FIELDS.rotation,
};

const FRAME_FIELDS = {
  ...GRID_CONTAINER_ALIASES,
  ["clipsContent" satisfies keyof typeof INPUT_ALIASES]: inputAlias(z.boolean()),
  layout: prop(z.object(LAYOUT_FIELDS), 'Container settings plus placement under the parent; both tables follow.', '{ mode?, gridTemplateColumns?, gridTemplateRows?, gap?, wrap?, padding?, justifyContent?, alignItems?, gridColumn?, gridRow?, justifySelf?, alignSelf?, zIndex? }'),
  clip: prop(z.boolean(), "Default false."),
};

// Text style — the base every run layers over. The hybrid structure groups these under a `textStyle`
// object (canonical names: fontFamily/fontWeight/fontSize/textAlign), mirroring the read side. The text's
// paint is NOT here — it is the node-level `fill`, like every other node's (see TEXT_FIELDS).
const TEXTSTYLE_FIELDS = {
  style: prop(
    z.custom<TokenIdentityInput>(),
    "A shared text style, by name or id. It sets the font, size and spacing words itself, so only textAlign, textAlignVertical, hyperlink and lineClamp ride beside it, and runs may set only color and hyperlink.",
    "name | id | { id?, name? }",
  ),
  fontFamily: prop(z.union([z.string(), variable]), "An unknown family falls back to Inter. A STRING variable binds it.", "string | { variable }"),
  fontWeight: prop(
    z.union([z.number(), z.string(), variable]),
    "Snaps to the nearest style the family has.",
    "number (100–900) | name | { variable }",
  ),
  fontSize: prop(z.union([z.number(), variable]), "", "number | { variable }"),
  fontStyle: prop(
    z.enum(["italic", "normal"]),
    'No oblique; snaps to the family\'s italic. "normal" only matters on a run, clearing an italic base.',
  ),
  lineHeight: prop(
    z.union([z.number(), z.string(), variable]),
    '"auto" is the font default. A variable binds it in px.',
    'number(px) | "Npx" | "N%" | "Nem" | "auto" | { variable }',
  ),
  letterSpacing: prop(
    z.union([z.number(), z.string(), variable]),
    "A variable binds it in px.",
    'number(px) | "Npx" | "N%" | "Nem" | { variable }',
  ),
  textDecoration: prop(
    z.enum(["underline", "line-through", "none"]),
    '"none" only matters on a run, clearing an inherited decoration. Also inline: ~~text~~.',
  ),
  textAlign: prop(z.enum(["left", "center", "right", "justify"]), ""),
  textAlignVertical: prop(
    z.enum(["top", "center", "bottom"]),
    'Whole node only, never per run.',
  ),
  textTransform: prop(
    z.enum(["uppercase", "lowercase", "capitalize", "none"]),
    'Changes the displayed case, not the characters. Shares a Figma slot with fontVariant, so "none" clears both.',
  ),
  fontVariant: prop(
    z.enum(["small-caps", "all-small-caps"]),
    'Shares a slot with textTransform, so naming both is refused.',
  ),
  paragraphSpacing: bindableMetric("Space between paragraphs."),
  paragraphIndent: bindableMetric("First-line indent."),
  listSpacing: metric("Space between list items."),
  hyperlink: prop(
    z.custom<string | { type: "URL"; url: string }>(),
    'Links the whole text node. Links to a node are read-only.',
    'string (url) | { type: "URL", url }',
  ),
  lineClamp: prop(
    z.union([z.number(), z.literal("none")]),
    'Ellipsis after N lines. Needs a `width` the text wraps against (a number, "fill" or "N%"); a hugging text is refused. "none" removes it.',
    'number (≥1) | "none"',
  ),
};

// text is content; fill is paint. boldWeight controls markdown emphasis, not base text style.
const TEXT_FIELDS = {
  ["fontSize" satisfies keyof typeof INPUT_ALIASES]: inputAlias(z.number()),
  text: prop(
    z.custom<string | TextRunInput[]>(),
    "A string with markdown (**bold**, *italic*, ~~strike~~, [text](url); backslash-escape a literal *) or an array of styled runs. Read style tokens like {ts1}…{/ts1} are refused. Under edit it replaces the whole content.",
    "string | run[]",
  ),
  textStyle: prop(
    z.object(TEXTSTYLE_FIELDS),
    "The text style base. Runs layer over it.",
    "{ style?, fontFamily?, fontWeight?, fontSize?, fontStyle?, lineHeight?, letterSpacing?, textDecoration?, textTransform?, fontVariant?, textAlign?, textAlignVertical?, paragraphSpacing?, paragraphIndent?, listSpacing?, hyperlink?, lineClamp? }",
  ),
  fill: color('The text color. A paint { style } takes the whole slot, and then runs can\'t set color. "none" removes it.', "paint | paint[] | { style }"),
  boldWeight: prop(
    z.union([z.number(), z.string()]),
    "What `**bold**` in `text` resolves to. Default 700; pass back the value `get` reports so a copy emphasizes like the original. Under edit it only matters beside `text`.",
    "number (100–900) | name",
  ),
};

// The rich-text run's style delta — the second element of a `[text, style]` run tuple (the array form of
// TEXT). Every field overrides the node-level `textStyle` base for just that span, so a run carries
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

// A line sizes ONLY along its length, which is its `width` (the read shape's word for it): a number,
// or "fill" under a row/column parent whose flow supplies the number — never "hug" or a percent,
// and there is no height word at all. So LineSchema does NOT
// spread the full SIZE_FIELDS — typing props the compiler drops would let a compile-checked example
// pass while rendering wrong (a real hole, since the example's whole job is to fail the build on API
// mismatch). It carries exactly what `line` reads.
const LINE_FIELDS = {
  stroke: color('The line\'s paint. A paint { style } takes the whole slot. "none" removes it.', "paint | paint[] | { style }"),
  strokeWidth: bindableMetric("Thickness. Defaults to 1."),
  width: bindableMetric('The length: a number or { variable }, or "fill" along an unrotated row or column parent. A rotated line needs a number; for a rule across a row use a 1px-wide RECTANGLE with height: "fill". No "hug" or percent.'),
  rotation: degrees('90 makes it vertical. Needs a numeric `width`.'),
  ...PLACEMENT_FIELDS,
};

// A single themeable vector (VECTOR with `d`/`vectorPaths`): the shared appearance vocabulary MINUS
// `radius` (a vector has no corner radius — accepting it would be a documented no-op, which ADR-0003
// forbids) plus path geometry and its one size word. Reuses the APPEARANCE_FIELDS entries so a path
// themes exactly like a rect and the docs can't drift.
//
// Negative space: no `width`/`height` here. The path form is BARE GEOMETRY — its box is the path's
// bounding box — so a canvas-shaped size has nothing to mean but a non-uniform stretch of the art.
// `scale` is the size word that survives that; `svg` is the form that has a canvas. (The words are
// still accepted from a `get` round-trip and ignored with a warning — see flcm.ts compilePath.)
const PATH_FIELDS = {
  vectorPaths: prop(z.array(z.object({ data: z.string(), windingRule: z.enum(["NONZERO", "EVENODD", "NONE"]) })), "Native path records for multiple paths or even-odd winding. Use exactly one of d, vectorPaths, or svg.", 'Array<{ data: string; windingRule: "NONZERO" | "EVENODD" | "NONE" }>'),
  d: z
    .string()
    .optional()
    .describe(
      "SVG path data; relative and shorthand commands are normalized. The box is the path's bounding " +
        "box: `width`/`height` are ignored with a warning, so use `scale`. Use exactly one of d, vectorPaths or svg.",
    ),
  scale: prop(
    z.number(),
    "Multiplies the natural bounding box. One positive number, so the art keeps its proportions; the path form's only size word.",
  ),
  fill: APPEARANCE_FIELDS.fill,
  stroke: APPEARANCE_FIELDS.stroke,
  strokeWidth: APPEARANCE_FIELDS.strokeWidth,
  strokeAlign: APPEARANCE_FIELDS.strokeAlign,
  effects: APPEARANCE_FIELDS.effects,
  rotation: APPEARANCE_FIELDS.rotation,
};

// An SVG import (VECTOR with `svg`): a canvas of art, so it takes the size/position words — and these
// two theme words. Figma parses the markup into a frame of vectors and flcm simply never touched them
// before, which is why colours looked baked in; `fill`/`stroke` repaint every vector inside.
// Negative space: no `strokeWidth`/`effects`/`radius`. Stroke weight is part of the ART's proportions
// (the markup's own stroke-width is what makes a 1.5px icon a 1.5px icon), so overriding it per-import
// would silently redraw the drawing rather than recolour it.
const SVG_FIELDS = {
  fill: color('Repaints every vector inside the imported markup, overriding the colors written into it — how an icon takes your theme. "none" clears their fills.'),
  stroke: color('Repaints every vector\'s stroke inside the imported markup. "none" clears them.'),
};

// Instance controls use the read vocabulary. The component target is grouped separately below.
const INSTANCE_FIELDS = {
  exposed: prop(z.boolean(), "Expose this nested instance's existing controls in the enclosing instance panel. Writable only inside a component definition; false clears it."),
  componentProperties: prop(
    z.custom<Record<string, ComponentPropertyInput>>(),
    "Values by bare name (no `#id` suffix), as `get` reports them: a variant axis, a boolean, a text, or a component target for an instance_swap. A slot has no value here — its content is `children` under `overrides`.",
    "{ [name]: string | boolean | component target }",
  ),
  overrides: prop(
    z.custom<Record<string, OverrideDeltaInput>>(),
    "Sublayer deltas keyed by component-relative path as `get` keys them (`\"11:9\"`, or `\"11:9;11:14\"` inside a nested instance), each in that sublayer's edit vocabulary; at a SLOT's path the delta also takes `children`.",
    "{ [path]: delta }",
  ),
};

// The fill word — the one word that exists ONLY inside an `overrides` entry, and only at a SLOT's
// path. Read words are write words: `get` republishes a filled slot's content as `children` under
// the slot's path, and that is exactly the spelling that fills one. Not an edit word on any node
// type (edit-plan's per-type gate never sees it): a SLOT's content is stated whole from the
// instance, or grown with the structural verbs, and the definition's bound frame grows with `append`.
const SLOT_CONTENT_FIELDS = {
  children: prop(
    z.custom<NodeSpec[]>(),
    "Plain child specs. Ids move and edit; omitted ids create. Unmentioned children remain. Use remove to delete content.",
    "node[]",
  ),
};

// The same target selects a new instance’s component and swaps a live instance’s component.
const SWAP_FIELDS = {
  componentId: prop(
    z.custom<Target>(),
    "Required on a new INSTANCE: its COMPONENT or COMPONENT_SET target. On a live instance, swaps to that component. See Changing an instance.",
    "component target",
  ),
};

// The BINDING word, on every node compiler: which component property drives which of this node's
// fields. The read's own `componentPropertyReferences`, with the read's own field spellings — so a
// component's children read back and author back in one vocabulary. It means something ONLY inside
// flcm.component (the verb that declares the properties in the same call); every other verb refuses
// a tree carrying one, by name. Which FIELDS a given compiler may bind is per-type and enforced
// at construction (flcm.ts compileBindingBag), not spelled in the type — a `slot` on a TEXT would be
// a frame's word on a node with no children.
const BINDING_FIELDS = {
  componentPropertyReferences: prop(
    z.object({
      visible: z.string().optional(),
      text: z.string().optional(),
      componentId: z.string().optional(),
      slot: z.string().optional(),
    }),
    "Which declared property drives this node's `visible`, `text`, `componentId` or `slot` (see Properties).",
    "{ visible?, text?, componentId?, slot? } — property names",
  ),
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

export const FrameSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS, ...APPEARANCE_FIELDS, ...FRAME_FIELDS, ...BINDING_FIELDS, ...ANNOTATION_FIELDS });
export const TextSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS, ...TEXT_FIELDS, ...BINDING_FIELDS, ...ANNOTATION_FIELDS });
export const ShapeSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS, ...APPEARANCE_FIELDS, ...BINDING_FIELDS, ...ANNOTATION_FIELDS });
export const EllipseSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS, ...ELLIPSE_FIELDS, ...BINDING_FIELDS, ...ANNOTATION_FIELDS });
export const LineSchema = z.object({ ...SHARED_FIELDS, ...LINE_FIELDS, ...BINDING_FIELDS, ...ANNOTATION_FIELDS });
export const PathSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS, ...PATH_FIELDS, ...BINDING_FIELDS, ...ANNOTATION_FIELDS });
// The compiler dispatch consumes the `svg` markup itself before these props.
export const SvgSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS, ...SVG_FIELDS, ...BINDING_FIELDS, ...ANNOTATION_FIELDS });
// An instance takes a FRAME's words — its root is a frame-like container, and naming one of them
// sets a root-level override (an unnamed word keeps tracking the component) — plus the component
// words. No `children`: an instance's content is its component's.
export const InstanceSchema = z.object({ ...SHARED_FIELDS, ...SIZE_FIELDS, ...APPEARANCE_FIELDS, ...FRAME_FIELDS, ...INSTANCE_FIELDS, ...BINDING_FIELDS, ...ANNOTATION_FIELDS });

export type FrameProps = z.infer<typeof FrameSchema>;
export type InstanceProps = z.infer<typeof InstanceSchema>;
export type TextProps = z.infer<typeof TextSchema>;
export type ShapeProps = z.infer<typeof ShapeSchema>;
export type EllipseProps = z.infer<typeof EllipseSchema>;
export type LineProps = z.infer<typeof LineSchema>;
export type PathProps = z.infer<typeof PathSchema>;
export type SvgProps = z.infer<typeof SvgSchema>;

// The two words that reach a COMPONENT / COMPONENT_SET's own DEFINITION under edit — what the
// component declares, as opposed to what its root frame looks like. Edit-only: at create they ride
// flcm.component's options bag (COMPONENT_FIELDS below reuses `description` from here), and the
// per-type gate keeps them off every other node type by name.
const COMPONENT_DEFINITION_FIELDS = {
  description: prop(z.string(), "Shown beside the component in Figma's assets panel."),
  propertyDefinitions: prop(
    z.custom<ComponentPropertyDefinitionEdits>(),
    "COMPONENT / COMPONENT_SET, under edit: add (bound in the same editMany), rename or delete a property; a read's own entry restates as a no-op. See Changing a component.",
    "{ [name]: { type?, name?, variantOptions? } | null }",
  ),
};

// The flcm.edit(target, changes) delta — the ONE authoring vocabulary (no second dialect,
// invariant: same spellings, same parsers as create). Entries REUSE the create field objects (the
// RUN_FIELDS pattern), so a prop can't mean something different under edit. Which words apply to
// which node type is the runtime's per-type gate (edit-plan.ts DELTA_KEYS_BY_TYPE, composed from the
// same KNOWN_KEYS atoms) — this schema is the flat closed set an unknown key fails loud against.
// One absence is the contract, not an oversight: `key` is immutable under edit (a delta naming it
// fails loud — re-keying could mint a duplicate address).
const EDIT_FIELDS = {
  ...GRID_CONTAINER_ALIASES,
  ...ANNOTATION_FIELDS,
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
  clipsContent: FRAME_FIELDS.clipsContent,
  minWidth: SIZE_FIELDS.minWidth,
  maxWidth: SIZE_FIELDS.maxWidth,
  minHeight: SIZE_FIELDS.minHeight,
  maxHeight: SIZE_FIELDS.maxHeight,
  width: SIZE_FIELDS.width,
  height: SIZE_FIELDS.height,
  ...PLACEMENT_FIELDS,
  layout: FRAME_FIELDS.layout,
  text: TEXT_FIELDS.text,
  textStyle: TEXT_FIELDS.textStyle,
  fontSize: TEXT_FIELDS.fontSize,
  boldWeight: TEXT_FIELDS.boldWeight,
  // The INSTANCE words. Reused from the compiler's group (not restated), because editing an
  // instance is the same vocabulary `get` reports on it and `INSTANCE` creates it with —
  // there is no separate "change the variant" verb. The per-type gate keeps them off every other
  // node type.
  exposed: INSTANCE_FIELDS.exposed,
  componentProperties: INSTANCE_FIELDS.componentProperties,
  overrides: INSTANCE_FIELDS.overrides,
  ...SWAP_FIELDS,
  // The COMPONENT words. The binding word is the compiler's own statement — which property drives
  // which of this node's fields — restated here rather than reused, because edit alone can UNBIND
  // (`null` per field) and the type has to say so. The two definition words reach the COMPONENT
  // itself. The per-type gate keeps each off the types that can't carry it.
  componentPropertyReferences: prop(
    z.custom<ComponentPropertyBindingEdit>(),
    "On a live sublayer of a COMPONENT: which of its properties drives `visible` (any node), `text` (TEXT), `componentId` (INSTANCE) or `slot` (FRAME); `null` unbinds the field. See Binding a layer in the components section.",
    "{ visible?, text?, componentId?, slot? } — property names, or null to unbind",
  ),
  ...COMPONENT_DEFINITION_FIELDS,
};
export const EditSchema = z.object(EDIT_FIELDS);
export type EditDelta = z.infer<typeof EditSchema>;
export type CloneProps = Omit<EditDelta, "componentId" | "componentProperties" | "overrides" | "exposed" | "componentPropertyReferences" | "description" | "propertyDefinitions">;

// One entry of an flcm.editMany batch — the plain-data node shape the whole surface uses: `id` is
// live identity (exactly as in a render spec), and every other key is an flcm.edit delta word. A key
// string or a handle is NOT an id: a batch mutates nodes you have ALREADY located, so locate them
// first (any object carrying an `id` — a find hit, a get result — supplies one). Structural ops stay
// out on purpose: mixing tree-shape and prop ops in one list is the `flcm.change` non-goal.
export type EditEntry = { id: string } & EditDelta;

// ---- The two verbs that MAKE a component. Read words are write words here too: `propertyDefinitions`
// and `componentPropertyReferences` are what a `get` reports on a COMPONENT, spelled the same way. ----

// flcm.component(nodeOrTarget, options?) options.
const COMPONENT_FIELDS = {
  name: prop(z.string(), "Defaults to the authored node's or promoted node's own name."),
  description: COMPONENT_DEFINITION_FIELDS.description,
  propertyDefinitions: prop(
    z.custom<ComponentPropertyDefinitions>(),
    "The properties it exposes, by name — non-empty, unique in the call, each bound in it. See Properties.",
    '{ [name]: { type } }',
  ),
};

// One entry of `propertyDefinitions` — its own table, since the bag above documents only the map.
const PROPERTY_DEFINITION_FIELDS = {
  type: z
    .enum(["boolean", "text", "instance_swap", "slot"])
    .describe("Required; each type drives one field (see Properties). No default: it is the bound layer's content."),
  // Deliberately absent at create: there the KEY is the name, and a `name` beside it would be two
  // names for one property. It exists only so an edit can rename — see COMPONENT_DEFINITION_FIELDS.
  name: prop(
    z.string(),
    "Edit only: renames the property. At create the key IS the name, so this fails loud.",
  ),
};

// One entry of flcm.variants — both fields required, so neither rides prop() (which optionals).
const VARIANT_ENTRY_FIELDS = {
  component: z
    .custom<Target>()
    .describe("The standalone local COMPONENT that becomes this variant.")
    .meta({ type: "component target" }),
  variant: z
    .custom<Record<string, string>>()
    .describe('Which member of the set this component IS: { Size: "Large", State: "Default" }.')
    .meta({ type: "{ [axis]: value }" }),
};

const VARIANTS_FIELDS = {
  name: z.string().describe("Required."),
  description: COMPONENT_FIELDS.description,
};

export const ComponentOptionsSchema = z.object(COMPONENT_FIELDS);
export type ComponentOptions = z.infer<typeof ComponentOptionsSchema>;
export const VariantsOptionsSchema = z.object(VARIANTS_FIELDS);
export type VariantsOptions = z.infer<typeof VariantsOptionsSchema>;

// Image sources are URLs or local paths under the server’s asset root; options control paint mapping.
const IMAGE_FIELDS = {
  scaleMode: prop(
    z.enum(["FILL", "FIT", "CROP", "TILE"]),
    'How the image maps into the node box. Default "FILL" (cover). "FIT" contains it, "CROP" uses the crop transform, "TILE" repeats it.',
  ),
  placeholder: prop(
    z.boolean(),
    "Mark this as a stand-in, not a real asset. Persisted on the node so a later read can tell a placeholder from a real image (and not hardcode the stand-in url as the real src). Default false.",
  ),
  opacity: prop(z.number(), "Paint opacity, 0–1, independent of the node's own opacity. Default 1.", "number (0–1)"),
  rotation: prop(
    z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    "Turns the image inside the node in quarter turns. Default 0.",
    "0 | 90 | 180 | 270",
  ),
  filters: prop(
    z.object({
      exposure: z.number(), contrast: z.number(), saturation: z.number(), temperature: z.number(),
      tint: z.number(), highlights: z.number(), shadows: z.number(),
    }).partial(),
    "Figma's image adjustments, each -1 to 1 (0 is untouched). Unnamed ones stay 0.",
    "{ exposure?, contrast?, saturation?, temperature?, tint?, highlights?, shadows? }",
  ),
  blendMode: prop(
    z.string(),
    "How this paint blends with the paints beneath it — a CSS blend name, as in mixBlendMode. Default \"normal\".",
    '"multiply" | "screen" | "overlay" | … (CSS blend name)',
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
  progressiveBackgroundBlur: prop(
    z.custom<ProgressiveBlurSugar>(),
    "A background blur that ramps across the node (blurs what's behind, like `backgroundBlur`) — object form only. Same fields and defaults as `progressiveBlur`.",
    "number | object",
  ),
});

export type NodeSpec = (Omit<Partial<SimplifiedNode>, "children"> & { children?: NodeSpec[] }) | ({ id?: string; type?: string; children?: NodeSpec[] } & Partial<FrameProps & TextProps & LineProps & PathProps & InstanceProps & { svg: string; componentId: Target }>);
export type AuthoredTree = NodeSpec & { warnings?: WarningRecord[]; id: string; children?: AuthoredTree[] };

// ---- The typed public surface. flcm.ts's real exports are asserted `satisfies Flcm`, so this can't
// drift from them; the example files author against it and fail the build if a signature moves. ----
export interface Flcm {
  detach(target: Target): Promise<Handle>;
  // Promotion returns authored data with type COMPONENT and the promoted root id.
  component(nodeOrTarget: NodeSpec | Target, options?: ComponentOptions): Promise<AuthoredTree>;
  // Fold standalone components into a COMPONENT_SET: each entry says which member of the set its
  // component IS, in the set's axes. The set lands where the first component sat, and the variant
  // axes become the set's own `variant` properties — the ones INSTANCE's `componentProperties`
  // then select by.
  variants(entries: VariantEntryInput[], options: VariantsOptions): Promise<Handle>;
  gradient(sugar: GradientSugar): WritePaint;
  gradient(type: "linear" | "radial", stops: GradientStopInput[], angle?: number): WritePaint;
  // A raster image fill value — like flcm.gradient, a paint you pass to any node's `fill`. The bytes are
  // fetched server-side (the sandbox reaches nothing); an unfetchable/blocked/invalid url fails loud.
  image(url: string, opts?: ImageOpts): WritePaint;
  effects(sugar: EffectsSugar): WriteEffect[];
  render(tree: NodeSpec): Promise<AuthoredTree>;
  // Nudge an existing node: apply a partial delta (same vocabulary as create — node-local props in
  // this slice) to the resolved target and return its updated Handle with fresh geometry. Atomic per
  // call: the whole delta validates before the first write, and a post-validation Figma refusal
  // rolls the verb back (commit-then-undo) — the canvas is never half-a-verb.
  edit(target: Target, changes: EditDelta | Partial<SimplifiedNode>): Promise<Handle>;
  // The atomic batch form: every id resolves and every delta validates before the first write,
  // so one invalid entry leaves the canvas untouched and the rejection names EVERY failing entry.
  // The whole set is one undo step, and cross-entry order doesn't matter (a parent turned
  // auto-layout settles before a child set to "fill", whichever way round they were written).
  editMany(entries: EditEntry[]): Promise<Handle[]>;
  // Ids select live nodes at every depth; each result is a copy of the spec with ids filled.
  append(parent: Target, thing: NodeSpec): Promise<AuthoredTree>;
  prepend(parent: Target, thing: NodeSpec): Promise<AuthoredTree>;
  insertBefore(sibling: Target, thing: NodeSpec): Promise<AuthoredTree>;
  insertAfter(sibling: Target, thing: NodeSpec): Promise<AuthoredTree>;
  remove(target: Target): Promise<RemoveResult>;
  // A faithful live duplicate — the copy path for subtrees a rebuild can't reproduce (anything
  // outside the authoring vocabulary). Lands at the end of `parent`, beside the original when omitted, and comes
  // back key-less: a raw node.clone() would copy the flcm/key and mint a duplicate address.
  clone(target: Target, parent?: Target): Promise<Handle>;
  clone(target: Target, props: CloneProps, parent?: Target): Promise<Handle>;
  measure(target: Target): Promise<{ x: number; y: number; width: number; height: number; warnings?: WarningRecord[] }>;
  replace(target: Target, replacement: NodeSpec): Promise<AuthoredTree>;
  // Complete runtime tree, including hidden and inherited children, plus component definitions.
  get(target: Target): Promise<GetResult>;
  // Locate: every node matching the query, as slim handles (identity + a cheap layout world-model). May be
  // empty; AND-combines the query keys (default scope: current page). The query is a FILTER, not an
  // address — only `within` takes a target (id/key/handle); the other keys are match conditions, and a
  // bare string is rejected rather than guessed at. Dive into a hit with `get`. The query pre-filters live
  // nodes; a whole-scope simplify supplies predicate shapes and geometry.
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
// ----
// `category` groups verbs for the quick-start's compact per-group rendering (the ≤2KB budget can't afford a
// line per verb). The verb TABLE still lists each verb in full — only the quick-start groups.
export type VerbCategory = "value" | "render" | "edit" | "structure" | "component" | "read" | "page" | "target";

export interface VerbDoc {
  signature: string;
  builds: string;
  args: string;
  category: VerbCategory;
  // The ≤2KB quick-start spelling, when the full signature doesn't fit its budget — written in the
  // same `flcm.`-prefixed form as `signature`, since the renderer strips the prefix from both.
  // `null` means "folded into the PREVIOUS entry's combined spelling": verbs that differ only in
  // where they place (append/prepend, insertBefore/insertAfter) print as one line. The verb TABLE
  // is unaffected — it always renders the full `signature`.
  quickStart?: string | null;
}

export const VERBS: VerbDoc[] = [
  {"category": "render", "signature": "await flcm.render(spec)", "builds": "the spec copied with ids on every node", "args": "Place on the current page. An id moves and edits that live node; no id creates. Children follow the same rule. With an id and children, it adds several children to that live node in one call."},
  {"category": "structure", "signature": "await flcm.append(parent, spec)", "builds": "the spec copied with ids on every node", "args": "Place as the last child. Unmentioned live children remain."},
  {"category": "structure", "signature": "await flcm.prepend(parent, spec)", "builds": "the spec copied with ids on every node", "args": "Place as the first child."},
  {"category": "structure", "signature": "await flcm.insertBefore(sibling, spec)", "builds": "the spec copied with ids on every node", "args": "Place immediately before the sibling."},
  {"category": "structure", "signature": "await flcm.insertAfter(sibling, spec)", "builds": "the spec copied with ids on every node", "args": "Place immediately after the sibling."},
  {"category": "structure", "signature": "await flcm.replace(target, spec)", "builds": "the spec copied with ids on every node", "args": "Place in the target position, then remove the target. New roots inherit omitted placement and size; explicit props win."},
  {"category": "structure", "signature": "await flcm.remove(target)", "builds": "{ removedId, from? }", "args": "Delete the node and subtree. from is the former parent handle, absent for pages."},
  {"category": "structure", "signature": "await flcm.clone(target, props?, parent?)", "builds": "the copy's handle", "args": "Faithful live copy, with optional root edits and destination. Keys are cleared. Default destination is the original parent."},
  {"category": "component", "signature": "await flcm.component(specOrTarget, options?)", "builds": "the spec copied with ids and root type COMPONENT", "args": "Promote a FRAME to a COMPONENT. A live root stays in place; a new root lands on the current page. The returned root id is the component id. options declares name, description and propertyDefinitions."},
  {"category": "component", "signature": "await flcm.variants(entries, options)", "builds": "a COMPONENT_SET handle", "args": "Each entry is { component: target, variant: { axis: value } }. options names the set."},
  {"category": "component", "signature": "await flcm.detach(target)", "builds": "a FRAME handle", "args": "Detach an instance. Root and descendant ids change."},
  {"category": "edit", "signature": "await flcm.edit(target, changes)", "builds": "an updated handle", "args": "Apply only the named props. Structure changes use placement verbs."},
  {"category": "edit", "signature": "await flcm.editMany(entries)", "builds": "updated handles in entry order", "args": "One atomic batch. Each entry is { id, ...changes } — a live node id plus the same props edit takes."},
  {"category": "read", "signature": "await flcm.get(target)", "builds": "{ node, components? }", "args": "Expanded read data. Pass node directly to a placement verb to move and edit it. components contains shared definitions."},
  {"category": "read", "signature": "await flcm.find(query?, predicate?)", "builds": "slim handles[]", "args": "Query keys, the complete set: type, name, key, within, hasAnnotations. The optional predicate receives each candidate's full flcm read shape and can test any field in it."},
  {"category": "read", "signature": "await flcm.findOne(query?, predicate?)", "builds": "one slim handle", "args": "Like find; throws unless exactly one matches."},
  {"category": "read", "signature": "await flcm.selection()", "builds": "slim handles[]", "args": "The current selection."},
  {"category": "read", "signature": "await flcm.measure(target)", "builds": "{ x, y, width, height }", "args": "Measured pixels; x/y are relative to the containing frame or page, so a group's children measure from the frame around the group."},
  {"category": "value", "signature": "flcm.gradient(sugar)", "builds": "a paint value", "args": "{ type: linear or radial, stops, angle?, at? }. Also accepts (type, stops, angle?)."},
  {"category": "value", "signature": "flcm.image(url, options?)", "builds": "a paint value", "args": "Raster fill. Options: scaleMode, placeholder, opacity, rotation, filters, blendMode. Bytes are fetched through the host at the mutation verb."},
  {"category": "value", "signature": "flcm.effects(sugar)", "builds": "effect values[]", "args": "CSS and Figma effect values for an effects prop."},
  {"category": "target", "signature": "flcm.id(nodeId)", "builds": "{ __flcmId: nodeId }", "args": "Force raw-id resolution in a target argument."},
  {"category": "page", "signature": "await flcm.page.current()", "builds": "{ fileName, page, pages }", "args": "Current page and available pages."},
  {"category": "page", "signature": "await flcm.page.use(nameOrId)", "builds": "{ fileName, page, pages }", "args": "Switch to an existing page."},
  {"category": "page", "signature": "await flcm.page.new(name)", "builds": "{ fileName, page, pages }", "args": "Create a uniquely named page and switch to it."},
];

// Re-exported for the doc generator: which FIELD_GROUPS compose each node type's edit surface —
// the same table edit-plan.ts builds its runtime legality gate from, so the per-type doc lists and the
// gate cannot drift. (A runtime value, but from zod-free ir.ts — the purity gate is unaffected.)
export { EDIT_TYPE_WORD_GROUPS } from "./ir.js";

// ---- Field-group registry — how the reference groups props into tables. Each verb's full schema drives
// its TYPE; these groups drive its DOC layout (shared/size tables once, verb-specific tables per verb). ----
export const FIELD_GROUPS = {
  annotation: ANNOTATION_FIELDS,
  shared: SHARED_FIELDS,
  size: SIZE_FIELDS,
  placement: PLACEMENT_FIELDS,
  appearance: APPEARANCE_FIELDS,
  ellipse: ELLIPSE_FIELDS,
  frame: FRAME_FIELDS,
  layout: LAYOUT_FIELDS,
  childLayout: CHILD_LAYOUT_FIELDS,
  containerLayout: CONTAINER_LAYOUT_FIELDS,
  text: TEXT_FIELDS,
  textStyle: TEXTSTYLE_FIELDS,
  run: RUN_FIELDS,
  line: LINE_FIELDS,
  path: PATH_FIELDS,
  svg: SVG_FIELDS,
  edit: EDIT_FIELDS,
  instance: INSTANCE_FIELDS,
  swap: SWAP_FIELDS,
  slotContent: SLOT_CONTENT_FIELDS,
  binding: BINDING_FIELDS,
  componentOptions: COMPONENT_FIELDS,
  componentDefinition: COMPONENT_DEFINITION_FIELDS,
  propertyDefinition: PROPERTY_DEFINITION_FIELDS,
  variantEntry: VARIANT_ENTRY_FIELDS,
  variantsOptions: VARIANTS_FIELDS,
  image: IMAGE_FIELDS,
  gradient: GradientSchema.shape,
  effects: EffectsSchema.shape,
} as const;
