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
  WriteNode, WriteProps, WriteChild, WriteLayout, WriteTextStyle, WriteTextRun, PaintSpec,
  GradientStop, EffectSpec, Sizing, Edges, Handle, WriteCssEffects, PinX, PinY, AnchorX, AnchorY,
  Justify, Align, TextAlign, TextDecoration, RawIdRef,
} from "./ir.js";
import { loadFontsForTree } from "./fonts.js";
import { parseInlineMarkdown, MdSegment } from "./markdown.js";
import { linearGradient, radialGradient } from "./paint.js";
import { layerBlurFromCssPx, backgroundBlurFromCssPx, shadow, glass, noise, texture, progressiveBlur } from "./effects.js";
import { parseColor, parseFill, parseCssEffects, parseBlendMode, length, lineHeight, letterSpacing, isPercent, percent } from "./css.js";
import { buildNode, settleHandles, resolvePercents, RenderCtx } from "./bridge.js";
import { enterMutatingVerb } from "./mutation-lock.js";
import { get, find, findOne, selection } from "./read.js";
import { rejectUnknownKeys } from "./validate.js";

// The authoring surface (verb Props + gradient/effects sugar) is defined ONCE in schema.ts as zod schemas
// with per-field docs; these are the z.infer'd types. Imported `import type` ONLY so schema.ts's zod is
// erased by esbuild and never reaches the sandbox bundle. Change a prop by editing the schema, not here.
import type {
  BaseProps, SizeProps, AppearanceProps, FrameProps, TextProps, TextRunInput, StyleDeltaInput,
  ShapeProps, LineProps, PathProps, SvgProps, ImageOpts,
  PadInput, EffectsInput, GradientSugar, GradientStopInput, EffectsSugar, ShadowSugar, BlurSugar,
  GlassSugar, NoiseSugar, TextureSugar, ProgressiveBlurSugar,
} from "./schema.js";

// ---- Unknown-prop rejection (ratified decision 1: fail loud, surface-wide, at construction) ----
//
// The write path used to silently drop any authoring prop it didn't read from a positive list — a typo'd
// `textTransform` on a run, a stray `background` on a frame, just vanished, and the agent got a node that
// quietly ignored what it asked for. That ends here: every constructor and every nested authoring object
// rejects unknown keys at construction — BEFORE render/edit touches the canvas — so the whole call fails
// atomically (nothing partial lands) and the agent can `catch` the error and fix the typo.
//
// The known-key sets live HERE, not sourced from schema.ts's zod: that zod must never enter the QuickJS
// bundle (the purity gate). They mirror schema.ts's FIELD_GROUPS exactly — a tier-2 drift test
// (unknown-props.test.ts) asserts each group == Object.keys of its schema group, so a prop added to (or
// dropped from) the schema can't drift out of sync here. The reject itself is the shared closed-set gate in
// validate.ts, the same one read.ts's locate query fails loud with.
export const KNOWN_KEYS = {
  shared: ["name", "key", "opacity", "mixBlendMode", "visible", "locked"],
  edit: ["name", "opacity", "mixBlendMode", "visible", "locked", "fill", "stroke", "strokeWidth", "borderRadius", "effects", "rotation", "clip", "width", "height", "absolute", "pin", "layout", "length", "w"],
  size: ["width", "height", "absolute", "pin"],
  appearance: ["fill", "stroke", "strokeWidth", "borderRadius", "effects", "rotation"],
  frame: ["layout", "clip"],
  layout: ["mode", "gap", "padding", "justifyContent", "alignItems"],
  text: ["textStyle", "color"],
  textStyle: ["fontFamily", "fontWeight", "fontSize", "fontStyle", "lineHeight", "letterSpacing", "textDecoration", "textAlign", "lineClamp"],
  run: ["fontWeight", "fontSize", "fontFamily", "fontStyle", "lineHeight", "letterSpacing", "textDecoration", "color", "hyperlink"],
  line: ["stroke", "color", "strokeWidth", "length", "w", "rotation", "absolute", "pin"],
  path: ["d", "fill", "stroke", "strokeWidth", "effects", "rotation"],
  image: ["scaleMode", "placeholder"],
  gradient: ["type", "stops", "angle", "at"],
  effects: ["shadow", "blur", "backgroundBlur", "glass", "noise", "texture", "progressiveBlur"],
} as const;

