/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// obligation-observers — for each kind of obligation, how to tell whether the canvas holds it.
// One observer per kind, with no generic fallback: a kind added to ObligationRequests fails the
// type-check here until someone writes how it is observed. Observers are synchronous and read
// native fields only, comparing at the read pipeline's own precision (its decoders, pixelRound,
// 8-bit colour), so a word spelled exactly as a read spells it is realized exactly when a read
// would print it back.

import { componentPath, liveSublayerId, parsePaint, pixelRound, simplifyEffectStack, stableStringify } from "@framelink/core";
import type { SnapshotPaint } from "@framelink/core/snapshot";
import { decodeSceneEffect, decodeScenePaints, type SceneEffect, type ScenePaint } from "./node-to-snapshot.js";
import { aspectRatioAgrees } from "./aspect-ratio.js";
import { unrotatedCornerOf } from "./pivot.js";
import { normalizePathData } from "./path.js";
import { AXES, layoutModeOf, type Axis } from "./layout-mode.js";
import { readKey } from "./identity.js";
import { fontHonoursWords } from "./fonts.js";
import type { ApplySpan, StyleSlot } from "./apply-span.js";
import {
  concessionsOnNode, describeObligationTarget, resolveObligationTarget,
  type BindableObligationRequest, type Obligation, type ObligationKind, type ObligationRequests, type PaintStackRequest,
  type RealizationConcession, type TextFieldRequest, type TextMetricValue, type TextRange,
} from "./obligation.js";

export interface ObligationObserver<K extends ObligationKind, R> {
  /** Plain data: what the canvas holds for this word now. */
  read(node: SceneNode, request: ObligationRequests[K]): R;
  realizes(reading: R, request: ObligationRequests[K], concessions: readonly RealizationConcession[]): boolean;
  /** In the agent's own spelling: 280, "62.5%", { variable: "color/brand" }. */
  describeRequest(request: ObligationRequests[K]): string;
  describeReading(reading: R): string;
  /** A style-link kind only: the reading once `styleId`, queued by this call, is linked. */
  linking?(reading: R, styleId: string): R;
}

export type ObligationObservation = { realized: true } | { realized: false; ended: string };

// ---- shared readings ----

interface BindableReading {
  value: number | null;
  /** The bound variable's id, or null when the field holds a literal. */
  variableId: string | null;
}

function describeBindableRequest(request: BindableObligationRequest): string {
  return "literal" in request ? String(request.literal) : "{ variable: " + JSON.stringify(request.variable) + " }";
}

function describeBindableReading(reading: BindableReading): string {
  const value = reading.value === null ? "unset" : String(pixelRound(reading.value));
  return reading.variableId === null ? value : value + " bound to variable " + JSON.stringify(reading.variableId);
}

// A literal means "unbound, with this value": a literal equal to a bound value is still unrealized,
// since writing it unbinds the field. A variable is realized only by a binding to that exact variable.
function realizesBindable(reading: BindableReading, request: BindableObligationRequest): boolean {
  if ("variableId" in request) return reading.variableId === request.variableId;
  return reading.variableId === null && reading.value !== null && pixelRound(reading.value) === pixelRound(request.literal);
}

/** A node field's binding id. Text fields bind per range, so their node-level entry is a list. */
function boundIdOf(node: any, field: string): string | null {
  const alias = node.boundVariables?.[field];
  const one = Array.isArray(alias) ? alias[0] : alias;
  return one?.id ?? null;
}

function readBindable(node: any, field: string): BindableReading {
  const value = node[field];
  return { value: typeof value === "number" ? value : null, variableId: boundIdOf(node, field) };
}

function bindableObserver(field: string, fallback: number | null = null): ObligationObserver<any, BindableReading> {
  return {
    read: (node) => field in node ? readBindable(node, field) : { value: fallback, variableId: null },
    realizes: realizesBindable,
    describeRequest: describeBindableRequest,
    describeReading: describeBindableReading,
  };
}

function equalityObserver<K extends ObligationKind, V>(read: (node: any) => V, same: (reading: V, request: ObligationRequests[K]) => boolean = (a, b) => a === (b as unknown)): ObligationObserver<K, V> {
  return {
    read: (node) => read(node),
    realizes: (reading, request) => same(reading, request),
    describeRequest: (request) => JSON.stringify(request),
    describeReading: (reading) => reading === undefined ? "unset" : JSON.stringify(reading),
  };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.01;

// ---- paints and effects, through the read's own decoders ----

// A variable reference keeps only its id: the value a read prints beside it is whatever the
// variable resolves to now, and the request's placeholder colour is not.
function withoutVariableValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVariableValues);
  if (!value || typeof value !== "object") return value;
  const bag = value as Record<string, unknown>;
  if ("variable" in bag) return { variable: (bag.variable as { id?: string })?.id ?? bag.variable };
  return Object.fromEntries(Object.entries(bag).map(([k, v]) => [k, withoutVariableValues(v)]));
}

function canonicalPaints(paints: readonly ScenePaint[] | symbol | undefined, hasChildren: boolean): Record<string, unknown>[] {
  const decoded: SnapshotPaint[] = decodeScenePaints(paints as ReadonlyArray<ScenePaint>) ?? [];
  return decoded
    .filter((paint) => (paint as { visible?: boolean }).visible !== false)
    .map((paint) => {
      const parsed = withoutVariableValues(parsePaint(paint, hasChildren));
      return (parsed && typeof parsed === "object" ? parsed : { value: parsed }) as Record<string, unknown>;
    });
}

