// flcm — the constructors. This is most of what the agent touches: a namespace of inert constructors
// that build POJO WriteNodes (the typed IR currency) and mutate nothing. render() — the one async call
// that walks a tree and creates live nodes — lives in render.ts, which imports FROM here: an instance
// spec resolves its component in render's prepare through the edit compile (instance.ts → edit-plan.ts
// → this module), and a constructor module that imported that chain would close a cycle.
//
// The constructors take the read shape's own props (width/height/left/top/layout/fill/...) and compile
// them into the typed WriteNode currency here. Author CSS-shaped leaves (a #hex color, a gradient string,
// a "32px" metric) are normalized ONCE through css.ts at construction — the bridge only ever sees the
// typed currency, never a string. The constructors are the ONLY way to make a renderable node:
// their output is provenance-tracked and deep-frozen (mintWriteNode/sealWriteNode below), and the
// bridge refuses anything else — hand-built IR could state combinations the compile forbids.
//
// Props types are precise so the bundle's own authors get checking, while the public entry points stay
// runtime-lenient (agent code runs in QuickJS, not tsc): a bad value still fails loud at the parsers
// (parseFill/length/sizing throw), it just isn't caught at compile time in the sandbox.
//
// Only the names exported from runtime.ts land on the `flcm` global; everything imported here stays
// closure-private in the IIFE bundle — which is why nothing in this preamble needs a name prefix.

import {
  WriteNode, WriteProps, WriteChild, WriteLayout, WriteTextStyle, WriteTextRun, PaintSpec,
  GradientStop, EffectSpec, Sizing, Edges, WriteCssEffects, PinX, PinY, AnchorX, AnchorY,
  Justify, Align, TextAlign, TextDecoration, WriteTextCase, RawIdRef, WriteType, Target,
  ComponentPropertyInput, OverrideDeltaInput, ComponentPropertyBinding, ComponentPropertyDefinitionEdit,
} from "./ir.js";
import { markConstructorBuilt, isConstructorBuilt } from "./provenance.js";
import { assertLayoutRealizableForType } from "./layout-legality.js";
import { parseInlineMarkdown, MdSegment } from "./markdown.js";
import { linearGradient, radialGradient } from "./paint.js";
import { layerBlurFromCssPx, backgroundBlurFromCssPx, shadow, glass, noise, texture, progressiveBlur } from "./effects.js";
import { parseColor, parseFill, parseCssEffects, parseBlendMode, boxShorthand, length, lineHeight, letterSpacing, isPercent, percent } from "./css.js";
import { requestHostImages } from "./host.js";
import { get, find, findOne, selection } from "./read.js";
import { rejectUnknownKeys, acceptAuthoringProps, rejectNonDeltaWords, own } from "./validate.js";
import type { SimplifiedNode } from "@framelink/core";

// The authoring surface (verb Props + gradient/effects sugar) is defined ONCE in schema.ts as zod schemas
// with per-field docs; these are the z.infer'd types. Imported `import type` ONLY so schema.ts's zod is
// erased by esbuild and never reaches the sandbox bundle. Change a prop by editing the schema, not here.
import type {
  BaseProps, SizeProps, AppearanceProps, FrameProps, TextProps, TextRunInput, StyleDeltaInput,
  ShapeProps, EllipseProps, LineProps, PathProps, SvgProps, ImageOpts, InstanceProps,
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
  edit: ["name", "opacity", "mixBlendMode", "visible", "locked", "fill", "stroke", "strokeWidth", "strokeAlign", "borderRadius", "effects", "rotation", "clip", "width", "height", "left", "top", "position", "anchor", "pin", "layout", "text", "textStyle", "boldWeight", "componentProperties", "overrides", "componentId", "componentPropertyReferences", "description", "propertyDefinitions"],
  size: ["width", "height", "left", "top", "position", "anchor", "pin"],
  placement: ["left", "top", "position", "anchor", "pin"],
  appearance: ["fill", "stroke", "strokeWidth", "strokeAlign", "borderRadius", "effects", "rotation"],
  ellipse: ["fill", "stroke", "strokeWidth", "strokeAlign", "effects", "rotation"],
  frame: ["layout", "clip"],
  layout: ["mode", "gap", "padding", "justifyContent", "alignItems"],
  text: ["text", "textStyle", "fill", "boldWeight"],
  textStyle: ["fontFamily", "fontWeight", "fontSize", "fontStyle", "lineHeight", "letterSpacing", "textDecoration", "textTransform", "fontVariant", "textAlign", "textAlignVertical", "paragraphSpacing", "paragraphIndent", "listSpacing", "hyperlink", "lineClamp"],
  run: ["fontWeight", "fontSize", "fontFamily", "fontStyle", "lineHeight", "letterSpacing", "textDecoration", "textTransform", "fontVariant", "paragraphSpacing", "paragraphIndent", "listSpacing", "color", "hyperlink"],
  line: ["stroke", "strokeWidth", "width", "rotation", "left", "top", "position", "anchor", "pin"],
  path: ["d", "fill", "stroke", "strokeWidth", "strokeAlign", "effects", "rotation"],
  instance: ["componentProperties", "overrides"],
  swap: ["componentId"],
  binding: ["componentPropertyReferences"],
  componentOptions: ["name", "description", "propertyDefinitions"],
  componentDefinition: ["description", "propertyDefinitions"],
  propertyDefinition: ["type", "defaultValue", "name"],
  variantEntry: ["component", "variant"],
  variantsOptions: ["name", "description"],
  image: ["scaleMode", "placeholder"],
  gradient: ["type", "stops", "angle", "at"],
  effects: ["shadow", "blur", "backgroundBlur", "glass", "noise", "texture", "progressiveBlur"],
} as const;

function keySet(...groups: readonly (readonly string[])[]): ReadonlySet<string> {
  return new Set(groups.flat());
}

// Per-verb known-key sets, COMPOSED from the guarded group atoms above (so a verb set can't drift once the
// groups are). Each mirrors the verb's composed schema — FrameSchema = shared+size+appearance+frame, etc.
// `binding` composes into EVERY node's set: any layer can be bound to a component property, and
// which FIELDS a given type may bind is the per-constructor list below (compileBindingBag), not the
// key set — the word itself is universal.
const FRAME_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.appearance, KNOWN_KEYS.frame, KNOWN_KEYS.binding);
const TEXT_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.text, KNOWN_KEYS.binding);
const SHAPE_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.appearance, KNOWN_KEYS.binding);
const ELLIPSE_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.ellipse, KNOWN_KEYS.binding);
const LINE_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.line, KNOWN_KEYS.binding);
const INSTANCE_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.appearance, KNOWN_KEYS.frame, KNOWN_KEYS.instance, KNOWN_KEYS.binding);
// The words an override delta may name — the edit vocabulary, since an override IS an edit of one
// sublayer, judged at construction the way edit's stage 1 judges a delta. MINUS the three component
// words: a path names a sublayer, and re-pointing a NESTED instance from here would need a second
// round of path resolution against a tree this call is still deciding. Refused by name below, with
// the reachable spelling (edit the nested instance by its live id).
//
// INSTANCE_COMPONENT_WORDS is also what edit's stage 2 splits off a delta as the instance half
// (edit-plan.ts) — one set, so a word added to either group can't be split by one and refused by the other.
export const INSTANCE_COMPONENT_WORDS: ReadonlySet<string> = keySet(KNOWN_KEYS.instance, KNOWN_KEYS.swap);
// The COMPONENT half of the same split: what the component DECLARES (`description`,
// `propertyDefinitions`, on a COMPONENT/COMPONENT_SET) and which property drives a SUBLAYER
// (`componentPropertyReferences`). Live-document questions all — which definition a bare name
// reaches, which component owns the node — so edit's stage 2 splits them off raw exactly as it
// splits the instance words, and component-edit.ts resolves them.
export const COMPONENT_EDIT_WORDS: ReadonlySet<string> = keySet(KNOWN_KEYS.componentDefinition, KNOWN_KEYS.binding);
// Every edit word the sync compile can only judge the SHAPE of. One set, so a word added to either
// half is split by stage 2 and refused by the override gate below without a second edit.
export const DOCUMENT_RESOLVED_EDIT_WORDS: ReadonlySet<string> = keySet([...INSTANCE_COMPONENT_WORDS], [...COMPONENT_EDIT_WORDS]);
const OVERRIDE_DELTA_KEYS = keySet(KNOWN_KEYS.edit.filter((k) => !DOCUMENT_RESOLVED_EDIT_WORDS.has(k)));
// Each constructor's closed vocabulary, by the read type it builds — what fromRead judges a spec's
// read words against before the call, so a word the type lacks is named as real state, not a typo.
export const CONSTRUCTOR_KEYS_BY_TYPE: Record<"FRAME" | "TEXT" | "RECTANGLE" | "ELLIPSE" | "LINE" | "INSTANCE", ReadonlySet<string>> = {
  FRAME: FRAME_KEYS, TEXT: TEXT_KEYS, RECTANGLE: SHAPE_KEYS, ELLIPSE: ELLIPSE_KEYS, LINE: LINE_KEYS, INSTANCE: INSTANCE_KEYS,
};
const PATH_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.path, KNOWN_KEYS.binding);
const SVG_KEYS = keySet(KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.binding);
const LAYOUT_KEYS = keySet(KNOWN_KEYS.layout);
const IMAGE_KEYS = keySet(KNOWN_KEYS.image);
const GRADIENT_KEYS = keySet(KNOWN_KEYS.gradient);
const EFFECTS_KEYS = keySet(KNOWN_KEYS.effects);
// The CSS-effects bag (WriteCssEffects) — the string form of `effects`, routed to parseCssEffects. Its keys
// are an ir.ts interface, not a schema FIELD_GROUP, so no runtime drift test reaches them; but they're the
// frozen CSS spellings, and this ONE list drives both the is-this-CSS detection and the reject (normalizeEffects).
const CSS_EFFECTS_WORDS = ["boxShadow", "filter", "backdropFilter", "textShadow"] as const;
const CSS_EFFECTS_KEYS = keySet(CSS_EFFECTS_WORDS);
// The `effects:` prop accepts EITHER vocabulary in one bag, so its closed set is the union — the reject
// has to run before the split, or a typo lands in whichever half claims it and gets named by that half's
// gate instead of by `effects` (which is where the author wrote it).
const EFFECTS_INPUT_KEYS = keySet(KNOWN_KEYS.effects, CSS_EFFECTS_WORDS);
// The directional `{ x, y }` shape is defined INLINE in schema.ts's SIZE_FIELDS (not its own FIELD_GROUP).
// The drift test still guards it by unwrapping the `anchor` zod object directly. `pin` reuses it: a
// z.custom with no zod shape of its own, but its keys ARE anchor's, so the anchor guard covers it too.
export const DIRECTIONAL_KEYS = keySet(["x", "y"]); // pin and anchor

