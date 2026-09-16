import { FLOW_ALIGNMENT_GUIDANCE } from "./layout-mode.js";
import { acceptAuthoringProps } from "./authoring-input.js";
import { gridAliasKeys } from "./input-aliases.js";
import { parseGridTracks, parseGridPlacement } from "./grid-tracks.js";
import { normalizeVectorPaths } from "./path.js";
import { compileBounds, BOUND_KEYS } from "./size-bounds.js";
import { compileAnnotations } from "./annotations.js";
import {
  WriteNode, WriteProps, WriteChild, WriteLayout, WriteTextStyle, WriteTextRun, WritePaint, WritePaintStack,
  GradientStop, WriteEffect, Sizing, Edges, WriteCssEffects, PinX, PinY, AnchorX, AnchorY,
  Justify, Align, TextAlign, TextDecoration, WriteTextCase, RawIdRef, WriteType, Target,
  ComponentPropertyInput, OverrideDeltaInput, ComponentPropertyBinding, ComponentPropertyDefinitionEdit,
} from "./ir.js";
import { assertLayoutRealizableForType, assertGridSizing } from "./layout-legality.js";
import { parseInlineMarkdown, MdSegment } from "./markdown.js";
import { linearGradient, radialGradient } from "./paint.js";
import { layerBlurFromCssPx, backgroundBlurFromCssPx, shadow, glass, noise, texture, progressiveBlur } from "./effects.js";
import { parseColor, parseFill, parseCssEffects, parseBlendMode, boxShorthand, length, lineHeight, letterSpacing, isPercent, percent } from "./css.js";
import { requestHostImages } from "./host.js";
import { get, find, findOne, selection } from "./read.js";
import { rejectUnknownKeys, rejectNonDeltaWords, own } from "./validate.js";
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