/** Whether `live` (Figma's bottom-first storage) holds the requested stack, at read precision. */
function paintsMatch(live: readonly ScenePaint[] | symbol | undefined, request: Pick<PaintStackRequest, "paints" | "hashKnown">, hasChildren: boolean): boolean {
  if (typeof live === "symbol") return false;
  const asked = canonicalPaints(request.paints, hasChildren);
  const held = canonicalPaints(live, hasChildren);
  if (asked.length !== held.length) return false;
  return asked.every((paint, i) => {
    // The hash of a fetched image is minted by the write, so the request can only name the rest.
    const strip = (p: Record<string, unknown>) => (request.hashKnown[i] ? p : { ...p, imageRef: undefined });
    return stableStringify(strip(paint)) === stableStringify(strip(held[i]));
  });
}

function describePaints(paints: readonly ScenePaint[] | symbol | undefined, hasChildren: boolean): string {
  if (typeof paints === "symbol") return "mixed across the text";
  const held = canonicalPaints(paints, hasChildren).reverse();
  if (!held.length) return "none";
  return JSON.stringify(held.length === 1 ? held[0].value ?? held[0] : held.map((p) => p.value ?? p));
}

function canonicalEffects(effects: readonly SceneEffect[] | undefined, onText: boolean): string {
  return stableStringify(simplifyEffectStack((effects ?? []).map(decodeSceneEffect), onText));
}

// ---- text, read segment by segment ----

interface TextSegment { start: number; end: number; style: any }

const SEGMENT_FIELDS = [
  "fontName", "fontSize", "lineHeight", "letterSpacing", "textDecoration", "textCase", "paragraphSpacing",
  "paragraphIndent", "listSpacing", "fills", "hyperlink", "boundVariables",
] as const;

function segmentsOf(node: any): TextSegment[] {
  if (typeof node.getStyledTextSegments !== "function") return [];
  let at = 0;
  return node.getStyledTextSegments([...SEGMENT_FIELDS]).map((style: any) => {
    const start = typeof style.start === "number" ? style.start : at;
    const end = typeof style.end === "number" ? style.end : start + String(style.characters ?? "").length;
    at = end;
    return { start, end, style };
  });
}

const overlaps = (segment: TextSegment, [start, end]: TextRange): boolean => segment.start < end && start < segment.end;

/** The segments with a character outside every `except` range: where a base word must hold. */
function baseSegments(segments: readonly TextSegment[], except: readonly TextRange[]): TextSegment[] {
  return segments.filter((segment) => {
    for (let i = segment.start; i < segment.end; i++) if (!except.some(([s, e]) => s <= i && i < e)) return true;
    return false;
  });
}

// What a text with no characters carries: its node-level fields, read as one segment.
function nodeAsSegment(node: any): any {
  const style: Record<string, unknown> = {};
  for (const field of SEGMENT_FIELDS) if (field !== "boundVariables" && field !== "hyperlink") style[field] = node[field];
  const bound: Record<string, { id: string }> = {};
  for (const field of ["fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent"]) {
    const id = boundIdOf(node, field);
    if (id) bound[field] = { id };
  }
  style.boundVariables = bound;
  return style;
}

const DEFAULT_SEGMENT: Record<string, string> = { textDecoration: "NONE", textCase: "ORIGINAL" };

function metricMatches(held: any, value: TextMetricValue | { variableId: string }): boolean {
  if (typeof value === "number") return typeof held === "number" && pixelRound(held) === pixelRound(value);
  if ("variableId" in value) return false;
  if (!held || typeof held !== "object" || held.unit !== value.unit) return false;
  return value.unit === "AUTO" || pixelRound(held.value) === pixelRound(value.value);
}

/** Whether one segment carries one requested field; `onText` decides the paint spelling. */
function segmentCarries(style: any, request: TextFieldRequest, onText: boolean): boolean {
  const bound = (field: string): string | null => style.boundVariables?.[field]?.id ?? null;
  switch (request.field) {
    case "fontName": {
      const font = style.fontName;
      if (!font || typeof font === "symbol") return false;
      const written = request.written;
      const same = (font.family === request.font.family && font.style === request.font.style) ||
        (!!written && fontHonoursWords(font, written.family, written.weight, written.italic));
      if (!same) return false;
      if (request.family !== undefined && bound("fontFamily") !== request.family) return false;
      return request.weight === undefined || bound("fontWeight") === request.weight;
    }
    case "fontSize": case "lineHeight": case "letterSpacing": case "paragraphSpacing": case "paragraphIndent": case "listSpacing": {
      const value = request.value;
      if (typeof value === "object" && "variableId" in value) return bound(request.field) === value.variableId;
      if (request.field !== "listSpacing" && bound(request.field) !== null) return false;
      return metricMatches(style[request.field], value);
    }
    case "textDecoration": case "textCase":
      return (style[request.field] ?? DEFAULT_SEGMENT[request.field]) === request.value;
    case "fills":
      return paintsMatch(style.fills, request, onText);
    case "hyperlink":
      return style.hyperlink?.type === "URL" && style.hyperlink.value === request.url;
  }
}

function describeSegmentField(style: any, request: TextFieldRequest): string {
  switch (request.field) {
    case "fontName": {
      const font = style.fontName;
      return !font || typeof font === "symbol" ? "mixed fonts" : JSON.stringify(font.family + " " + font.style);
    }
    case "fills":
      return describePaints(style.fills, false);
    case "hyperlink":
      return style.hyperlink ? JSON.stringify(style.hyperlink.value) : "no link";
    default: {
      const id = style.boundVariables?.[request.field]?.id;
      const value = style[request.field] ?? DEFAULT_SEGMENT[request.field];
      return (value === undefined ? "unset" : JSON.stringify(value)) + (id ? " bound to variable " + JSON.stringify(id) : "");
    }
  }
}

