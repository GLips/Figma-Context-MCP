/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// compile-nodes — the per-type prop compilers for every non-TEXT node, and the words they share with
// TEXT and with edit's patch compile: base, appearance, paint slots and layout. Each turns an accepted
// prop bag into the plain WriteNode IR; nothing here touches the document.
import { FLOW_ALIGNMENT_GUIDANCE } from "./layout-mode.js";
import type { Accepted } from "./authoring-input.js";
import { keySet, NESTED_WORDS, WORD_VALUES, type WordValue } from "./vocabulary.js";
import { parseGridTracks, parseGridPlacement } from "./grid-tracks.js";
import { normalizePathData, normalizeVectorPaths } from "./path.js";
import { compileBounds } from "./size-bounds.js";
import { compileAnnotations } from "./annotations.js";
import {
  BuiltNode, WriteProps, WriteLayout, WritePaintStack, Sizing, Edges, ConstraintX, ConstraintY, Justify, Align,
  WriteType, Bindable, CornerRadii, isTokenRef,
} from "./ir.js";
import { assertLayoutRealizableForType, assertGridSizing } from "./layout-legality.js";
import { shadow } from "./effects.js";
import { parseFill, parseBlendMode, boxShorthand, cornerRadii, length, isPercent, percent } from "./css.js";
import { rejectUnknownKeys, own, oneOf, words, assertEnum } from "./validate.js";
import { isTargetShaped, COMPONENT_TARGET_HINT } from "./target.js";
import { isVariableInput, isStyleInput, compileVariableRef, compileStyleRef, compileBindable, refuseTokenInput } from "./tokens.js";
import { pixelRound } from "@framelink/core";
import { normalizeEffects } from "./value-sugar.js";
import { compileBindings, compileComponentPropertyBag, compileOverrideBag } from "./compile-component-words.js";

// The authoring surface (verb Props + gradient/effects sugar) is defined ONCE in schema.ts as zod schemas
// with per-field docs; these are the z.infer'd types. Imported `import type` ONLY so schema.ts's zod is
// erased by esbuild and never reaches the sandbox bundle. Change a prop by editing the schema, not here.
import type {
  BaseProps, SizeProps, AppearanceProps, FrameProps, ShapeProps, EllipseProps, LineProps, PathProps, SvgProps,
  InstanceProps, PadInput, EffectsInput,
} from "./schema.js";

const CONSTRAINT_KEYS = keySet(NESTED_WORDS.constraints);

// The closed-set reject (rejectUnknownKeys) lives in validate.ts — one gate shared with read.ts's locate
// query. Every compiler + nested object below passes its verb name / path as the `subject`.

// ---- shared prop -> WriteNode compilers ----

// terse pad (number | CSS box shorthand | {x,y} | {top,right,bottom,left}) -> typed edges. The string
// form is the READ shape's spelling ("12px 16px"): `get` returns padding as a CSS shorthand, and without
// it here a `get` result's own layout wouldn't re-author. Inside the object form the edges stay NUMBERS — a "24px"
// there once dropped silently to zero on every side, and that reject stays (ADR-0003 fail-loud).
const PAD_KEYS = keySet(NESTED_WORDS.pad);
const GAP_KEYS = keySet(NESTED_WORDS.gap);

function padEdges(pad: PadInput): Edges<Bindable> {
  if (typeof pad === "number") return { top: pad, right: pad, bottom: pad, left: pad };
  if (typeof pad === "string") return boxShorthand(pad, "pad");
  // One variable binds all four sides — the same token each side would name on its own.
  if (isVariableInput(pad)) {
    const ref = compileVariableRef(pad, "pad", "FLOAT");
    return { top: ref, right: ref, bottom: ref, left: ref };
  }
  if (pad == null || typeof pad !== "object" || Array.isArray(pad)) {
    throw new Error('flcm: pad must be a number, a CSS box shorthand string ("12px 16px"), { variable }, or an object ({ x, y } or { top, right, bottom, left }) — got ' + JSON.stringify(pad) + ".");
  }
  rejectUnknownKeys(pad, PAD_KEYS, "pad");
  const edge = (v: unknown, name: string): Bindable | undefined => {
    if (v == null) return undefined;
    // Rides length(), like every other metric: a number or "Npx", and anything else fails loud there.
    return compileBindable(v, "pad." + name, "FLOAT", (literal: number | string) => {
      try {
        return length(literal);
      } catch {
        throw new Error("flcm: pad." + name + ' must be a number or "Npx" (or { variable }), got ' + JSON.stringify(literal) + ".");
      }
    });
  };
  const p = pad as Record<string, unknown>;
  const y = edge(p.y, "y"), x = edge(p.x, "x");
  const top = edge(p.top, "top"), right = edge(p.right, "right");
  const bottom = edge(p.bottom, "bottom"), left = edge(p.left, "left");
  // Specific edge wins over the x/y shorthand; `??` (not `||`) so an explicit 0 isn't treated as unset.
  return { top: top ?? y ?? 0, right: right ?? x ?? 0, bottom: bottom ?? y ?? 0, left: left ?? x ?? 0 };
}