// These zod-free key sets mirror schema.ts; the drift test compares every field group.
export const KNOWN_KEYS = {
  annotation: ["annotations"],
  shared: ["name", "key", "opacity", "mixBlendMode", "visible", "locked"],
  edit: [...gridAliasKeys("all"), "exposed", ...BOUND_KEYS, "clipsContent", "fontSize", "annotations", "name", "opacity", "mixBlendMode", "visible", "locked", "fill", "stroke", "strokeWidth", "strokeAlign", "borderRadius", "effects", "rotation", "clip", "width", "height", "left", "top", "position", "anchor", "pin", "layout", "text", "textStyle", "boldWeight", "componentProperties", "overrides", "componentId", "componentPropertyReferences", "description", "propertyDefinitions"],
  size: [...gridAliasKeys("child"), "layout", ...BOUND_KEYS, "width", "height", "left", "top", "position", "anchor", "pin"],
  placement: [...gridAliasKeys("child"), "layout", "left", "top", "position", "anchor", "pin"],
  appearance: ["fill", "stroke", "strokeWidth", "strokeAlign", "borderRadius", "effects", "rotation"],
  ellipse: ["fill", "stroke", "strokeWidth", "strokeAlign", "effects", "rotation"],
  frame: [...gridAliasKeys("container"), "layout", "clip", "clipsContent"],
  layout: [...gridAliasKeys("all"), "gridTemplateColumns", "gridTemplateRows", "gridColumn", "gridRow", "justifySelf", "alignSelf", "zIndex", "mode", "gap", "wrap", "padding", "justifyContent", "alignItems"],
  childLayout: [...gridAliasKeys("child"), "gridColumn", "gridRow", "justifySelf", "alignSelf", "zIndex"],
  containerLayout: [...gridAliasKeys("container"), "mode", "gridTemplateColumns", "gridTemplateRows", "gap", "wrap", "padding", "justifyContent", "alignItems"],
  text: ["text", "textStyle", "fill", "boldWeight", "fontSize"],
  textStyle: ["fontFamily", "fontWeight", "fontSize", "fontStyle", "lineHeight", "letterSpacing", "textDecoration", "textTransform", "fontVariant", "textAlign", "textAlignVertical", "paragraphSpacing", "paragraphIndent", "listSpacing", "hyperlink", "lineClamp"],
  run: ["fontWeight", "fontSize", "fontFamily", "fontStyle", "lineHeight", "letterSpacing", "textDecoration", "textTransform", "fontVariant", "paragraphSpacing", "paragraphIndent", "listSpacing", "color", "hyperlink"],
  line: [...gridAliasKeys("child"), "layout", "stroke", "strokeWidth", "width", "rotation", "left", "top", "position", "anchor", "pin"],
  path: ["vectorPaths", "d", "fill", "stroke", "strokeWidth", "strokeAlign", "effects", "rotation"],
  instance: ["componentProperties", "overrides", "exposed"],
  swap: ["componentId"],
  slotContent: ["children"],
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
// which FIELDS a given type may bind is the per-compiler list below (compileBindingBag), not the
// key set — the word itself is universal.
const FRAME_KEYS = keySet(KNOWN_KEYS.annotation, KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.appearance, KNOWN_KEYS.frame, KNOWN_KEYS.binding);
const TEXT_KEYS = keySet(KNOWN_KEYS.annotation, KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.text, KNOWN_KEYS.binding);
const SHAPE_KEYS = keySet(KNOWN_KEYS.annotation, KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.appearance, KNOWN_KEYS.binding);
const ELLIPSE_KEYS = keySet(KNOWN_KEYS.annotation, KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.ellipse, KNOWN_KEYS.binding);
const LINE_KEYS = keySet(KNOWN_KEYS.annotation, KNOWN_KEYS.shared, KNOWN_KEYS.line, KNOWN_KEYS.binding);
const INSTANCE_KEYS = keySet(KNOWN_KEYS.annotation, KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.appearance, KNOWN_KEYS.frame, KNOWN_KEYS.instance, KNOWN_KEYS.binding);
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
// PLUS the one word that exists only inside an override: `children` at a SLOT's path fills the
// slot. Not an edit word on any node type — a bound frame in the definition grows through
// `append`, and the SLOT node's own child list is stated whole, from the instance, or grown
// with the structural verbs. Which path is a slot is the document's to say (instance.ts).
export const SLOT_CONTENT_WORD = KNOWN_KEYS.slotContent[0];
const OVERRIDE_DELTA_KEYS = keySet(KNOWN_KEYS.edit.filter((k) => !DOCUMENT_RESOLVED_EDIT_WORDS.has(k)), KNOWN_KEYS.slotContent);
// The per-type authored vocabulary, checked against the prop schemas in the drift test.
export const NODE_KEYS_BY_TYPE: Record<"FRAME" | "TEXT" | "RECTANGLE" | "ELLIPSE" | "LINE" | "INSTANCE", ReadonlySet<string>> = {
  FRAME: FRAME_KEYS, TEXT: TEXT_KEYS, RECTANGLE: SHAPE_KEYS, ELLIPSE: ELLIPSE_KEYS, LINE: LINE_KEYS, INSTANCE: INSTANCE_KEYS,
};
const PATH_KEYS = keySet(KNOWN_KEYS.annotation, KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.path, KNOWN_KEYS.binding);
const SVG_KEYS = keySet(KNOWN_KEYS.annotation, KNOWN_KEYS.shared, KNOWN_KEYS.size, KNOWN_KEYS.binding);
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
// query. Every compiler + nested object below passes its verb name / path as the `subject`.

// ---- shared prop -> WriteNode compilers ----

// terse pad (number | CSS box shorthand | {x,y} | {top,right,bottom,left}) -> typed edges. The string
// form is the READ shape's spelling ("12px 16px"): `get` returns padding as a CSS shorthand, and without
// it here a `get` result's own layout wouldn't re-author. Inside the object form the edges stay NUMBERS — a "24px"
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
  "flex-start": "start", "flex-end": "end", center: "center", stretch: "stretch", baseline: "baseline",
};
const LAYOUT_MODE = new Set<"none" | "row" | "column" | "grid">(["row", "column", "grid", "none"]);

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