// The closed-set reject (rejectUnknownKeys) lives in validate.ts — one gate shared with read.ts's locate
// query. Every constructor + nested object below passes its verb name / path as the `subject`.

// ---- shared prop -> WriteNode compilers ----

// terse pad (number | CSS box shorthand | {x,y} | {top,right,bottom,left}) -> typed edges. The string
// form is the READ shape's spelling ("12px 16px"): `get` returns padding as a CSS shorthand, and without
// it here a spec's own layout wouldn't re-author. Inside the object form the edges stay NUMBERS — a "24px"
// there once dropped silently to zero on every side, and that reject stays (ADR-0003 fail-loud).
const PAD_KEYS = keySet(["x", "y", "top", "right", "bottom", "left"]);

function padEdges(pad: PadInput): Edges {
  if (typeof pad === "number") return { top: pad, right: pad, bottom: pad, left: pad };
  if (typeof pad === "string") return boxShorthand(pad, "pad");
  if (pad == null || typeof pad !== "object" || Array.isArray(pad)) {
    throw new Error('flcm: pad must be a number, a CSS box shorthand string ("12px 16px"), or an object ({ x, y } or { top, right, bottom, left }) — got ' + JSON.stringify(pad) + ".");
  }
  rejectUnknownKeys(pad, PAD_KEYS, "pad");
  const edge = (v: number | string | undefined, name: string): number | undefined => {
    if (v == null) return undefined;
    // Rides length(), like every other metric: a number or "Npx", and anything else fails loud there.
    try {
      return length(v);
    } catch {
      throw new Error("flcm: pad." + name + ' must be a number or "Npx", got ' + JSON.stringify(v) + ".");
    }
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
    // "N%" is a fixed px once resolved against the parent (the bridge folds it in at render), so it sizes
    // "fixed" and carries only the percent intent here.
    else if (isPercent(val)) { sz[key] = "fixed"; pct[dim] = percent(val); }
    // A number or "Npx" — one spelling of the same fixed size, so both ride length().
    else {
      try {
        sz[key] = "fixed";
        dims[dim] = length(val);
      } catch {
        throw new Error('flcm: width/height must be a number, "Npx", "N%", "fill", or "hug" — got ' + JSON.stringify(val) + ".");
      }
    }
  };
  axis(props.width, "horizontal", "width");
  axis(props.height, "vertical", "height");
  if (sz.horizontal || sz.vertical) layout.sizing = sz;
  if (dims.width != null || dims.height != null) layout.dimensions = dims;
  if (pct.width != null || pct.height != null) layout.percentSize = pct;
}

// The placement words — `left`/`top`, `position`, `anchor` — in the read shape's own spelling. Naming a
// coordinate is what lifts a node out of an auto-layout parent's flow (the IR's position:"absolute";
// under a free-form parent the bridge writes the coordinate natively and the flag is inert), so
// `position: "absolute"` alone is the coordinate-free lift and "none" (edit) is the return to flow.
function applyPlacement(layout: WriteLayout, props: SizeProps): void {
  const { left, top, position, anchor } = props;
  if (position != null && position !== "absolute" && position !== "none") {
    throw new Error('flcm: position must be "absolute" or "none" — got ' + JSON.stringify(position) + ".");
  }
  if (position === "none") {
    // A node rejoining the flow is placed by the layout, not by coordinates — a coordinate or an
    // anchor beside "none" is two contradictory claims, refused rather than resolved.
    if (left != null || top != null || anchor != null) {
      throw new Error('flcm: position: "none" returns the node to its parent\'s flow, where the layout places it — `left`/`top`/`anchor` can\'t ride along. Drop them, or drop position: "none".');
    }
    layout.position = "none";
    return;
  }
  // A percent coordinate resolves to px against the parent axis at render (percentPos); a number is
  // the location directly. Presence-preserving per axis: an unnamed axis compiles to NOTHING — a
  // fresh node sits at Figma's own 0, and an edit naming only `left` must not teleport the `top` it
  // didn't speak (the bridge falls back to the live coordinate where it needs one).
  const pct: { x?: number; y?: number } = {};
  const axis = (val: number | string | undefined, key: "left" | "top") => {
    if (val == null) return;
    if (isPercent(val)) { pct[key === "left" ? "x" : "y"] = percent(val); return; }
    try {
      layout[key] = length(val);
    } catch {
      throw new Error("flcm: " + key + ' must be a number, "Npx", or "N%" — got ' + JSON.stringify(val) + ".");
    }
  };
  axis(left, "left");
  axis(top, "top");
  if (pct.x != null || pct.y != null) layout.percentPos = pct;
  const a = parseDirectional("anchor", anchor, ANCHOR_X, ANCHOR_Y);
  if (a) {
    // An anchor axis without its coordinate has nothing to land on. Rejected rather than anchored
    // against the live coordinate: subtracting the anchor offset from wherever the node sits would
    // move it again on every re-apply — the relative-delta drift the absolute-values contract forbids.
    if (a.x != null && layout.left == null && pct.x == null) {
      throw new Error("flcm: anchor.x names which point of the node lands on `left` — name `left` alongside it.");
    }
    if (a.y != null && layout.top == null && pct.y == null) {
      throw new Error("flcm: anchor.y names which point of the node lands on `top` — name `top` alongside it.");
    }
    layout.anchor = a;
  }
  if (position === "absolute" || layout.left != null || layout.top != null || layout.percentPos) layout.position = "absolute";
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
// neither axis is set). `name` prefixes every error (e.g. "pin", "anchor"); each message lists the set's
// own members as the allowed words.
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

// Map a CSS-total author word to the Figma-domain value its table names — the container words
// (justifyContent/alignItems, see JUSTIFY_CONTENT/ALIGN_ITEMS for why this gate exists) and the text
// casing words (textTransform/fontVariant). `hint` appends prop-specific guidance; the shared body
// names the realizable CSS spellings.
function mapCssWord<T extends string>(name: string, raw: unknown, table: Record<string, T>, hint = ""): T {
  const mapped = typeof raw === "string" ? table[raw] : undefined;
  if (!mapped) {
    const allowed = Object.keys(table).map((w) => '"' + w + '"').join(", ");
    throw new Error("flcm: " + name + " must be one of " + allowed + " — got " + JSON.stringify(raw) + "." + hint);
  }
  return mapped;
}

// pin -> constraint-override intent on the layout. Only meaningful for a positioned child (a free-form
// parent's, or an out-of-flow one); stored but inert under auto-layout. Never lifts a node out of flow.
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
// into an auto-layout kill. Exported for edit-plan.ts.
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
  if (cfg.justifyContent != null) layout.justifyContent = mapCssWord("layout.justifyContent", cfg.justifyContent, JUSTIFY_CONTENT, " Figma auto-layout can't realize CSS space-around/space-evenly; add gap/padding for spacing instead.");
  if (cfg.alignItems != null) layout.alignItems = mapCssWord("layout.alignItems", cfg.alignItems, ALIGN_ITEMS);
  return layout;
}