function keySet(...groups: readonly (readonly string[])[]): ReadonlySet<string> {
  return new Set(groups.flat());
}

// Per-verb known-key sets, COMPOSED from the guarded group atoms above (so a verb set can't drift once the
// groups are). Each mirrors the verb's composed schema — FrameSchema = shared+size+appearance+frame, etc.
const FRAME_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.appearance, KNOWN_KEYS.frame);
const TEXT_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.text);
const SHAPE_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.appearance);
const LINE_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.line);
const PATH_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.path);
const SVG_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size);
const LAYOUT_KEYS = keySet(KNOWN_KEYS.layout);
const TEXTSTYLE_KEYS = keySet(KNOWN_KEYS.textStyle);
const RUN_KEYS = keySet(KNOWN_KEYS.run);
const IMAGE_KEYS = keySet(KNOWN_KEYS.image);
const GRADIENT_KEYS = keySet(KNOWN_KEYS.gradient);
const EFFECTS_KEYS = keySet(KNOWN_KEYS.effects);
// The CSS-effects bag (WriteCssEffects) — the string form of `effects`, routed to parseCssEffects. Its keys
// are an ir.ts interface, not a schema FIELD_GROUP, so no runtime drift test reaches them; but they're the
// frozen CSS spellings, and this ONE list drives both the is-this-CSS detection and the reject (normalizeEffects).
const CSS_EFFECTS_KEYS = keySet(["boxShadow", "filter", "backdropFilter", "textShadow"]);
// The directional nested shapes are defined INLINE in schema.ts's SIZE_FIELDS (not their own FIELD_GROUP).
// The drift test still guards them by unwrapping the zod objects directly — ABSOLUTE_KEYS against the
// `absolute` shape, DIRECTIONAL_KEYS against the `anchor` shape. `pin` reuses DIRECTIONAL_KEYS: it's a
// z.custom with no zod shape of its own, but its keys ARE anchor's, so the anchor guard covers it too.
export const ABSOLUTE_KEYS = keySet(["x", "y", "anchor"]);
export const DIRECTIONAL_KEYS = keySet(["x", "y"]); // pin and absolute.anchor

// The closed-set reject (rejectUnknownKeys) lives in validate.ts — one gate shared with read.ts's locate
// query. Every constructor + nested object below passes its verb name / path as the `subject`.

// ---- shared prop -> WriteNode compilers ----

// terse pad (number | {x,y} | {top,right,bottom,left}) -> typed edges. pad takes NUMBERS, not "px"
// strings: a string like "24px" is neither a number nor an edge object, and the old code silently
// dropped it to zero padding on every side. Reject a non-number/non-object, and a non-numeric edge
// field, rather than emit a silent zero (ADR-0003 fail-loud).
const PAD_KEYS = keySet(["x", "y", "top", "right", "bottom", "left"]);

function padEdges(pad: PadInput): Edges {
  if (typeof pad === "number") return { top: pad, right: pad, bottom: pad, left: pad };
  if (pad == null || typeof pad !== "object" || Array.isArray(pad)) {
    throw new Error("flcm: pad must be a number or an object ({ x, y } or { top, right, bottom, left }) — got " + JSON.stringify(pad) + '. pad takes numbers, not "px" strings.');
  }
  rejectUnknownKeys(pad, PAD_KEYS, "pad");
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
  if (props.absolute == null) return;
  // absolute:"none" is edit's return-to-flow word — no x/y ride it (a node rejoining the flow is
  // positioned by the layout, not by coordinates).
  if (props.absolute === "none") {
    layout.position = "none";
    return;
  }
  // QuickJS boundary: a present-but-malformed value (false, a number, an array) must reject the
  // whole call, not read as absence and let the rest of the props land as a partial write.
  if (typeof props.absolute !== "object" || Array.isArray(props.absolute)) {
    throw new Error('flcm: absolute must be an object like { x, y, anchor } or "none" — got ' + JSON.stringify(props.absolute) + ".");
  }
  rejectUnknownKeys(props.absolute, ABSOLUTE_KEYS, "absolute");
  layout.position = "absolute";
  // A percent x/y resolves to px against the parent axis at render (percentPos); a number is the
  // location directly. Presence-preserving per axis: an unnamed axis compiles to NOTHING — a fresh
  // node sits at Figma's own 0, and an edit naming only `absolute: { x }` must not teleport the y
  // it didn't speak (the bridge falls back to the live coordinate where it needs one).
  const pct: { x?: number; y?: number } = {};
  const axis = (val: number | string | undefined, key: "x" | "y") => {
    if (val == null) return;
    if (typeof val === "number") layout[key === "x" ? "left" : "top"] = val;
    else if (isPercent(val)) pct[key] = percent(val);
    else throw new Error("flcm: absolute." + key + ' must be a number or "N%" — got ' + JSON.stringify(val) + ".");
  };
  axis(props.absolute.x, "x");
  axis(props.absolute.y, "y");
  if (pct.x != null || pct.y != null) layout.percentPos = pct;
  applyAnchor(layout, props.absolute.anchor);
  // An anchor axis without its coordinate has nothing to land on. Rejected rather than anchored
  // against the live coordinate: subtracting the anchor offset from wherever the node sits would
  // move it again on every re-apply — the relative-delta drift the absolute-values contract forbids.
  const a = layout.anchor;
  if (a) {
    if (a.x != null && layout.left == null && pct.x == null) {
      throw new Error("flcm: absolute.anchor.x names which point of the node lands on x — name absolute.x alongside it.");
    }
    if (a.y != null && layout.top == null && pct.y == null) {
      throw new Error("flcm: absolute.anchor.y names which point of the node lands on y — name absolute.y alongside it.");
    }
  }
}

