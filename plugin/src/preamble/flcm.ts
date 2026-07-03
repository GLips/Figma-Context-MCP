// flcm — the public surface. This is the ONLY thing the agent touches: a single namespace of inert
// constructors plus render(). Constructors build POJO WriteNodes (the typed IR currency) and mutate
// nothing; render() is the one async call that walks the tree and creates live nodes.
//
// The constructors take TERSE sugar props (w/h/pad/gap/align/cross/absolute/radius/fill/...) and compile
// them into the typed WriteNode currency here. Author CSS-shaped leaves (a #hex color, a gradient string,
// a "32px" metric) are normalized ONCE through css.ts at construction — the bridge only ever sees the
// typed currency, never a string. A raw WriteNode (e.g. a future tweaked `get` result, normalized through
// css.ts first) is the same typed shape a constructor emits, so it renders too.
//
// Props types are precise so the bundle's own authors get checking, while the public entry points stay
// runtime-lenient (agent code runs in QuickJS, not tsc): a bad value still fails loud at the parsers
// (parseFill/length/sizing throw), it just isn't caught at compile time in the sandbox.
//
// Only the names exported from runtime.ts land on the `flcm` global; everything imported here stays
// closure-private in the IIFE bundle — which is why nothing in this preamble needs a name prefix.

import {
  WriteNode, WriteChild, WriteLayout, WriteTextStyle, WriteTextRun, PaintSpec,
  GradientStop, EffectSpec, Sizing, Edges, Handle, WriteCssEffects, PinX, PinY, AnchorX, AnchorY,
  Justify, Align, TextAlign, TextDecoration,
} from "./ir.js";
import { loadFontsForTree } from "./fonts.js";
import { parseInlineMarkdown, MdSegment } from "./markdown.js";
import { linearGradient, radialGradient } from "./paint.js";
import { layerBlurFromCssPx, backgroundBlurFromCssPx, shadow, glass, noise, texture, progressiveBlur } from "./effects.js";
import { parseColor, parseFill, parseCssEffects, parseBlendMode, length, lineHeight, letterSpacing, isPercent, percent } from "./css.js";
import { buildNode, handle, readBackGeometry, resolvePercents, RenderCtx } from "./bridge.js";

// The authoring surface (verb Props + gradient/effects sugar) is defined ONCE in schema.ts as zod schemas
// with per-field docs; these are the z.infer'd types. Imported `import type` ONLY so schema.ts's zod is
// erased by esbuild and never reaches the sandbox bundle. Change a prop by editing the schema, not here.
import type {
  BaseProps, SizeProps, AppearanceProps, FrameProps, TextProps, TextRunInput, StyleDeltaInput,
  ShapeProps, LineProps, PathProps, SvgProps, ImageOpts,
  PadInput, EffectsInput, GradientSugar, GradientStopInput, EffectsSugar, ShadowSugar, BlurSugar,
  GlassSugar, NoiseSugar, TextureSugar, ProgressiveBlurSugar, Flcm,
} from "./schema.js";

// ---- shared prop -> WriteNode compilers ----

// terse pad (number | {x,y} | {top,right,bottom,left}) -> typed edges. pad takes NUMBERS, not "px"
// strings: a string like "24px" is neither a number nor an edge object, and the old code silently
// dropped it to zero padding on every side. Reject a non-number/non-object, and a non-numeric edge
// field, rather than emit a silent zero (ADR-0003 fail-loud).
function padEdges(pad: PadInput): Edges {
  if (typeof pad === "number") return { top: pad, right: pad, bottom: pad, left: pad };
  if (pad == null || typeof pad !== "object") {
    throw new Error("flcm: pad must be a number or an object ({ x, y } or { top, right, bottom, left }) — got " + JSON.stringify(pad) + '. pad takes numbers, not "px" strings.');
  }
  const edge = (v: number | undefined, name: string): number | undefined => {
    if (v == null) return undefined;
    if (typeof v !== "number") throw new Error("flcm: pad." + name + " must be a number, got " + JSON.stringify(v) + ' (pad takes numbers, not "px" strings).');
    return v;
  };
  const y = edge(pad.y, "y"), x = edge(pad.x, "x");
  const top = edge(pad.top, "top"), right = edge(pad.right, "right");
  const bottom = edge(pad.bottom, "bottom"), left = edge(pad.left, "left");
  // Specific edge wins over the x/y shorthand; `??` (not `||`) so an explicit 0 isn't treated as unset.
  return { top: top ?? y ?? 0, right: right ?? x ?? 0, bottom: bottom ?? y ?? 0, left: left ?? x ?? 0 };
}

// w/h -> sizing intent + fixed dimensions. A number is a fixed size (carries a dimension); 'fill'/'hug'
// are intents the bridge resolves against the parent / content.
function applySizing(props: SizeProps, layout: WriteLayout): void {
  const sz: { horizontal?: Sizing; vertical?: Sizing } = {};
  const dims: { width?: number; height?: number } = {};
  const pct: { width?: number; height?: number } = {};
  const axis = (val: SizeProps["width"], key: "horizontal" | "vertical", dim: "width" | "height") => {
    if (val === undefined) return;
    if (val === "fill" || val === "hug") sz[key] = val;
    else if (typeof val === "number") { sz[key] = "fixed"; dims[dim] = val; }
    // "N%" is a fixed px once resolved against the parent (the bridge folds it in at render), so it sizes
    // "fixed" and carries only the percent intent here.
    else if (isPercent(val)) { sz[key] = "fixed"; pct[dim] = percent(val); }
    else throw new Error('flcm: width/height must be a number, "N%", "fill", or "hug" — got ' + JSON.stringify(val) + ".");
  };
  axis(props.width, "horizontal", "width");
  axis(props.height, "vertical", "height");
  if (sz.horizontal || sz.vertical) layout.sizing = sz;
  if (dims.width != null || dims.height != null) layout.dimensions = dims;
  if (pct.width != null || pct.height != null) layout.percentSize = pct;
}