// Compile the child-side size/placement words (width/height, left/top/position/anchor, pin) into a
// WriteLayout — the same set every constructor rides. Presence-preserving like the container compile;
// the return is undefined when no word was written, so callers can gate on "was any layout named".
// Exported for edit-plan.ts.
export function compileSizeWords(props: SizeProps): WriteLayout | undefined {
  const layout: WriteLayout = {};
  applySizing(props, layout);
  applyPlacement(layout, props);
  applyPin(layout, props);
  return Object.keys(layout).length ? layout : undefined;
}

// The placement words alone — what a LINE takes beside its width (a line has no sizing intent to
// compile). Exported for edit-plan.ts.
export function compilePlacementWords(props: SizeProps): WriteLayout | undefined {
  const layout: WriteLayout = {};
  applyPlacement(layout, props);
  applyPin(layout, props);
  return Object.keys(layout).length ? layout : undefined;
}

// A LINE sizes on one word, `width` — its length, and a FIXED size only. Compiled here so flcm.line and
// an edit delta reject a sizing intent with the SAME error: "fill"/"hug"/a percent read as a size on
// every other node, and on a line they would silently become nothing.
export function compileLineWidth(props: Pick<LineProps, "width">): WriteLayout | undefined {
  const w = props.width;
  if (w == null) return undefined;
  if (w === "fill" || w === "hug" || isPercent(w)) {
    throw new Error('flcm: a LINE\'s width is its length, a fixed size — "fill", "hug" and "N%" have no meaning on a line. Got ' + JSON.stringify(w) + ".");
  }
  let px: number;
  try {
    px = length(w);
  } catch {
    throw new Error('flcm: `width` on a LINE must be a number or "Npx" — got ' + JSON.stringify(w) + ".");
  }
  // The sizing intent must say "fixed": clearChildFlowFill keys the un-fill off it, so a width edit on a
  // live line someone set to grow (layoutGrow 1 — authorable in the Figma UI, not in flcm) actually takes
  // over from the fill.
  return { sizing: { horizontal: "fixed" }, dimensions: { width: px } };
}

function buildLayout(props: FrameProps, nodeType: WriteType, subject: string): WriteLayout {
  const layout: WriteLayout = {};
  if (nodeType === "FRAME") {
    // ?? not ||: a falsy-but-present layout (false, 0) must reach the compile's malformed-value reject.
    Object.assign(layout, compileContainerWords(props.layout ?? {}, "flcm.frame.layout"));
    if (layout.mode == null) layout.mode = "none"; // the creation default: an omitted mode is free-form
  }
  // The size/position words ride the same compile edit does — the container words above and the
  // creation default are the only create-side extras.
  Object.assign(layout, compileSizeWords(props) || {});
  // The shared per-type legality authority (layout-legality.ts) — the same call edit's live gate
  // makes, so a word that rejects on edit rejects identically here instead of silently not landing.
  assertLayoutRealizableForType(nodeType, layout, false, subject);
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
// Exported for edit-plan.ts (which imports FROM here; flcm.ts never imports it — no cycle).
export function compileNodeLocalProps(wn: WriteProps, props: AppearanceProps, opts: { radius?: boolean; clip?: boolean }): void {
  base(wn, props);
  if (props.fill != null) wn.fills = compilePaintWord(props.fill, "fill");
  if (props.stroke != null) wn.strokes = compilePaintWord(props.stroke, "stroke");
  if (props.strokeWidth != null) wn.strokeWeight = length(props.strokeWidth);
  if (props.strokeAlign != null) wn.strokeAlign = compileStrokeAlign(props.strokeAlign);
  if (props.effects != null) wn.effects = props.effects === "none" ? [] : normalizeEffects(props.effects);
  if (opts.radius && props.borderRadius != null) wn.borderRadius = length(props.borderRadius);
  const clip = (props as FrameProps).clip;
  if (opts.clip && clip != null) { assertScalarType(clip, "boolean", "clip"); wn.clip = clip; }
  if (props.rotation != null) { assertScalarType(props.rotation, "number", "rotation"); wn.rotation = props.rotation; }
}

// Which side of the edge a border sits on. Lowercase on both sides of the surface (the read shape emits
// "outside"/"center" and omits the default), uppercased here to Figma's own enum.
const STROKE_ALIGNS: Record<string, "INSIDE" | "OUTSIDE" | "CENTER"> = {
  inside: "INSIDE",
  outside: "OUTSIDE",
  center: "CENTER",
};

function compileStrokeAlign(value: unknown): "INSIDE" | "OUTSIDE" | "CENTER" {
  const hit = typeof value === "string" ? STROKE_ALIGNS[value.toLowerCase()] : undefined;
  if (!hit) {
    throw new Error('flcm: strokeAlign is "inside", "outside" or "center" — got ' + JSON.stringify(value) + ".");
  }
  return hit;
}

// THE paint-word compile, shared by every constructor and edit's deltas so values and rejections
// can't drift between verbs. "none" is the removal word (CSS's own absence spelling): an EMPTY
// array is the compiled "clear this" — distinct from an ABSENT array, which means "don't touch it".
// Create writing [] onto a fresh node clears a live seeded default; the distinction exists for edit.
//
// An ARRAY is what a read emits for a genuinely STACKED paint, accepted so a `get` result feeds
// straight back in. Exactly one paint is authorable: flcm paints a single fill/stroke, and a STACK —
// a gradient over a solid, an image over a tint — has no write vocabulary at all, so it fails loud
// naming the count instead of quietly dropping every layer but one. An empty array is "no paint",
// identical to "none".
export function compilePaintWord(value: NonNullable<AppearanceProps["fill"]>, subject: string): NonNullable<WriteProps["fills"]> {
  if (value === "none") return [];
  if (Array.isArray(value)) {
    if (value.length > 1) {
      throw new Error(
        "flcm: " + subject + " has " + value.length + " stacked paints, and flcm paints one — there is no authored form for a paint stack. " +
          "Pass the single paint you want, or duplicate the node with flcm.clone to keep the stack.",
      );
    }
    return value.length ? [parseFill(value[0], subject)] : [];
  }
  return [parseFill(value, subject)];
}

// Every constructor births its WriteNode here (WeakSet provenance — see provenance.ts on why
// the IR is not an authoring surface) and returns it through sealWriteNode below. A spread-copy
// ({ ...flcm.rect() }) is a different object and rejects at render — clone a node by re-calling
// its constructor, the only validated path.
function mintWriteNode(type: WriteType): WriteNode {
  const wn: WriteNode = { type };
  markConstructorBuilt(wn);
  return wn;
}

// Seal the finished compile so provenance stays MEANINGFUL: without it, membership only proves
// the node was once constructor-built, while `node.layout.gap = 12` after the fact would smuggle
// unvalidated IR through the gate. Sealing CLONES as it freezes — the compile retains
// caller-passed structures (a gradient PaintSpec, an effects array), and freezing those in place
// would break the caller's own reuse of them, while a caller-frozen shell would shield its
// mutable descendants from an isFrozen-pruned walk. Cloning severs both: the sealed node shares
// nothing caller-reachable except child nodes, which are constructor-sealed themselves (the
// provenance check is the prune — never isFrozen). One traversal does both so the prune rule
// can't drift between a clone pass and a freeze pass.
function cloneAndFreeze(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (isConstructorBuilt(v)) return v; // a child node: already sealed, shared by design
  if (Array.isArray(v)) return Object.freeze(v.map(cloneAndFreeze));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) out[k] = cloneAndFreeze((v as Record<string, unknown>)[k]);
  return Object.freeze(out);
}

function sealWriteNode(wn: WriteNode): WriteNode {
  const bag = wn as unknown as Record<string, unknown>;
  for (const k of Object.keys(bag)) bag[k] = cloneAndFreeze(bag[k]);
  Object.freeze(wn);
  return wn;
}

// Every constructor opens with the shared prelude (validate.ts acceptAuthoringProps): the read shape's
// read-only words (`id`, `type`, `children`, a root's `designedWidth`) fold away, then the closed-set
// gate runs — so a `get` result spreads straight in, and what comes back is the constructor's own
// vocabulary.
function frame(props: FrameProps | SimplifiedNode = {}, children?: WriteChild | WriteChild[]): WriteNode {
  // ?? not || (here and in every constructor): null/undefined mean "no props" (the pinned absence
  // convention), but a present falsy non-object (false, 0, "") is malformed and must reach the
  // gate's non-object reject, not read as absence.
  props = props ?? {};
  // An array arriving first is almost always the children — steer to the real fix rather than
  // letting the generic non-object reject imply a props problem.
  if (Array.isArray(props)) {
    throw new Error('flcm.frame takes (props, children) — children are the second argument: flcm.frame({}, [...]).');
  }
  props = acceptAuthoringProps(props, { type: "FRAME", verb: "create", known: FRAME_KEYS, subject: "flcm.frame" }) as FrameProps;
  const wn = mintWriteNode("FRAME");
  compileNodeLocalProps(wn, props, { radius: true, clip: true });
  compileBindings(wn, props, FRAME_BINDINGS, "flcm.frame");
  wn.layout = buildLayout(props, "FRAME", "flcm.frame");
  // The children array is frozen IN PLACE — the one deliberate exception to the seal's
  // clone-don't-freeze rule (cloneAndFreeze). A children list is the tree itself, and the
  // aliasing accident is push-AFTER-frame(): with a silent clone that push builds a node the
  // author believes has children and renders an empty frame; frozen, the push throws (agent
  // code runs strict). Reusable specs (a gradient, an effects array) keep the clone rule —
  // sharing those across nodes is legitimate, appending to a handed-over children list is not.
  wn.children = Object.freeze(Array.isArray(children) ? children : children ? [children] : []) as WriteChild[];
  return sealWriteNode(wn);
}