// Compile the read layout bag, including container and grid-child words, into a
// WriteLayout — presence-preserving: a word the author didn't write compiles to nothing. The
// creation default (an omitted mode means free-form) is buildLayout's to inject, NOT this
// function's: edit uses the same compile, and a defaulted mode would turn a gap nudge
// into an auto-layout kill.
function compileLayoutBag(cfg: NonNullable<FrameProps["layout"]>, subject: string): WriteLayout {
  const layout: WriteLayout = {};
  for (const key of ["gridTemplateColumns", "gridTemplateRows"] as const) {
    const raw = cfg[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !raw.trim()) throw new Error(subject + ": " + key + " needs a track template.");
    layout[key] = parseGridTracks(raw, subject);
  }
  for (const key of ["gridColumn", "gridRow"] as const) {
    const raw = cfg[key];
    if (raw === undefined) continue;
    layout[key] = parseGridPlacement(raw, subject + ": " + key);
  }
  for (const key of ["justifySelf"] as const) {
    if (cfg[key] !== undefined) layout[key] = mapCssWord(key, cfg[key], { start: "MIN", center: "CENTER", end: "MAX", auto: "AUTO" } as const);
  }
  if (cfg.alignSelf !== undefined) layout.alignSelf = mapCssWord(subject + ".alignSelf", cfg.alignSelf, { center: "center", stretch: "stretch", start: "start", end: "end", auto: "auto" } as const, " " + FLOW_ALIGNMENT_GUIDANCE);
  if (cfg.zIndex !== undefined) {
    if (!Number.isSafeInteger(cfg.zIndex) || cfg.zIndex < 0) throw new Error(subject + ": zIndex needs a non-negative integer.");
    layout.zIndex = cfg.zIndex;
  }
  if (cfg.mode != null) layout.mode = assertEnum("layout.mode", cfg.mode, LAYOUT_MODE);
  if (cfg.gap != null) {
    const values = typeof cfg.gap === "string" ? cfg.gap.trim().split(/\s+/).map(length) : [cfg.gap];
    if (values.length < 1 || values.length > 2 || values.some(v => typeof v !== "number" || !Number.isFinite(v))) throw new Error("flcm." + subject + ': gap needs a finite number, "Npx", or "row-gap column-gap".');
    layout.gap = values.length === 1 || values[0] === values[1] ? values[0] : { row: values[0], column: values[1] };
  }
  if (cfg.wrap !== undefined) {
    if (typeof cfg.wrap !== "boolean") throw new Error("flcm." + subject + ": wrap must be a boolean.");
    layout.wrap = cfg.wrap;
  }
  if (cfg.padding != null) layout.padding = padEdges(cfg.padding);
  // The space-around/evenly hint is primary-axis-only (a justify-content notion), so only justifyContent carries it.
  if (cfg.justifyContent != null) layout.justifyContent = mapCssWord("layout.justifyContent", cfg.justifyContent, JUSTIFY_CONTENT, " Figma auto-layout can't realize CSS space-around/space-evenly; add gap/padding for spacing instead.");
  if (cfg.alignItems != null) layout.alignItems = mapCssWord("layout.alignItems", cfg.alignItems, ALIGN_ITEMS);
  return layout;
}

// All node layout inputs compile once after the per-type vocabulary gate. LINE has only fixed width.
export function compileNodeLayout(props: Omit<SizeProps, "layout"> & { layout?: FrameProps["layout"] }, nodeType: string, subject: string): WriteLayout | undefined {
  const layout = props.layout == null ? {} : compileLayoutBag(props.layout, subject + ".layout");
  if (nodeType === "LINE") Object.assign(layout, compileLineWidth(props));
  else {
    applySizing(props, layout);
    const bounds = compileBounds(props);
    if (bounds) layout.bounds = bounds;
  }
  applyPlacement(layout, props);
  applyPin(layout, props);
  return Object.keys(layout).length ? layout : undefined;
}

// A LINE sizes on one word, `width` — its length. A number, or "fill" to take the length from a
// row/column parent's flow (a divider spanning its column, which layout-legality.ts gates on the
// parent). Compiled here so LINE and an edit delta reject the other sizing intents with the SAME
// error: "hug" and a percent read as a size on every other node, and on a line they'd become nothing.
export function compileLineWidth(props: Pick<LineProps, "width">): WriteLayout | undefined {
  const w = props.width;
  if (w == null) return undefined;
  if (w === "fill") return { sizing: { horizontal: "fill" } };
  if (w === "hug" || isPercent(w)) {
    throw new Error('flcm: a LINE\'s width is its length — "hug" and "N%" have no meaning on a line, which has no content to hug and no cell to measure against. Use a number, or "fill" under a row or column. Got ' + JSON.stringify(w) + ".");
  }
  let px: number;
  try {
    px = length(w);
  } catch {
    throw new Error('flcm: `width` on a LINE must be a number or "Npx" — got ' + JSON.stringify(w) + ".");
  }
  // The sizing intent must say "fixed": the parent policy’s clearFill keys the un-fill off it, so a width edit on a
  // live line someone set to grow (layoutGrow 1 — authorable in the Figma UI, not in flcm) actually takes
  // over from the fill.
  return { sizing: { horizontal: "fixed" }, dimensions: { width: px } };
}

