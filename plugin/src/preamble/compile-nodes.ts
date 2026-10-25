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
import { compileAspectRatio } from "./aspect-ratio.js";
import { compileAnnotations } from "./annotations.js";
import { isNodeIdShaped } from "@framelink/core";
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
import { normalizeEffects } from "./value-sugar.js";
import { FlcmError, locateFailure } from "./flcm-error.js";
import { assertSlotFrameNameAgrees, compileBindings, compileComponentPropertyBag, compileOverrideBag } from "./compile-component-words.js";

// The authoring surface (verb Props + gradient/effects sugar) is defined ONCE in schema.ts as zod schemas
// with per-field docs; these are the z.infer'd types. Imported `import type` ONLY so schema.ts's zod is
// erased by esbuild and never reaches the sandbox bundle. Change a prop by editing the schema, not here.
import type {
  BaseProps, SizeProps, AppearanceProps, FrameProps, ShapeProps, EllipseProps, LineProps, PathProps, SvgProps,
  InstanceProps, PadInput, EffectsInput,
} from "./schema.js";

const CONSTRAINT_KEYS = keySet(NESTED_WORDS.constraints);

// The closed-set reject (rejectUnknownKeys) lives in validate.ts — one gate shared with read.ts's locate
// query. Every compiler below takes `at`, the node's spec path rooted at the call
// ("flcm.render.spec.children[1]", or "flcm.edit" for an edit's delta), and every refusal names the
// word at fault as a path under it, so a message points at the exact value written.

// ---- shared prop -> WriteNode compilers ----

// terse pad (number | CSS box shorthand | {x,y} | {top,right,bottom,left}) -> typed edges. The string
// form is the READ shape's spelling ("12px 16px"): `get` returns padding as a CSS shorthand, and without
// it here a `get` result's own layout wouldn't re-author. Inside the object form the edges stay NUMBERS — a "24px"
// there once dropped silently to zero on every side, and that reject stays (ADR-0003 fail-loud).
const PAD_KEYS = keySet(NESTED_WORDS.pad);
const GAP_KEYS = keySet(NESTED_WORDS.gap);