// The two shapes of an instance's first argument. A props bag carrying `componentId` is the read shape
// (`flcm.instance({ ...spec })`); anything else is a component target. A handle carries `id` and no
// `componentId`, so it stays a target — the only object that reads as props is one naming its
// component in the read's own word.
function isInstancePropsForm(arg: unknown): arg is Record<string, unknown> {
  return !!arg && typeof arg === "object" && !Array.isArray(arg) && Object.prototype.hasOwnProperty.call(arg, "componentId");
}

// Target-by-shape, the one test every verb that takes a component uses (flcm.instance's positional
// argument, an instance-swap value, flcm.component/variants' subjects) — so they refuse the same
// non-targets with the same sentence. Exported for component.ts, which meets the same shapes.
export function isTargetShaped(value: unknown): value is Target {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as { __flcmId?: unknown; id?: unknown };
  return typeof v.__flcmId === "string" || typeof v.id === "string";
}

export const COMPONENT_TARGET_HINT = "a component's node id (a read's `componentId`), an flcm/key, flcm.id(id), or a handle from flcm.find";

// flcm.instance(component, props) — stamp a component. Inert like every constructor: the component
// target, the property values and the override deltas ride the WriteNode RAW (ir.ts WriteProps on why),
// and render's prepare phase resolves them against the live document (instance.ts) before any write.
// What IS judged here is everything the document can't change: the root words' vocabulary and values
// (they compile exactly as a frame's do), the SHAPE of the two component bags, and each override
// delta's words — the same document-blind gate edit's stage 1 runs on a delta.
//
// PRESENCE-PRESERVING, unlike flcm.frame: no `layout.mode: "none"` default, no transparent-fill
// default, no hug default. An instance's root already has every value from its component, and a
// creation default written onto it would be a root-level override the author never asked for — the
// instance would stop tracking the component on that field. Only a named word becomes an override.
function instance(componentOrProps: Target | InstanceProps | SimplifiedNode, props?: InstanceProps | SimplifiedNode): WriteNode {
  let component: unknown;
  let bag: unknown;
  if (isInstancePropsForm(componentOrProps)) {
    if (props !== undefined) {
      throw new Error("flcm.instance takes (component, props) or ONE props object carrying `componentId` — not both. Drop the second argument, or pass the component first and leave `componentId` out of the props.");
    }
    const { componentId, ...rest } = componentOrProps as Record<string, unknown>;
    component = componentId;
    bag = rest;
  } else {
    component = componentOrProps;
    bag = props ?? {};
    if (isInstancePropsForm(bag)) {
      throw new Error("flcm.instance: the component is the first argument, and the props also name `componentId` — two components for one instance. Pass one or the other.");
    }
  }
  if (!isTargetShaped(component)) {
    throw new Error("flcm.instance: the component must be " + COMPONENT_TARGET_HINT + " — got " + JSON.stringify(component) + ".");
  }
  const accepted = acceptAuthoringProps(bag, { type: "INSTANCE", verb: "create", known: INSTANCE_KEYS, subject: "flcm.instance" }) as InstanceProps;
  const wn = mintWriteNode("INSTANCE");
  wn.component = component;
  compileNodeLocalProps(wn, accepted, { radius: true, clip: true });
  const layout: WriteLayout = {};
  // ?? not ||, as in buildLayout: a falsy-but-present layout must reach the compile's malformed reject.
  if (accepted.layout != null) Object.assign(layout, compileContainerWords(accepted.layout, "flcm.instance.layout"));
  Object.assign(layout, compileSizeWords(accepted) || {});
  // The type rule (hug needs auto-layout, gap needs a container) is NOT run here: whether this root is
  // a row/column is the COMPONENT's fact, read in render's prepare — the same live-mode call edit makes.
  if (Object.keys(layout).length) wn.layout = layout;
  compileBindings(wn, accepted, INSTANCE_BINDINGS, "flcm.instance");
  if (accepted.componentProperties != null) wn.componentProperties = compileComponentPropertyBag(accepted.componentProperties, "flcm.instance");
  if (accepted.overrides != null) wn.overrides = compileOverrideBag(accepted.overrides, "flcm.instance");
  return sealWriteNode(wn);
}

// The property bag's SHAPE: an object of names to scalars or component targets. Which names exist,
// what type each takes and which variant combinations are real are the component's to say, at
// prepare. A null value is refused here rather than treated as absence: unlike a constructor word,
// a property has no "unset" — the read never reports one as null, and a null would either
// silently keep the default or throw inside Figma's setter.
//
// `subject` is the verb that met the bag — flcm.instance at construction, flcm.edit/editMany when a
// delta carries the same word. ONE shape gate for both, so what an instance is created with and what
// an instance edit sets can't diverge on what a property value even is.
export function compileComponentPropertyBag(raw: unknown, subject: string): Record<string, ComponentPropertyInput> {
  const where = subject + ".componentProperties";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(where + ' must be an object of property values by name, e.g. { Size: "Large", Label: "Save" } — got ' + JSON.stringify(raw) + ".");
  }
  const out: Record<string, ComponentPropertyInput> = {};
  for (const name of Object.keys(raw)) {
    const value = (raw as Record<string, unknown>)[name];
    if (!name.trim()) throw new Error(where + ": a property name is empty.");
    if (typeof value === "string" || typeof value === "boolean" || isTargetShaped(value)) {
      out[name] = value as ComponentPropertyInput;
      continue;
    }
    throw new Error(
      where + "[" + JSON.stringify(name) + "]: a property value is a string (a variant option or a text), a boolean, or — for an instance-swap property — " +
        COMPONENT_TARGET_HINT + ". Got " + JSON.stringify(value) + ".",
    );
  }
  return out;
}

// The edit bag's SHAPE: an object of property names to a definition object or `null`. Which names
// already exist — and therefore whether an entry adds, changes or deletes — is the component's to
// say at prepare (component-edit.ts), exactly as `componentProperties` splits the question.
//
// Names are TRIMMED here, once, for the same reason flcm.component trims them: the dedupe below, the
// live lookup, and the name Figma stores must all see one spelling.
export function compilePropertyDefinitionEditBag(raw: unknown, subject: string): Record<string, ComponentPropertyDefinitionEdit | null> {
  const where = subject + ".propertyDefinitions";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(where + ' must be an object of definitions by property name, e.g. { Label: { defaultValue: "Save" }, Icon: null } — got ' + JSON.stringify(raw) + ".");
  }
  const out: Record<string, ComponentPropertyDefinitionEdit | null> = {};
  for (const rawName of Object.keys(raw)) {
    const name = rawName.trim();
    if (!name) throw new Error(where + ": a property name is empty.");
    if (own(out, name) !== undefined) {
      throw new Error(where + ": two entries name the property " + JSON.stringify(name) + " — one property, one entry.");
    }
    const value = (raw as Record<string, unknown>)[rawName];
    if (value !== null && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new Error(
        where + "[" + JSON.stringify(name) + "] must be a definition object — { defaultValue } to re-default it, { name } to rename it, " +
          '{ type, defaultValue } to add one — or null to delete it. Got ' + JSON.stringify(value) + ".",
      );
    }
    out[name] = value as ComponentPropertyDefinitionEdit | null;
  }
  return out;
}