// pin and anchor are the two directional `{ x?, y? }` props: same shape, different vocabularies. Both
// validate each axis at the boundary (a bad value fails loud, ADR-0003) so the bridge can trust the words —
// pin's map to Figma's constraint enum, anchor's to an offset. anchor's words are a subset of pin's (no
// stretch/scale: an anchor is a point, not a resize rule).
const PIN_X = new Set<PinX>(["left", "center", "right", "stretch", "scale", "none"]);
const PIN_Y = new Set<PinY>(["top", "center", "bottom", "stretch", "scale", "none"]);
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
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("flcm: " + name + " must be an object like { x, y } — got " + JSON.stringify(raw) + ".");
  }
  const r = raw as { x?: string; y?: string };
  rejectUnknownKeys(r, DIRECTIONAL_KEYS, name);
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
  // `pin: "none"` is shorthand for clearing both axes; per-axis "none" rides parseDirectional.
  const raw = props.pin === "none" ? { x: "none", y: "none" } : props.pin;
  const pin = parseDirectional("pin", raw, PIN_X, PIN_Y);
  if (pin) layout.pin = pin;
}

// Compile the container words (`layout: { mode, gap, padding, justifyContent, alignItems }`) into a
// WriteLayout — presence-preserving: a word the author didn't write compiles to nothing. The
// creation default (an omitted mode means free-form) is buildLayout's to inject, NOT this
// function's: edit compiles through here directly, and a defaulted mode would turn a gap nudge
// into an auto-layout kill. Exported for edit.ts.
export function compileContainerWords(cfg: NonNullable<FrameProps["layout"]>, subject: string): WriteLayout {
  // QuickJS boundary: a present-but-malformed value (false, a number, an array) must reject the
  // whole call — Object.keys on it would read as "no words named" and the rest would partially apply.
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
    throw new Error("flcm: " + subject + " must be an object like { mode, gap, padding, justifyContent, alignItems } — got " + JSON.stringify(cfg) + ".");
  }
  rejectUnknownKeys(cfg, LAYOUT_KEYS, subject);
  const layout: WriteLayout = {};
  if (cfg.mode != null) layout.mode = assertEnum("layout.mode", cfg.mode, LAYOUT_MODE);
  if (cfg.gap != null) layout.gap = length(cfg.gap);
  if (cfg.padding != null) layout.padding = padEdges(cfg.padding);
  // The space-around/evenly hint is primary-axis-only (a justify-content notion), so only justifyContent carries it.
  if (cfg.justifyContent != null) layout.justifyContent = mapLayoutWord("layout.justifyContent", cfg.justifyContent, JUSTIFY_CONTENT, " Figma auto-layout can't realize CSS space-around/space-evenly; add gap/padding for spacing instead.");
  if (cfg.alignItems != null) layout.alignItems = mapLayoutWord("layout.alignItems", cfg.alignItems, ALIGN_ITEMS);
  return layout;
}