function applyAbsolute(layout: WriteLayout, props: SizeProps): void {
  if (!props.absolute) return;
  layout.position = "absolute";
  // A percent x/y resolves to px against the parent axis at render (percentPos); a number is the location
  // directly. The percent axes seed 0 here and the bridge overwrites them once the parent size is known.
  layout.left = 0;
  layout.top = 0;
  const pct: { x?: number; y?: number } = {};
  const axis = (val: number | string | undefined, key: "x" | "y", side: "left" | "top") => {
    if (val == null) return;
    if (typeof val === "number") layout[side] = val;
    else if (isPercent(val)) pct[key] = percent(val);
    else throw new Error("flcm: absolute." + key + ' must be a number or "N%" — got ' + JSON.stringify(val) + ".");
  };
  axis(props.absolute.x, "x", "left");
  axis(props.absolute.y, "y", "top");
  if (pct.x != null || pct.y != null) layout.percentPos = pct;
  applyAnchor(layout, props.absolute.anchor);
}

// pin and anchor are the two directional `{ x?, y? }` props: same shape, different vocabularies. Both
// validate each axis at the boundary (a bad value fails loud, ADR-0003) so the bridge can trust the words —
// pin's map to Figma's constraint enum, anchor's to an offset. anchor's words are a subset of pin's (no
// stretch/scale: an anchor is a point, not a resize rule).
const PIN_X = new Set<PinX>(["left", "center", "right", "stretch", "scale"]);
const PIN_Y = new Set<PinY>(["top", "center", "bottom", "stretch", "scale"]);
const ANCHOR_X = new Set<AnchorX>(["left", "center", "right"]);
const ANCHOR_Y = new Set<AnchorY>(["top", "center", "bottom"]);

// justifyContent (primary-axis distribution) and alignItems (counter-axis alignment) — the two container
// enums. The author speaks CSS-total value spellings (flex-start/space-between); these tables map them to
// the terse render intent the IR/bridge carry. Mapping HERE at the describe boundary keeps the CSS-total
// vocabulary an LLM-edge concern (Invariant 2) without pushing inverse translators into the bridge. This is
// also the ONLY runtime gate: schema.ts's zod enum is type/doc-only (never enters the sandbox), and the
// bridge resolves a miss to a silent MIN — so a valid-CSS-but-unrealizable value (space-around/space-evenly)
// would silently no-op without this check (ADR-0003). Figma's primaryAxisAlignItems has no space-around/evenly.
const JUSTIFY_CONTENT: Record<string, Justify> = {
  "flex-start": "start", "flex-end": "end", center: "center", "space-between": "between",
};
const ALIGN_ITEMS: Record<string, Align> = {
  "flex-start": "start", "flex-end": "end", center: "center", stretch: "stretch",
};
// Auto-layout direction. Unlike justify/align these need no CSS→terse mapping (row/column/none ARE the
// values), so mode validates by identity via assertEnum — a stray mode (notably `grid`, which flcm can't
// author) fails loud naming the set rather than silently degrading to free-form (ADR-0003; the schema doc
// promises exactly this).
const LAYOUT_MODE = new Set<"none" | "row" | "column">(["row", "column", "none"]);

// TS's Set.has doesn't narrow its argument, so wrap it as a real type guard: a hit proves the string is one
// of the set's literals, letting parseDirectional return the typed axis words with no cast at the call site.
function oneOf<T extends string>(set: ReadonlySet<T>, v: string): v is T {
  return set.has(v as T);
}

function words(set: ReadonlySet<string>): string {
  return [...set].map((w) => '"' + w + '"').join(", ");
}

// Validate a directional prop against its per-axis word sets, returning the typed pair (or undefined when
// neither axis is set). `name` prefixes every error (e.g. "pin", "absolute.anchor"); each message lists the
// set's own members as the allowed words.
function parseDirectional<X extends string, Y extends string>(
  name: string, raw: unknown, xSet: ReadonlySet<X>, ySet: ReadonlySet<Y>,
): { x?: X; y?: Y } | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object") {
    throw new Error("flcm: " + name + " must be an object like { x, y } — got " + JSON.stringify(raw) + ".");
  }
  const r = raw as { x?: string; y?: string };
  const out: { x?: X; y?: Y } = {};
  if (r.x != null) {
    if (!oneOf(xSet, r.x)) throw new Error("flcm: " + name + ".x must be one of " + words(xSet) + " — got " + JSON.stringify(r.x) + ".");
    out.x = r.x;
  }
  if (r.y != null) {
    if (!oneOf(ySet, r.y)) throw new Error("flcm: " + name + ".y must be one of " + words(ySet) + " — got " + JSON.stringify(r.y) + ".");
    out.y = r.y;
  }
  return out.x != null || out.y != null ? out : undefined;
}