// Each override is a delta in the edit vocabulary, keyed by the sublayer's component-relative path.
// The document-blind half of edit's validation runs on every entry now (a misspelled word rejects
// before any component is looked up); the per-type half — which words THIS sublayer takes, what a
// `null` means for it — runs at prepare against the resolved definition (instance.ts).
export function compileOverrideBag(raw: unknown, subject: string): Record<string, OverrideDeltaInput> {
  const where = subject + ".overrides";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(where + ' must be an object of deltas by sublayer path, e.g. { "11:9": { text: "Save" } } — got ' + JSON.stringify(raw) + ".");
  }
  const out: Record<string, OverrideDeltaInput> = {};
  for (const path of Object.keys(raw)) {
    if (!path.trim()) throw new Error(where + ": a sublayer path is empty.");
    const delta = (raw as Record<string, unknown>)[path];
    const at = where + "[" + JSON.stringify(path) + "]";
    if (delta && typeof delta === "object") {
      for (const word of Object.keys(delta)) {
        if (INSTANCE_COMPONENT_WORDS.has(word)) {
          throw new Error(
            at + ": `" + word + "` reaches a NESTED instance's own component, which an override path can't address — the path names a sublayer, and the tree behind it is what this call is still deciding. " +
              'Edit that instance directly once this call lands: flcm.edit("I<instanceId>;' + path + '", { ' + word + ": … }).",
          );
        }
        // The definition words reach the COMPONENT, and an override is a per-INSTANCE difference —
        // writing one here would change every instance, which is the opposite of what an override is.
        if (COMPONENT_EDIT_WORDS.has(word)) {
          throw new Error(
            at + ": `" + word + "` belongs to the main COMPONENT, not to one instance's override — setting it here would change every instance of it. " +
              "Edit the component itself: flcm.edit(componentId, { " + word + ": … }).",
          );
        }
      }
    }
    rejectNonDeltaWords(delta, OVERRIDE_DELTA_KEYS, at);
    out[path] = delta as OverrideDeltaInput;
  }
  return out;
}

// ---- the BINDING word (`componentPropertyReferences`) ----
//
// Which component property drives which of this node's fields. The constructor judges SHAPE and
// per-type legality only: the names point at properties an flcm.component call declares in the same
// breath, so whether a name exists (and whether its TYPE matches the field) is that verb's prepare
// to say — the same split `componentProperties` takes.

// Why each field belongs to the one constructor it does, for the refusal's second sentence. `visible`
// has no entry: every node has one, so it is never the wrong node's word.
const BINDING_FIELD_OWNERS: Record<string, string> = {
  text: "`text` drives a TEXT node's content, so it belongs to flcm.text",
  componentId: "`componentId` is an instance-swap property re-pointing an INSTANCE, so it belongs to flcm.instance",
  slot: "`slot` marks the FRAME that IS the slot (an instance shows it as a SLOT holding that frame's content), so it belongs to flcm.frame",
};

// Which fields each constructor may bind — `visible` everywhere, the other three only on the node
// type whose field they name. Written as arrays (not a set) so a refusal can list them in order.
const ANY_NODE_BINDINGS: readonly string[] = ["visible"];
const FRAME_BINDINGS: readonly string[] = ["visible", "slot"];
const TEXT_BINDINGS: readonly string[] = ["visible", "text"];
const INSTANCE_BINDINGS: readonly string[] = ["visible", "componentId"];
// The union of those lists — every field the word can name anywhere. Guarded against the schema's
// inline object (unknown-props.test.ts), the way DIRECTIONAL_KEYS is: the bag's fields are defined
// inline in BINDING_FIELDS, not as their own FIELD_GROUP.
export const BINDING_FIELD_KEYS: ReadonlySet<string> = keySet(FRAME_BINDINGS, TEXT_BINDINGS, INSTANCE_BINDINGS);

/**
 * Which fields a LIVE node of this type may bind — the same per-type rule the constructors carry,
 * read off the document instead of off the verb, so `flcm.edit(sublayer, { componentPropertyReferences })`
 * and `flcm.text(…, { componentPropertyReferences })` refuse the same field on the same node.
 */
export function bindingFieldsForType(type: string): readonly string[] {
  if (type === "FRAME") return FRAME_BINDINGS;
  if (type === "TEXT") return TEXT_BINDINGS;
  if (type === "INSTANCE") return INSTANCE_BINDINGS;
  return ANY_NODE_BINDINGS;
}

// The per-field legality half, shared by the create bag and the edit bag so a field on the wrong
// node type reads the same either way. `what` is what the refusal calls the thing that can't bind
// it — a constructor name at create ("flcm.text"), the live node's type under edit ("a TEXT").
function assertBindingFieldLegal(field: string, legal: readonly string[], where: string, what: string): void {
  if (legal.indexOf(field) !== -1) return;
  const owner = BINDING_FIELD_OWNERS[field];
  throw new Error(
    where + ": `" + field + "` is not one of " + what + "'s binding fields (" + legal.join(", ") + ")" +
      (owner ? " — " + owner : "") + ".",
  );
}

export function compileBindingBag(raw: unknown, legal: readonly string[], subject: string): ComponentPropertyBinding {
  const where = subject + ".componentPropertyReferences";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(where + ' must be an object naming which component property drives which field, e.g. { text: "Label" } — got ' + JSON.stringify(raw) + ".");
  }
  const out: Record<string, string> = {};
  for (const field of Object.keys(raw)) {
    const value = (raw as Record<string, unknown>)[field];
    if (value == null) continue; // an explicitly-absent field is absence, not a claim
    assertBindingFieldLegal(field, legal, where, subject);
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(where + "." + field + ": a binding names the component property that drives this field — a property name declared in the same flcm.component call. Got " + JSON.stringify(value) + ".");
    }
    out[field] = value;
  }
  return out as ComponentPropertyBinding;
}

/**
 * The EDIT bag's shape gate. One thing separates it from the create bag above: `null` is a CLAIM
 * here, not absence — it unbinds the field — so a null can't be skipped, and the field it names is
 * judged for legality like any other. Which property each name reaches (and whether unbinding this
 * one is legal) is prepare's, against the owning component: component-edit.ts.
 *
 * `what` names the live node's type, since under edit the offending field belongs to a node, not to
 * a constructor: "`slot` is not one of a TEXT's binding fields".
 */
export function compileBindingEditBag(raw: unknown, legal: readonly string[], subject: string, what: string): Record<string, string | null> {
  const where = subject + ".componentPropertyReferences";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(where + ' must be an object naming which component property drives which field, e.g. { text: "Label" } (or null to unbind) — got ' + JSON.stringify(raw) + ".");
  }
  const out: Record<string, string | null> = {};
  for (const field of Object.keys(raw)) {
    const value = (raw as Record<string, unknown>)[field];
    if (value === undefined) continue; // an explicitly-undefined field is absence; `null` is the unbind
    assertBindingFieldLegal(field, legal, where, what);
    if (value === null) {
      out[field] = null;
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(where + "." + field + ": a binding names the component property that drives this field — a property this component declares — or null to unbind it. Got " + JSON.stringify(value) + ".");
    }
    out[field] = value;
  }
  return out;
}

// The constructor-side half: compile the bag (when named) onto the WriteNode. An empty bag lands
// nothing — a node carrying `componentPropertyReferences: {}` binds nothing and must not read as a
// bound node to flcm.component's gate.
function compileBindings(wn: WriteProps, props: { componentPropertyReferences?: unknown }, legal: readonly string[], subject: string): void {
  if (props.componentPropertyReferences == null) return;
  const refs = compileBindingBag(props.componentPropertyReferences, legal, subject);
  if (Object.keys(refs).length) wn.componentPropertyReferences = refs;
}

/**
 * Refuse a tree carrying bindings with no declaring component behind it. A binding names a property
 * that only a component has — through render, or an append landing on a page or a plain frame, the
 * name points at nothing, and Figma would take the reference silently onto a node with no component
 * behind it. Called by every spec-taking verb except flcm.component (which mints the names), and by
 * an insert once it knows its destination is NOT inside a component (component-edit.ts).
 */
export function assertNoComponentPropertyBindings(tree: WriteChild, subject: string): void {
  if (!tree || typeof tree !== "object") return;
  if (tree.componentPropertyReferences) {
    throw new Error(
      subject + ": `componentPropertyReferences` binds a node to a component property, and nothing here declares one — a binding means something only with a component behind it. " +
        "Either build the component in one call (flcm.component(spec, { propertyDefinitions: … }), which declares the properties the spec binds), " +
        "or insert this into a COMPONENT that already declares them (flcm.append(component, spec)). To place a copy of a component, use flcm.instance.",
    );
  }
  for (const child of tree.children || []) assertNoComponentPropertyBindings(child, subject);
}

// The swap word's SHAPE — the same target grammar the constructor's positional component takes, so
// `flcm.edit(inst, { componentId })` and `flcm.instance(component)` refuse the same non-targets with
// the same sentence. WHICH node it names (a COMPONENT, a set, an instance) is prepare's to say.
export function compileSwapTarget(raw: unknown, subject: string): Target {
  if (!isTargetShaped(raw)) {
    throw new Error(subject + ".componentId: the component to swap to must be " + COMPONENT_TARGET_HINT + " — got " + JSON.stringify(raw) + ".");
  }
  return raw;
}

// CSS text-transform / font-variant-caps -> Figma's ONE textCase enum. Two author words, one slot,
// which is why compileTextCase refuses a style naming both rather than letting the later key win.
const TEXT_TRANSFORM: Record<string, WriteTextCase> = {
  uppercase: "UPPER", lowercase: "LOWER", capitalize: "TITLE", none: "ORIGINAL",
};
const FONT_VARIANT: Record<string, WriteTextCase> = {
  "small-caps": "SMALL_CAPS", "all-small-caps": "SMALL_CAPS_FORCED",
};