function buildLayout(props: FrameProps, nodeType: WriteType, subject: string): WriteLayout {
  const layout = compileNodeLayout(props, nodeType, subject) || {};
  if (nodeType === "FRAME" && layout.mode == null) layout.mode = "none";
  // The shared per-type legality authority (layout-legality.ts) — the same call edit's live gate
  // makes, so a word that rejects on edit rejects identically here instead of silently not landing.

  assertLayoutRealizableForType(nodeType, layout, undefined, subject);
  assertGridSizing(layout, undefined, subject);
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
function base(wn: WriteProps, props: BaseProps & { annotations?: unknown }): void {
  if (props.annotations !== undefined) wn.annotations = compileAnnotations(props.annotations);
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

// THE paint-word compile, shared by every compiler and edit's deltas so values and rejections
// can't drift between verbs. Every paint word produces a STACK (ir.ts WritePaintStack), top first —
// one paint is the one-element case, and an ARRAY is the stack read and write share: a photo under a
// legibility scrim is `[flcm.gradient({...}), flcm.image(url)]`, the first entry on top, which is the
// order `get` returns so a read pastes straight back.
//
// "none" is the removal word (CSS's own absence spelling): an EMPTY stack is the compiled "clear this"
// — distinct from an ABSENT one, which means "don't touch it". Create writing [] onto a fresh node
// clears a live seeded default; the distinction exists for edit. An empty array spells the same thing.
//
// A bad entry inside a stack is named by index in the AUTHORED order, so the refusal points at the
// entry as written rather than at wherever it lands in Figma's own (reversed) storage order.
export function compilePaintWord(value: NonNullable<AppearanceProps["fill"]>, subject: string): WritePaintStack {
  if (value === "none") return [];
  if (Array.isArray(value)) return value.map((leaf, i) => parseFill(leaf, subject + "[" + i + "]"));
  return [parseFill(value, subject)];
}

function compileFrame(props: FrameProps): WriteNode {
  props = acceptAuthoringProps(props, { type: "FRAME", verb: "create", known: FRAME_KEYS, subject: "FRAME" }) as FrameProps;
  const wn: WriteNode = { type: "FRAME" };
  compileNodeLocalProps(wn, props, { radius: true, clip: true });
  compileBindings(wn, props, FRAME_BINDINGS, "FRAME");
  wn.layout = buildLayout(props, "FRAME", "FRAME");
  return wn;
}

// Component targets share one grammar across instance specs, swaps, and component/variants subjects — so they refuse the same
// non-targets with the same sentence. Exported for component.ts, which meets the same shapes.
export function isTargetShaped(value: unknown): value is Target {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as { __flcmId?: unknown; id?: unknown };
  return typeof v.__flcmId === "string" || typeof v.id === "string";
}

export const COMPONENT_TARGET_HINT = "a component's node id (a read's `componentId`), an flcm/key, flcm.id(id), or a handle from flcm.find";

// INSTANCE(component, props) — stamp a component. Document-blind like every compiler: the component
// target, the property values and the override deltas ride the WriteNode RAW (ir.ts WriteProps on why),
// and render resolves them against the live document (instance.ts) before any write.
// What IS judged here is everything the document can't change: the root words' vocabulary and values
// (they compile exactly as a frame's do), the SHAPE of the two component bags, and each override
// delta's words — the same document-blind gate edit's stage 1 runs on a delta.
//
// PRESENCE-PRESERVING, unlike FRAME: no `layout.mode: "none"` default, no transparent-fill
// default, no hug default. An instance's root already has every value from its component, and a
// creation default written onto it would be a root-level override the author never asked for — the
// instance would stop tracking the component on that field. Only a named word becomes an override.
function compileInstance(props: InstanceProps & { componentId: Target }): WriteNode {
  const { componentId: component, ...bag } = props;
  if (!isTargetShaped(component)) {
    throw new Error("INSTANCE: the component must be " + COMPONENT_TARGET_HINT + " — got " + JSON.stringify(component) + ".");
  }
  const accepted = acceptAuthoringProps(bag, { type: "INSTANCE", verb: "create", known: INSTANCE_KEYS, subject: "INSTANCE" }) as InstanceProps;
  const wn: WriteNode = { type: "INSTANCE" };
  wn.component = component;
  if (accepted.exposed !== undefined) { assertScalarType(accepted.exposed, "boolean", "exposed"); wn.exposed = accepted.exposed; }
  compileNodeLocalProps(wn, accepted, { radius: true, clip: true });
  const layout = compileNodeLayout(accepted, "INSTANCE", "INSTANCE") || {};
  // The type rule (hug needs auto-layout, gap needs a container) is NOT run here: whether this root is
  // a row/column is the COMPONENT's fact, read in render's prepare — the same live-mode call edit makes.
  if (Object.keys(layout).length) wn.layout = layout;
  compileBindings(wn, accepted, INSTANCE_BINDINGS, "INSTANCE");
  if (accepted.componentProperties != null) wn.componentProperties = compileComponentPropertyBag(accepted.componentProperties, "INSTANCE");
  if (accepted.overrides != null) wn.overrides = compileOverrideBag(accepted.overrides, "INSTANCE");
  return wn;
}

// The property bag's SHAPE: an object of names to scalars or component targets. Which names exist,
// what type each takes and which variant combinations are real are the component's to say, at
// prepare. A null value is refused here rather than treated as absence: unlike a compiler word,
// a property has no "unset" — the read never reports one as null, and a null would either
// silently keep the default or throw inside Figma's setter.
//
// `subject` is the verb that met the bag — INSTANCE at construction, flcm.edit/editMany when a
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
    if (own(delta as Record<string, unknown>, SLOT_CONTENT_WORD) !== undefined) assertSlotContentShape((delta as Record<string, unknown>)[SLOT_CONTENT_WORD], at);
    out[path] = delta as OverrideDeltaInput;
  }
  return out;
}