function describeTextFieldRequest(request: TextFieldRequest): string {
  switch (request.field) {
    case "fontName": return JSON.stringify(request.font.family + " " + request.font.style);
    case "fills": return "the fill " + describePaints(request.paints, false);
    case "hyperlink": return JSON.stringify(request.url);
    case "textDecoration": case "textCase": return JSON.stringify(request.value);
    default: {
      const value = request.value;
      return typeof value === "object" && "variableId" in value ? "variable " + JSON.stringify(value.variableId) : JSON.stringify(value);
    }
  }
}

/** A base text word: the first uncovered segment that doesn't carry it, or none. */
interface TextFieldReading { holds: boolean; ended: string }

function readBaseTextField(node: any, request: TextFieldRequest, except: readonly TextRange[]): TextFieldReading {
  const segments = segmentsOf(node);
  const onText = node.type === "TEXT";
  const styles = segments.length ? baseSegments(segments, except).map((s) => s.style) : [nodeAsSegment(node)];
  const miss = styles.find((style) => !segmentCarries(style, request, onText));
  return miss ? { holds: false, ended: describeSegmentField(miss, request) } : { holds: true, ended: "" };
}

function baseTextObserver<K extends "fontIdentity" | "textMetric">(): ObligationObserver<K, TextFieldReading> {
  return {
    read: (node, request) => readBaseTextField(node, request as TextFieldRequest, request.except),
    realizes: (reading) => reading.holds,
    describeRequest: (request) => describeTextFieldRequest(request as TextFieldRequest),
    describeReading: (reading) => reading.ended,
  };
}

// ---- sizes and positions ----

interface AxisSizeReading { size: number; sizing: string | undefined; variableId: string | null; parentSize: number | null; flow: boolean }

function parentOf(node: any): any | null {
  const parent = node.parent;
  return parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT" ? parent : null;
}

function inFlowOf(node: any): boolean {
  const parent = parentOf(node);
  return !!parent && layoutModeOf(parent).kind !== "free" && node.layoutPositioning !== "ABSOLUTE";
}

function concededSize(axis: Axis, size: number, concessions: readonly RealizationConcession[]): boolean {
  const dimension = AXES[axis].dimension;
  return concessions.some((c) => c.axis === dimension && near(c.realized, size));
}

function describeIntent(intent: ObligationRequests["axisSize"]["intent"]): string {
  if ("px" in intent) return describeBindableRequest(intent.px);
  if ("percent" in intent) return JSON.stringify(intent.percent + "%");
  return "fill" in intent ? '"fill"' : '"hug"';
}

// ---- structure ----

function sublayerPathsOf(node: any): string[] {
  return (node.children ?? []).map((child: any) => child.id);
}

function bareName(full: string): string {
  const hash = full.lastIndexOf("#");
  return hash === -1 ? full : full.slice(0, hash);
}

// The full property ids a layer's references resolve against where it sits: the nearest instance's
// properties (its sublayers reference the main component's), else the nearest component's
// definitions, read off the set for a variant.
function declaredPropertiesAround(node: any): Set<string> {
  for (let p = node.parent; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) {
    if (p.type === "INSTANCE") return new Set(Object.keys(p.componentProperties ?? {}));
    if (p.type === "COMPONENT" || p.type === "COMPONENT_SET") {
      const owner = p.type === "COMPONENT" && p.parent?.type === "COMPONENT_SET" ? p.parent : p;
      return new Set(Object.keys(owner.componentPropertyDefinitions ?? {}));
    }
  }
  return new Set();
}

// Path data compared up to the box it is drawn in: Figma re-scales a path's coordinates whenever its
// box is resized, and a redrawn path keeps the box it had (bridge applyVectorPath).
function boxNormalizedPath(data: string): string {
  const normalized = normalizePathData(data);
  const numbers = normalized.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  const xs = numbers.filter((_, i) => i % 2 === 0), ys = numbers.filter((_, i) => i % 2 === 1);
  const span = (values: number[]) => ({ min: Math.min(...values), size: Math.max(...values) - Math.min(...values) || 1 });
  const x = span(xs), y = span(ys);
  let i = 0;
  return normalized.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (match) => {
    const value = Number(match);
    const axis = i++ % 2 === 0 ? x : y;
    return String(Math.round(((value - axis.min) / axis.size) * 1000) / 1000);
  });
}

function canonicalVectorPaths(paths: readonly { data: string; windingRule: string }[] | undefined): string {
  return stableStringify((paths ?? []).map((p) => ({ data: boxNormalizedPath(p.data), windingRule: p.windingRule })));
}

/** What each kind's observer reads off the canvas. */
interface ObligationReadings {
  name: string;
  blendMode: string | undefined;
  visible: boolean;
  locked: boolean;
  pluginKey: string;
  opacity: BindableReading;
  paintStack: { holds: boolean; ended: string };
  styleLink: { styleId: string; valuesHeld: boolean };
  strokeWeight: BindableReading[];
  strokeAlign: string | undefined;
  cornerRadii: BindableReading[];
  effects: { held: string; styleId: string };
  rotation: number;
  clip: boolean | undefined;
  annotations: string;
  characters: string;
  textRuns: TextFieldReading;
  fontIdentity: TextFieldReading;
  textMetric: TextFieldReading;
  textAlign: string | undefined;
  textAlignVertical: string | undefined;
  textDecoration: TextFieldReading;
  textCase: TextFieldReading;
  hyperlink: TextFieldReading;
  textStyleLink: string | symbol | undefined;
  lineClamp: { truncation: string | undefined; maxLines: number | null | undefined };
  vectorPaths: string;
  pathScale: { width: number; height: number };
  layoutMode: string;
  justifyContent: string | undefined;
  alignItems: { align: string | undefined; stretched: boolean; parked: string[] };
  alignItemsStretch: string[];
  gap: { mode: string; row: BindableReading | null; column: BindableReading | null };
  wrap: string | undefined;
  padding: BindableReading[];
  gridTracks: string;
  gridPlacement: { anchor: number | undefined; span: number | undefined };
  gridCellAlign: string | undefined;
  zIndex: number;
  axisSize: AxisSizeReading;
  sizeBound: BindableReading;
  aspectRatio: { locked: boolean; width: number; height: number };
  positionOffset: { at: number; parentSize: number | null; absolute: boolean; inAutoLayout: boolean };
  positioning: { positioning: string | undefined; inAutoLayout: boolean };
  constraint: string | undefined;
  parentage: { parentId: string | null; index: number };
  instanceComponent: string[];
  componentPropertyValue: { value: unknown; type: string | undefined } | null;
  exposedInstance: boolean | undefined;
  slotContent: string[];
  componentDescription: string | undefined;
  propertyDefinition: Record<string, { type: string }>;
  propertyBinding: { held: string | undefined; declared: boolean };
}