function compileTextCase(c: { textTransform?: unknown; fontVariant?: unknown }, subject: string): WriteTextCase | undefined {
  if (c.textTransform != null && c.fontVariant != null) {
    throw new Error(
      subject + ": textTransform and fontVariant are two CSS words for Figma's ONE textCase slot, so they can't both be set — name whichever you mean. " +
        '(To clear a small-caps, use textTransform: "none".)',
    );
  }
  if (c.textTransform != null) return mapCssWord(subject + ".textTransform", c.textTransform, TEXT_TRANSFORM);
  if (c.fontVariant != null) return mapCssWord(subject + ".fontVariant", c.fontVariant, FONT_VARIANT);
  return undefined;
}

const TEXT_ALIGN_VERTICAL = new Set<NonNullable<WriteTextStyle["textAlignVertical"]>>(["top", "center", "bottom"]);

// A hyperlink leaf: an author URL string, or the read form ({ type: "URL", url }) so a `get` result
// round-trips without the caller unwrapping it. A NODE link — Figma's other kind, a jump to another
// node in the design — has no authored form at all, so it rejects BY NAME instead of dropping the
// link silently and handing back a node the agent believes still carries it.
function parseHyperlink(value: unknown, subject: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const h = value as { type?: unknown; url?: unknown };
    if (h.type === "URL" && typeof h.url === "string" && h.url.trim()) return h.url;
    if (h.type === "NODE") {
      throw new Error(subject + ": that is a NODE hyperlink (a jump to another node in the design) — Figma has no way for a plugin to author one. Point it at a URL, or drop the field.");
    }
  }
  throw new Error(subject + ': hyperlink must be a non-empty URL string, or the read form { type: "URL", url } — got ' + JSON.stringify(value) + ".");
}

// Read-shape text leaves that are NOT authoring input, so a spread `{ ...spec.textStyle, fontSize: 18 }`
// still compiles instead of dying on the closed-set gate. Two dispositions, deliberately different:
//   • IGNORED — purely DERIVED, its information already elsewhere in the same style, so dropping it
//     loses nothing. `fontVariantName` ("Bold Italic") IS fontWeight + fontStyle, restated as Figma's
//     own label; there is nothing to write that the triple doesn't already say.
//   • REFUSED — real state the plugin API cannot write. Named with its reason, because silently
//     dropping it would hand back a node the agent believes carries it (ADR-0003).
const IGNORED_READ_TEXT_LEAVES = ["fontVariantName"];
const REFUSED_READ_TEXT_LEAVES: Record<string, string> = {
  opentypeFlags: "OpenType features are read-only to a plugin — TextNode.openTypeFeatures has no setter and no setRange* counterpart [verified, plugin-typings 1.133]",
};
// A RUN's refusals add the two alignment words. Both are legal on the BASE (they're whole-node
// properties, which is exactly the point) but a run delta can carry them too — the read side emits them
// as inverse overrides of a non-default base — and Figma has no setRangeTextAlignHorizontal/Vertical
// [verified, plugin-typings 1.133], so one span cannot align differently from its node. Named here rather
// than left to the unknown-prop gate, which would diagnose a real read leaf as a typo.
const REFUSED_RUN_TEXT_LEAVES: Record<string, string> = {
  ...REFUSED_READ_TEXT_LEAVES,
  textAlign: "horizontal alignment is a whole-node property in Figma (no setRangeTextAlignHorizontal), so a single run can't set it — move it to the node's textStyle",
  textAlignVertical: "vertical alignment is a whole-node property in Figma (no setRangeTextAlignVertical), so a single run can't set it — move it to the node's textStyle",
};

// The closed set each text-style carrier accepts as INPUT: its own words plus the derived read leaves
// it drops. Built from KNOWN_KEYS (schema-mirrored, drift-guarded) so the tolerated extras stay
// visibly separate from the authoring surface — they are not props, and the docs must not list them.
const TEXTSTYLE_INPUT_KEYS = keySet(KNOWN_KEYS.textStyle, IGNORED_READ_TEXT_LEAVES);
const RUN_INPUT_KEYS = keySet(KNOWN_KEYS.run, IGNORED_READ_TEXT_LEAVES);

function rejectUnauthorableTextLeaves(c: object, subject: string, refused: Record<string, string> = REFUSED_READ_TEXT_LEAVES): void {
  for (const leaf of Object.keys(refused)) {
    if (c.hasOwnProperty(leaf)) {
      throw new Error(subject + ": `" + leaf + "` is a read-only field — " + refused[leaf] + ". Drop it from the style.");
    }
  }
}

// The text words a BASE style and a RUN delta share — casing, paragraph metrics, links. Written once
// because Figma applies every one of them per range (setRangeTextCase/setRangeParagraph*/…), so the
// two carriers differ only in which range they cover, never in what the word means.
function compileSharedTextWords(c: Record<string, unknown>, ts: WriteTextStyle, subject: string): void {
  const textCase = compileTextCase(c, subject);
  if (textCase) ts.textCase = textCase;
  if (c.paragraphSpacing != null) ts.paragraphSpacing = length(c.paragraphSpacing as number | string);
  if (c.paragraphIndent != null) ts.paragraphIndent = length(c.paragraphIndent as number | string);
  if (c.listSpacing != null) ts.listSpacing = length(c.listSpacing as number | string);
}

// The textStyle word compile every text carrier rides — flcm.text's base and an edit delta alike
// (one vocabulary, one parser). One word in the group is deliberately NOT compiled here: lineClamp
// validates against a width the two callers know differently (create: the authored width; edit: the
// live wrap state), so each reads cfg.lineClamp itself. (`boldWeight` is a node-level word, not a
// style: it is the CONTENT-compile convention for what `**` resolves to, so it rides into
// compileTextContent and never onto the IR.)
// Exported for edit-plan.ts.
export function compileTextStyleWords(cfg: unknown, subject: string): WriteTextStyle {
  // QuickJS boundary: a present-but-malformed value must reject the whole call, not read as absence.
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
    throw new Error("flcm: " + subject + " must be an object like { fontSize, fontWeight, … } — got " + JSON.stringify(cfg) + ".");
  }
  const c = cfg as NonNullable<TextProps["textStyle"]>;
  rejectUnauthorableTextLeaves(c, subject);
  rejectUnknownKeys(c, TEXTSTYLE_INPUT_KEYS, subject);
  const ts: WriteTextStyle = {};
  if (c.fontSize != null) { assertScalarType(c.fontSize, "number", "textStyle.fontSize"); ts.fontSize = c.fontSize; }
  // The one non-scalar-typed leaf: a number (700) or a name ("bold"). Anything else must reject —
  // wantWeight would silently read it as 400, a whole-node reset to regular.
  if (c.fontWeight != null) {
    if (typeof c.fontWeight !== "number" && typeof c.fontWeight !== "string") {
      throw new Error('flcm: textStyle.fontWeight must be a number (400, 700) or a weight name ("bold", "semibold") — got ' + JSON.stringify(c.fontWeight) + ".");
    }
    ts.fontWeight = c.fontWeight;
  }
  if (c.fontFamily != null) { assertScalarType(c.fontFamily, "string", "textStyle.fontFamily"); ts.fontFamily = c.fontFamily; }
  if (c.fontStyle != null) ts.fontStyle = assertEnum("textStyle.fontStyle", c.fontStyle, FONT_STYLE);
  if (c.lineHeight != null) ts.lineHeight = lineHeight(c.lineHeight);
  if (c.letterSpacing != null) ts.letterSpacing = letterSpacing(c.letterSpacing);
  if (c.textDecoration != null) ts.textDecoration = assertEnum("textStyle.textDecoration", c.textDecoration, TEXT_DECORATION);
  if (c.textAlign != null) ts.textAlign = assertEnum("textStyle.textAlign", c.textAlign, TEXT_ALIGN);
  if (c.textAlignVertical != null) ts.textAlignVertical = assertEnum("textStyle.textAlignVertical", c.textAlignVertical, TEXT_ALIGN_VERTICAL);
  if (c.hyperlink != null) ts.hyperlink = parseHyperlink(c.hyperlink, subject + ".hyperlink");
  compileSharedTextWords(c as Record<string, unknown>, ts, subject);
  return ts;
}