function padEdges(pad: PadInput, at: string): Edges<Bindable> {
  if (typeof pad === "number") return { top: pad, right: pad, bottom: pad, left: pad };
  if (typeof pad === "string") return boxShorthand(pad, at);
  // One variable binds all four sides — the same token each side would name on its own.
  if (isVariableInput(pad)) {
    const ref = compileVariableRef(pad, at, "FLOAT");
    return { top: ref, right: ref, bottom: ref, left: ref };
  }
  if (pad == null || typeof pad !== "object" || Array.isArray(pad)) {
    throw new FlcmError("authoring", 'must be a number, a CSS box shorthand string ("12px 16px"), { variable }, or an object ({ x, y } or { top, right, bottom, left }) — got ' + JSON.stringify(pad) + ".", { path: at });
  }
  rejectUnknownKeys(pad, PAD_KEYS, at, { reference: "props" });
  const edge = (v: unknown, name: string): Bindable | undefined => {
    if (v == null) return undefined;
    // Rides length(), like every other metric: a number or "Npx", and anything else fails loud there.
    return compileBindable(v, at + "." + name, "FLOAT", (literal: number | string) => {
      try {
        return length(literal);
      } catch {
        throw new FlcmError("authoring", 'must be a number or "Npx" (or { variable }) — got ' + JSON.stringify(literal) + ".", { path: at + "." + name });
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
function applySizing(props: SizeProps, layout: WriteLayout, at: string): void {
  const sz: { horizontal?: Sizing; vertical?: Sizing } = {};
  const dims: { width?: Bindable; height?: Bindable } = {};
  const pct: { width?: number; height?: number } = {};
  const axis = (val: SizeProps["width"], key: "horizontal" | "vertical", dim: "width" | "height") => {
    if (val === undefined) return;
    if (val === "fill" || val === "hug") sz[key] = val;
    // A bound size is a fixed size whose number the variable supplies.
    else if (isVariableInput(val)) { sz[key] = "fixed"; dims[dim] = compileVariableRef(val, at + "." + dim, "FLOAT"); }
    // "N%" is a fixed px once resolved against the parent (the bridge folds it in at render), so it sizes
    // "fixed" and carries only the percent intent here.
    else if (isPercent(val)) { sz[key] = "fixed"; pct[dim] = percent(val); }
    // A number or "Npx" — one spelling of the same fixed size, so both ride length().
    else {
      try {
        sz[key] = "fixed";
        dims[dim] = length(val);
      } catch {
        throw new FlcmError("authoring", 'must be a number, "Npx", "N%", "fill", "hug", or { variable } — got ' + JSON.stringify(val) + ".", { path: at + "." + dim });
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
function applyPlacement(layout: WriteLayout, props: SizeProps, at: string): void {
  const { left, top, position } = props;
  if (position != null && !(WORD_VALUES.position as readonly string[]).includes(position)) {
    throw new FlcmError("authoring", 'position must be "absolute" or "none" — got ' + JSON.stringify(position) + ".", { path: at });
  }
  if (position === "none") {
    // A node rejoining the flow is placed by the layout, not by coordinates — a coordinate beside
    // "none" is two contradictory claims, refused rather than resolved.
    if (left != null || top != null) {
      throw new FlcmError("authoring", 'position: "none" returns the node to its parent\'s flow, where the layout places it, so `left`/`top` can\'t be set beside it. Drop them, or drop position: "none".', { path: at });
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
      throw new FlcmError("authoring", 'must be a number, "Npx", or "N%" — got ' + JSON.stringify(val) + ".", { path: at + "." + key });
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
function parseConstraints(raw: unknown, at: string): { x?: ConstraintX; y?: ConstraintY } | undefined {
  if (raw == null) return undefined;
  if (raw === "none") return { x: "none", y: "none" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new FlcmError("authoring", 'must be an object like { x, y } or "none" — got ' + JSON.stringify(raw) + ".", { path: at });
  }
  const r = raw as { x?: string; y?: string };
  rejectUnknownKeys(r, CONSTRAINT_KEYS, at, { reference: "props" });
  const out: { x?: ConstraintX; y?: ConstraintY } = {};
  if (r.x != null) {
    if (!oneOf(CONSTRAINT_X, r.x)) throw new FlcmError("authoring", "must be one of " + words(CONSTRAINT_X) + " — got " + JSON.stringify(r.x) + ".", { path: at + ".x" });
    out.x = r.x;
  }
  if (r.y != null) {
    if (!oneOf(CONSTRAINT_Y, r.y)) throw new FlcmError("authoring", "must be one of " + words(CONSTRAINT_Y) + " — got " + JSON.stringify(r.y) + ".", { path: at + ".y" });
    out.y = r.y;
  }
  return out.x != null || out.y != null ? out : undefined;
}

// Map a CSS-total author word to the Figma-domain value its table names — the container words
// (justifyContent/alignItems, see JUSTIFY_CONTENT/ALIGN_ITEMS for why this gate exists) and the text
// casing words (textTransform/fontVariant). `path` is the word's spec path; `hint` appends
// prop-specific guidance; the shared body names the realizable CSS spellings.
export function mapCssWord<T extends string>(path: string, raw: unknown, table: Record<string, T>, hint = ""): T {
  const mapped = tableWord(table, raw);
  if (!mapped) {
    const allowed = Object.keys(table).map((w) => '"' + w + '"').join(", ");
    throw new FlcmError("authoring", "must be one of " + allowed + " — got " + JSON.stringify(raw) + "." + hint, { path });
  }
  return mapped;
}

// constraints -> constraint-override intent on the layout. Only meaningful for a positioned child (a
// free-form parent's, or an out-of-flow one); stored but inert under auto-layout. Never lifts a node out of flow.
function applyConstraintsProp(layout: WriteLayout, props: SizeProps, at: string): void {
  const constraints = parseConstraints(props.constraints, at + ".constraints");
  if (constraints) layout.constraints = constraints;
}

// Compile the read layout bag, including container and grid-child words, into a
// WriteLayout — presence-preserving: a word the author didn't write compiles to nothing. The
// creation default (an omitted mode means free-form) is buildLayout's to inject, NOT this
// function's: edit uses the same compile, and a defaulted mode would turn a gap nudge
// into an auto-layout kill.
function compileLayoutBag(cfg: NonNullable<FrameProps["layout"]>, at: string): WriteLayout {
  const layout: WriteLayout = {};
  for (const key of ["gridTemplateColumns", "gridTemplateRows"] as const) {
    const raw = cfg[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !raw.trim()) throw new FlcmError("authoring", 'needs a track template string, e.g. "1fr 1fr" — got ' + JSON.stringify(raw) + ".", { path: at + "." + key });
    layout[key] = parseGridTracks(raw, at + "." + key);
  }
  for (const key of ["gridColumn", "gridRow"] as const) {
    const raw = cfg[key];
    if (raw === undefined) continue;
    layout[key] = parseGridPlacement(raw, at + "." + key);
  }
  if (cfg.justifySelf !== undefined) layout.justifySelf = mapCssWord(at + ".justifySelf", cfg.justifySelf, JUSTIFY_SELF);
  if (cfg.alignSelf !== undefined) layout.alignSelf = mapCssWord(at + ".alignSelf", cfg.alignSelf, ALIGN_SELF, " " + FLOW_ALIGNMENT_GUIDANCE);
  if (cfg.zIndex !== undefined) {
    if (!Number.isSafeInteger(cfg.zIndex) || cfg.zIndex < 0) throw new FlcmError("authoring", "must be a non-negative integer — got " + JSON.stringify(cfg.zIndex) + ".", { path: at + ".zIndex" });
    layout.zIndex = cfg.zIndex;
  }
  if (cfg.mode != null) layout.mode = assertEnum(at + ".mode", cfg.mode, LAYOUT_MODE);
  if (cfg.gap != null) {
    const gapAt = at + ".gap";
    const guidance = 'needs a finite number, "Npx", "row-gap column-gap", { variable }, or { row, column } — got ' + JSON.stringify(cfg.gap) + ".";
    const finite = (v: Bindable): Bindable => {
      if (!isTokenRef(v) && (typeof v !== "number" || !Number.isFinite(v))) throw new FlcmError("authoring", guidance, { path: gapAt });
      return v;
    };
    const side = (v: unknown, name: string): Bindable => finite(compileBindable(v, gapAt + "." + name, "FLOAT", length));
    const raw: unknown = cfg.gap;
    if (isVariableInput(raw)) layout.gap = compileVariableRef(raw, gapAt, "FLOAT");
    else if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      rejectUnknownKeys(raw, GAP_KEYS, gapAt, { reference: "props" });
      const g = raw as { row?: unknown; column?: unknown };
      if (g.row == null || g.column == null) throw new FlcmError("authoring", guidance, { path: gapAt });
      layout.gap = { row: side(g.row, "row"), column: side(g.column, "column") };
    } else {
      let values: number[];
      try {
        values = typeof raw === "string" ? raw.trim().split(/\s+/).map(length) : [raw as number];
      } catch (cause) { throw locateFailure(cause, { path: gapAt }); }
      if (values.length < 1 || values.length > 2) throw new FlcmError("authoring", guidance, { path: gapAt });
      values.forEach(finite);
      layout.gap = values.length === 1 || values[0] === values[1] ? values[0] : { row: values[0], column: values[1] };
    }
  }
  if (cfg.wrap !== undefined) {
    if (typeof cfg.wrap !== "boolean") throw new FlcmError("authoring", "must be a boolean — got " + JSON.stringify(cfg.wrap) + ".", { path: at + ".wrap" });
    layout.wrap = cfg.wrap;
  }
  if (cfg.padding != null) layout.padding = padEdges(cfg.padding, at + ".padding");
  // The space-around/evenly hint is primary-axis-only (a justify-content notion), so only justifyContent carries it.
  if (cfg.justifyContent != null) layout.justifyContent = mapCssWord(at + ".justifyContent", cfg.justifyContent, JUSTIFY_CONTENT, " Figma auto-layout has no CSS space-around/space-evenly; add gap/padding for spacing instead.");
  if (cfg.alignItems != null) layout.alignItems = mapCssWord(at + ".alignItems", cfg.alignItems, ALIGN_ITEMS);
  return layout;
}

// All node layout inputs compile once after the per-type vocabulary gate. LINE has only fixed width.
export function compileNodeLayout(props: Omit<SizeProps, "layout"> & { layout?: FrameProps["layout"] }, nodeType: string, at: string): WriteLayout | undefined {
  const layout = props.layout == null ? {} : compileLayoutBag(props.layout, at + ".layout");
  if (nodeType === "LINE") Object.assign(layout, compileLineWidth(props, at));
  else {
    applySizing(props, layout, at);
    const bounds = compileBounds(props, at);
    if (bounds) layout.bounds = bounds;
    compileAspectRatio(props.aspectRatio, layout, at + ".aspectRatio");
  }
  applyDesignedSize(props as { designedWidth?: unknown; designedHeight?: unknown }, layout, at);
  applyPlacement(layout, props, at);
  applyConstraintsProp(layout, props, at);
  return Object.keys(layout).length ? layout : undefined;
}

// A read root's designedWidth/designedHeight, kept by acceptAuthoringProps only beside a "fill" axis.
function applyDesignedSize(props: { designedWidth?: unknown; designedHeight?: unknown }, layout: WriteLayout, at: string): void {
  const designed: { width?: number; height?: number } = {};
  const axis = (val: unknown, key: "horizontal" | "vertical", dim: "width" | "height", word: string) => {
    if (val == null || layout.sizing?.[key] !== "fill") return;
    try {
      designed[dim] = length(val as string | number);
    } catch {
      throw new FlcmError("authoring", 'must be a number or "Npx" — got ' + JSON.stringify(val) + ".", { path: at + "." + word });
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
function compileLineWidth(props: Pick<LineProps, "width">, at: string): WriteLayout | undefined {
  const w = props.width;
  if (w == null) return undefined;
  if (w === "fill") return { sizing: { horizontal: "fill" } };
  if (isVariableInput(w)) return { sizing: { horizontal: "fixed" }, dimensions: { width: compileVariableRef(w, at + ".width", "FLOAT") } };
  if (w === "hug" || isPercent(w)) {
    throw new FlcmError("authoring", 'a LINE\'s width is its length — "hug" and "N%" have no meaning on a line, which has no content to hug and no cell to measure against. Use a number, or "fill" under a row or column. Got ' + JSON.stringify(w) + ".", { path: at + ".width" });
  }
  let px: number;
  try {
    px = length(w);
  } catch {
    throw new FlcmError("authoring", 'a LINE\'s width must be a number or "Npx" — got ' + JSON.stringify(w) + ".", { path: at + ".width" });
  }
  // The sizing intent must say "fixed": the parent policy’s clearFill keys the un-fill off it, so a width edit on a
  // live line someone set to grow (layoutGrow 1 — authorable in the Figma UI, not in flcm) actually takes
  // over from the fill.
  return { sizing: { horizontal: "fixed" }, dimensions: { width: px } };
}

export function buildLayout(props: FrameProps, nodeType: WriteType, at: string): WriteLayout {
  const layout = compileNodeLayout(props, nodeType, at) || {};
  if (nodeType === "FRAME" && layout.mode == null) layout.mode = "none";
  // The shared per-type legality authority (layout-legality.ts) — the same call edit's live gate
  // makes, so a word that rejects on edit rejects identically here instead of silently not landing.

  assertLayoutRealizableForType(nodeType, layout, undefined, at);
  assertGridSizing(layout, undefined, at);
  return layout;
}

// The QuickJS boundary has no type checking, so a present-but-mistyped scalar must reject LOUD —
// a bare typeof guard would silently drop it, committing the rest of the props as a partial write
// (the ADR-0003 silent no-op, and for edit a broken whole-delta validation). null/undefined still
// mean "absent": presence-preserving stays intact.
export function assertScalarType(value: unknown, want: "string" | "number" | "boolean", path: string): void {
  if (typeof value !== want) {
    throw new FlcmError("authoring", "must be a " + want + " — got " + JSON.stringify(value) + ".", { path });
  }
}

// The shared-by-every-node props. Additive: only present props land on the WriteNode.
export function base(wn: WriteProps, props: BaseProps & { annotations?: unknown }, at: string): void {
  if (props.annotations !== undefined) {
    try {
      wn.annotations = compileAnnotations(props.annotations);
    } catch (cause) { throw locateFailure(cause, { path: at + ".annotations" }); }
  }
  if (props.name != null) { assertScalarType(props.name, "string", at + ".name"); wn.name = props.name; }
  if (props.key != null) {
    assertScalarType(props.key, "string", at + ".key");
    // A bare target string spelled like an id is always read as one (target.ts resolveString).
    if (isNodeIdShaped(props.key)) {
      throw new FlcmError("authoring", JSON.stringify(props.key) + " is spelled like a node id, and a target spelled like an id always means the id. Choose a key that isn't, e.g. \"card\".", { path: at + ".key" });
    }
    wn.key = props.key;
  }
  if (props.opacity != null) wn.opacity = compileBindable(props.opacity, at + ".opacity", "FLOAT", (v: unknown) => { assertScalarType(v, "number", at + ".opacity"); return v as number; });
  const blend = props.mixBlendMode;
  if (blend != null) wn.blendMode = locatedParse(() => parseBlendMode(blend), at + ".mixBlendMode");
  if (props.visible != null) { assertScalarType(props.visible, "boolean", at + ".visible"); wn.visible = props.visible; }
  if (props.locked != null) { assertScalarType(props.locked, "boolean", at + ".locked"); wn.locked = props.locked; }
}

// The shared parsers (css.ts, markdown.ts, path.ts) don't know which property they read, so the
// compiler names it.
export function locatedParse<T>(parse: () => T, path: string): T {
  try {
    return parse();
  } catch (cause) { throw locateFailure(cause, { path }); }
}

// Appearance props shared by frame/rect/ellipse (and edit's delta compile), on top of base(). Every
// CSS-shaped leaf is normalized to the typed currency through css.ts here — presence-preserving by
// construction, so it doubles as the edit patch compiler's core: only present keys produce writes.
// Exported for edit-plan.ts, which imports FROM here — nothing here imports edit-plan, so no cycle.
export function compileNodeLocalProps(wn: WriteProps, props: AppearanceProps, opts: { type: string; at: string; radius?: boolean; clip?: boolean }): void {
  const { at } = opts;
  base(wn, props, at);
  if (props.fill != null) compilePaintSlot(wn, props.fill, "fill", at);
  if (props.stroke != null) compilePaintSlot(wn, props.stroke, "stroke", at);
  if (props.strokeWidth != null) wn.strokeWeight = compileStrokeWidth(props.strokeWidth, opts.type, at + ".strokeWidth");
  if (props.strokeAlign != null) wn.strokeAlign = compileStrokeAlign(props.strokeAlign, at + ".strokeAlign");
  if (props.effects != null) compileEffectsSlot(wn, props.effects, at + ".effects");
  if (opts.radius && props.borderRadius != null) wn.borderRadius = compileBorderRadius(props.borderRadius, at + ".borderRadius");
  const clip = (props as FrameProps).clip;
  if (opts.clip && clip != null) { assertScalarType(clip, "boolean", at + ".clip"); wn.clip = clip; }
  if (props.rotation != null) { assertScalarType(props.rotation, "number", at + ".rotation"); wn.rotation = props.rotation; }
}

// Figma's IndividualStrokesMixin: only the rectangle-family boxes weigh their sides apart. LINE,
// ELLIPSE and VECTOR have one strokeWeight, so a per-side width there is refused at compile, before
// any canvas write — never dropped or averaged.
const PER_SIDE_STROKE_TYPES: ReadonlySet<string> = new Set(["FRAME", "RECTANGLE", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SLOT"]);

// `strokeWidth` is CSS `border-width`: one value, or the 1–4 value box shorthand read emits when a
// node's sides differ ("0px 0px 0px 1px" = a left-only border). Uniform collapses to a number so the
// bridge keeps writing `strokeWeight`; only differing sides become per-side Edges.
function compileStrokeWidth(value: unknown, type: string, at: string): Bindable | Edges<Bindable> {
  if (typeof value === "number") return value;
  if (isVariableInput(value)) return compileVariableRef(value, at, "FLOAT");
  let sides: Edges<Bindable>;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    rejectUnknownKeys(value, EDGE_KEYS, at, { reference: "props" });
    const v = value as Record<string, unknown>;
    const side = (name: string): Bindable => {
      if (v[name] == null) throw new FlcmError("authoring", "as an object it names all four sides { top, right, bottom, left } — " + name + " is missing. Add it, or give one width.", { path: at });
      return compileBindable(v[name], at + "." + name, "FLOAT", (literal: number | string) => locatedParse(() => length(literal), at + "." + name));
    };
    sides = { top: side("top"), right: side("right"), bottom: side("bottom"), left: side("left") };
  } else sides = boxShorthand(value as string, at);
  if (sides.top === sides.right && sides.right === sides.bottom && sides.bottom === sides.left) return sides.top;
  if (!PER_SIDE_STROKE_TYPES.has(type)) {
    throw new FlcmError(
      "authoring",
      "a " + type + " has one stroke weight for every side, so the per-side width " + JSON.stringify(value) +
        " has no equivalent on it. Give one width.",
      { path: at },
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
function compileBorderRadius(value: unknown, at: string): CornerRadii<Bindable> {
  if (isVariableInput(value)) {
    const ref = compileVariableRef(value, at, "FLOAT");
    return { topLeft: ref, topRight: ref, bottomRight: ref, bottomLeft: ref };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    rejectUnknownKeys(value, CORNER_KEYS, at, { reference: "props" });
    const v = value as Record<string, unknown>;
    const corner = (name: string): Bindable => {
      if (v[name] == null) throw new FlcmError("authoring", "as an object it names all four corners { topLeft, topRight, bottomRight, bottomLeft } — " + name + " is missing. Add it, or give one radius.", { path: at });
      return compileBindable(v[name], at + "." + name, "FLOAT", (literal: number | string) => locatedParse(() => length(literal), at + "." + name));
    };
    return { topLeft: corner("topLeft"), topRight: corner("topRight"), bottomRight: corner("bottomRight"), bottomLeft: corner("bottomLeft") };
  }
  return cornerRadii(value as number | string, at);
}

// A `{ style }` is the WHOLE slot — a paint style is a stack of its own — so it lands on the node's
// style slot, never as one entry of a stack.
export function compilePaintSlot(wn: WriteProps, value: unknown, slot: "fill" | "stroke", at: string): void {
  const path = at + "." + slot;
  if (isStyleInput(value)) {
    rejectUnknownKeys(value, STYLE_INPUT_KEYS, path, { reference: "values" });
    wn.styles = { ...wn.styles, [slot]: compileStyleRef(value.style, path, "PAINT") };
    return;
  }
  wn[slot === "fill" ? "fills" : "strokes"] = compilePaintWord(value as NonNullable<AppearanceProps["fill"]>, path);
}

// Negative space: an effect's own fields (a shadow's color or radius) don't bind variables — only a
// whole effect style does.
function compileEffectsSlot(wn: WriteProps, value: unknown, at: string): void {
  if (isStyleInput(value)) {
    rejectUnknownKeys(value, STYLE_INPUT_KEYS, at, { reference: "values" });
    wn.styles = { ...wn.styles, effect: compileStyleRef(value.style, at, "EFFECT") };
    return;
  }
  refuseTokenInput(value, at, "effects bind an effect style ({ style }), not a variable");
  wn.effects = value === "none" ? [] : normalizeEffects(value as EffectsInput, at);
}

// Which side of the edge a border sits on. Lowercase on both sides of the surface (the read shape emits
// "outside"/"center" and omits the default), uppercased here to Figma's own enum.
const STROKE_ALIGNS: Record<WordValue<"strokeAlign">, "INSIDE" | "OUTSIDE" | "CENTER"> = {
  inside: "INSIDE",
  outside: "OUTSIDE",
  center: "CENTER",
};

function compileStrokeAlign(value: unknown, at: string): "INSIDE" | "OUTSIDE" | "CENTER" {
  const hit = typeof value === "string" ? tableWord(STROKE_ALIGNS, value.toLowerCase()) : undefined;
  if (!hit) {
    throw new FlcmError("authoring", 'must be "inside", "outside" or "center" — got ' + JSON.stringify(value) + ".", { path: at });
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
export function compilePaintWord(value: NonNullable<AppearanceProps["fill"]>, at: string): WritePaintStack {
  if (value === "none") return [];
  if (isStyleInput(value)) {
    throw new FlcmError("authoring", "a paint style is a node's whole fill or stroke — write it as the node's `fill: { style }` / `stroke: { style }`, never as a run's color or an imported SVG's paint.", { path: at });
  }
  if (Array.isArray(value)) return value.map((leaf, i) => locatedParse(() => parseFill(leaf, at + "[" + i + "]"), at + "[" + i + "]"));
  return [locatedParse(() => parseFill(value, at), at)];
}

function compileFrame(props: Accepted<FrameProps>, at: string): BuiltNode {
  const wn: BuiltNode = { type: "FRAME" };
  compileNodeLocalProps(wn, props, { type: "FRAME", at, radius: true, clip: true });
  compileBindings(wn, props, "FRAME", at);
  assertSlotFrameNameAgrees(wn.name, wn.componentPropertyReferences, at);
  wn.layout = buildLayout(props, "FRAME", at);
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
function compileInstance(props: Accepted<InstanceProps>, at: string): BuiltNode {
  const component = props.componentId;
  if (!isTargetShaped(component)) {
    throw new FlcmError("authoring", "the component must be " + COMPONENT_TARGET_HINT + " — got " + JSON.stringify(component) + ".", { path: at + ".componentId" });
  }
  const wn: BuiltNode = { type: "INSTANCE" };
  wn.component = component;
  if (props.exposed !== undefined) { assertScalarType(props.exposed, "boolean", at + ".exposed"); wn.exposed = props.exposed; }
  compileNodeLocalProps(wn, props, { type: "INSTANCE", at, radius: true, clip: true });
  const layout = compileNodeLayout(props, "INSTANCE", at) || {};
  // The type rule (hug needs auto-layout, gap needs a container) is NOT run here: whether this root is
  // a row/column is the COMPONENT's fact, read in render's prepare — the same live-mode call edit makes.
  if (Object.keys(layout).length) wn.layout = layout;
  compileBindings(wn, props, "INSTANCE", at);
  if (props.componentProperties != null) wn.componentProperties = compileComponentPropertyBag(props.componentProperties, at);
  if (props.overrides != null) wn.overrides = compileOverrideBag(props.overrides, at);
  return wn;
}

// An ELLIPSE has no corners, so its row has no radius word (vocabulary `ellipse` group): refused by the
// gate, not accepted and dropped on the floor.
function shape(type: "RECTANGLE" | "ELLIPSE", props: ShapeProps | EllipseProps, at: string): BuiltNode {
  const wn: BuiltNode = { type };
  compileNodeLocalProps(wn, props, { type, at, radius: type === "RECTANGLE" });
  compileBindings(wn, props, type, at);
  const layout = buildLayout(props as FrameProps, type, at);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

function compileRectangle(props: Accepted<ShapeProps>, at: string): BuiltNode { return shape("RECTANGLE", props, at); }
function compileEllipse(props: Accepted<EllipseProps>, at: string): BuiltNode { return shape("ELLIPSE", props, at); }

function compileLine(props: Accepted<LineProps>, at: string): BuiltNode {
  const wn: BuiltNode = { type: "LINE" };
  base(wn, props, at);
  compileBindings(wn, props, "LINE", at);
  if (props.stroke != null) compilePaintSlot(wn, props.stroke, "stroke", at);
  if (props.strokeWidth != null) wn.strokeWeight = compileStrokeWidth(props.strokeWidth, "LINE", at + ".strokeWidth");
  const layout = compileNodeLayout(props, "LINE", at) || {};
  // line() is the one compiler that doesn't ride buildLayout (width-only sizing), so it consults
  // the shared authority itself — no rule fires on a width-only layout today, but a future LINE-keyed
  // rule must not end up edit-only (the asymmetry this module forbids).
  assertLayoutRealizableForType("LINE", layout, undefined, at);
  if (Object.keys(layout).length) wn.layout = layout;
  if (props.rotation != null) { assertScalarType(props.rotation, "number", at + ".rotation"); wn.rotation = props.rotation; }
  return wn;
}

// ---- Vector verbs. Two forms, different domains (see ir.ts WriteVectorSource): `svg` is a CANVAS of
// art, sized like any box and themed through its vectors; `d`/`vectorPaths` is BARE GEOMETRY, sized only
// by `scale`. Both compile the whole authoring surface here so the bridge never re-parses author input.

// SVG markup imports through createNodeFromSvg, which yields a native frame of vectors. The markup must
// look like an <svg> document (catches a URL/path passed by mistake); the render-time parse (bridge) is
// the second, authoritative fail-loud.
function compileSvg(props: Accepted<SvgProps>, at: string): BuiltNode {
  const markup = props.svg;
  if (typeof markup !== "string" || !/<svg[\s>]/i.test(markup)) {
    throw new FlcmError("authoring", "expected SVG markup containing an <svg> element — got " + JSON.stringify(markup) + ". For a themeable single-path vector use { type: " + JSON.stringify("VECTOR") + ", d } instead.", { path: at + ".svg" });
  }
  const wn: BuiltNode = { type: "VECTOR", vector: { kind: "svg", markup } };
  // Compiled like any other node's paints, but the bridge lands them on the vectors INSIDE the imported
  // frame rather than on the frame itself — painting the frame would put a backdrop behind the art.
  if (props.fill != null) wn.fills = compilePaintWord(props.fill, at + ".fill");
  if (props.stroke != null) wn.strokes = compilePaintWord(props.stroke, at + ".stroke");
  base(wn, props, at);
  compileBindings(wn, props, "VECTOR", at);
  const layout = buildLayout(props as FrameProps, "VECTOR", at);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// A path spec creates a native vector with vectorPaths. It takes the shared appearance props via
// compileNodeLocalProps() (radius off — a vector has none), so it themes like a rect. Path data is
// normalized HERE, not at render: Figma's parser accepts only absolute M/L/C/Q/Z, and doing the
// conversion at compile means malformed data fails before anything reaches the canvas.
function compilePath(accepted: Accepted<PathProps>, at: string): BuiltNode {
  const d = accepted.d;
  if (accepted.vectorPaths === undefined && (typeof d !== "string" || !d.trim())) {
    throw new FlcmError("authoring", "must be a non-empty string of SVG path data — got " + JSON.stringify(d) + ".", { path: at + ".d" });
  }
  const { width, height, aspectRatio, ...props } = accepted;
  const paths = props.vectorPaths !== undefined
    ? normalizeVectorPaths(props.vectorPaths, at + ".vectorPaths")
    : [{ windingRule: "NONZERO" as const, data: locatedParse(() => normalizePathData(d as string), at + ".d") }];
  const wn: BuiltNode = { type: "VECTOR", vector: { kind: "path", paths, scale: compileScale(props.scale, at + ".scale") } };
  if (width !== undefined || height !== undefined || aspectRatio !== undefined) wn.ignoredSize = { width, height, aspectRatio };
  compileNodeLocalProps(wn, props, { type: "VECTOR", at }); // fill/stroke/strokeWidth/effects/rotation + base; radius/clip off for a vector
  compileBindings(wn, props, "VECTOR", at);
  const layout = buildLayout(props as FrameProps, "VECTOR", at);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// One positive number, so "scaled" can never mean "stretched" — that is the whole reason this word
// exists rather than a second pair of size props. Zero and negatives would collapse or mirror the art.
function compileScale(scale: number | undefined, at: string): number | undefined {
  if (scale === undefined) return undefined;
  if (typeof scale !== "number" || !isFinite(scale) || scale <= 0) {
    throw new FlcmError("authoring", "must be a positive number multiplying the path's natural size (scale: 2 draws it twice as big) — got " + JSON.stringify(scale) + ".", { path: at });
  }
  return scale;
}

// The compilers serve compile-tree.ts.
export { compileFrame, compileRectangle, compileEllipse, compileLine, compileSvg, compilePath, compileInstance };