const TEXT_ALIGNS: Record<string, string> = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };
const SIDES = ["top", "right", "bottom", "left"] as const;
const CORNERS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
const STROKE_SIDE_FIELDS = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"] as const;
const CORNER_FIELDS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"] as const;
const PADDING_FIELDS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;
const ALIGN_NATIVE: Record<string, string> = { start: "MIN", center: "CENTER", end: "MAX", baseline: "BASELINE" };
const JUSTIFY_NATIVE: Record<string, string> = { start: "MIN", center: "CENTER", end: "MAX", between: "SPACE_BETWEEN" };

// A side or corner either has its own field, or (on a type with one value for all) shares the uniform one.
function readFour(node: any, fields: readonly string[], uniform: string, uniformBinding: string): BindableReading[] {
  if (!(fields[0] in node)) return [0, 1, 2, 3].map(() => readBindable(node, uniform));
  const shared = boundIdOf(node, uniformBinding);
  return fields.map((field) => {
    const reading = readBindable(node, field);
    return reading.variableId === null && shared !== null ? { ...reading, variableId: shared } : reading;
  });
}

function realizesFour(readings: readonly BindableReading[], requests: readonly BindableObligationRequest[]): boolean {
  return requests.every((request, i) => realizesBindable(readings[i], request));
}

function describeFour(readings: readonly BindableReading[]): string {
  const spelled = readings.map(describeBindableReading);
  return spelled.every((s) => s === spelled[0]) ? spelled[0] : spelled.join(" / ");
}

function edgesOf<T>(edges: { top: T; right: T; bottom: T; left: T }): T[] {
  return SIDES.map((side) => edges[side]);
}