// Content -> { text | runs }, the ONE parser behind flcm.text's positional arg and the `text` prop
// (create and edit). Both the runs-array and plain-string forms flow through the markdown parser (markdown.ts):
// a plain string may carry `**bold**` or literal escapes; a runs-array entry's text is markdown
// too. `base` is the style each styled run layers over (create: the authored textStyle; edit: the
// delta's textStyle enriched with the live node's font identity, so a run that only bolds inherits
// the family the node actually uses). A plain string that parses to a single flagless segment
// stays plain `text`; anything richer becomes `runs`. Exported for edit-plan.ts.
export function compileTextContent(content: unknown, base: WriteTextStyle, boldWeight?: number | string): { text?: string; runs?: WriteTextRun[] } {
  if (boldWeight != null && typeof boldWeight !== "number" && typeof boldWeight !== "string") {
    throw new Error('flcm: boldWeight must be a number (400, 700) or a weight name ("bold", "semibold") — got ' + JSON.stringify(boldWeight) + ".");
  }
  if (Array.isArray(content)) {
    const runs = compileRuns(content, base, boldWeight);
    return runs.length ? { runs } : { text: "" };
  }
  const segs = parseInlineMarkdown(assertNotReadToken(plainString(content)));
  if (segs.length === 1 && isPlainSeg(segs[0])) return { text: segs[0].text };
  if (!segs.length) return { text: "" };
  return { runs: segs.map((seg) => compileRun(seg.text, mergeDelta(seg, {}, boldWeight), base, "flcm.text run")) };
}

function text(content: unknown, props: TextProps | SimplifiedNode = {}): WriteNode {
  props = props ?? {};
  // The props-first form, flcm.text(props): the content is the `text` prop — how a read spec carries
  // it. Content is never a plain object (a string, or a runs ARRAY), so an object first is unambiguously
  // the props, and anything in the second slot is then a mistake worth naming.
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    if (typeof props !== "object" || Array.isArray(props) || Object.keys(props).length) {
      throw new Error("flcm.text(props) takes the props alone (the content is its `text`); flcm.text(text, props) takes a string or runs array first — got a second argument " + JSON.stringify(props) + ".");
    }
    props = content as TextProps;
    content = undefined;
  }
  props = acceptAuthoringProps(props, { type: "TEXT", verb: "create", known: TEXT_KEYS, subject: "flcm.text" }) as TextProps;
  // Content named twice — positionally AND as the prop — is refused by PRESENCE, not value: a spread
  // spec with a positional override is exactly where a silent "one wins" would bite.
  if (Object.prototype.hasOwnProperty.call(props, "text")) {
    if (content !== undefined) throw new Error("flcm.text: the text arrived twice — as the first argument and as the `text` prop. Pass one.");
    content = props.text;
  }
  const wn = mintWriteNode("TEXT");
  base(wn, props);
  compileBindings(wn, props, TEXT_BINDINGS, "flcm.text");
  // The text's paint is `fill`, like every other node's. "none" is the same removal word edit takes.
  if (props.fill != null) wn.fills = compilePaintWord(props.fill, "fill");
  const cfg = (props.textStyle ?? {}) as NonNullable<TextProps["textStyle"]>;
  const ts = compileTextStyleWords(cfg, "flcm.text.textStyle");
  if (Object.keys(ts).length) wn.textStyle = ts;
  Object.assign(wn, compileTextContent(content, ts, props.boldWeight ?? undefined));
  // lineClamp "none" at create is the explicit default — no clamp to remove, nothing lands.
  if (cfg.lineClamp != null && cfg.lineClamp !== "none") wn.maxLines = assertLineClamp(cfg.lineClamp, props.width);
  const layout = buildLayout(props as FrameProps, "TEXT", "flcm.text");
  if (Object.keys(layout).length) wn.layout = layout;
  return sealWriteNode(wn);
}

// N's shape gate, shared by create and edit so one author mistake reads one error. "none" is each
// caller's, before this: create skips it (the explicit default), edit compiles it to the removal.
// Boundedness is also the caller's — create knows the authored width, edit the live wrap state.
export function assertLineClampCount(lineClamp: unknown, subject: string): number {
  if (typeof lineClamp !== "number" || !Number.isInteger(lineClamp) || lineClamp < 1) {
    throw new Error(subject + ': textStyle.lineClamp must be a whole number ≥ 1 or "none" — got ' + JSON.stringify(lineClamp) + ".");
  }
  return lineClamp;
}