// Map a CSS-total container word (justifyContent/alignItems) to the terse render intent via its table (see
// JUSTIFY_CONTENT/ALIGN_ITEMS for why this gate exists). `hint` appends prop-specific guidance; the shared
// body names the realizable CSS spellings.
function mapLayoutWord<T extends string>(name: string, raw: unknown, table: Record<string, T>, hint = ""): T {
  const mapped = typeof raw === "string" ? table[raw] : undefined;
  if (!mapped) {
    const allowed = Object.keys(table).map((w) => '"' + w + '"').join(", ");
    throw new Error("flcm: " + name + " must be one of " + allowed + " — got " + JSON.stringify(raw) + "." + hint);
  }
  return mapped;
}

// anchor -> which point of the child lands on x/y. Omitted = {left, top} (back-compatible).
function applyAnchor(layout: WriteLayout, anchor: { x?: AnchorX; y?: AnchorY } | undefined): void {
  const a = parseDirectional("absolute.anchor", anchor, ANCHOR_X, ANCHOR_Y);
  if (a) layout.anchor = a;
}

// pin -> constraint-override intent on the layout. Only meaningful for a free-form parent's child;
// harmlessly ignored under auto-layout.
function applyPin(layout: WriteLayout, props: SizeProps): void {
  const pin = parseDirectional("pin", props.pin, PIN_X, PIN_Y);
  if (pin) layout.pin = pin;
}

function buildLayout(props: FrameProps, isFrame: boolean): WriteLayout {
  const layout: WriteLayout = {};
  if (isFrame) {
    const cfg = props.layout || {};
    layout.mode = cfg.mode == null ? "none" : assertEnum("layout.mode", cfg.mode, LAYOUT_MODE);
    if (cfg.gap != null) layout.gap = length(cfg.gap);
    if (cfg.padding != null) layout.padding = padEdges(cfg.padding);
    // The space-around/evenly hint is primary-axis-only (a justify-content notion), so only justifyContent carries it.
    if (cfg.justifyContent != null) layout.justifyContent = mapLayoutWord("layout.justifyContent", cfg.justifyContent, JUSTIFY_CONTENT, " Figma auto-layout can't realize CSS space-around/space-evenly; add gap/padding for spacing instead.");
    if (cfg.alignItems != null) layout.alignItems = mapLayoutWord("layout.alignItems", cfg.alignItems, ALIGN_ITEMS);
  }
  applySizing(props, layout);
  applyAbsolute(layout, props);
  applyPin(layout, props);
  return layout;
}

// name/key/opacity — present on every node kind. Additive: only present props land on the WriteNode.
function base(wn: WriteNode, props: BaseProps): void {
  if (typeof props.name === "string") wn.name = props.name;
  if (typeof props.key === "string") wn.key = props.key;
  if (typeof props.opacity === "number") wn.opacity = props.opacity;
  if (props.mixBlendMode != null) wn.blendMode = parseBlendMode(props.mixBlendMode);
}

// Appearance props shared by frame/rect/ellipse, on top of base(). Every CSS-shaped leaf is normalized
// to the typed currency through css.ts here.
function appearance(wn: WriteNode, props: AppearanceProps, opts: { radius?: boolean; clip?: boolean }): void {
  base(wn, props);
  if (props.fill != null) wn.fills = [parseFill(props.fill, "fill")];
  if (props.stroke != null) wn.strokes = [parseFill(props.stroke, "stroke")];
  if (props.strokeWidth != null) wn.strokeWeight = length(props.strokeWidth);
  if (props.effects != null) wn.effects = normalizeEffects(props.effects);
  if (opts.radius && props.borderRadius != null) wn.borderRadius = length(props.borderRadius);
  if (opts.clip && typeof (props as FrameProps).clip === "boolean") wn.clip = (props as FrameProps).clip;
  if (typeof props.rotation === "number") wn.rotation = props.rotation;
}

function frame(props: FrameProps = {}, children?: WriteChild | WriteChild[]): WriteNode {
  props = props || {};
  const wn: WriteNode = { type: "FRAME" };
  appearance(wn, props, { radius: true, clip: true });
  wn.layout = buildLayout(props, true);
  wn.children = Array.isArray(children) ? children : children ? [children] : [];
  return wn;
}