export const OBLIGATION_OBSERVERS: { readonly [K in ObligationKind]: ObligationObserver<K, ObligationReadings[K]> } = {
  name: equalityObserver((node) => node.name),
  // The read's default rule: a frame's PASS_THROUGH and a leaf's NORMAL both render as no blending.
  blendMode: equalityObserver((node) => node.blendMode, (held, asked) => held === asked || (asked === "NORMAL" && held === "PASS_THROUGH")),
  visible: equalityObserver((node) => node.visible),
  locked: equalityObserver((node) => node.locked),
  pluginKey: equalityObserver((node) => readKey(node)),
  opacity: bindableObserver("opacity", 1),
  paintStack: {
    read: (node: any, request) => {
      const hasChildren = !!node.children?.length;
      const styleId = node[request.slot === "fills" ? "fillStyleId" : "strokeStyleId"];
      // A literal stack is an unstyled slot: the same paints under a style are still the style's.
      if (typeof styleId === "string" && styleId !== "") return { holds: false, ended: "the style " + JSON.stringify(styleId) };
      if (node.type === "TEXT" && request.slot === "fills") {
        return readBaseTextField(node, { field: "fills", paints: request.paints, hashKnown: request.hashKnown }, request.except);
      }
      const live = node[request.slot];
      return paintsMatch(live, request, hasChildren) ? { holds: true, ended: "" } : { holds: false, ended: describePaints(live, hasChildren) };
    },
    realizes: (reading) => reading.holds,
    describeRequest: (request) => request.spelled,
    describeReading: (reading) => reading.ended,
  },
  // The link and the values it lands: a style whose values were overwritten after linking is detached live.
  styleLink: {
    read: (node: any, request) => {
      const styleId = typeof node[request.slot + "StyleId"] === "string" ? node[request.slot + "StyleId"] : "";
      const hasChildren = !!node.children?.length;
      const valuesHeld = request.slot === "effect"
        ? canonicalEffects(node.effects, node.type === "TEXT") === canonicalEffects(request.effects as SceneEffect[], node.type === "TEXT")
        : paintsMatch(node[request.slot + "s"], { paints: request.paints, hashKnown: request.paints.map(() => true) }, hasChildren);
      return { styleId, valuesHeld };
    },
    realizes: (reading, request) => reading.styleId === request.styleId && reading.valuesHeld,
    describeRequest: (request) => "{ style: " + JSON.stringify(request.styleName) + " }",
    describeReading: (reading) => (reading.styleId ? "the style " + JSON.stringify(reading.styleId) + (reading.valuesHeld ? "" : " with other values") : "no style"),
    linking: (reading, styleId) => ({ ...reading, styleId }),
  },
  strokeWeight: {
    read: (node) => readFour(node, STROKE_SIDE_FIELDS, "strokeWeight", "strokeWeight"),
    realizes: (readings, request) => realizesFour(readings, "uniform" in request ? [0, 1, 2, 3].map(() => request.uniform) : edgesOf(request.sides)),
    describeRequest: (request) => ("uniform" in request ? describeBindableRequest(request.uniform) : edgesOf(request.sides).map(describeBindableRequest).join(" / ")),
    describeReading: describeFour,
  },
  strokeAlign: equalityObserver((node) => node.strokeAlign),
  cornerRadii: {
    read: (node) => readFour(node, CORNER_FIELDS, "cornerRadius", "cornerRadius"),
    realizes: (readings, request) => realizesFour(readings, CORNERS.map((corner) => request[corner])),
    describeRequest: (request) => CORNERS.map((corner) => describeBindableRequest(request[corner])).join(" / "),
    describeReading: describeFour,
  },
  effects: {
    read: (node: any) => ({ held: canonicalEffects(node.effects, node.type === "TEXT"), styleId: typeof node.effectStyleId === "string" ? node.effectStyleId : "" }),
    realizes: (reading, request) => reading.styleId === "" && reading.held === canonicalEffects(request.effects as SceneEffect[], false) ||
      reading.styleId === "" && reading.held === canonicalEffects(request.effects as SceneEffect[], true),
    describeRequest: (request) => request.spelled,
    describeReading: (reading) => (reading.styleId ? "the style " + JSON.stringify(reading.styleId) : reading.held),
  },
  // CSS degrees turn clockwise, Figma's counter-clockwise; any turn congruent mod 360 is the same picture.
  rotation: {
    read: (node: any) => (typeof node.rotation === "number" ? -node.rotation : 0),
    realizes: (held, asked) => {
      const delta = (((held - asked) % 360) + 540) % 360 - 180;
      return Math.abs(delta) <= 0.01;
    },
    describeRequest: (request) => String(request),
    describeReading: (reading) => String(pixelRound(reading)),
  },
  clip: equalityObserver((node) => node.clipsContent),
  annotations: {
    read: (node: any) => stableStringify((node.annotations ?? []).map((a: any) => ({
      text: a.labelMarkdown ?? a.label ?? undefined,
      categoryId: a.categoryId ?? undefined,
      properties: a.properties?.length ? a.properties.map((p: any) => p.type) : undefined,
    }))),
    realizes: (held, asked) => held === stableStringify(asked.map((a) => ({ text: a.text, categoryId: a.categoryId, properties: a.properties?.length ? a.properties : undefined }))),
    describeRequest: (request) => JSON.stringify(request),
    describeReading: (reading) => reading,
  },
  characters: equalityObserver((node) => node.characters),
  textRuns: {
    read: (node: any, request) => {
      const segments = segmentsOf(node);
      for (const run of request.runs) {
        for (const field of run.fields) {
          const miss = segments.find((segment) => overlaps(segment, [run.start, run.end]) && !segmentCarries(segment.style, field, true));
          if (miss) return { holds: false, ended: "characters " + run.start + "–" + run.end + " " + describeSegmentField(miss.style, field) + " where asked " + describeTextFieldRequest(field) };
        }
      }
      return { holds: true, ended: "" };
    },
    realizes: (reading) => reading.holds,
    describeRequest: (request) => request.runs.length + " styled run" + (request.runs.length === 1 ? "" : "s"),
    describeReading: (reading) => reading.ended,
  },
  fontIdentity: baseTextObserver<"fontIdentity">(),
  textMetric: baseTextObserver<"textMetric">(),
  textAlign: {
    read: (node: any) => node.textAlignHorizontal,
    realizes: (held, asked) => held === asked,
    describeRequest: (request) => JSON.stringify(TEXT_ALIGNS[request] ?? request),
    describeReading: (reading) => JSON.stringify(TEXT_ALIGNS[reading ?? ""] ?? reading),
  },
  textAlignVertical: equalityObserver((node) => node.textAlignVertical),
  textDecoration: {
    read: (node, request) => readBaseTextField(node, { field: "textDecoration", value: request.value }, request.except),
    realizes: (reading) => reading.holds,
    describeRequest: (request) => JSON.stringify(request.value),
    describeReading: (reading) => reading.ended,
  },
  textCase: {
    read: (node, request) => readBaseTextField(node, { field: "textCase", value: request.value }, request.except),
    realizes: (reading) => reading.holds,
    describeRequest: (request) => JSON.stringify(request.value),
    describeReading: (reading) => reading.ended,
  },
  // An empty text holds no link: there is no character to carry one.
  hyperlink: {
    read: (node: any, request) => (node.characters?.length
      ? readBaseTextField(node, { field: "hyperlink", url: request.url }, request.except)
      : { holds: false, ended: "no characters to link" }),
    realizes: (reading) => reading.holds,
    describeRequest: (request) => JSON.stringify(request.url),
    describeReading: (reading) => reading.ended,
  },
  textStyleLink: {
    read: (node: any) => node.textStyleId,
    realizes: (held, request) => held === request.styleId,
    describeRequest: (request) => "{ style: " + JSON.stringify(request.styleName) + " }",
    describeReading: (reading) => (typeof reading === "symbol" ? "mixed text styles" : reading ? "the style " + JSON.stringify(reading) : "no style"),
    linking: (_reading, styleId) => styleId,
  },
  lineClamp: {
    read: (node: any) => ({ truncation: node.textTruncation, maxLines: node.maxLines }),
    realizes: (held, asked) => (asked === "none" ? held.truncation !== "ENDING" && held.maxLines == null : held.truncation === "ENDING" && held.maxLines === asked),
    describeRequest: (request) => JSON.stringify(request),
    describeReading: (reading) => (reading.truncation === "ENDING" ? String(reading.maxLines) : '"none"'),
  },
  vectorPaths: {
    read: (node: any) => canonicalVectorPaths(node.vectorPaths),
    realizes: (held, asked) => held === canonicalVectorPaths(asked.paths),
    describeRequest: (request) => JSON.stringify(request.paths.map((p) => p.data).join(" ")),
    describeReading: () => "other path data",
  },
  pathScale: {
    read: (node: any) => ({ width: node.width, height: node.height }),
    realizes: (held, asked, concessions) =>
      (near(held.width, asked.width * asked.scale) || concededSize("horizontal", held.width, concessions)) &&
      (near(held.height, asked.height * asked.scale) || concededSize("vertical", held.height, concessions)),
    describeRequest: (request) => String(request.scale),
    describeReading: (reading) => pixelRound(reading.width) + " × " + pixelRound(reading.height),
  },
  layoutMode: equalityObserver((node) => layoutModeOf(node).word),
  justifyContent: {
    read: (node: any) => node.primaryAxisAlignItems,
    realizes: (held, asked) => held === JUSTIFY_NATIVE[asked],
    describeRequest: (request) => JSON.stringify(request),
    describeReading: (reading) => JSON.stringify(Object.keys(JUSTIFY_NATIVE).find((k) => JUSTIFY_NATIVE[k] === reading) ?? reading),
  },
  // Only the container's own word: a child it stretches is that child's sizing, not alignment.
  // As a read spells it: a frame whose every in-flow child fills across reads "stretch", whatever the
  // native field holds. A mark parked on an absolute child is no child's own word, so it fails it too.
  alignItems: {
    read: (node: any) => {
      const mode = layoutModeOf(node);
      const children: any[] = node.children ?? [];
      const field = mode.kind === "flow" ? AXES[mode.cross].sizing : undefined;
      return {
        align: node.counterAxisAlignItems,
        stretched: !!field && children.some((c) => c.layoutPositioning !== "ABSOLUTE") && children.every((c) => c.layoutPositioning === "ABSOLUTE" || c[field] === "FILL"),
        parked: children.filter((c) => c.layoutPositioning === "ABSOLUTE" && c.layoutAlign === "STRETCH").map((c) => describeObligationTarget({ node: c })),
      };
    },
    realizes: (held, asked) => held.align === ALIGN_NATIVE[asked] && !held.stretched && held.parked.length === 0,
    describeRequest: (request) => JSON.stringify(request),
    describeReading: (reading) => (reading.stretched ? '"stretch"' : JSON.stringify(Object.keys(ALIGN_NATIVE).find((k) => ALIGN_NATIVE[k] === reading.align) ?? reading.align)) +
      (reading.parked.length ? " with " + reading.parked.join(", ") + " still marked to stretch" : ""),
  },
  alignItemsStretch: {
    read: (node: any) => {
      const mode = layoutModeOf(node);
      if (mode.kind !== "flow") return ["the frame has no row or column"];
      const field = AXES[mode.cross].sizing;
      return (node.children ?? []).filter((c: any) => c.layoutPositioning !== "ABSOLUTE" && c[field] !== "FILL").map((c: any) => describeObligationTarget({ node: c }));
    },
    realizes: (unstretched) => unstretched.length === 0,
    describeRequest: () => '"stretch"',
    describeReading: (unstretched) => "not stretching " + unstretched.join(", "),
  },
  gap: {
    read: (node: any) => {
      const mode = layoutModeOf(node);
      if (mode.kind === "grid") return { mode: "grid", row: readBindable(node, "gridRowGap"), column: readBindable(node, "gridColumnGap") };
      if (mode.kind === "free") return { mode: "none", row: null, column: null };
      const wraps = node.layoutWrap === "WRAP";
      const item = readBindable(node, "itemSpacing");
      if (mode.word === "row") return { mode: "row", column: item, row: wraps ? readBindable(node, "counterAxisSpacing") : null };
      return { mode: "column", row: item, column: null };
    },
    realizes: (held, asked) => {
      if (held.mode === "none") return false;
      if (held.row && !realizesBindable(held.row, asked.row)) return false;
      return !held.column || realizesBindable(held.column, asked.column);
    },
    describeRequest: (request) => {
      const row = describeBindableRequest(request.row), column = describeBindableRequest(request.column);
      return row === column ? row : "{ row: " + row + ", column: " + column + " }";
    },
    describeReading: (reading) => (reading.mode === "none" ? "no auto-layout" : [reading.row, reading.column].filter(Boolean).map((r) => describeBindableReading(r!)).join(" / ")),
  },
  wrap: {
    read: (node: any) => node.layoutWrap,
    realizes: (held, asked) => held === (asked ? "WRAP" : "NO_WRAP") || (!asked && held === undefined),
    describeRequest: (request) => String(request),
    describeReading: (reading) => String(reading === "WRAP"),
  },
  padding: {
    read: (node) => PADDING_FIELDS.map((field) => readBindable(node, field)),
    realizes: (readings, request) => realizesFour(readings, edgesOf(request)),
    describeRequest: (request) => edgesOf(request).map(describeBindableRequest).join(" / "),
    describeReading: describeFour,
  },
  gridTracks: {
    read: (node: any, request) => stableStringify((node[AXES[request.axis].tracks] ?? []).map((t: any) => ({ type: t.type, ...(t.type === "HUG" ? {} : { value: pixelRound(t.value) }) }))),
    realizes: (held, asked) => held === stableStringify(asked.tracks.map((t) => ({ type: t.type, ...(t.type === "HUG" ? {} : { value: pixelRound(t.value) }) }))),
    describeRequest: (request) => JSON.stringify(request.tracks),
    describeReading: (reading) => reading,
  },
  gridPlacement: {
    read: (node: any, request) => request.axis === "horizontal"
      ? { anchor: node.gridColumnAnchorIndex, span: node.gridColumnSpan }
      : { anchor: node.gridRowAnchorIndex, span: node.gridRowSpan },
    realizes: (held, asked) => held.span === asked.span && (asked.anchor === undefined || held.anchor === asked.anchor),
    describeRequest: (request) => JSON.stringify({ anchor: request.anchor, span: request.span }),
    describeReading: (reading) => JSON.stringify(reading),
  },
  gridCellAlign: {
    read: (node: any, request) => (request.axis === "horizontal" ? node.gridChildHorizontalAlign : node.gridChildVerticalAlign),
    realizes: (held, asked) => held === asked.align,
    describeRequest: (request) => JSON.stringify(request.align),
    describeReading: (reading) => JSON.stringify(reading),
  },
  zIndex: {
    read: (node: any) => (node.parent?.children ?? []).indexOf(node),
    realizes: (held, asked) => held === asked,
    describeRequest: (request) => String(request),
    describeReading: (reading) => String(reading),
  },
  axisSize: {
    read: (node: any, request) => {
      const { dimension, sizing } = AXES[request.axis];
      const parent = parentOf(node);
      return {
        size: node[dimension], sizing: node[sizing], variableId: boundIdOf(node, dimension),
        parentSize: parent ? parent[dimension] : null, flow: inFlowOf(node),
      };
    },
    realizes: (held, { axis, intent }, concessions) => {
      if (concededSize(axis, held.size, concessions)) return true;
      if ("px" in intent) {
        if (typeof held.sizing === "string" && held.sizing !== "FIXED") return false;
        return "variableId" in intent.px ? held.variableId === intent.px.variableId : held.variableId === null && near(held.size, intent.px.literal);
      }
      if ("hug" in intent) return held.sizing === "HUG";
      if ("percent" in intent) return held.parentSize !== null && near(held.size, (intent.percent / 100) * held.parentSize);
      // Fill is a share of the flow in auto-layout, and the parent's whole box anywhere else.
      return held.flow ? held.sizing === "FILL" : held.parentSize !== null && near(held.size, held.parentSize);
    },
    describeRequest: (request) => describeIntent(request.intent),
    describeReading: (reading) => {
      const size = String(pixelRound(reading.size)) + (reading.variableId ? " bound to variable " + JSON.stringify(reading.variableId) : "");
      return reading.sizing === "FILL" ? '"fill"' : reading.sizing === "HUG" ? '"hug" (' + size + ")" : size;
    },
  },
  sizeBound: {
    read: (node: any, request) => readBindable(node, request.bound),
    realizes: (held, asked) => (asked.value === "none" ? held.value === null && held.variableId === null : realizesBindable(held, asked.value)),
    describeRequest: (request) => (request.value === "none" ? '"none"' : describeBindableRequest(request.value)),
    describeReading: (reading) => (reading.value === null && reading.variableId === null ? '"none"' : describeBindableReading(reading)),
  },
  aspectRatio: {
    read: (node: any) => ({ locked: !!node.targetAspectRatio, width: node.width, height: node.height }),
    // A resize Figma didn't honour leaves the lock on the box it did realize; that miss is the warning.
    realizes: (held, asked, concessions) => (asked === "none" ? !held.locked
      : held.locked && (aspectRatioAgrees(held.width, held.height, asked) || concessions.some((c) => c.kind === "write-time-resize-miss"))),
    describeRequest: (request) => JSON.stringify(request),
    describeReading: (reading) => (reading.locked ? String(pixelRound(reading.width / reading.height)) : "unlocked at " + pixelRound(reading.width / reading.height)),
  },
  positionOffset: {
    read: (node: any, request) => {
      const corner = unrotatedCornerOf(node);
      const parent = parentOf(node);
      return {
        at: request.axis === "horizontal" ? corner.x : corner.y,
        parentSize: parent ? parent[AXES[request.axis].dimension] : null,
        absolute: node.layoutPositioning === "ABSOLUTE",
        inAutoLayout: !!parent && layoutModeOf(parent).kind !== "free",
      };
    },
    realizes: (held, { offset }) => {
      if (held.inAutoLayout && !held.absolute) return false;
      const asked = "px" in offset ? offset.px : held.parentSize === null ? NaN : (offset.percent / 100) * held.parentSize;
      return near(held.at, asked);
    },
    describeRequest: (request) => ("px" in request.offset ? String(request.offset.px) : JSON.stringify(request.offset.percent + "%")),
    describeReading: (reading) => String(pixelRound(reading.at)) + (reading.inAutoLayout && !reading.absolute ? " in its parent's flow" : ""),
  },
  // Out of an auto-layout parent's flow there is no flow to leave or rejoin: inert, so realized.
  positioning: {
    read: (node: any) => ({ positioning: node.layoutPositioning, inAutoLayout: !!parentOf(node) && layoutModeOf(parentOf(node)).kind !== "free" }),
    realizes: (held, asked) => !held.inAutoLayout || held.positioning === (asked === "absolute" ? "ABSOLUTE" : "AUTO"),
    describeRequest: (request) => JSON.stringify(request),
    describeReading: (reading) => JSON.stringify(reading.positioning === "ABSOLUTE" ? "absolute" : "none"),
  },
  constraint: {
    read: (node: any, request) => node.constraints?.[request.axis],
    realizes: (held, asked) => held === asked.value,
    describeRequest: (request) => JSON.stringify(request.spelled),
    describeReading: (reading) => JSON.stringify(reading),
  },
  parentage: {
    read: (node: any) => ({ parentId: node.parent?.id ?? null, index: (node.parent?.children ?? []).indexOf(node) }),
    realizes: (held, asked) => {
      const parent = resolveObligationTarget(asked.parent);
      return !!parent && held.parentId === parent.id && (asked.index === undefined || held.index === asked.index);
    },
    describeRequest: (request) => "under " + describeObligationTarget(request.parent) + (request.index === undefined ? "" : " at " + request.index),
    describeReading: (reading) => (reading.parentId === null ? "detached" : "under the layer " + JSON.stringify(reading.parentId) + " at " + reading.index),
  },
  // The proof assertInstanceStillOf uses: an instance's sublayer ids are its component's, prefixed.
  instanceComponent: {
    read: (node) => sublayerPathsOf(node),
    realizes: (held, asked) => held.length === asked.sublayerPaths.length && held.every((id, i) => id === asked.sublayerPaths[i]),
    describeRequest: (request) => describeObligationTarget({ node: { id: request.componentId, name: request.componentName, type: "COMPONENT", removed: false } as unknown as SceneNode }),
    describeReading: () => "another component's layers",
  },
  componentPropertyValue: {
    read: (node: any, request) => {
      const property = node.componentProperties?.[request.name];
      return property ? { value: property.value, type: property.type } : null;
    },
    realizes: (held, asked) => held !== null && held.value === asked.value,
    describeRequest: (request) => JSON.stringify(request.value),
    describeReading: (reading) => (reading === null ? "no such property" : JSON.stringify(reading.value)),
  },
  exposedInstance: equalityObserver((node) => node.isExposedInstance),
  slotContent: {
    read: (node) => sublayerPathsOf(node),
    realizes: (held, asked) => {
      const content = asked.content.map((target) => resolveObligationTarget(target)?.id);
      return content.every((id) => id !== undefined) && held.length === content.length && held.every((id, i) => id === content[i]);
    },
    describeRequest: (request) => request.content.length + " layer" + (request.content.length === 1 ? "" : "s"),
    describeReading: (reading) => reading.length + " layer" + (reading.length === 1 ? "" : "s"),
  },
  componentDescription: equalityObserver((node) => node.description),
  propertyDefinition: {
    read: (node: any) => {
      const owner = node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET" ? node.parent : node;
      return owner.componentPropertyDefinitions ?? {};
    },
    realizes: (definitions, asked) => {
      if ("delete" in asked) return !(asked.delete in definitions);
      const named = Object.keys(definitions).filter((full) => bareName(full) === asked.declare);
      if (named.length !== 1 || definitions[named[0]].type !== asked.figmaType) return false;
      return asked.replaces === undefined || asked.replaces === named[0] || !(asked.replaces in definitions);
    },
    describeRequest: (request) => ("delete" in request ? "deleted" : JSON.stringify(request.declare) + " (" + request.figmaType.toLowerCase() + ")"),
    describeReading: (definitions) => {
      const names = Object.keys(definitions).map(bareName);
      return names.length ? "properties " + names.map((n) => JSON.stringify(n)).join(", ") : "no properties";
    },
  },
  // The full property id the field references, which must be one the component it sits in now
  // declares: a reference carried over from another component, or to a property deleted and
  // re-declared under the same name, names a property its owner doesn't hold.
  propertyBinding: {
    read: (node: any, request) => {
      const held: string | undefined = node.componentPropertyReferences?.[request.wire];
      return { held, declared: held !== undefined && declaredPropertiesAround(node).has(held) };
    },
    realizes: ({ held, declared }, asked) => (asked.name === null ? held === undefined : declared && bareName(held!) === asked.name),
    describeRequest: (request) => (request.name === null ? "unbound" : JSON.stringify(request.name)),
    describeReading: ({ held, declared }) => (held === undefined ? "unbound" : JSON.stringify(bareName(held)) + (declared ? "" : " (a property the component it sits in doesn't declare)")),
  },
};