// lineClamp clamps a text to N lines with an ending ellipsis, but truncation only bites when the text has a
// bounded width to wrap against — buildText wires a fixed/`"fill"`/`"N%"` width to height-only auto-resize,
// giving it a wrap; a width-hugging text grows sideways on one line, so there's nothing to clamp. Rather
// than let `lineClamp` be a silent no-op there (ADR-0003), reject it loud and name the fix.
function assertLineClamp(lineClamp: unknown, width: TextProps["width"]): number {
  const n = assertLineClampCount(lineClamp, "flcm.text");
  const bounded = typeof width === "number" || width === "fill" || isPercent(width);
  if (!bounded) {
    throw new Error('flcm.text: textStyle.lineClamp needs a bounded width to truncate against — set width to a number, "fill", or "N%". A width-hugging text grows on one line, so there is nothing to wrap and clamp.');
  }
  return n;
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

// flcm.text takes PLAIN text OR a runs array (see compileRuns); an object arriving first is the props —
// see text(). (A stray `**` in a plain string is NOT rejected: it is markdown now, gated on the escape
// convention — an author who wants a literal `**` writes `\*\*`, which decodes back to the literal.)
function plainString(content: unknown): string {
  return content == null ? "" : String(content);
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
function compileRuns(runs: TextRunInput[], baseStyle: WriteTextStyle, boldWeight?: number | string): WriteTextRun[] {
  if (!runs.length) {
    throw new Error("flcm.text: a runs array must be non-empty — pass at least one run (a string or a [text, style] tuple).");
  }
  const out: WriteTextRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    let raw: string;
    let delta: StyleDeltaInput;
    if (typeof run === "string") { raw = run; delta = {}; }
    else if (Array.isArray(run) && typeof run[0] === "string") { raw = run[0]; delta = run[1] ?? {}; }
    else {
      throw new Error('flcm.text: each run is a plain string or a [text, style] tuple like ["bold bit", { fontWeight: 700 }] — got ' + JSON.stringify(run) + ".");
    }
    // The run delta is the grounded silent-drop site: compileRun reads a positive list and never looked at
    // the rest, so a typo'd `textTransfrom` on a run vanished. Reject it here, on the raw author delta.
    rejectUnauthorableTextLeaves(delta, `flcm.text run[${i}]`, REFUSED_RUN_TEXT_LEAVES);
    rejectUnknownKeys(delta, RUN_INPUT_KEYS, `flcm.text run[${i}]`);
    for (const seg of parseInlineMarkdown(assertNotReadToken(raw))) {
      out.push(compileRun(seg.text, mergeDelta(seg, delta, boldWeight), baseStyle, `flcm.text run[${i}]`));
    }
  }
  return out;
}

// Markdown flags → StyleDelta fields, then overlay the tuple's explicit delta so an explicit field wins
// over the one the markdown implied. `\n`-decoded newlines and every other char already live in seg.text.
//
// `**` resolves to the NODE's bold weight, not a global 700. The read side compresses a bold span to
// markdown and reports the weight it stood for ONCE, on the node (`boldWeight`) — it deliberately omits
// the per-run `fontWeight` when the run matches that weight, so the node-level word is the only carrier.
// Defaulting to "bold" here regardless would re-render a Semi Bold (600) emphasis at 700: silently wrong
// pixels on the commonest mixed-weight text there is.
function mergeDelta(seg: MdSegment, explicit: StyleDeltaInput, boldWeight?: number | string): StyleDeltaInput {
  const d: StyleDeltaInput = {};
  if (seg.bold) d.fontWeight = boldWeight != null ? boldWeight : "bold";
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
function compileRun(str: string, delta: StyleDeltaInput, baseStyle: WriteTextStyle, subject: string): WriteTextRun {
  const out: WriteTextRun = { text: str };
  const style: WriteTextStyle = {};
  const italic = delta.fontStyle != null
    ? assertEnum("run fontStyle", delta.fontStyle, FONT_STYLE)
    : baseStyle.fontStyle;
  if (delta.fontFamily != null || delta.fontWeight != null || delta.fontStyle != null) {
    // CONTRACT: a run changing any of the (family, weight, slant) triple carries the COMPLETE
    // effective triple — fontFamily is assigned even when the base has none (the key is present
    // with an undefined value). Edit's mixed-base guard reads exactly that presence; don't "tidy"
    // the undefined assignment away.
    style.fontFamily = delta.fontFamily != null ? delta.fontFamily : baseStyle.fontFamily;
    style.fontWeight = delta.fontWeight != null ? delta.fontWeight : baseStyle.fontWeight;
    if (italic != null) style.fontStyle = italic;
  }
  if (delta.fontSize != null) style.fontSize = delta.fontSize;
  if (delta.lineHeight != null) style.lineHeight = lineHeight(delta.lineHeight);
  if (delta.letterSpacing != null) style.letterSpacing = letterSpacing(delta.letterSpacing);
  if (delta.textDecoration != null) style.textDecoration = assertEnum("run textDecoration", delta.textDecoration, TEXT_DECORATION);
  compileSharedTextWords(delta as Record<string, unknown>, style, subject);
  if (Object.keys(style).length) out.style = style;
  if (delta.color != null) out.fills = compilePaintWord(delta.color, "color");
  // A run's link lives on the RUN, not its style: the span already IS the range setRangeHyperlink
  // needs, so it takes no per-field range of its own.
  if (delta.hyperlink != null) out.hyperlink = parseHyperlink(delta.hyperlink, subject + ".hyperlink");
  return out;
}

function shape(type: "RECTANGLE" | "ELLIPSE", props: ShapeProps | EllipseProps | SimplifiedNode = {}): WriteNode {
  props = props ?? {};
  const subject = type === "RECTANGLE" ? "flcm.rect" : "flcm.ellipse";
  // An ELLIPSE has no corners, so its vocabulary has no radius word (schema ELLIPSE_FIELDS): refused by
  // the gate, not accepted and dropped on the floor.
  const known = type === "RECTANGLE" ? SHAPE_KEYS : ELLIPSE_KEYS;
  props = acceptAuthoringProps(props, { type, verb: "create", known, subject }) as ShapeProps;
  const wn = mintWriteNode(type);
  compileNodeLocalProps(wn, props, { radius: type === "RECTANGLE" });
  compileBindings(wn, props, ANY_NODE_BINDINGS, subject);
  const layout = buildLayout(props as FrameProps, type, subject);
  if (Object.keys(layout).length) wn.layout = layout;
  return sealWriteNode(wn);
}

function rect(props?: ShapeProps | SimplifiedNode): WriteNode { return shape("RECTANGLE", props); }
function ellipse(props?: EllipseProps | SimplifiedNode): WriteNode { return shape("ELLIPSE", props); }

function line(props: LineProps | SimplifiedNode = {}): WriteNode {
  props = props ?? {};
  props = acceptAuthoringProps(props, { type: "LINE", verb: "create", known: LINE_KEYS, subject: "flcm.line" }) as LineProps;
  const wn = mintWriteNode("LINE");
  base(wn, props);
  compileBindings(wn, props, ANY_NODE_BINDINGS, "flcm.line");
  if (props.stroke != null) wn.strokes = compilePaintWord(props.stroke, "stroke");
  if (props.strokeWidth != null) wn.strokeWeight = length(props.strokeWidth);
  const layout: WriteLayout = { ...(compileLineWidth(props) || {}), ...(compilePlacementWords(props) || {}) };
  // line() is the one constructor that doesn't ride buildLayout (width-only sizing), so it consults
  // the shared authority itself — no rule fires on a width-only layout today, but a future LINE-keyed
  // rule must not end up edit-only (the asymmetry this module forbids).
  assertLayoutRealizableForType("LINE", layout, false, "flcm.line");
  if (Object.keys(layout).length) wn.layout = layout;
  if (props.rotation != null) { assertScalarType(props.rotation, "number", "rotation"); wn.rotation = props.rotation; }
  return sealWriteNode(wn);
}

// ---- Vector verbs. Two contracts, deliberately not interchangeable (see ir.ts WriteNode.svg/pathData):
// svg pastes opaque markup (colors baked in); path is a single themeable vector taking our appearance props.

// flcm.svg(markup) -> a VECTOR node carrying raw markup (createNodeFromSvg at render, which yields a frame).
// Colors live in the markup, so fill/stroke DON'T apply — accepting them silently would be the exact no-op
// ADR-0003 forbids, so reject them loud. The markup must look like an <svg> document (catches a URL/path
// passed by mistake); the render-time parse (bridge) is the second, authoritative fail-loud.
function svg(markup: unknown, props: SvgProps = {}): WriteNode {
  props = props ?? {};
  if (typeof markup !== "string" || !/<svg[\s>]/i.test(markup)) {
    throw new Error("flcm.svg: expected SVG markup containing an <svg> element — got " + JSON.stringify(markup) + ". For a themeable single-path vector use flcm.path({ d }) instead.");
  }
  const p = props as AppearanceProps;
  if (p.fill != null || p.stroke != null) {
    throw new Error("flcm.svg: colors are baked into the SVG markup — fill/stroke don't apply. Edit the markup's own colors, or use flcm.path({ d, fill }) for a themeable vector.");
  }
  // After the fill/stroke special-case (its tailored message beats a generic "unknown prop") — reject the rest.
  rejectUnknownKeys(props, SVG_KEYS, "flcm.svg");
  const wn = mintWriteNode("VECTOR");
  wn.svg = markup;
  base(wn, props);
  compileBindings(wn, props, ANY_NODE_BINDINGS, "flcm.svg");
  const layout = buildLayout(props as FrameProps, "VECTOR", "flcm.svg");
  if (Object.keys(layout).length) wn.layout = layout;
  return sealWriteNode(wn);
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
  const wn = mintWriteNode("VECTOR");
  wn.pathData = d;
  compileNodeLocalProps(wn, props, {}); // fill/stroke/strokeWidth/effects/rotation + base; radius/clip off for a vector
  compileBindings(wn, props, ANY_NODE_BINDINGS, "flcm.path");
  const layout = buildLayout(props as FrameProps, "VECTOR", "flcm.path");
  if (Object.keys(layout).length) wn.layout = layout;
  return sealWriteNode(wn);
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
  opts = opts ?? {};
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
// flcm.effects returns), or a CSS WriteEffects bag — all converge on EffectSpec[].
//
// The two string/object vocabularies are SPLIT, not routed: one read `effects` value carries both at once
// (a frame with a drop shadow AND native glass reads back as { boxShadow, glass }), so picking a single
// path by "does this look CSS?" would reject exactly the shape `get` hands back. The closed-set reject runs
// ONCE over the union first — parseCssEffects reads a positive list, so without a gate a typo beside a real
// CSS key would vanish silently; and gating after the split would name the half the typo fell into rather
// than `effects`, where it was written, with only half the legal vocabulary listed.
function normalizeEffects(v: EffectsInput): EffectSpec[] {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object") throw new Error("flcm: effects must be an object — got " + JSON.stringify(v) + ".");
  rejectUnknownKeys(v, EFFECTS_INPUT_KEYS, "effects");
  const bag = v as Record<string, unknown>;
  const css: Record<string, unknown> = {};
  const sugar: Record<string, unknown> = {};
  for (const k of Object.keys(bag)) (CSS_EFFECTS_KEYS.has(k) ? css : sugar)[k] = bag[k];
  const out: EffectSpec[] = [];
  if (Object.keys(css).length) out.push(...parseCssEffects(css as WriteCssEffects));
  if (Object.keys(sugar).length) out.push(...effects(sugar as EffectsSugar));
  return out;
}

// Gather every image url in the tree — from EVERY paint-bearing location the bridge later resolves through
// paintOf (node fills/strokes AND per-run fills), so render() can check which still need server-fetched
// bytes before it creates a single node. This must stay in lockstep with paintOf's coverage: a paint site
// paintOf resolves but this misses would fetch nothing, then hit the "no bytes" throw at render.
function collectImageUrls(tree: WriteProps): string[] {
  const urls: string[] = [];
  const addFrom = (paints: readonly PaintSpec[] | undefined): void => {
    // `"url" in spec` is the whole hash-vs-url branch: a hash-backed image already names bytes in the
    // document, so including it here would ask the server to fetch a string that is not a source.
    if (paints) for (const spec of paints) if (spec && spec.kind === "image" && "url" in spec) urls.push(spec.url);
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

// Fetch bytes for every image paint in `trees` through the host channel (protocol 2), in ONE deduped
// awaitable request, BEFORE any canvas write — a fetch failure (blocked url, oversize, unreachable)
// aborts with zero mutations. The await is the run's suspension point (the sandbox suspends while the
// plugin relays the WS round-trip); a cancelled or disconnected run dies here when the host rejects
// its pending fetch. Shared by render (one tree) and the edit verbs (a delta's fill/stroke) — the
// walk reads only paint sites, so WriteProps (no type discriminant) is the honest input.
//
// Plural because ONE VERB OWES ONE ROUND TRIP: a batch of deltas dedupes across every entry, so ten
// entries sharing an image url fetch it once and the batch has a single suspension point.
export async function fetchImagesForTrees(trees: readonly WriteProps[]): Promise<Record<string, string>> {
  const all: string[] = [];
  for (const tree of trees) for (const url of collectImageUrls(tree)) all.push(url);
  const urls = Array.from(new Set(all));
  if (!urls.length) return {};
  return requestHostImages(urls);
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
// these plus `render` (render.ts) and `edit` (edit.ts), both of which import FROM this module, so
// defining either here would be a cycle — and holds the one exhaustive `satisfies Flcm` drift guard
// against the schema's typed surface. Nothing else in the preamble is re-exported, so every other
// helper stays closure-private. `get`/`find`/`findOne`/`selection` are defined in read.ts (the
// figma.*-speaking read walk) and surface here.
export { frame, text, rect, ellipse, line, svg, path, instance, gradient, image, effects, get, find, findOne, selection, id };