function text(content: unknown, props: TextProps = {}): WriteNode {
  props = props || {};
  const wn: WriteNode = { type: "TEXT" };
  base(wn, props);
  // `color` is a top-level node-level sugar prop (compiles to the text node's fill), NOT part of textStyle —
  // base color lives in `fills` like every other node, and the grouped `textStyle` is the type base only.
  if (props.color != null) wn.fills = [parseFill(props.color, "color")];
  const cfg = props.textStyle || {};
  const ts: WriteTextStyle = {};
  if (cfg.fontSize != null) ts.fontSize = cfg.fontSize;
  if (cfg.fontWeight != null) ts.fontWeight = cfg.fontWeight;
  if (typeof cfg.fontFamily === "string") ts.fontFamily = cfg.fontFamily;
  if (cfg.fontStyle != null) ts.fontStyle = assertEnum("textStyle.fontStyle", cfg.fontStyle, FONT_STYLE);
  if (cfg.lineHeight != null) ts.lineHeight = lineHeight(cfg.lineHeight);
  if (cfg.letterSpacing != null) ts.letterSpacing = letterSpacing(cfg.letterSpacing);
  if (cfg.textDecoration != null) ts.textDecoration = assertEnum("textStyle.textDecoration", cfg.textDecoration, TEXT_DECORATION);
  if (cfg.textAlign != null) ts.textAlign = assertEnum("textStyle.textAlign", cfg.textAlign, TEXT_ALIGN);
  if (Object.keys(ts).length) wn.textStyle = ts;
  // Content is either the rich-text runs array or a plain string, and BOTH flow through the markdown
  // parser now (markdown.ts). A plain string may carry markdown (`**bold**`) or literal escapes (`\*`);
  // a runs-array entry's text is markdown too (read renders a run's decorations INSIDE its text). The
  // base textStyle above is the default each run layers over. A plain string that parses to a single
  // flagless segment stays a plain `text`; anything richer becomes `runs`.
  if (Array.isArray(content)) {
    const runs = compileRuns(content, ts);
    if (runs.length) wn.runs = runs;
    else wn.text = "";
  } else {
    const segs = parseInlineMarkdown(assertNotReadToken(plainString(content)));
    if (segs.length === 1 && isPlainSeg(segs[0])) wn.text = segs[0].text;
    else if (!segs.length) wn.text = "";
    else wn.runs = segs.map((seg) => compileRun(seg.text, mergeDelta(seg, {}), ts));
  }
  if (cfg.lineClamp != null) wn.maxLines = assertLineClamp(cfg.lineClamp, props.width);
  const layout = buildLayout(props as FrameProps, false);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// lineClamp clamps a text to N lines with an ending ellipsis, but truncation only bites when the text has a
// bounded width to wrap against — buildText wires a fixed/`"fill"`/`"N%"` width to height-only auto-resize,
// giving it a wrap; a width-hugging text grows sideways on one line, so there's nothing to clamp. Rather
// than let `lineClamp` be a silent no-op there (ADR-0003), reject it loud and name the fix. N must be a
// whole number ≥ 1. (A `"hug"` or absent `width` is the unbounded case.)
function assertLineClamp(lineClamp: unknown, width: TextProps["width"]): number {
  if (typeof lineClamp !== "number" || !Number.isInteger(lineClamp) || lineClamp < 1) {
    throw new Error("flcm.text: textStyle.lineClamp must be a whole number ≥ 1 — got " + JSON.stringify(lineClamp) + ".");
  }
  const bounded = typeof width === "number" || width === "fill" || isPercent(width);
  if (!bounded) {
    throw new Error('flcm.text: textStyle.lineClamp needs a bounded width to truncate against — set width to a number, "fill", or "N%". A width-hugging text grows on one line, so there is nothing to wrap and clamp.');
  }
  return lineClamp;
}

// Realizable subsets for the two enum-valued text-style leaves. zod's enums (schema.ts) are type/doc only
// and never enter the sandbox, so THESE are the runtime fail-loud gates (ADR-0003): a valid-CSS-but-
// unrealizable value (fontStyle "oblique", textDecoration "overline") is rejected naming the supported set
// rather than silently dropped.
const FONT_STYLE = new Set<"italic" | "normal">(["italic", "normal"]);
const TEXT_DECORATION = new Set<TextDecoration>(["underline", "line-through", "none"]);
const TEXT_ALIGN = new Set<TextAlign>(["left", "center", "right", "justify"]);

// Identity-validate an enum-valued prop against its realizable set, returning the value narrowed to the
// set's member type via the `oneOf` guard (no cast at the call site). The runtime fail-loud gate for props
// whose zod enum is type/doc-only (never in the sandbox); `words` renders the allowed set, shared with the
// directional-prop gate. `name` is bare ("layout.mode", "run fontStyle") — the caller prefixes the verb.
function assertEnum<T extends string>(name: string, raw: unknown, set: ReadonlySet<T>): T {
  if (typeof raw !== "string" || !oneOf(set, raw)) {
    throw new Error("flcm: " + name + " must be one of " + words(set) + " — got " + JSON.stringify(raw) + ".");
  }
  return raw;
}

// flcm.text takes PLAIN text OR a runs array (see compileRuns). A bare structured/object value that is
// neither is a READ artifact with no write path — figma-mcp read output nests styled text as an object, and
// writing it back verbatim would render its shape literally — so reject loud. (A stray `**` in a plain
// string is NOT rejected: it is markdown now, gated on the escape convention — an author who wants a
// literal `**` writes `\*\*`, which decodes back to the literal.)
function plainString(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "object") {
    throw new Error("flcm.text: expected a plain string or a runs array, got a structured value (" + JSON.stringify(content) + "). A styled-text read object has no write path — pass a plain string, or an array of [text, style] runs.");
  }
  return String(content);
}

// figma-mcp compressed read-side rich text by wrapping spans in inline style-ref tokens ({ts1}…{/ts1}); a
// retired READ format distinct from the authored runs form. Writing it back verbatim renders the tokens
// literally, so reject it on the RAW input, BEFORE markdown decode — an author who wants a literal "{ts1}"
// escapes the braces (`\{ts1\}`), which doesn't match this pattern and decodes back to the literal. Never
// re-run on decoded text, or that escaped-literal round-trip would false-positive.
function assertNotReadToken(s: string): string {
  if (/\{\/?ts\d+\}/.test(s)) {
    throw new Error("flcm.text: this text carries figma-mcp style-ref tokens ({tsN}…{/tsN}) — a read artifact. Strip the inline styling, or express the styling as a runs array.");
  }
  return s;
}

const isPlainSeg = (seg: MdSegment): boolean => !seg.bold && !seg.italic && !seg.strike && seg.hyperlink === undefined;