/** Whether the canvas holds the obligation now. A target the call no longer finds never does. */
/** A style link this call queued but hasn't written yet: links are async-only, so they land last. */
export type PendingStyleLink = ApplySpan["styleLinks"][number];

/**
 * Whether the canvas holds `obligation` now. With `pendingLinks`, a style-link word counts as linked
 * when this call queued that exact link: a link writes only the style id onto values apply already
 * wrote, so nothing else it could change is observable before it runs.
 */
export function observeObligation(obligation: Obligation, pendingLinks?: readonly PendingStyleLink[]): ObligationObservation {
  const node = resolveObligationTarget(obligation.target);
  if (!node) return { realized: false, ended: "missing" };
  // Erased to `unknown` once, here: the table pairs each kind's reading with its own observer.
  const observer = OBLIGATION_OBSERVERS[obligation.kind] as unknown as ObligationObserver<ObligationKind, unknown>;
  const live = observer.read(node, obligation.request);
  const queued = observer.linking && pendingLinks ? queuedStyleIdOf(obligation, node, pendingLinks) : undefined;
  const reading = queued === undefined ? live : observer.linking!(live, queued);
  if (observer.realizes(reading, obligation.request, concessionsOnNode(node))) return { realized: true };
  return { realized: false, ended: observer.describeReading(reading) };
}