// w/h -> sizing intent + fixed dimensions. A number is a fixed size (carries a dimension); 'fill'/'hug'
// are intents the bridge resolves against the parent / content.
function applySizing(props: SizeProps, layout: WriteLayout): void {
  const sz: { horizontal?: Sizing; vertical?: Sizing } = {};
  const dims: { width?: Bindable; height?: Bindable } = {};
  const pct: { width?: number; height?: number } = {};
  const axis = (val: SizeProps["width"], key: "horizontal" | "vertical", dim: "width" | "height") => {
    if (val === undefined) return;
    if (val === "fill" || val === "hug") sz[key] = val;
    // A bound size is a fixed size whose number the variable supplies.
    else if (isVariableInput(val)) { sz[key] = "fixed"; dims[dim] = compileVariableRef(val, dim, "FLOAT"); }
    // "N%" is a fixed px once resolved against the parent (the bridge folds it in at render), so it sizes
    // "fixed" and carries only the percent intent here.
    else if (isPercent(val)) { sz[key] = "fixed"; pct[dim] = percent(val); }
    // A number or "Npx" — one spelling of the same fixed size, so both ride length().
    else {
      try {
        sz[key] = "fixed";
        dims[dim] = length(val);
      } catch {
        throw new Error('flcm: width/height must be a number, "Npx", "N%", "fill", "hug", or { variable } — got ' + JSON.stringify(val) + ".");
      }
    }
  };
  axis(props.width, "horizontal", "width");
  axis(props.height, "vertical", "height");
  if (sz.horizontal || sz.vertical) layout.sizing = sz;
  if (dims.width != null || dims.height != null) layout.dimensions = dims;
  if (pct.width != null || pct.height != null) layout.percentSize = pct;
}