// Compile the author's runs array into typed WriteTextRuns. Each entry is a bare string (plain segment) or
// a `[text, StyleDelta]` tuple (a styled span) — the canonical run model, so read output re-authors
// verbatim. The entry's TEXT is itself markdown (read renders a run's decorations INSIDE its text), so it
// is parsed and may expand to several runs; each carries the entry's residual StyleDelta merged UNDER the
// markdown flags (an explicit delta field wins over the field the markdown implied — e.g. a non-canonical
// heavy weight overrides the plain `**` bold). The `{tsN}` rejection runs on the raw entry text, pre-decode.
function compileRuns(runs: TextRunInput[], baseStyle: WriteTextStyle): WriteTextRun[] {
  if (!runs.length) {
    throw new Error("flcm.text: a runs array must be non-empty — pass at least one run (a string or a [text, style] tuple).");
  }
  const out: WriteTextRun[] = [];
  for (const run of runs) {
    let raw: string;
    let delta: StyleDeltaInput;
    if (typeof run === "string") { raw = run; delta = {}; }
    else if (Array.isArray(run) && typeof run[0] === "string") { raw = run[0]; delta = run[1] || {}; }
    else {
      throw new Error('flcm.text: each run is a plain string or a [text, style] tuple like ["bold bit", { fontWeight: 700 }] — got ' + JSON.stringify(run) + ".");
    }
    for (const seg of parseInlineMarkdown(assertNotReadToken(raw))) {
      out.push(compileRun(seg.text, mergeDelta(seg, delta), baseStyle));
    }
  }
  return out;
}

// Markdown flags → StyleDelta fields, then overlay the tuple's explicit delta so an explicit field wins
// over the one the markdown implied. Bold maps to the default bold weight ("bold", snapped by fonts.ts);
// a read run whose weight isn't the canonical bold carries an explicit `fontWeight` in its delta that
// overrides this. `\n`-decoded newlines and every other char already live in seg.text.
function mergeDelta(seg: MdSegment, explicit: StyleDeltaInput): StyleDeltaInput {
  const d: StyleDeltaInput = {};
  if (seg.bold) d.fontWeight = "bold";
  if (seg.italic) d.fontStyle = "italic";
  if (seg.strike) d.textDecoration = "line-through";
  if (seg.hyperlink !== undefined) d.hyperlink = seg.hyperlink;
  return { ...d, ...explicit };
}

// Compile one run's (already-decoded text, StyleDelta) over the node base into a typed WriteTextRun. Font
// resolution is effective-at-construction: a run changing family, weight, OR slant carries the complete
// (family, weight, fontStyle) triple so fonts.ts preloads the exact style and the bridge applies it via
// setRangeFontName — italic is a font-name concern in Figma, not a separate call. A run that only inherits
// base italic carries no per-range font (the base font is already italic). textDecoration and hyperlink are
// independent Figma calls. The `{tsN}` guard is NOT re-run here — the text is already decoded (see
// assertNotReadToken); it was checked on the raw input in compileRuns / text().
function compileRun(str: string, delta: StyleDeltaInput, baseStyle: WriteTextStyle): WriteTextRun {
  const out: WriteTextRun = { text: str };
  const style: WriteTextStyle = {};
  const italic = delta.fontStyle != null
    ? assertEnum("run fontStyle", delta.fontStyle, FONT_STYLE)
    : baseStyle.fontStyle;
  if (delta.fontFamily != null || delta.fontWeight != null || delta.fontStyle != null) {
    style.fontFamily = delta.fontFamily != null ? delta.fontFamily : baseStyle.fontFamily;
    style.fontWeight = delta.fontWeight != null ? delta.fontWeight : baseStyle.fontWeight;
    if (italic != null) style.fontStyle = italic;
  }
  if (delta.fontSize != null) style.fontSize = delta.fontSize;
  if (delta.lineHeight != null) style.lineHeight = lineHeight(delta.lineHeight);
  if (delta.letterSpacing != null) style.letterSpacing = letterSpacing(delta.letterSpacing);
  if (delta.textDecoration != null) style.textDecoration = assertEnum("run textDecoration", delta.textDecoration, TEXT_DECORATION);
  if (Object.keys(style).length) out.style = style;
  if (delta.color != null) out.fills = [parseFill(delta.color, "color")];
  if (delta.hyperlink != null) out.hyperlink = assertHyperlink(delta.hyperlink);
  return out;
}

function assertHyperlink(url: unknown): string {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("flcm.text: hyperlink must be a non-empty URL string — got " + JSON.stringify(url) + ".");
  }
  return url;
}