function assertSlotContentShape(raw: unknown, at: string): void {
  if (!Array.isArray(raw)) throw new Error(at + ".children must be an array of node specs.");
}

// ---- the BINDING word (`componentPropertyReferences`) ----
//
// Which component property drives which of this node's fields. The compiler judges SHAPE and
// per-type legality only: the names point at properties an flcm.component call declares in the same
// breath, so whether a name exists (and whether its TYPE matches the field) is that verb's prepare
// to say — the same split `componentProperties` takes.

// Why each field belongs to the one compiler it does, for the refusal's second sentence. `visible`
// has no entry: every node has one, so it is never the wrong node's word.
const BINDING_FIELD_OWNERS: Record<string, string> = {
  text: "`text` drives a TEXT node's content, so it belongs to TEXT",
  componentId: "`componentId` is an instance-swap property re-pointing an INSTANCE, so it belongs to INSTANCE",
  slot: "`slot` marks the FRAME that IS the slot (an instance shows it as a SLOT holding that frame's content), so it belongs to FRAME",
};

// Which fields each compiler may bind — `visible` everywhere, the other three only on the node
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
 * Which fields a LIVE node of this type may bind — the same per-type rule the compilers carry,
 * read off the document instead of off the verb, so `flcm.edit(sublayer, { componentPropertyReferences })`
 * and `TEXT(…, { componentPropertyReferences })` refuse the same field on the same node.
 */
export function bindingFieldsForType(type: string): readonly string[] {
  if (type === "FRAME") return FRAME_BINDINGS;
  if (type === "TEXT") return TEXT_BINDINGS;
  if (type === "INSTANCE") return INSTANCE_BINDINGS;
  return ANY_NODE_BINDINGS;
}

// The per-field legality half, shared by the create bag and the edit bag so a field on the wrong
// node type reads the same either way. `what` is what the refusal calls the thing that can't bind
// it — a compiler name at create ("TEXT"), the live node's type under edit ("a TEXT").
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
 * a compiler: "`slot` is not one of a TEXT's binding fields".
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

// The compiler-side half: compile the bag (when named) onto the WriteNode. An empty bag lands
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
 * behind it. Called by every tree-taking verb except flcm.component (which mints the names), and by
 * an insert once it knows its destination is NOT inside a component (component-edit.ts).
 */
export function assertNoComponentPropertyBindings(tree: WriteChild, subject: string): void {
  if (!tree || typeof tree !== "object") return;
  if (tree.componentPropertyReferences) {
    throw new Error(
      subject + ": `componentPropertyReferences` binds a node to a component property, and nothing here declares one — a binding means something only with a component behind it. " +
        "Either build the component in one call (flcm.component(node, { propertyDefinitions: … }), which declares the properties the tree binds), " +
        "or insert this into a COMPONENT that already declares them (flcm.append(component, node)). To place a copy of a component, use INSTANCE.",
    );
  }
  for (const child of tree.children || []) assertNoComponentPropertyBindings(child, subject);
}

// Component target syntax is shared by new instances and swaps; prepare resolves live identity.
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

// Read-shape text leaves that are NOT authoring input, so a spread `{ ...node.textStyle, fontSize: 18 }`
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

// The textStyle word compile every text carrier rides — TEXT's base and an edit delta alike
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

// The text prop compiles to plain content or styled runs for both create and edit. Both the runs-array and plain-string forms flow through the markdown parser (markdown.ts):
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
  return { runs: segs.map((seg) => compileRun(seg.text, mergeDelta(seg, {}, boldWeight), base, "TEXT run")) };
}