// Compile the child-side size/position words (width/height, absolute, pin) into a WriteLayout —
// the same trio every constructor rides. Presence-preserving like the container compile; the
// return is undefined when no word was written, so callers can gate on "was any layout named".
// Exported for edit.ts.
export function compileSizeWords(props: SizeProps): WriteLayout | undefined {
  const layout: WriteLayout = {};
  applySizing(props, layout);
  applyAbsolute(layout, props);
  applyPin(layout, props);
  return Object.keys(layout).length ? layout : undefined;
}

// A LINE sizes on one word — `length`, alias `w` — compiled here so flcm.line and an edit delta
// reject a mistyped value with the SAME error, naming the prop the author actually wrote.
export function compileLineLength(props: Pick<LineProps, "length" | "w">): WriteLayout | undefined {
  const prop = props.length != null ? "length" : props.w != null ? "w" : null;
  if (!prop) return undefined;
  const len = props[prop];
  assertScalarType(len, "number", prop);
  // A length is a FIXED width, and the sizing intent must say so: clearChildFlowFill keys the
  // un-fill off sizing "fixed", so a length edit on a live line someone set to grow (layoutGrow 1
  // — authorable in the Figma UI, not in flcm) actually takes over from the fill.
  return { sizing: { horizontal: "fixed" }, dimensions: { width: len as number } };
}

function buildLayout(props: FrameProps, isFrame: boolean): WriteLayout {
  const layout: WriteLayout = {};
  if (isFrame) {
    // ?? not ||: a falsy-but-present layout (false, 0) must reach the compile's malformed-value reject.
    Object.assign(layout, compileContainerWords(props.layout ?? {}, "flcm.frame.layout"));
    if (layout.mode == null) layout.mode = "none"; // the creation default: an omitted mode is free-form
  }
  // The size/position words ride the same compile edit does — the container words above and the
  // creation default are the only create-side extras.
  Object.assign(layout, compileSizeWords(props) || {});
  return layout;
}

// The QuickJS boundary has no type checking, so a present-but-mistyped scalar must reject LOUD —
// a bare typeof guard would silently drop it, committing the rest of the props as a partial write
// (the ADR-0003 silent no-op, and for edit a broken whole-delta validation). null/undefined still
// mean "absent": presence-preserving stays intact.
function assertScalarType(value: unknown, want: "string" | "number" | "boolean", prop: string): void {
  if (typeof value !== want) {
    throw new Error("flcm: `" + prop + "` must be a " + want + " — got " + JSON.stringify(value) + ".");
  }
}

// The shared-by-every-node props. Additive: only present props land on the WriteNode.
function base(wn: WriteProps, props: BaseProps): void {
  if (props.name != null) { assertScalarType(props.name, "string", "name"); wn.name = props.name; }
  if (props.key != null) { assertScalarType(props.key, "string", "key"); wn.key = props.key; }
  if (props.opacity != null) { assertScalarType(props.opacity, "number", "opacity"); wn.opacity = props.opacity; }
  if (props.mixBlendMode != null) wn.blendMode = parseBlendMode(props.mixBlendMode);
  if (props.visible != null) { assertScalarType(props.visible, "boolean", "visible"); wn.visible = props.visible; }
  if (props.locked != null) { assertScalarType(props.locked, "boolean", "locked"); wn.locked = props.locked; }
}

// Appearance props shared by frame/rect/ellipse (and edit's delta compile), on top of base(). Every
// CSS-shaped leaf is normalized to the typed currency through css.ts here — presence-preserving by
// construction, so it doubles as the edit patch compiler's core: only present keys produce writes.
// Exported for edit.ts (which imports FROM here; flcm.ts never imports edit.ts — no cycle).
export function compileNodeLocalProps(wn: WriteProps, props: AppearanceProps, opts: { radius?: boolean; clip?: boolean }): void {
  base(wn, props);
  // "none" is the removal word (CSS's own absence spelling): an EMPTY array is the compiled form of
  // "clear this" — distinct from an ABSENT array, which means "don't touch it". Create writing []
  // onto a fresh node is a harmless no-op; the distinction exists for edit.
  if (props.fill != null) wn.fills = props.fill === "none" ? [] : [parseFill(props.fill, "fill")];
  if (props.stroke != null) wn.strokes = props.stroke === "none" ? [] : [parseFill(props.stroke, "stroke")];
  if (props.strokeWidth != null) wn.strokeWeight = length(props.strokeWidth);
  if (props.effects != null) wn.effects = props.effects === "none" ? [] : normalizeEffects(props.effects);
  if (opts.radius && props.borderRadius != null) wn.borderRadius = length(props.borderRadius);
  const clip = (props as FrameProps).clip;
  if (opts.clip && clip != null) { assertScalarType(clip, "boolean", "clip"); wn.clip = clip; }
  if (props.rotation != null) { assertScalarType(props.rotation, "number", "rotation"); wn.rotation = props.rotation; }
}