function shape(type: "RECTANGLE" | "ELLIPSE", props: ShapeProps = {}): WriteNode {
  props = props || {};
  const wn: WriteNode = { type };
  appearance(wn, props, { radius: type === "RECTANGLE" });
  const layout = buildLayout(props as FrameProps, false);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

function rect(props?: ShapeProps): WriteNode { return shape("RECTANGLE", props); }
function ellipse(props?: ShapeProps): WriteNode { return shape("ELLIPSE", props); }

function line(props: LineProps = {}): WriteNode {
  props = props || {};
  const wn: WriteNode = { type: "LINE" };
  base(wn, props);
  const paint = props.stroke != null ? props.stroke : props.color;
  if (paint != null) wn.strokes = [parseFill(paint, "stroke")];
  if (props.strokeWidth != null) wn.strokeWeight = length(props.strokeWidth);
  const len = props.length != null ? props.length : props.w;
  const layout: WriteLayout = {};
  if (typeof len === "number") layout.dimensions = { width: len };
  applyAbsolute(layout, props);
  applyPin(layout, props);
  if (Object.keys(layout).length) wn.layout = layout;
  if (typeof props.rotation === "number") wn.rotation = props.rotation;
  return wn;
}

// ---- Vector verbs. Two contracts, deliberately not interchangeable (see ir.ts WriteNode.svg/pathData):
// svg pastes opaque markup (colors baked in); path is a single themeable vector taking our appearance props.

// flcm.svg(markup) -> a VECTOR node carrying raw markup (createNodeFromSvg at render, which yields a frame).
// Colors live in the markup, so fill/stroke DON'T apply — accepting them silently would be the exact no-op
// ADR-0003 forbids, so reject them loud. The markup must look like an <svg> document (catches a URL/path
// passed by mistake); the render-time parse (bridge) is the second, authoritative fail-loud.
function svg(markup: unknown, props: SvgProps = {}): WriteNode {
  props = props || {};
  if (typeof markup !== "string" || !/<svg[\s>]/i.test(markup)) {
    throw new Error("flcm.svg: expected SVG markup containing an <svg> element — got " + JSON.stringify(markup) + ". For a themeable single-path vector use flcm.path({ d }) instead.");
  }
  const p = props as AppearanceProps;
  if (p.fill != null || p.stroke != null) {
    throw new Error("flcm.svg: colors are baked into the SVG markup — fill/stroke don't apply. Edit the markup's own colors, or use flcm.path({ d, fill }) for a themeable vector.");
  }
  const wn: WriteNode = { type: "VECTOR", svg: markup };
  base(wn, props);
  const layout = buildLayout(props as FrameProps, false);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// flcm.path({ d, ... }) -> a VECTOR node carrying the path data (createVector + vectorPaths at render). Takes
// the shared appearance props via appearance() (radius off — a vector has none), so it themes like a rect.
// `d` is required and must be a non-empty string; bad path data fails loud again at render (bridge).
function path(props: PathProps): WriteNode {
  if (!props || typeof props !== "object") {
    throw new Error("flcm.path: expected a props object with a `d` path string, e.g. flcm.path({ d: \"M12 2 L22 20 L2 20 Z\", fill: \"#111\" }) — got " + JSON.stringify(props) + ".");
  }
  const d = props.d;
  if (typeof d !== "string" || !d.trim()) {
    throw new Error("flcm.path: `d` (SVG path data) must be a non-empty string — got " + JSON.stringify(d) + ".");
  }
  const wn: WriteNode = { type: "VECTOR", pathData: d };
  appearance(wn, props, {}); // fill/stroke/strokeWidth/effects/rotation + base; radius/clip off for a vector
  const layout = buildLayout(props as FrameProps, false);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// ---- gradient() sugar: structured spec -> typed PaintSpec (no string round-trip). The transform math
// lives in paint.ts, shared with css.ts's gradient-string parser, so sugar and hand-written CSS agree.
// GradientSugar / GradientStopInput are defined in schema.ts (the authoring-surface source). ----

function gradient(a: GradientSugar | "linear" | "radial", b?: GradientStopInput[], c?: number): PaintSpec {
  const spec: GradientSugar = a && typeof a === "object" ? a : { type: a, stops: b, angle: c };
  const stops = gradientStops(spec.stops);
  const type = spec.type || "linear";
  if (type === "linear") return linearGradient(typeof spec.angle === "number" ? spec.angle : 180, stops);
  if (type === "radial") {
    const x = spec.at && spec.at.x != null ? spec.at.x : 50;
    const y = spec.at && spec.at.y != null ? spec.at.y : 50;
    return radialGradient("GRADIENT_RADIAL", x, y, stops);
  }
  throw new Error('flcm.gradient: type must be "linear" or "radial" — got ' + JSON.stringify(spec.type) + ".");
}

// stops: ['#000','#fff'] | [{ color, pos }] -> typed stops, even spread when pos is omitted.
function gradientStops(stops: GradientStopInput[] | undefined): GradientStop[] {
  if (!Array.isArray(stops) || !stops.length) {
    throw new Error('flcm.gradient: needs a non-empty stops array, e.g. ["#000","#fff"].');
  }
  const n = stops.length;
  return stops.map((st, i) => {
    const raw = typeof st === "string" ? { color: st } : st;
    return { position: stopPercent(raw, i, n) / 100, color: parseColor(raw.color) };
  });
}

// A stop's percent position: explicit `pos`/`position`, else an even spread across the run.
function stopPercent(raw: { pos?: number; position?: number }, i: number, n: number): number {
  if (typeof raw.pos === "number") return raw.pos;
  if (typeof raw.position === "number") return raw.position;
  return n > 1 ? (i / (n - 1)) * 100 : 0;
}

// ---- image() paint constructor: a url + intent -> an inert image PaintSpec (a fill value, like
// flcm.gradient). The sandbox NEVER fetches — the spec carries only the source; the trusted server fetches
// + validates the bytes and the bridge resolves them to a plugin ImagePaint at render (keyed by url).
// `placeholder` marks a stand-in so a later read can tell it from a real asset (bridge persists it on the
// node). Fails loud on a non-string/empty url or a scaleMode outside the set — never a silent blank fill.

const IMAGE_SCALE_MODES = new Set(["FILL", "FIT", "CROP", "TILE"]);

function image(url: unknown, opts: ImageOpts = {}): PaintSpec {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("flcm.image: expected an image url string, e.g. flcm.image(\"https://example.com/photo.jpg\") — got " + JSON.stringify(url) + ".");
  }
  opts = opts || {};
  const scaleMode = opts.scaleMode != null ? opts.scaleMode : "FILL";
  if (!IMAGE_SCALE_MODES.has(scaleMode)) {
    throw new Error('flcm.image: scaleMode must be one of "FILL", "FIT", "CROP", "TILE" — got ' + JSON.stringify(scaleMode) + ".");
  }
  return { kind: "image", url: url.trim(), scaleMode, placeholder: opts.placeholder === true };
}

// ---- effects() sugar: { shadow, blur, backgroundBlur } -> typed EffectSpec[] (no string round-trip).
// Values are CSS px; the blur ×2 factor lives in the *FromCssPx constructors (effects.ts). EffectsSugar /
// ShadowSugar / BlurSugar are defined in schema.ts (the authoring-surface source). ----

function effects(spec: EffectsSugar): EffectSpec[] {
  if (!spec || typeof spec !== "object") {
    throw new Error("flcm.effects: expected { shadow?, blur?, backgroundBlur?, glass?, noise?, texture?, progressiveBlur? } — got " + JSON.stringify(spec) + ".");
  }
  const out: EffectSpec[] = [];
  if (spec.shadow !== undefined) out.push(...sugarShadows(spec.shadow));
  if (spec.blur !== undefined) out.push(layerBlurFromCssPx(blurRadius(spec.blur)));
  if (spec.backgroundBlur !== undefined) out.push(backgroundBlurFromCssPx(blurRadius(spec.backgroundBlur)));
  if (spec.glass !== undefined) out.push(sugarGlass(spec.glass));
  if (spec.noise !== undefined) out.push(sugarNoise(spec.noise));
  if (spec.texture !== undefined) out.push(sugarTexture(spec.texture));
  if (spec.progressiveBlur !== undefined) out.push(sugarProgressiveBlur(spec.progressiveBlur));
  return out;
}

// ---- Beyond-CSS effect sugar: friendly bag -> typed spec, defaults filled here (the sugar layer owns
// defaults + color parsing, mirroring sugarShadows). `true` gives a usable effect with all defaults.
// Values are raw Figma-domain (no CSS-px scaling) — see ir.ts.

function sugarGlass(g: GlassSugar): EffectSpec {
  const s = g === true ? {} : g;
  return glass({
    lightIntensity: s.lightIntensity != null ? s.lightIntensity : 0.5,
    lightAngle: s.lightAngle != null ? s.lightAngle : 130,
    refraction: s.refraction != null ? s.refraction : 0.25,
    depth: s.depth != null ? s.depth : 12,
    dispersion: s.dispersion != null ? s.dispersion : 0.08,
    radius: s.radius != null ? s.radius : 4,
  });
}

function sugarNoise(n: NoiseSugar): EffectSpec {
  const s = n === true ? {} : n;
  const type = s.type || "monotone";
  return noise({
    noiseType: type,
    color: parseColor(s.color || "rgba(0,0,0,0.4)"),
    noiseSize: s.noiseSize != null ? s.noiseSize : 1,
    density: s.density != null ? s.density : 0.2,
    secondaryColor: s.secondaryColor != null ? parseColor(s.secondaryColor) : type === "duotone" ? parseColor("rgba(255,255,255,0.4)") : undefined,
    opacity: s.opacity != null ? s.opacity : type === "multitone" ? 0.5 : undefined,
  });
}

function sugarTexture(t: TextureSugar): EffectSpec {
  const s = t === true ? {} : t;
  return texture({
    noiseSize: s.noiseSize != null ? s.noiseSize : 3,
    radius: s.radius != null ? s.radius : 6,
    clipToShape: s.clipToShape != null ? s.clipToShape : true,
  });
}

function sugarProgressiveBlur(b: ProgressiveBlurSugar): EffectSpec {
  const s = typeof b === "number" ? { endRadius: b } : b;
  return progressiveBlur({
    startRadius: s.startRadius != null ? s.startRadius : 0,
    radius: s.endRadius != null ? s.endRadius : 20,
    startOffset: s.startOffset || { x: 0, y: 0 },
    endOffset: s.endOffset || { x: 0, y: 1 },
  });
}

function sugarShadows(input: ShadowSugar | ShadowSugar[]): EffectSpec[] {
  const list = Array.isArray(input) ? input : [input];
  return list.map((raw) => {
    const s = raw === true || raw == null ? {} : raw;
    return shadow({
      inner: !!s.inner,
      color: parseColor(s.color || "rgba(0,0,0,0.25)"),
      x: s.x || 0,
      y: s.y != null ? s.y : 4,
      radius: s.blur != null ? s.blur : 8, // CSS box-shadow blur, 1:1 with the Figma radius
      spread: s.spread || 0,
    });
  });
}

// A blur radius (CSS px) from a number or a { layer | background | radius } object.
function blurRadius(b: BlurSugar): number {
  if (typeof b === "number") return b;
  if (b.layer != null) return b.layer;
  if (b.background != null) return b.background;
  return b.radius || 0;
}

// Accept the sugar spec ({ shadow, blur, backgroundBlur }), an already-typed EffectSpec[] (what
// flcm.effects returns), or a hand-written CSS WriteEffects bag — all converge on EffectSpec[].
function normalizeEffects(v: EffectsInput): EffectSpec[] {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object") throw new Error("flcm: effects must be an object — got " + JSON.stringify(v) + ".");
  const isCss = (["boxShadow", "filter", "backdropFilter", "textShadow"] as const).some((f) => f in v);
  return isCss ? parseCssEffects(v as WriteCssEffects) : effects(v as EffectsSugar);
}

// The server injects the raster bytes for image fills on this global between the two render passes (a
// Record keyed by url → base64). It's the ONE channel that reaches into the preamble: the preamble is its
// own IIFE closure, so a var declared in the agent-code scope wouldn't be visible here. Declared because
// the sandbox's ES2017 lib predates the globalThis TYPE; the `typeof` guard makes the READ safe even in an
// engine where the identifier is truly absent (typeof never throws on an undeclared name). Absent on the
// first pass (and whenever no image fills are used); a Record on the re-run.
declare const globalThis: { __flcmImageBytes?: Record<string, string> } | undefined;

function injectedImageBytes(): Record<string, string> {
  const g = typeof globalThis !== "undefined" ? globalThis : undefined;
  const bag = g && g.__flcmImageBytes;
  return bag && typeof bag === "object" ? bag : {};
}

// Gather every image url in the tree — from EVERY paint-bearing location the bridge later resolves through
// paintOf (node fills/strokes AND per-run fills), so render() can check which still need server-fetched
// bytes before it creates a single node. This must stay in lockstep with paintOf's coverage: a paint site
// paintOf resolves but this misses would fetch nothing, then hit the "no bytes" throw at render.
function collectImageUrls(tree: WriteNode): string[] {
  const urls: string[] = [];
  const addFrom = (paints: readonly PaintSpec[] | undefined): void => {
    if (paints) for (const spec of paints) if (spec && spec.kind === "image") urls.push(spec.url);
  };
  const visit = (wn: WriteChild): void => {
    if (!wn || typeof wn !== "object") return;
    addFrom(wn.fills);
    addFrom(wn.strokes);
    if (wn.runs) for (const run of wn.runs) addFrom(run.fills);
    if (wn.children) for (const child of wn.children) visit(child);
  };
  visit(tree);
  return urls;
}

// render(tree) — the one place nodes are created. Loads fonts, walks the WriteNode tree, stamps each
// `key` into pluginData('flcm/key'), and returns the root handle plus a map of every keyed node. Only
// keyed nodes appear in `keyed`; a duplicate key within one render is a loud error (in bridge).
async function render(tree: WriteNode): Promise<{ root: Handle; keyed: Record<string, Handle> }> {
  if (!tree || typeof tree !== "object" || typeof tree.type !== "string") {
    throw new Error("flcm.render: expected a node from flcm.frame()/text()/rect()/ellipse()/line() (or a raw WriteNode), got " + JSON.stringify(tree) + ".");
  }
  // The root has no parent to resolve a percent against, so reject it up front — before the image round-trip
  // below (this check needs no bytes), and before buildNode, which only guards a percent on a *child*. A
  // percent w/h/x/y belongs on a child, against its parent.
  if (tree.layout && (tree.layout.percentSize || tree.layout.percentPos)) {
    throw new Error("flcm: a percent w/h/x/y on the root node has no parent to resolve against — the root node sizes in px. Put the percent on a child, against its parent.");
  }
  // Two-pass image path: collect every image url and, if the server hasn't injected its bytes yet, signal
  // "images needed" BEFORE creating any node (flcm builds an inert tree then renders, so nothing has run
  // yet — the re-run can't double any side effect). The executor turns this throw into an imagesNeeded
  // reply; the server fetches+validates and re-runs this same code with bytes injected, and this pass then
  // finds them present. Dedupe so the server never fetches one url twice.
  const images = injectedImageBytes();
  const missing = collectImageUrls(tree).filter((url) => !(url in images));
  if (missing.length) {
    const err: Error & { __flcmImagesNeeded?: string[] } = new Error("flcm.render: image bytes not fetched yet — the server supplies them and re-runs this code.");
    err.__flcmImagesNeeded = Array.from(new Set(missing));
    throw err;
  }
  const fonts = await loadFontsForTree(tree);
  const ctx: RenderCtx = { keyed: {}, fonts, images, pending: [] };
  // Build the tree (percent children land at a provisional size), then fold every percent/anchor into
  // pixels against each parent's now-realized size in one post-walk pass (bridge.resolvePercents).
  const root = buildNode(tree, ctx);
  resolvePercents(ctx);
  const rootHandle = handle(root, tree.key);
  // Geometry settles only after the whole tree is laid out — read it back into every handle now (see
  // bridge.readBackGeometry). Walk-time boundingBox on these handles is provisional until this runs.
  readBackGeometry(rootHandle, ctx.keyed);
  return { root: rootHandle, keyed: ctx.keyed };
}

// Tier-1 drift guard: assert the real constructors match the typed public surface (Flcm) that schema.ts
// exports and the reference/example generators author against. If a verb's signature here diverges from
// Flcm, plugin typecheck fails — so the docs can't describe a shape the code doesn't have. `satisfies`
// checks without widening and the local is DCE'd from the bundle (pure init, unreferenced).
const _flcmShape = { frame, text, rect, ellipse, line, svg, path, gradient, image, effects, render } satisfies Flcm;
void _flcmShape;

// Exported individually so the IIFE bundle's `globalName: flcm` collects them into the public
// `flcm.frame` / `flcm.render` / … surface. runtime.ts (the bundle entry) re-exports exactly this set;
// nothing else in the preamble is re-exported, so every other helper stays closure-private.
export { frame, text, rect, ellipse, line, svg, path, render, gradient, image, effects };