function compileText(props: TextProps): WriteNode {
  props = acceptAuthoringProps(props, { type: "TEXT", verb: "create", known: TEXT_KEYS, subject: "TEXT" }) as TextProps;
  const content = props.text;
  const wn: WriteNode = { type: "TEXT" };
  base(wn, props);
  compileBindings(wn, props, TEXT_BINDINGS, "TEXT");
  // The text's paint is `fill`, like every other node's. "none" is the same removal word edit takes.
  if (props.fill != null) wn.fills = compilePaintWord(props.fill, "fill");
  const cfg = (props.textStyle ?? {}) as NonNullable<TextProps["textStyle"]>;
  const ts = compileTextStyleWords(cfg, "TEXT.textStyle");
  if (Object.keys(ts).length) wn.textStyle = ts;
  Object.assign(wn, compileTextContent(content, ts, props.boldWeight ?? undefined));
  // lineClamp "none" at create is the explicit default — no clamp to remove, nothing lands.
  if (cfg.lineClamp != null && cfg.lineClamp !== "none") wn.maxLines = assertLineClamp(cfg.lineClamp, props.width);
  const layout = buildLayout(props as FrameProps, "TEXT", "TEXT");
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
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
  const n = assertLineClampCount(lineClamp, "TEXT");
  const bounded = typeof width === "number" || width === "fill" || isPercent(width);
  if (!bounded) {
    throw new Error('TEXT: textStyle.lineClamp needs a bounded width to truncate against — set width to a number, "fill", or "N%". A width-hugging text grows on one line, so there is nothing to wrap and clamp.');
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

// TEXT takes PLAIN text OR a runs array (see compileRuns); an object arriving first is the props —
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
    throw new Error("TEXT: this text carries figma-mcp style-ref tokens ({tsN}…{/tsN}) — a read artifact. Strip the inline styling, or express the styling as a runs array.");
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
    throw new Error("TEXT: a runs array must be non-empty — pass at least one run (a string or a [text, style] tuple).");
  }
  const out: WriteTextRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    let raw: string;
    let delta: StyleDeltaInput;
    if (typeof run === "string") { raw = run; delta = {}; }
    else if (Array.isArray(run) && typeof run[0] === "string") { raw = run[0]; delta = run[1] ?? {}; }
    else {
      throw new Error('TEXT: each run is a plain string or a [text, style] tuple like ["bold bit", { fontWeight: 700 }] — got ' + JSON.stringify(run) + ".");
    }
    // The run delta is the grounded silent-drop site: compileRun reads a positive list and never looked at
    // the rest, so a typo'd `textTransfrom` on a run vanished. Reject it here, on the raw author delta.
    rejectUnauthorableTextLeaves(delta, `TEXT run[${i}]`, REFUSED_RUN_TEXT_LEAVES);
    rejectUnknownKeys(delta, RUN_INPUT_KEYS, `TEXT run[${i}]`);
    for (const seg of parseInlineMarkdown(assertNotReadToken(raw))) {
      out.push(compileRun(seg.text, mergeDelta(seg, delta, boldWeight), baseStyle, `TEXT run[${i}]`));
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
  const subject = type === "RECTANGLE" ? "RECTANGLE" : "ELLIPSE";
  // An ELLIPSE has no corners, so its vocabulary has no radius word (schema ELLIPSE_FIELDS): refused by
  // the gate, not accepted and dropped on the floor.
  const known = type === "RECTANGLE" ? SHAPE_KEYS : ELLIPSE_KEYS;
  props = acceptAuthoringProps(props, { type, verb: "create", known, subject }) as ShapeProps;
  const wn: WriteNode = { type };
  compileNodeLocalProps(wn, props, { radius: type === "RECTANGLE" });
  compileBindings(wn, props, ANY_NODE_BINDINGS, subject);
  const layout = buildLayout(props as FrameProps, type, subject);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

function compileRectangle(props?: ShapeProps | SimplifiedNode): WriteNode { return shape("RECTANGLE", props); }
function compileEllipse(props?: EllipseProps | SimplifiedNode): WriteNode { return shape("ELLIPSE", props); }

function compileLine(props: LineProps | SimplifiedNode = {}): WriteNode {
  props = props ?? {};
  props = acceptAuthoringProps(props, { type: "LINE", verb: "create", known: LINE_KEYS, subject: "LINE" }) as LineProps;
  const wn: WriteNode = { type: "LINE" };
  base(wn, props);
  compileBindings(wn, props, ANY_NODE_BINDINGS, "LINE");
  if (props.stroke != null) wn.strokes = compilePaintWord(props.stroke, "stroke");
  if (props.strokeWidth != null) wn.strokeWeight = length(props.strokeWidth);
  const layout = compileNodeLayout(props, "LINE", "LINE") || {};
  // line() is the one compiler that doesn't ride buildLayout (width-only sizing), so it consults
  // the shared authority itself — no rule fires on a width-only layout today, but a future LINE-keyed
  // rule must not end up edit-only (the asymmetry this module forbids).
  assertLayoutRealizableForType("LINE", layout, undefined, "LINE");
  if (Object.keys(layout).length) wn.layout = layout;
  if (props.rotation != null) { assertScalarType(props.rotation, "number", "rotation"); wn.rotation = props.rotation; }
  return wn;
}

// ---- Vector verbs. Two contracts, deliberately not interchangeable (see ir.ts WriteNode.svg/pathData):
// svg pastes opaque markup (colors baked in); path is a single themeable vector taking our appearance props.

// Opaque SVG markup imports through createNodeFromSvg, which yields a native frame.
// Colors live in the markup, so fill/stroke DON'T apply — accepting them silently would be the exact no-op
// ADR-0003 forbids, so reject them loud. The markup must look like an <svg> document (catches a URL/path
// passed by mistake); the render-time parse (bridge) is the second, authoritative fail-loud.
function compileSvg(markup: unknown, props: SvgProps = {}): WriteNode {
  props = props ?? {};
  if (typeof markup !== "string" || !/<svg[\s>]/i.test(markup)) {
    throw new Error("VECTOR: expected SVG markup containing an <svg> element — got " + JSON.stringify(markup) + ". For a themeable single-path vector use { type: " + JSON.stringify("VECTOR") + ", d } instead.");
  }
  const p = props as AppearanceProps;
  if (p.fill != null || p.stroke != null) {
    throw new Error("VECTOR: colors are baked into the SVG markup — fill/stroke don't apply. Edit the markup's own colors, or use a VECTOR spec with d and fill for a themeable vector.");
  }
  // After the fill/stroke special-case (its tailored message beats a generic "unknown prop") — reject the rest.
  rejectUnknownKeys(props, SVG_KEYS, "VECTOR");
  const wn: WriteNode = { type: "VECTOR" };
  wn.svg = markup;
  base(wn, props);
  compileBindings(wn, props, ANY_NODE_BINDINGS, "VECTOR");
  const layout = buildLayout(props as FrameProps, "VECTOR", "VECTOR");
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// A path spec creates a native vector with vectorPaths. It takes
// the shared appearance props via compileNodeLocalProps() (radius off — a vector has none), so it themes like a rect.
// `d` is required and must be a non-empty string; bad path data fails loud again at render (bridge).
function compilePath(props: PathProps): WriteNode {
  props = acceptAuthoringProps(props, { type: "VECTOR", verb: "create", known: PATH_KEYS, subject: "VECTOR" }) as PathProps;
  if (!props || typeof props !== "object") {
    throw new Error("VECTOR: expected a props object with a `d` path string, e.g. { type: \"VECTOR\", d: \"M12 2 L22 20 L2 20 Z\", fill: \"#111\" } — got " + JSON.stringify(props) + ".");
  }
  const d = props.d;
  if (props.vectorPaths === undefined && (typeof d !== "string" || !d.trim())) {
    throw new Error("VECTOR: `d` (SVG path data) must be a non-empty string — got " + JSON.stringify(d) + ".");
  }
  rejectUnknownKeys(props, PATH_KEYS, "VECTOR");
  const wn: WriteNode = { type: "VECTOR" };
  if (props.vectorPaths !== undefined) {
    if (d !== undefined) throw new Error("VECTOR needs exactly one of d or vectorPaths.");
    wn.vectorPaths = normalizeVectorPaths(props.vectorPaths);
  } else wn.pathData = d;
  compileNodeLocalProps(wn, props, {}); // fill/stroke/strokeWidth/effects/rotation + base; radius/clip off for a vector
  compileBindings(wn, props, ANY_NODE_BINDINGS, "VECTOR");
  const layout = buildLayout(props as FrameProps, "VECTOR", "VECTOR");
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// ---- gradient() sugar: a structured bag -> typed WritePaint (no string round-trip). The transform math
// lives in paint.ts, shared with css.ts's gradient-string parser, so sugar and hand-written CSS agree.
// GradientSugar / GradientStopInput are defined in schema.ts (the authoring-surface source). ----

function gradient(a: GradientSugar | "linear" | "radial", b?: GradientStopInput[], c?: number): WritePaint {
  // Only the object form carries author-supplied keys to check; the positional form builds a closed bag.
  if (a && typeof a === "object") rejectUnknownKeys(a, GRADIENT_KEYS, "flcm.gradient");
  const sugar: GradientSugar = a && typeof a === "object" ? a : { type: a, stops: b, angle: c };
  const stops = gradientStops(sugar.stops);
  const type = sugar.type || "linear";
  if (type === "linear") return linearGradient(typeof sugar.angle === "number" ? sugar.angle : 180, stops);
  if (type === "radial") {
    const x = sugar.at && sugar.at.x != null ? sugar.at.x : 50;
    const y = sugar.at && sugar.at.y != null ? sugar.at.y : 50;
    return radialGradient("GRADIENT_RADIAL", x, y, stops);
  }
  throw new Error('flcm.gradient: type must be "linear" or "radial" — got ' + JSON.stringify(sugar.type) + ".");
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

// ---- image() paint compiler: a source + intent -> an image WritePaint (a fill value, like
// flcm.gradient). The source is an https url or a local file path (CSS url() takes both; the server
// confines paths to its asset root). The sandbox NEVER touches network or disk — the paint carries only the
// source string; the trusted server loads + validates the bytes and the bridge resolves them to a plugin
// ImagePaint at render (keyed by source). `placeholder` marks a stand-in so a later read can tell it from a
// real asset (bridge persists it on the node). Fails loud on a non-string/empty source or a scaleMode
// outside the set — never a silent blank fill.

const IMAGE_SCALE_MODES = new Set(["FILL", "FIT", "CROP", "TILE"]);

function image(url: unknown, opts: ImageOpts = {}): WritePaint {
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

// ---- effects() sugar: { shadow, blur, backgroundBlur } -> typed WriteEffect[] (no string round-trip).
// Values are CSS px; the blur ×2 factor lives in the *FromCssPx compilers (effects.ts). EffectsSugar /
// ShadowSugar / BlurSugar are defined in schema.ts (the authoring-surface source). ----

function effects(sugar: EffectsSugar): WriteEffect[] {
  if (!sugar || typeof sugar !== "object") {
    throw new Error("flcm.effects: expected { shadow?, blur?, backgroundBlur?, glass?, noise?, texture?, progressiveBlur? } — got " + JSON.stringify(sugar) + ".");
  }
  rejectUnknownKeys(sugar, EFFECTS_KEYS, "flcm.effects");
  const out: WriteEffect[] = [];
  if (sugar.shadow !== undefined) out.push(...sugarShadows(sugar.shadow));
  if (sugar.blur !== undefined) out.push(layerBlurFromCssPx(blurRadius(sugar.blur)));
  if (sugar.backgroundBlur !== undefined) out.push(backgroundBlurFromCssPx(blurRadius(sugar.backgroundBlur)));
  if (sugar.glass !== undefined) out.push(sugarGlass(sugar.glass));
  if (sugar.noise !== undefined) out.push(sugarNoise(sugar.noise));
  if (sugar.texture !== undefined) out.push(sugarTexture(sugar.texture));
  if (sugar.progressiveBlur !== undefined) out.push(sugarProgressiveBlur(sugar.progressiveBlur));
  return out;
}

// ---- Beyond-CSS effect sugar: friendly bag -> typed effect, defaults filled here (the sugar layer owns
// defaults + color parsing, mirroring sugarShadows). `true` gives a usable effect with all defaults.
// Values are raw Figma-domain (no CSS-px scaling) — see ir.ts.

function sugarGlass(g: GlassSugar): WriteEffect {
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

function sugarNoise(n: NoiseSugar): WriteEffect {
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

function sugarTexture(t: TextureSugar): WriteEffect {
  const s = t === true ? {} : t;
  return texture({
    noiseSize: s.noiseSize != null ? s.noiseSize : 3,
    radius: s.radius != null ? s.radius : 6,
    clipToShape: s.clipToShape != null ? s.clipToShape : true,
  });
}

function sugarProgressiveBlur(b: ProgressiveBlurSugar): WriteEffect {
  const s = typeof b === "number" ? { endRadius: b } : b;
  return progressiveBlur({
    startRadius: s.startRadius != null ? s.startRadius : 0,
    radius: s.endRadius != null ? s.endRadius : 20,
    startOffset: s.startOffset || { x: 0, y: 0 },
    endOffset: s.endOffset || { x: 0, y: 1 },
  });
}

function sugarShadows(input: ShadowSugar | ShadowSugar[]): WriteEffect[] {
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

// Accept the sugar bag ({ shadow, blur, backgroundBlur }), an already-typed WriteEffect[] (what
// flcm.effects returns), or a CSS WriteEffects bag — all converge on WriteEffect[].
//
// The two string/object vocabularies are SPLIT, not routed: one read `effects` value carries both at once
// (a frame with a drop shadow AND native glass reads back as { boxShadow, glass }), so picking a single
// path by "does this look CSS?" would reject exactly the shape `get` hands back. The closed-set reject runs
// ONCE over the union first — parseCssEffects reads a positive list, so without a gate a typo beside a real
// CSS key would vanish silently; and gating after the split would name the half the typo fell into rather
// than `effects`, where it was written, with only half the legal vocabulary listed.
function normalizeEffects(v: EffectsInput): WriteEffect[] {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object") throw new Error("flcm: effects must be an object — got " + JSON.stringify(v) + ".");
  rejectUnknownKeys(v, EFFECTS_INPUT_KEYS, "effects");
  const bag = v as Record<string, unknown>;
  const css: Record<string, unknown> = {};
  const sugar: Record<string, unknown> = {};
  for (const k of Object.keys(bag)) (CSS_EFFECTS_KEYS.has(k) ? css : sugar)[k] = bag[k];
  const out: WriteEffect[] = [];
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
  const addFrom = (paints: readonly WritePaint[] | undefined): void => {
    // `"url" in paint` is the whole hash-vs-url branch: a hash-backed image already names bytes in the
    // document, so including it here would ask the server to fetch a string that is not a source.
    if (paints) for (const paint of paints) if (paint && paint.kind === "image" && "url" in paint) urls.push(paint.url);
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
// way). A plain POJO compiler like the others; the resolver (read.resolveTarget) unwraps it —
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
export { compileFrame, compileText, compileRectangle, compileEllipse, compileLine, compileSvg, compilePath, compileInstance, gradient, image, effects, get, find, findOne, selection, id };