// The placement words — `left`/`top` and `position` — in the read shape's own spelling. Naming a
// coordinate is what lifts a node out of an auto-layout parent's flow (the IR's position:"absolute";
// under a free-form parent the bridge writes the coordinate natively and the flag is inert), so
// `position: "absolute"` alone is the coordinate-free lift and "none" (edit) is the return to flow.
function applyPlacement(layout: WriteLayout, props: SizeProps): void {
  const { left, top, position } = props;
  if (position != null && !(WORD_VALUES.position as readonly string[]).includes(position)) {
    throw new Error('flcm: position must be "absolute" or "none" — got ' + JSON.stringify(position) + ".");
  }
  if (position === "none") {
    // A node rejoining the flow is placed by the layout, not by coordinates — a coordinate beside
    // "none" is two contradictory claims, refused rather than resolved.
    if (left != null || top != null) {
      throw new Error('flcm: position: "none" returns the node to its parent\'s flow, where the layout places it — `left`/`top` can\'t ride along. Drop them, or drop position: "none".');
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
  if (position === "absolute" || layout.left != null || layout.top != null || layout.percentPos) layout.position = "absolute";
}

// `constraints` validates each axis at the boundary (a bad value fails loud, ADR-0003) so the bridge
// can trust the words it maps to Figma's constraint enum.
const CONSTRAINT_X: ReadonlySet<ConstraintX> = new Set(WORD_VALUES.constraintX);
const CONSTRAINT_Y: ReadonlySet<ConstraintY> = new Set(WORD_VALUES.constraintY);

// justifyContent (primary-axis distribution) and alignItems (counter-axis alignment) — the two container
// enums. The author speaks CSS-total value spellings (flex-start/space-between); these tables map them to
// the terse render intent the IR/bridge carry. Mapping HERE at the describe boundary keeps the CSS-total
// vocabulary an LLM-edge concern (Invariant 2) without pushing inverse translators into the bridge. This is
// also the ONLY runtime gate: schema.ts's zod enum is type/doc-only (never enters the sandbox), and the
// bridge resolves a miss to a silent MIN — so a valid-CSS-but-unrealizable value (space-around/space-evenly)
// would silently no-op without this check (ADR-0003). Figma's primaryAxisAlignItems has no space-around/evenly.
const JUSTIFY_CONTENT: Record<WordValue<"justifyContent">, Justify> = {
  "flex-start": "start", "flex-end": "end", center: "center", "space-between": "between",
};
const ALIGN_ITEMS: Record<WordValue<"alignItems">, Align> = {
  "flex-start": "start", "flex-end": "end", center: "center", stretch: "stretch", baseline: "baseline",
};
const JUSTIFY_SELF: Record<WordValue<"justifySelf">, NonNullable<WriteLayout["justifySelf"]>> = {
  start: "MIN", center: "CENTER", end: "MAX", auto: "AUTO", stretch: "stretch",
};
const ALIGN_SELF: Record<WordValue<"alignSelf">, NonNullable<WriteLayout["alignSelf"]>> = {
  center: "center", stretch: "stretch", start: "start", end: "end", auto: "auto",
};
const LAYOUT_MODE: ReadonlySet<WordValue<"mode">> = new Set(WORD_VALUES.mode);

// TS's Set.has doesn't narrow its argument, so wrap it as a real type guard: a hit proves the string is one
// of the set's literals, letting parseConstraints return the typed axis words with no cast at the call site.
// Own keys only: an agent-supplied word must not reach Object.prototype through a lookup table.
function tableWord<T>(table: Record<string, T>, raw: unknown): T | undefined {
  return typeof raw === "string" ? own(table, raw) : undefined;
}

// Validate `constraints` against its per-axis word sets, returning the typed pair (or undefined when
// neither axis is set). `"none"` is shorthand for clearing both axes.
function parseConstraints(raw: unknown): { x?: ConstraintX; y?: ConstraintY } | undefined {
  if (raw == null) return undefined;
  if (raw === "none") return { x: "none", y: "none" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('flcm: constraints must be an object like { x, y } or "none" — got ' + JSON.stringify(raw) + ".");
  }
  const r = raw as { x?: string; y?: string };
  rejectUnknownKeys(r, CONSTRAINT_KEYS, "constraints");
  const out: { x?: ConstraintX; y?: ConstraintY } = {};
  if (r.x != null) {
    if (!oneOf(CONSTRAINT_X, r.x)) throw new Error("flcm: constraints.x must be one of " + words(CONSTRAINT_X) + " — got " + JSON.stringify(r.x) + ".");
    out.x = r.x;
  }
  if (r.y != null) {
    if (!oneOf(CONSTRAINT_Y, r.y)) throw new Error("flcm: constraints.y must be one of " + words(CONSTRAINT_Y) + " — got " + JSON.stringify(r.y) + ".");
    out.y = r.y;
  }
  return out.x != null || out.y != null ? out : undefined;
}

// Map a CSS-total author word to the Figma-domain value its table names — the container words
// (justifyContent/alignItems, see JUSTIFY_CONTENT/ALIGN_ITEMS for why this gate exists) and the text
// casing words (textTransform/fontVariant). `hint` appends prop-specific guidance; the shared body
// names the realizable CSS spellings.
export function mapCssWord<T extends string>(name: string, raw: unknown, table: Record<string, T>, hint = ""): T {
  const mapped = tableWord(table, raw);
  if (!mapped) {
    const allowed = Object.keys(table).map((w) => '"' + w + '"').join(", ");
    throw new Error("flcm: " + name + " must be one of " + allowed + " — got " + JSON.stringify(raw) + "." + hint);
  }
  return mapped;
}

// constraints -> constraint-override intent on the layout. Only meaningful for a positioned child (a
// free-form parent's, or an out-of-flow one); stored but inert under auto-layout. Never lifts a node out of flow.
function applyConstraintsProp(layout: WriteLayout, props: SizeProps): void {
  const constraints = parseConstraints(props.constraints);
  if (constraints) layout.constraints = constraints;
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
    if (cfg[key] !== undefined) layout[key] = mapCssWord(key, cfg[key], JUSTIFY_SELF);
  }
  if (cfg.alignSelf !== undefined) layout.alignSelf = mapCssWord(subject + ".alignSelf", cfg.alignSelf, ALIGN_SELF, " " + FLOW_ALIGNMENT_GUIDANCE);
  if (cfg.zIndex !== undefined) {
    if (!Number.isSafeInteger(cfg.zIndex) || cfg.zIndex < 0) throw new Error(subject + ": zIndex needs a non-negative integer.");
    layout.zIndex = cfg.zIndex;
  }
  if (cfg.mode != null) layout.mode = assertEnum("layout.mode", cfg.mode, LAYOUT_MODE);
  if (cfg.gap != null) {
    const guidance = "flcm." + subject + ': gap needs a finite number, "Npx", "row-gap column-gap", { variable }, or { row, column }.';
    const finite = (v: Bindable): Bindable => {
      if (!isTokenRef(v) && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(guidance);
      return v;
    };
    const side = (v: unknown, name: string): Bindable => finite(compileBindable(v, subject + ".gap." + name, "FLOAT", length));
    const raw: unknown = cfg.gap;
    if (isVariableInput(raw)) layout.gap = compileVariableRef(raw, subject + ".gap", "FLOAT");
    else if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      rejectUnknownKeys(raw, GAP_KEYS, subject + ".gap");
      const g = raw as { row?: unknown; column?: unknown };
      if (g.row == null || g.column == null) throw new Error(guidance);
      layout.gap = { row: side(g.row, "row"), column: side(g.column, "column") };
    } else {
      const values = typeof raw === "string" ? raw.trim().split(/\s+/).map(length) : [raw as number];
      if (values.length < 1 || values.length > 2) throw new Error(guidance);
      values.forEach(finite);
      layout.gap = values.length === 1 || values[0] === values[1] ? values[0] : { row: values[0], column: values[1] };
    }
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
    compileAspectRatio(props.aspectRatio, layout, subject);
  }
  applyDesignedSize(props as { designedWidth?: unknown; designedHeight?: unknown }, layout);
  applyPlacement(layout, props);
  applyConstraintsProp(layout, props);
  return Object.keys(layout).length ? layout : undefined;
}

// How far a fixed width ÷ height may sit from an authored ratio and still agree: a read rounds both
// sizes and the ratio to 2 decimals, so its own paste-back is off by rounding, never by more.
const ASPECT_RATIO_TOLERANCE = 0.01;

// What can be judged before the node exists: the value, a "hug" axis (its size is its content's,
// so it can't follow a ratio), two filled axes (neither is free to follow) and two fixed sizes that
// disagree. A fixed axis beside an unnamed one derives it here, so the node is built at the ratio;
// the rest settles once every size has landed (bridge.ts settleAspectRatio).
function compileAspectRatio(raw: unknown, layout: WriteLayout, subject: string): void {
  if (raw === undefined) return;
  if (raw === "none") {
    layout.aspectRatio = "none";
    return;
  }
  if (typeof raw !== "number" || !isFinite(raw) || raw <= 0) {
    throw new Error(subject + ': aspectRatio must be a positive number, width ÷ height (16 / 9), or "none" to unlock — got ' + JSON.stringify(raw) + ".");
  }
  const sizing = (layout.sizing ??= {});
  if (sizing.horizontal === "hug" || sizing.vertical === "hug") {
    throw new Error(subject + ': a "hug" axis is sized by its content, so it can\'t follow aspectRatio. Give it a size or "fill", or drop aspectRatio.');
  }
  if (sizing.horizontal === "fill" && sizing.vertical === "fill") {
    throw new Error(subject + ': with both axes "fill" neither is free to follow aspectRatio. Size one of them, or drop aspectRatio.');
  }
  const dims = (layout.dimensions ??= {});
  const width = typeof dims.width === "number" ? dims.width : undefined;
  const height = typeof dims.height === "number" ? dims.height : undefined;
  if (width !== undefined && height !== undefined) {
    if (Math.abs(width / height - raw) > ASPECT_RATIO_TOLERANCE) {
      throw new Error(subject + ": width " + width + " and height " + height + " are a " + pixelRound(width / height) + " ratio, not aspectRatio " + raw + ". Name one size and the ratio derives the other.");
    }
  } else if (width !== undefined && sizing.vertical === undefined) {
    sizing.vertical = "fixed";
    dims.height = width / raw;
  } else if (height !== undefined && sizing.horizontal === undefined) {
    sizing.horizontal = "fixed";
    dims.width = height * raw;
  }
  if (!sizing.horizontal && !sizing.vertical) delete layout.sizing;
  if (dims.width === undefined && dims.height === undefined) delete layout.dimensions;
  layout.aspectRatio = raw;
}

// A read root's designedWidth/designedHeight, kept by acceptAuthoringProps only beside a "fill" axis.
function applyDesignedSize(props: { designedWidth?: unknown; designedHeight?: unknown }, layout: WriteLayout): void {
  const designed: { width?: number; height?: number } = {};
  const axis = (val: unknown, key: "horizontal" | "vertical", dim: "width" | "height", word: string) => {
    if (val == null || layout.sizing?.[key] !== "fill") return;
    try {
      designed[dim] = length(val as string | number);
    } catch {
      throw new Error("flcm: `" + word + '` must be a number or "Npx" — got ' + JSON.stringify(val) + ".");
    }
  };
  axis(props.designedWidth, "horizontal", "width", "designedWidth");
  axis(props.designedHeight, "vertical", "height", "designedHeight");
  if (designed.width != null || designed.height != null) layout.designedSize = designed;
}

// A LINE sizes on one word, `width` — its length. A number, or "fill" to take the length from a
// row/column parent's flow (a divider spanning its column, which layout-legality.ts gates on the
// parent). Compiled here so LINE and an edit delta reject the other sizing intents with the SAME
// error: "hug" and a percent read as a size on every other node, and on a line they'd become nothing.
export function compileLineWidth(props: Pick<LineProps, "width">): WriteLayout | undefined {
  const w = props.width;
  if (w == null) return undefined;
  if (w === "fill") return { sizing: { horizontal: "fill" } };
  if (isVariableInput(w)) return { sizing: { horizontal: "fixed" }, dimensions: { width: compileVariableRef(w, "width", "FLOAT") } };
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

export function buildLayout(props: FrameProps, nodeType: WriteType, subject: string): WriteLayout {
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
export function assertScalarType(value: unknown, want: "string" | "number" | "boolean", prop: string): void {
  if (typeof value !== want) {
    throw new Error("flcm: `" + prop + "` must be a " + want + " — got " + JSON.stringify(value) + ".");
  }
}

// The shared-by-every-node props. Additive: only present props land on the WriteNode.
export function base(wn: WriteProps, props: BaseProps & { annotations?: unknown }): void {
  if (props.annotations !== undefined) wn.annotations = compileAnnotations(props.annotations);
  if (props.name != null) { assertScalarType(props.name, "string", "name"); wn.name = props.name; }
  if (props.key != null) { assertScalarType(props.key, "string", "key"); wn.key = props.key; }
  if (props.opacity != null) wn.opacity = compileBindable(props.opacity, "opacity", "FLOAT", (v: unknown) => { assertScalarType(v, "number", "opacity"); return v as number; });
  if (props.mixBlendMode != null) wn.blendMode = parseBlendMode(props.mixBlendMode);
  if (props.visible != null) { assertScalarType(props.visible, "boolean", "visible"); wn.visible = props.visible; }
  if (props.locked != null) { assertScalarType(props.locked, "boolean", "locked"); wn.locked = props.locked; }
}

// Appearance props shared by frame/rect/ellipse (and edit's delta compile), on top of base(). Every
// CSS-shaped leaf is normalized to the typed currency through css.ts here — presence-preserving by
// construction, so it doubles as the edit patch compiler's core: only present keys produce writes.
// Exported for edit-plan.ts, which imports FROM here — nothing here imports edit-plan, so no cycle.
export function compileNodeLocalProps(wn: WriteProps, props: AppearanceProps, opts: { type: string; radius?: boolean; clip?: boolean }): void {
  base(wn, props);
  if (props.fill != null) compilePaintSlot(wn, props.fill, "fill");
  if (props.stroke != null) compilePaintSlot(wn, props.stroke, "stroke");
  if (props.strokeWidth != null) wn.strokeWeight = compileStrokeWidth(props.strokeWidth, opts.type);
  if (props.strokeAlign != null) wn.strokeAlign = compileStrokeAlign(props.strokeAlign);
  if (props.effects != null) compileEffectsSlot(wn, props.effects);
  if (opts.radius && props.borderRadius != null) wn.borderRadius = compileBorderRadius(props.borderRadius);
  const clip = (props as FrameProps).clip;
  if (opts.clip && clip != null) { assertScalarType(clip, "boolean", "clip"); wn.clip = clip; }
  if (props.rotation != null) { assertScalarType(props.rotation, "number", "rotation"); wn.rotation = props.rotation; }
}

// Figma's IndividualStrokesMixin: only the rectangle-family boxes weigh their sides apart. LINE,
// ELLIPSE and VECTOR have one strokeWeight, so a per-side width there is refused at compile, before
// any canvas write — never dropped or averaged.
const PER_SIDE_STROKE_TYPES: ReadonlySet<string> = new Set(["FRAME", "RECTANGLE", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SLOT"]);

// `strokeWidth` is CSS `border-width`: one value, or the 1–4 value box shorthand read emits when a
// node's sides differ ("0px 0px 0px 1px" = a left-only border). Uniform collapses to a number so the
// bridge keeps writing `strokeWeight`; only differing sides become per-side Edges.
function compileStrokeWidth(value: unknown, type: string): Bindable | Edges<Bindable> {
  if (typeof value === "number") return value;
  if (isVariableInput(value)) return compileVariableRef(value, "strokeWidth", "FLOAT");
  let sides: Edges<Bindable>;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    rejectUnknownKeys(value, EDGE_KEYS, "strokeWidth");
    const v = value as Record<string, unknown>;
    const side = (name: string): Bindable => {
      if (v[name] == null) throw new Error("flcm: strokeWidth as an object names all four sides { top, right, bottom, left } — " + name + " is missing.");
      return compileBindable(v[name], "strokeWidth." + name, "FLOAT", (literal: number | string) => length(literal));
    };
    sides = { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") };
  } else sides = boxShorthand(value as string, "strokeWidth");
  if (sides.top === sides.right && sides.right === sides.bottom && sides.bottom === sides.left) return sides.top;
  if (!PER_SIDE_STROKE_TYPES.has(type)) {
    throw new Error(
      "flcm: a " + type + " has one stroke weight for every side — the per-side strokeWidth " + JSON.stringify(value) +
        " has no equivalent on it. Give one width.",
    );
  }
  return sides;
}

const EDGE_KEYS = keySet(NESTED_WORDS.sides);
const CORNER_KEYS = keySet(NESTED_WORDS.corners);
// `value` is the read's resolved literal, ignored: the style binds by identity.
const STYLE_INPUT_KEYS = keySet(["style", "value"]);

// borderRadius: the CSS leaf (css.ts cornerRadii), one variable for every corner, or the per-corner
// object — the only spelling where a corner can be bound on its own.
function compileBorderRadius(value: unknown): CornerRadii<Bindable> {
  if (isVariableInput(value)) {
    const ref = compileVariableRef(value, "borderRadius", "FLOAT");
    return { topLeft: ref, topRight: ref, bottomRight: ref, bottomLeft: ref };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    rejectUnknownKeys(value, CORNER_KEYS, "borderRadius");
    const v = value as Record<string, unknown>;
    const corner = (name: string): Bindable => {
      if (v[name] == null) throw new Error("flcm: borderRadius as an object names all four corners { topLeft, topRight, bottomRight, bottomLeft } — " + name + " is missing.");
      return compileBindable(v[name], "borderRadius." + name, "FLOAT", (literal: number | string) => length(literal));
    };
    return { topLeft: corner("topLeft"), topRight: corner("topRight"), bottomRight: corner("bottomRight"), bottomLeft: corner("bottomLeft") };
  }
  return cornerRadii(value as number | string, "borderRadius");
}

// A `{ style }` is the WHOLE slot — a paint style is a stack of its own — so it lands on the node's
// style slot, never as one entry of a stack.
export function compilePaintSlot(wn: WriteProps, value: unknown, slot: "fill" | "stroke"): void {
  if (isStyleInput(value)) {
    rejectUnknownKeys(value, STYLE_INPUT_KEYS, slot);
    wn.styles = { ...wn.styles, [slot]: compileStyleRef(value.style, slot, "PAINT") };
    return;
  }
  wn[slot === "fill" ? "fills" : "strokes"] = compilePaintWord(value as NonNullable<AppearanceProps["fill"]>, slot);
}

// Negative space: an effect's own fields (a shadow's color or radius) don't bind variables — only a
// whole effect style does.
function compileEffectsSlot(wn: WriteProps, value: unknown): void {
  if (isStyleInput(value)) {
    rejectUnknownKeys(value, STYLE_INPUT_KEYS, "effects");
    wn.styles = { ...wn.styles, effect: compileStyleRef(value.style, "effects", "EFFECT") };
    return;
  }
  refuseTokenInput(value, "effects", "effects bind an effect style ({ style }), not a variable");
  wn.effects = value === "none" ? [] : normalizeEffects(value as EffectsInput);
}

// Which side of the edge a border sits on. Lowercase on both sides of the surface (the read shape emits
// "outside"/"center" and omits the default), uppercased here to Figma's own enum.
const STROKE_ALIGNS: Record<WordValue<"strokeAlign">, "INSIDE" | "OUTSIDE" | "CENTER"> = {
  inside: "INSIDE",
  outside: "OUTSIDE",
  center: "CENTER",
};

function compileStrokeAlign(value: unknown): "INSIDE" | "OUTSIDE" | "CENTER" {
  const hit = typeof value === "string" ? tableWord(STROKE_ALIGNS, value.toLowerCase()) : undefined;
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
  if (isStyleInput(value)) {
    throw new Error("flcm: " + subject + ": a paint style is a node's whole fill or stroke — write it as the node's `fill: { style }` / `stroke: { style }`, never as a run's color or an imported SVG's paint.");
  }
  if (Array.isArray(value)) return value.map((leaf, i) => parseFill(leaf, subject + "[" + i + "]"));
  return [parseFill(value, subject)];
}

function compileFrame(props: Accepted<FrameProps>): BuiltNode {
  const wn: BuiltNode = { type: "FRAME" };
  compileNodeLocalProps(wn, props, { type: "FRAME", radius: true, clip: true });
  compileBindings(wn, props, "FRAME");
  wn.layout = buildLayout(props, "FRAME", "FRAME");
  return wn;
}

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
function compileInstance(props: Accepted<InstanceProps>): BuiltNode {
  const component = props.componentId;
  if (!isTargetShaped(component)) {
    throw new Error("INSTANCE: the component must be " + COMPONENT_TARGET_HINT + " — got " + JSON.stringify(component) + ".");
  }
  const wn: BuiltNode = { type: "INSTANCE" };
  wn.component = component;
  if (props.exposed !== undefined) { assertScalarType(props.exposed, "boolean", "exposed"); wn.exposed = props.exposed; }
  compileNodeLocalProps(wn, props, { type: "INSTANCE", radius: true, clip: true });
  const layout = compileNodeLayout(props, "INSTANCE", "INSTANCE") || {};
  // The type rule (hug needs auto-layout, gap needs a container) is NOT run here: whether this root is
  // a row/column is the COMPONENT's fact, read in render's prepare — the same live-mode call edit makes.
  if (Object.keys(layout).length) wn.layout = layout;
  compileBindings(wn, props, "INSTANCE");
  if (props.componentProperties != null) wn.componentProperties = compileComponentPropertyBag(props.componentProperties, "INSTANCE");
  if (props.overrides != null) wn.overrides = compileOverrideBag(props.overrides, "INSTANCE");
  return wn;
}

// An ELLIPSE has no corners, so its row has no radius word (vocabulary `ellipse` group): refused by the
// gate, not accepted and dropped on the floor.
function shape(type: "RECTANGLE" | "ELLIPSE", props: ShapeProps | EllipseProps): BuiltNode {
  const subject = type;
  const wn: BuiltNode = { type };
  compileNodeLocalProps(wn, props, { type, radius: type === "RECTANGLE" });
  compileBindings(wn, props, type);
  const layout = buildLayout(props as FrameProps, type, subject);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

function compileRectangle(props: Accepted<ShapeProps>): BuiltNode { return shape("RECTANGLE", props); }
function compileEllipse(props: Accepted<EllipseProps>): BuiltNode { return shape("ELLIPSE", props); }

function compileLine(props: Accepted<LineProps>): BuiltNode {
  const wn: BuiltNode = { type: "LINE" };
  base(wn, props);
  compileBindings(wn, props, "LINE");
  if (props.stroke != null) compilePaintSlot(wn, props.stroke, "stroke");
  if (props.strokeWidth != null) wn.strokeWeight = compileStrokeWidth(props.strokeWidth, "LINE");
  const layout = compileNodeLayout(props, "LINE", "LINE") || {};
  // line() is the one compiler that doesn't ride buildLayout (width-only sizing), so it consults
  // the shared authority itself — no rule fires on a width-only layout today, but a future LINE-keyed
  // rule must not end up edit-only (the asymmetry this module forbids).
  assertLayoutRealizableForType("LINE", layout, undefined, "LINE");
  if (Object.keys(layout).length) wn.layout = layout;
  if (props.rotation != null) { assertScalarType(props.rotation, "number", "rotation"); wn.rotation = props.rotation; }
  return wn;
}

// ---- Vector verbs. Two forms, different domains (see ir.ts WriteVectorSource): `svg` is a CANVAS of
// art, sized like any box and themed through its vectors; `d`/`vectorPaths` is BARE GEOMETRY, sized only
// by `scale`. Both compile the whole authoring surface here so the bridge never re-parses author input.

// SVG markup imports through createNodeFromSvg, which yields a native frame of vectors. The markup must
// look like an <svg> document (catches a URL/path passed by mistake); the render-time parse (bridge) is
// the second, authoritative fail-loud.
function compileSvg(props: Accepted<SvgProps>): BuiltNode {
  const markup = props.svg;
  if (typeof markup !== "string" || !/<svg[\s>]/i.test(markup)) {
    throw new Error("VECTOR: expected SVG markup containing an <svg> element — got " + JSON.stringify(markup) + ". For a themeable single-path vector use { type: " + JSON.stringify("VECTOR") + ", d } instead.");
  }
  const wn: BuiltNode = { type: "VECTOR", vector: { kind: "svg", markup } };
  // Compiled like any other node's paints, but the bridge lands them on the vectors INSIDE the imported
  // frame rather than on the frame itself — painting the frame would put a backdrop behind the art.
  if (props.fill != null) wn.fills = compilePaintWord(props.fill, "fill");
  if (props.stroke != null) wn.strokes = compilePaintWord(props.stroke, "stroke");
  base(wn, props);
  compileBindings(wn, props, "VECTOR");
  const layout = buildLayout(props as FrameProps, "VECTOR", "VECTOR");
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// A path spec creates a native vector with vectorPaths. It takes the shared appearance props via
// compileNodeLocalProps() (radius off — a vector has none), so it themes like a rect. Path data is
// normalized HERE, not at render: Figma's parser accepts only absolute M/L/C/Q/Z, and doing the
// conversion at compile means malformed data fails before anything reaches the canvas.
function compilePath(accepted: Accepted<PathProps>): BuiltNode {
  const d = accepted.d;
  if (accepted.vectorPaths === undefined && (typeof d !== "string" || !d.trim())) {
    throw new Error("VECTOR: `d` (SVG path data) must be a non-empty string — got " + JSON.stringify(d) + ".");
  }
  const { width, height, aspectRatio, ...props } = accepted;
  const paths = props.vectorPaths !== undefined
    ? normalizeVectorPaths(props.vectorPaths)
    : [{ windingRule: "NONZERO" as const, data: normalizePathData(d as string) }];
  const wn: BuiltNode = { type: "VECTOR", vector: { kind: "path", paths, scale: compileScale(props.scale) } };
  if (width !== undefined || height !== undefined || aspectRatio !== undefined) wn.ignoredSize = { width, height, aspectRatio };
  compileNodeLocalProps(wn, props, { type: "VECTOR" }); // fill/stroke/strokeWidth/effects/rotation + base; radius/clip off for a vector
  compileBindings(wn, props, "VECTOR");
  const layout = buildLayout(props as FrameProps, "VECTOR", "VECTOR");
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// One positive number, so "scaled" can never mean "stretched" — that is the whole reason this word
// exists rather than a second pair of size props. Zero and negatives would collapse or mirror the art.
function compileScale(scale: number | undefined): number | undefined {
  if (scale === undefined) return undefined;
  if (typeof scale !== "number" || !isFinite(scale) || scale <= 0) {
    throw new Error("VECTOR: `scale` must be a positive number multiplying the path's natural size (scale: 2 draws it twice as big) — got " + JSON.stringify(scale) + ".");
  }
  return scale;
}

// The compilers serve compile-tree.ts.
export { compileFrame, compileRectangle, compileEllipse, compileLine, compileSvg, compilePath, compileInstance };