function queuedStyleIdOf(obligation: Obligation, node: SceneNode, pendingLinks: readonly PendingStyleLink[]): string | undefined {
  const slot: StyleSlot = obligation.kind === "textStyleLink" ? "text" : (obligation as Obligation<"styleLink">).request.slot;
  let styleId: string | undefined;
  for (const link of pendingLinks) if (link.node === node && link.slot === slot) styleId = link.styleId;
  return styleId;
}

/** The obligation's request in the agent's spelling, for a failure message. */
export function describeObligationRequest(obligation: Obligation): string {
  const observer = OBLIGATION_OBSERVERS[obligation.kind] as unknown as ObligationObserver<ObligationKind, unknown>;
  return observer.describeRequest(obligation.request);
}

/** The sublayer ids an instance shows once it points at `component`, for an instanceComponent request. */
export function expectedSublayerIds(instance: { id: string }, component: { children?: readonly { id: string }[] }): string[] {
  return (component.children ?? []).map((child) => liveSublayerId(instance.id, componentPath(child.id)));
}

/** Whether `node`'s `wire` references `name` (bare or full), declared where it sits now. */
export function propertyBindingHolds(node: SceneNode, wire: string, name: string): boolean {
  const observer = OBLIGATION_OBSERVERS.propertyBinding;
  const request = { wire, name: bareName(name) };
  return observer.realizes(observer.read(node, request), request, []);
}