function frame(props: FrameProps = {}, children?: WriteChild | WriteChild[]): WriteNode {
  props = props || {};
  rejectUnknownKeys(props, FRAME_KEYS, "flcm.frame");
  const wn: WriteNode = { type: "FRAME" };
  compileNodeLocalProps(wn, props, { radius: true, clip: true });
  wn.layout = buildLayout(props, true);
  wn.children = Array.isArray(children) ? children : children ? [children] : [];
  return wn;
}

function text(content: unknown, props: TextProps = {}): WriteNode {
  props = props || {};
  rejectUnknownKeys(props, TEXT_KEYS, "flcm.text");
  const wn: WriteNode = { type: "TEXT" };
  base(wn, props);
  // `color` is a top-level node-level sugar prop (compiles to the text node's fill), NOT part of textStyle —
  // base color lives in `fills` like every other node, and the grouped `textStyle` is the type base only.
  if (props.color != null) wn.fills = [parseFill(props.color, "color")];
  const cfg = props.textStyle || {};
  rejectUnknownKeys(cfg, TEXTSTYLE_KEYS, "flcm.text.textStyle");
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
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    let raw: string;
    let delta: StyleDeltaInput;
    if (typeof run === "string") { raw = run; delta = {}; }
    else if (Array.isArray(run) && typeof run[0] === "string") { raw = run[0]; delta = run[1] || {}; }
    else {
      throw new Error('flcm.text: each run is a plain string or a [text, style] tuple like ["bold bit", { fontWeight: 700 }] — got ' + JSON.stringify(run) + ".");
    }
    // The run delta is the grounded silent-drop site: compileRun reads a positive list and never looked at
    // the rest, so a typo'd `textTransform` on a run vanished. Reject it here, on the raw author delta.
    rejectUnknownKeys(delta, RUN_KEYS, `flcm.text run[${i}]`);
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
  rejectUnknownKeys(props, SHAPE_KEYS, type === "RECTANGLE" ? "flcm.rect" : "flcm.ellipse");
  const wn: WriteNode = { type };
  compileNodeLocalProps(wn, props, { radius: type === "RECTANGLE" });
  const layout = buildLayout(props as FrameProps, false);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

function rect(props?: ShapeProps): WriteNode { return shape("RECTANGLE", props); }
function ellipse(props?: ShapeProps): WriteNode { return shape("ELLIPSE", props); }

function line(props: LineProps = {}): WriteNode {
  props = props || {};
  rejectUnknownKeys(props, LINE_KEYS, "flcm.line");
  const wn: WriteNode = { type: "LINE" };
  base(wn, props);
  const paint = props.stroke != null ? props.stroke : props.color;
  // "none" is the surface-wide removal/explicit-default word — compile it to the present-but-empty
  // strokes array here too, or flcm.line({ stroke: "none" }) would throw where an edit's
  // stroke: "none" clears (the one-vocabulary invariant).
  if (paint === "none") wn.strokes = [];
  else if (paint != null) wn.strokes = [parseFill(paint, "stroke")];
  if (props.strokeWidth != null) wn.strokeWeight = length(props.strokeWidth);
  const layout: WriteLayout = { ...(compileLineLength(props) || {}) };
  applyAbsolute(layout, props);
  applyPin(layout, props);
  if (Object.keys(layout).length) wn.layout = layout;
  if (props.rotation != null) { assertScalarType(props.rotation, "number", "rotation"); wn.rotation = props.rotation; }
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
  // After the fill/stroke special-case (its tailored message beats a generic "unknown prop") — reject the rest.
  rejectUnknownKeys(props, SVG_KEYS, "flcm.svg");
  const wn: WriteNode = { type: "VECTOR", svg: markup };
  base(wn, props);
  const layout = buildLayout(props as FrameProps, false);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// flcm.path({ d, ... }) -> a VECTOR node carrying the path data (createVector + vectorPaths at render). Takes
// the shared appearance props via compileNodeLocalProps() (radius off — a vector has none), so it themes like a rect.
// `d` is required and must be a non-empty string; bad path data fails loud again at render (bridge).
function path(props: PathProps): WriteNode {
  if (!props || typeof props !== "object") {
    throw new Error("flcm.path: expected a props object with a `d` path string, e.g. flcm.path({ d: \"M12 2 L22 20 L2 20 Z\", fill: \"#111\" }) — got " + JSON.stringify(props) + ".");
  }
  const d = props.d;
  if (typeof d !== "string" || !d.trim()) {
    throw new Error("flcm.path: `d` (SVG path data) must be a non-empty string — got " + JSON.stringify(d) + ".");
  }
  rejectUnknownKeys(props, PATH_KEYS, "flcm.path");
  const wn: WriteNode = { type: "VECTOR", pathData: d };
  compileNodeLocalProps(wn, props, {}); // fill/stroke/strokeWidth/effects/rotation + base; radius/clip off for a vector
  const layout = buildLayout(props as FrameProps, false);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// ---- gradient() sugar: structured spec -> typed PaintSpec (no string round-trip). The transform math
// lives in paint.ts, shared with css.ts's gradient-string parser, so sugar and hand-written CSS agree.
// GradientSugar / GradientStopInput are defined in schema.ts (the authoring-surface source). ----

function gradient(a: GradientSugar | "linear" | "radial", b?: GradientStopInput[], c?: number): PaintSpec {
  // Only the object form carries author-supplied keys to check; the positional form builds a closed spec.
  if (a && typeof a === "object") rejectUnknownKeys(a, GRADIENT_KEYS, "flcm.gradient");
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

// ---- image() paint constructor: a source + intent -> an inert image PaintSpec (a fill value, like
// flcm.gradient). The source is an https url or a local file path (CSS url() takes both; the server
// confines paths to its asset root). The sandbox NEVER touches network or disk — the spec carries only the
// source string; the trusted server loads + validates the bytes and the bridge resolves them to a plugin
// ImagePaint at render (keyed by source). `placeholder` marks a stand-in so a later read can tell it from a
// real asset (bridge persists it on the node). Fails loud on a non-string/empty source or a scaleMode
// outside the set — never a silent blank fill.

const IMAGE_SCALE_MODES = new Set(["FILL", "FIT", "CROP", "TILE"]);

function image(url: unknown, opts: ImageOpts = {}): PaintSpec {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("flcm.image: expected an image url or local file path string, e.g. flcm.image(\"https://example.com/photo.jpg\") or flcm.image(\"assets/logo.png\") — got " + JSON.stringify(url) + ".");
  }
  opts = opts || {};
  rejectUnknownKeys(opts, IMAGE_KEYS, "flcm.image opts");
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
  rejectUnknownKeys(spec, EFFECTS_KEYS, "flcm.effects");
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
  // A bag carrying any CSS-effect key is the CSS form. Reject its unknown keys too — parseCssEffects reads a
  // positive list, so a typo'd key would otherwise silently vanish (the same closed-set policy as the sugar
  // bag, surface-wide). A bag with NO CSS key routes to the sugar path, whose own EFFECTS_KEYS reject fires.
  const isCss = [...CSS_EFFECTS_KEYS].some((f) => f in v);
  if (isCss) {
    rejectUnknownKeys(v, CSS_EFFECTS_KEYS, "effects (CSS bag)");
    return parseCssEffects(v as WriteCssEffects);
  }
  return effects(v as EffectsSugar);
}

// The host-installed mid-run image channel (protocol 2). executeCode (code.ts) passes this as the
// PARAMETER of the eval'd async wrapper this preamble runs inside, so the reference resolves as a
// function argument — no globalThis dependency in QuickJS, and immune to bundler renaming (both
// names live inside eval'd strings; build.mjs greps the bundle for the wrapper head to pin the
// pairing). The harness and preamble unit tests run via indirect eval / plain import (global
// scope) and install it on globalThis instead; both paths resolve the same free identifier, and
// `typeof` keeps the probe safe where it's truly absent.
declare const __flcmRequestImages:
  | ((urls: string[]) => Promise<Record<string, string>>)
  | undefined;

// Gather every image url in the tree — from EVERY paint-bearing location the bridge later resolves through
// paintOf (node fills/strokes AND per-run fills), so render() can check which still need server-fetched
// bytes before it creates a single node. This must stay in lockstep with paintOf's coverage: a paint site
// paintOf resolves but this misses would fetch nothing, then hit the "no bytes" throw at render.
function collectImageUrls(tree: WriteProps): string[] {
  const urls: string[] = [];
  const addFrom = (paints: readonly PaintSpec[] | undefined): void => {
    if (paints) for (const spec of paints) if (spec && spec.kind === "image") urls.push(spec.url);
  };
  const visit = (wn: WriteChild | WriteProps): void => {
    if (!wn || typeof wn !== "object") return;
    addFrom(wn.fills);
    addFrom(wn.strokes);
    if (wn.runs) for (const run of wn.runs) addFrom(run.fills);
    if (wn.children) for (const child of wn.children) visit(child);
  };
  visit(tree);
  return urls;
}

// Fetch bytes for every image paint in `tree` through the host channel (protocol 2), in ONE deduped
// awaitable request, BEFORE any canvas write — a fetch failure (blocked url, oversize, unreachable)
// aborts with zero mutations. The await is the run's suspension point (the sandbox suspends while the
// plugin relays the WS round-trip); a cancelled or disconnected run dies here when the host rejects
// its pending fetch. Shared by render (whole tree) and edit (a delta's fill/stroke) — the walk reads
// only paint sites, so WriteProps (no type discriminant) is the honest input.
export async function fetchTreeImages(tree: WriteProps): Promise<Record<string, string>> {
  const urls = Array.from(new Set(collectImageUrls(tree)));
  if (!urls.length) return {};
  if (typeof __flcmRequestImages !== "function") {
    throw new Error("flcm.image: this runtime has no image channel (__flcmRequestImages) — image fills need the live plugin bridge.");
  }
  return __flcmRequestImages(urls);
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
  const images = await fetchTreeImages(tree);
  const fonts = await loadFontsForTree(tree);
  // Only the MUTATING span enters the mutation lock (invariant 4): the image/font awaits above are
  // read-only and may overlap between concurrent renders, but node creation must serialize — and a
  // run the server cancelled is refused at the lock, before its first canvas write.
  return enterMutatingVerb("render", async () => {
    const ctx: RenderCtx = { keyed: {}, fonts, images, pending: [] };
    // Build the tree (percent children land at a provisional size), then fold every percent/anchor into
    // pixels against each parent's now-realized size in one post-walk pass (bridge.resolvePercents).
    const root = buildNode(tree, ctx);
    resolvePercents(ctx);
    // Handles are minted only now: geometry settles once the whole tree is laid out (bridge.settleHandles).
    return settleHandles(root, ctx.keyed);
  });
}

// flcm.id(id) — the target escape hatch. Wraps a raw node id so a target-taking verb (get/find/edit) treats
// it as a live-node id and never scans it as an flcm/key (the one string a bare target could be read either
// way). An inert POJO constructor like the others; the resolver (read.resolveTarget) unwraps it —
// production code unwraps `__flcmId` structurally, not via this function.
function id(nodeId: unknown): RawIdRef {
  if (typeof nodeId !== "string" || !nodeId.trim()) {
    throw new Error('flcm.id: expected a node id string, e.g. flcm.id("12:34") — got ' + JSON.stringify(nodeId) + ".");
  }
  return { __flcmId: nodeId };
}

// The verbs this module contributes to the public surface — runtime.ts (the bundle entry) re-exports
// these plus `edit` (which lives in edit.ts: it imports FROM this module, so defining it here would be
// a cycle) and holds the one exhaustive `satisfies Flcm` drift guard against the schema's typed
// surface. Nothing else in the preamble is re-exported, so every other helper stays closure-private.
// `get`/`find`/`findOne`/`selection` are defined in read.ts (the figma.*-speaking read walk) and surface
// here, the way render's live work lives in bridge.ts.
export { frame, text, rect, ellipse, line, svg, path, render, gradient, image, effects, get, find, findOne, selection, id };
