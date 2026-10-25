/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// obligation-derivation — the authored words of a compiled plan, as the obligations they put on the
// canvas (obligation.ts). Every authored word, held already or not: a write point skips one the
// canvas holds when the call reaches it (write-point.ts), and the call still owes it.
//
// One derivation per compiled field, exhaustive: adding a field to WriteProps or WriteLayout fails
// the type-check here until someone says what it obliges, the way the instance write policy's
// verdict tables do. A field another deriver owns names it (a closed union), so nothing is dropped
// by omission.

import { textOfRuns, isTokenRef } from "./ir.js";
import type {
  Bindable, BuiltNode, ComponentEditWords, ComponentPropertyBinding, ComponentPropertyBindingEdit, CornerRadii, Edges, InstanceEditWords, StyleRef, VariableRef, WriteLayout, WritePaint,
  WritePaintStack, WriteProps, WriteTextRun, WriteTextStyle,
} from "./ir.js";
import { namesFontIdentity } from "./ir.js";
import { toFigmaPaint, imagePaintAdjustments } from "./paint.js";
import { toFigmaEffects } from "./effects.js";
import { variableFor, styleFor, type ResolvedTokens } from "./tokens.js";
import { resolveFont } from "./fonts.js";
import { annotationCategoryId } from "./annotation-categories.js";
import { CONSTRAINT_H, CONSTRAINT_V, effectiveLayoutMode, layoutModeOf, type Axis, type LayoutMode } from "./layout-mode.js";
import { expectedSublayerIds } from "./obligation-observers.js";
import { overrideWordPath, wordPathsOf } from "./authored-words.js";
import { BINDING_FIELD_WIRE_KEYS, PROPERTY_TYPES, bareName, matchPropertyNames } from "./component-properties.js";
import { describeNodeIdentity, instanceContextOf, propertyDefinitionsOf, type InstanceContextFacts } from "./identity.js";
import type { RealizeOnlyFields } from "./instance-write-authorization.js";
import type { RealizeOnlyCheck } from "./call-obligations.js";
import type { ScenePaint } from "./node-to-snapshot.js";
import type { EditPlan, GateResources } from "./edit-plan.js";
import type { InstanceEditPlan } from "./instance.js";
import type { InstancePlan } from "./bridge.js";
import type { InstanceWriteRuleId } from "./instance-write-policy.js";
import { patchFieldKey } from "./obligation.js";
import type {
  AuthoredWordSource, BindableObligationRequest, Obligation, ObligationKind, ObligationRequests, ObligationTarget,
  ObligationWritePoint, PaintStackRequest, PatchField, TextFieldRequest, TextMetricValue, TextRange, TextRunRequest,
} from "./obligation.js";

/** An obligation before it has a target: a clone's copy, say, which exists only once apply makes it. */
export interface ObligationDraft<K extends ObligationKind = ObligationKind> {
  readonly kind: K;
  readonly request: ObligationRequests[K];
  /** The authored word, in the agent's own spelling ("fill", "layout.gap", `overrides["Label"].fill`). */
  readonly path: string;
  readonly writePoint: ObligationWritePoint;
  readonly carries: readonly PatchField[];
  readonly writability: Obligation["writability"];
  /** An instance sublayer path: the obligation is on that sublayer of the target, found when observed. */
  readonly sublayer?: string;
}

/** Where a plan's words land, for what only the landing decides. */
export interface ObligationDerivationSite {
  /** Its instance context there: a word the instance write policy refuses must hold without a write. */
  instance: Pick<InstanceContextFacts, "ownWritesLockedBy" | "isInstanceRoot">;
  /** The layout of the parent it sits in once the call lands. */
  parentMode: LayoutMode;
  /** Whether that parent is a page, where a "fill" read root lands at its designed size. */
  onPage: boolean;
}

interface DerivationContext extends ObligationDerivationSite {
  plan: EditPlan;
  gate: GateResources;
  /** Prepended to every path: an override's own address. */
  prefix: string;
  /**
   * Derive only fields an authored word names. A built node's compile injects what its creation
   * needs (a frame's empty fill, a line's stroke, its derived constraints); an edit's words are all authored.
   */
  authoredOnly?: boolean;
}

type PropDerivation<K extends keyof WriteProps> =
  | { authoredBy: readonly string[]; derive(value: NonNullable<WriteProps[K]>, ctx: DerivationContext): ObligationDraft[] }
  | { delegatedTo: "LAYOUT_OBLIGATION_DERIVATIONS" | "deriveInstanceEditObligations" | "deriveComponentEditObligations" | "deriveParentageObligations" }
  /** Derived together with another field, which reads this one. */
  | { foldedInto: keyof WriteProps };

type LayoutDerivation<K extends keyof WriteLayout> =
  | { authoredBy: readonly string[]; derive(value: NonNullable<WriteLayout[K]>, ctx: DerivationContext): ObligationDraft[] }
  | { foldedInto: keyof WriteLayout };

// ---- shared ----

function pathOf(ctx: DerivationContext, authoredBy: readonly string[]): string {
  return ctx.prefix + (authoredBy.find((word) => ctx.plan.authored.has(word)) ?? authoredBy[0]);
}

function draft<K extends ObligationKind>(
  kind: K, request: ObligationRequests[K], path: string, writePoint: ObligationWritePoint, carries: readonly PatchField[],
  writability: Obligation["writability"] = "writable",
): ObligationDraft<K> {
  return { kind, request, path, writePoint, carries, writability };
}

// A word the instance write policy refuses inside an instance is only ever held there, never written.
function lockedBy(ctx: DerivationContext, rule: InstanceWriteRuleId): Obligation["writability"] {
  return ctx.instance.ownWritesLockedBy ? { realizeOnly: rule } : "writable";
}

function bindableRequest(value: Bindable, tokens: ResolvedTokens): BindableObligationRequest {
  if (!isTokenRef(value)) return { literal: value };
  const ref = value as VariableRef;
  return { variable: ref.name ?? ref.id ?? ref.word, variableId: variableFor(ref, tokens).id };
}

function edgesRequest(edges: Edges<Bindable>, tokens: ResolvedTokens): Edges<BindableObligationRequest> {
  return { top: bindableRequest(edges.top, tokens), right: bindableRequest(edges.right, tokens), bottom: bindableRequest(edges.bottom, tokens), left: bindableRequest(edges.left, tokens) };
}

function cornersRequest(corners: CornerRadii<Bindable>, tokens: ResolvedTokens): CornerRadii<BindableObligationRequest> {
  return {
    topLeft: bindableRequest(corners.topLeft, tokens), topRight: bindableRequest(corners.topRight, tokens),
    bottomRight: bindableRequest(corners.bottomRight, tokens), bottomLeft: bindableRequest(corners.bottomLeft, tokens),
  };
}

function spelledWord(ctx: DerivationContext, word: string): string {
  const value = (ctx.plan.delta as Record<string, unknown>)[word];
  return value === undefined ? word : JSON.stringify(value);
}

// ---- paints, in the order and shape Figma stores them ----

// A url image's hash is minted by the write that fetches it, so the request can't name it.
function scenePaintOf(paint: WritePaint, tokens: ResolvedTokens): { paint: ScenePaint; hashKnown: boolean } {
  if (paint.kind === "image") {
    const hash = "hash" in paint ? paint.hash : null;
    const tile = "hash" in paint && paint.scalingFactor != null ? { scalingFactor: paint.scalingFactor } : {};
    return { paint: { type: "IMAGE", scaleMode: paint.scaleMode, imageHash: hash, ...tile, ...imagePaintAdjustments(paint) } as ScenePaint, hashKnown: hash !== null };
  }
  const figmaPaint = toFigmaPaint(paint) as unknown as Record<string, unknown>;
  if (paint.kind === "solid" && paint.colorVariable) {
    figmaPaint.boundVariables = { color: { type: "VARIABLE_ALIAS", id: variableFor(paint.colorVariable, tokens).id } };
  }
  return { paint: figmaPaint as unknown as ScenePaint, hashKnown: true };
}

function paintStackOf(stack: WritePaintStack, tokens: ResolvedTokens): Pick<PaintStackRequest, "paints" | "hashKnown"> {
  const scene = stack.slice().reverse().map((paint) => scenePaintOf(paint, tokens));
  return { paints: scene.map((s) => s.paint), hashKnown: scene.map((s) => s.hashKnown) };
}

// ---- text ----

/** Each run's character range, in the order the runs join into the node's characters. */
function runRanges(runs: readonly WriteTextRun[]): TextRange[] {
  let at = 0;
  return runs.map((run) => {
    const range: TextRange = [at, at + run.text.length];
    at = range[1];
    return range;
  });
}

/** The ranges of the runs that set a field of their own, which the base word yields to there. */
function exceptRuns(ctx: DerivationContext, sets: (run: WriteTextRun) => boolean): TextRange[] {
  const runs = ctx.plan.patch.runs ?? [];
  const ranges = runRanges(runs);
  return runs.flatMap((run, i) => (sets(run) ? [ranges[i]] : []));
}

const TEXT_ALIGN_NATIVE: Record<string, string> = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFIED" };
const VERTICAL_ALIGN_NATIVE: Record<string, string> = { top: "TOP", center: "CENTER", bottom: "BOTTOM" };
const DECORATION_NATIVE: Record<string, string> = { underline: "UNDERLINE", "line-through": "STRIKETHROUGH", none: "NONE" };

const METRIC_FIELDS = ["fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent", "listSpacing"] as const;

function metricValue(value: unknown, tokens: ResolvedTokens): TextMetricValue | { variableId: string } {
  if (isTokenRef(value)) return { variableId: variableFor(value as VariableRef, tokens).id };
  return value as TextMetricValue;
}

// A literal family or weight unbinds the field only where the agent wrote it: the rest of a font
// identity is read off the live node to resolve the face, not stated.
function fontRequest(style: WriteTextStyle, tokens: ResolvedTokens, fonts: GateResources["fonts"], written: { family: boolean; weight: boolean }): Extract<TextFieldRequest, { field: "fontName" }> {
  const italic = style.fontStyle === "italic";
  const requirement = (word: Bindable<string | number> | undefined, authored: boolean) =>
    isTokenRef(word) ? variableFor(word as VariableRef, tokens).id : authored && word !== undefined ? null : undefined;
  const request: Extract<TextFieldRequest, { field: "fontName" }> = {
    field: "fontName",
    font: resolveFont(fonts, style.fontFamily, style.fontWeight, italic),
    family: requirement(style.fontFamily, written.family),
    weight: requirement(style.fontWeight, written.weight),
  };
  if (typeof style.fontFamily === "string" && !isTokenRef(style.fontWeight)) {
    request.written = { family: style.fontFamily, weight: style.fontWeight as number | string | undefined, italic };
  }
  return request;
}

function runFieldRequests(run: WriteTextRun, tokens: ResolvedTokens, fonts: GateResources["fonts"]): TextFieldRequest[] {
  const fields: TextFieldRequest[] = [];
  const s = run.style;
  // A run carries its effective face whenever it changes any of it (compile-text.ts compileRun), so
  // its literal family is the base's echo, not a word to unbind by.
  if (s && namesFontIdentity(s)) fields.push(fontRequest(s, tokens, fonts, { family: false, weight: false }));
  if (s) {
    for (const field of METRIC_FIELDS) if (s[field] !== undefined) fields.push({ field, value: metricValue(s[field], tokens) } as TextFieldRequest);
    if (s.textDecoration) fields.push({ field: "textDecoration", value: DECORATION_NATIVE[s.textDecoration] });
    if (s.textCase) fields.push({ field: "textCase", value: s.textCase });
  }
  if (run.fills) fields.push({ field: "fills", ...paintStackOf(run.fills, tokens) });
  if (run.hyperlink) fields.push({ field: "hyperlink", url: run.hyperlink });
  return fields;
}

const TEXT_STYLE_WORD = (word: string) => "textStyle." + word;

function deriveTextStyle(style: WriteTextStyle, ctx: DerivationContext): ObligationDraft[] {
  const { tokens, fonts } = ctx.gate;
  const out: ObligationDraft[] = [];
  const text: PatchField[] = [{ prop: "textStyle" }];
  if (style.style) {
    const ref: StyleRef = style.style;
    out.push(draft("textStyleLink", { styleId: styleFor(ref, tokens).id, styleName: ref.name ?? ref.id ?? ref.word }, pathOf(ctx, [TEXT_STYLE_WORD("style")]), "finalizer", text));
  }
  if (namesFontIdentity(style)) {
    const written = { family: ctx.plan.authored.has(TEXT_STYLE_WORD("fontFamily")), weight: ctx.plan.authored.has(TEXT_STYLE_WORD("fontWeight")) };
    out.push(draft("fontIdentity", { ...fontRequest(style, tokens, fonts, written), except: exceptRuns(ctx, (run) => namesFontIdentity(run.style)) },
      pathOf(ctx, ["fontFamily", "fontWeight", "fontStyle"].map(TEXT_STYLE_WORD)), "text", text));
  }
  for (const field of METRIC_FIELDS) {
    if (style[field] === undefined) continue;
    const authoredBy = field === "fontSize" ? [TEXT_STYLE_WORD(field), "fontSize"] : [TEXT_STYLE_WORD(field)];
    out.push(draft("textMetric", { field, value: metricValue(style[field], tokens), except: exceptRuns(ctx, (run) => run.style?.[field] !== undefined) } as ObligationRequests["textMetric"],
      pathOf(ctx, authoredBy), "text", text));
  }
  if (style.textDecoration) {
    out.push(draft("textDecoration", { value: DECORATION_NATIVE[style.textDecoration], except: exceptRuns(ctx, (run) => !!run.style?.textDecoration) },
      pathOf(ctx, [TEXT_STYLE_WORD("textDecoration")]), "text", text));
  }
  if (style.textCase) {
    out.push(draft("textCase", { value: style.textCase, except: exceptRuns(ctx, (run) => !!run.style?.textCase) },
      pathOf(ctx, ["textTransform", "fontVariant"].map(TEXT_STYLE_WORD)), "text", text));
  }
  if (style.textAlign) out.push(draft("textAlign", TEXT_ALIGN_NATIVE[style.textAlign], pathOf(ctx, [TEXT_STYLE_WORD("textAlign")]), "text", text));
  if (style.textAlignVertical) out.push(draft("textAlignVertical", VERTICAL_ALIGN_NATIVE[style.textAlignVertical], pathOf(ctx, [TEXT_STYLE_WORD("textAlignVertical")]), "text", text));
  if (style.hyperlink) {
    out.push(draft("hyperlink", { url: style.hyperlink, except: exceptRuns(ctx, (run) => !!run.hyperlink) }, pathOf(ctx, [TEXT_STYLE_WORD("hyperlink")]), "text", text));
  }
  return out;
}

// ---- the tables ----

const appearance = (prop: keyof WriteProps): PatchField[] => [{ prop }];
// Runs are the content and `text` only their plain spelling: they are written together.
const RUN_FIELDS: PatchField[] = [{ prop: "runs" }, { prop: "text" }];

const PROP_OBLIGATION_DERIVATIONS: { readonly [K in keyof Required<WriteProps>]: PropDerivation<K> } = {
  annotations: {
    authoredBy: ["annotations"],
    derive: (annotations, ctx) => [draft("annotations", annotations.map(({ text, category, properties }) => ({
      text, categoryId: category === undefined ? undefined : annotationCategoryId(category), properties: properties?.slice(),
    })), pathOf(ctx, ["annotations"]), "appearance", appearance("annotations"))],
  },
  name: { authoredBy: ["name"], derive: (name, ctx) => [draft("name", name, pathOf(ctx, ["name"]), "appearance", appearance("name"))] },
  key: { authoredBy: ["key"], derive: (key, ctx) => [draft("pluginKey", key, pathOf(ctx, ["key"]), "after-binding", appearance("key"))] },
  text: {
    authoredBy: ["text"],
    // Runs, when present, are the content: `text` then is only their plain spelling.
    derive: (text, ctx) => (ctx.plan.patch.runs ? [] : [draft("characters", String(text), pathOf(ctx, ["text"]), "text", appearance("text"))]),
  },
  runs: {
    authoredBy: ["text", "boldWeight"],
    derive: (runs, ctx) => {
      const { tokens, fonts } = ctx.gate;
      const ranges = runRanges(runs);
      const styled: TextRunRequest[] = runs.flatMap((run, i) => {
        const fields = runFieldRequests(run, tokens, fonts);
        return fields.length && ranges[i][1] > ranges[i][0] ? [{ start: ranges[i][0], end: ranges[i][1], fields }] : [];
      });
      const path = pathOf(ctx, ["text"]);
      return [
        draft("characters", textOfRuns(runs), path, "text", RUN_FIELDS),
        ...(styled.length ? [draft("textRuns", { runs: styled }, path, "text", RUN_FIELDS)] : []),
      ];
    },
  },
  vector: {
    authoredBy: ["vectorPaths", "d"],
    // Imported markup has no live edit (live-tree.ts refuses it); path scale is the built node's.
    derive: (vector, ctx) => (vector.kind === "path" ? [draft("vectorPaths", { paths: vector.paths as VectorPaths }, pathOf(ctx, ["vectorPaths", "d"]), "vector-path", appearance("vector"))] : []),
  },
  textStyle: { authoredBy: ["textStyle"], derive: (style, ctx) => deriveTextStyle(style, ctx) },
  maxLines: { authoredBy: ["textStyle.lineClamp"], derive: (lines, ctx) => [draft("lineClamp", lines, pathOf(ctx, ["textStyle.lineClamp"]), "text-clamp", appearance("maxLines"))] },
  fills: {
    authoredBy: ["fill"],
    derive: (stack, ctx) => [draft("paintStack", {
      slot: "fills", ...paintStackOf(stack, ctx.gate.tokens), spelled: spelledWord(ctx, "fill"),
      except: ctx.plan.node.type === "TEXT" ? exceptRuns(ctx, (run) => !!run.fills) : [],
    }, pathOf(ctx, ["fill"]), "appearance", appearance("fills"))],
  },
  strokes: {
    authoredBy: ["stroke"],
    derive: (stack, ctx) => [draft("paintStack", { slot: "strokes", ...paintStackOf(stack, ctx.gate.tokens), spelled: spelledWord(ctx, "stroke"), except: [] },
      pathOf(ctx, ["stroke"]), "appearance", appearance("strokes"))],
  },
  strokeWeight: {
    authoredBy: ["strokeWidth"],
    derive: (weight, ctx) => {
      const request = typeof weight === "number" || isTokenRef(weight)
        ? { uniform: bindableRequest(weight as Bindable, ctx.gate.tokens) }
        : { sides: edgesRequest(weight as Edges<Bindable>, ctx.gate.tokens) };
      return [draft("strokeWeight", request, pathOf(ctx, ["strokeWidth"]), "appearance", appearance("strokeWeight"))];
    },
  },
  strokeAlign: { authoredBy: ["strokeAlign"], derive: (align, ctx) => [draft("strokeAlign", align, pathOf(ctx, ["strokeAlign"]), "appearance", appearance("strokeAlign"))] },
  effects: {
    authoredBy: ["effects"],
    derive: (effects, ctx) => [draft("effects", { effects: toFigmaEffects(effects), spelled: spelledWord(ctx, "effects") }, pathOf(ctx, ["effects"]), "appearance", appearance("effects"))],
  },
  styles: {
    authoredBy: ["fill", "stroke", "effects"],
    derive: (styles, ctx) => (["fill", "stroke", "effect"] as const).flatMap((slot) => {
      const ref = styles[slot];
      if (!ref) return [];
      const style = styleFor(ref, ctx.gate.tokens) as BaseStyle & { paints?: readonly Paint[]; effects?: readonly Effect[] };
      return [draft("styleLink", {
        slot, styleId: style.id, styleName: ref.name ?? ref.id ?? ref.word,
        paints: (style.paints ?? []) as unknown as ScenePaint[], effects: style.effects ?? [],
      }, pathOf(ctx, [slot === "effect" ? "effects" : slot]), "finalizer", appearance("styles"))];
    }),
  },
  opacity: { authoredBy: ["opacity"], derive: (opacity, ctx) => [draft("opacity", bindableRequest(opacity, ctx.gate.tokens), pathOf(ctx, ["opacity"]), "appearance", appearance("opacity"))] },
  blendMode: { authoredBy: ["mixBlendMode"], derive: (mode, ctx) => [draft("blendMode", mode, pathOf(ctx, ["mixBlendMode"]), "appearance", appearance("blendMode"))] },
  borderRadius: { authoredBy: ["borderRadius"], derive: (radii, ctx) => [draft("cornerRadii", cornersRequest(radii, ctx.gate.tokens), pathOf(ctx, ["borderRadius"]), "appearance", appearance("borderRadius"))] },
  clip: { authoredBy: ["clip", "clipsContent"], derive: (clip, ctx) => [draft("clip", clip, pathOf(ctx, ["clip", "clipsContent"]), "appearance", appearance("clip"))] },
  rotation: {
    authoredBy: ["rotation"],
    derive: (rotation, ctx) => [draft("rotation", rotation, pathOf(ctx, ["rotation"]), "appearance", appearance("rotation"), lockedBy(ctx, "instance.transform"))],
  },
  visible: { authoredBy: ["visible"], derive: (visible, ctx) => [draft("visible", visible, pathOf(ctx, ["visible"]), "appearance", appearance("visible"))] },
  locked: { authoredBy: ["locked"], derive: (locked, ctx) => [draft("locked", locked, pathOf(ctx, ["locked"]), "appearance", appearance("locked"))] },
  layout: { delegatedTo: "LAYOUT_OBLIGATION_DERIVATIONS" },
  children: { delegatedTo: "deriveParentageObligations" },
  exposed: { delegatedTo: "deriveInstanceEditObligations" },
  component: { delegatedTo: "deriveInstanceEditObligations" },
  componentProperties: { delegatedTo: "deriveInstanceEditObligations" },
  overrides: { delegatedTo: "deriveInstanceEditObligations" },
  componentPropertyReferences: { delegatedTo: "deriveComponentEditObligations" },
};

const LAYOUT_AXES = [["horizontal", "width", "x", "left"], ["vertical", "height", "y", "top"]] as const;
const layoutField = (layout: keyof WriteLayout): PatchField[] => [{ layout }];
// An offset holds the "absolute" it implies under a flow, so it carries the position word too.
const offsetFields = (layout: "left" | "top" | "percentPos"): PatchField[] => [{ layout }, { layout: "position" }];
const LAYOUT_WORD = (word: string) => "layout." + word;

// One axis's size, from every word that says it: the sizing intent and the px, variable or percent
// a fixed axis carries. An injected "fixed" with no value (a LINE's echo) says nothing to hold.
function deriveAxisSize(axis: Axis, sizing: NonNullable<WriteLayout["sizing"]>, ctx: DerivationContext): ObligationDraft[] {
  const layout = ctx.plan.patch.layout!;
  const [, dimension] = LAYOUT_AXES.find(([a]) => a === axis)!;
  const intent = sizing[axis];
  if (ctx.authoredOnly && !authors(ctx, dimension) && !authors(ctx, LAYOUT_WORD(dimension))) return [];
  const path = pathOf(ctx, [dimension, LAYOUT_WORD(dimension)]);
  const carries: PatchField[] = [{ axis }];
  if (intent === "hug") return [draft("axisSize", { axis, intent: { hug: true } }, path, "own-size", carries)];
  if (intent === "fill") {
    const designed = layout.designedSize?.[dimension];
    // A read root's "fill" lands on a page at the size it was read at (foldDesignedSizeForPage).
    if (ctx.onPage && designed !== undefined) return [draft("axisSize", { axis, intent: { px: { literal: designed } } }, path, "own-size", carries)];
    const resizes = ctx.parentMode.kind === "free";
    return [draft("axisSize", { axis, intent: { fill: true } }, path, resizes ? "cover" : "own-size", carries, resizes ? lockedBy(ctx, "instance.explicit-resize") : "writable")];
  }
  if (intent !== "fixed") return [];
  if (followsFilledRatioDriver(axis, sizing, layout)) return [];
  const px = layout.dimensions?.[dimension];
  if (px !== undefined) {
    return [draft("axisSize", { axis, intent: { px: bindableRequest(px, ctx.gate.tokens) } }, path, "own-size", carries, lockedBy(ctx, "instance.explicit-resize"))];
  }
  const percent = layout.percentSize?.[dimension];
  if (percent !== undefined) {
    return [draft("axisSize", { axis, intent: { percent } }, path, "percent-size", carries, lockedBy(ctx, "instance.explicit-resize"))];
  }
  return [];
}

// Under a ratio, a filled or percent axis drives (settleAspectRatio) and the other's size is the
// ratio's to set: a read pastes back both sizes with its lock, and the stated one yields to the box.
function followsFilledRatioDriver(axis: Axis, sizing: NonNullable<WriteLayout["sizing"]>, layout: WriteLayout): boolean {
  if (typeof layout.aspectRatio !== "number") return false;
  const [, other] = LAYOUT_AXES.find(([a]) => a !== axis)!;
  return sizing[axis === "horizontal" ? "vertical" : "horizontal"] === "fill" || layout.percentSize?.[other] !== undefined;
}

// "stretch" fills the axis the parent stretches along: its cross axis in a flow, the cell's height in a grid.
function stretchAxisOf(word: "alignSelf" | "justifySelf", ctx: DerivationContext): Axis {
  if (word === "justifySelf") return "horizontal";
  return ctx.parentMode.kind === "flow" ? ctx.parentMode.cross : "vertical";
}

function deriveStretch(word: "alignSelf" | "justifySelf", ctx: DerivationContext): ObligationDraft[] {
  const axis = stretchAxisOf(word, ctx);
  // The same axis named again as a size states the same fill; its own derivation holds it.
  if (ctx.plan.patch.layout?.sizing?.[axis] === "fill") return [];
  return [draft("axisSize", { axis, intent: { fill: true } }, pathOf(ctx, [LAYOUT_WORD(word)]), "own-size", [{ axis }, { layout: word }])];
}

const CELL_ALIGN_NATIVE: Record<string, string> = { start: "MIN", end: "MAX", center: "CENTER", auto: "AUTO" };

const LAYOUT_OBLIGATION_DERIVATIONS: { readonly [K in keyof Required<WriteLayout>]: LayoutDerivation<K> } = {
  bounds: {
    authoredBy: ["minWidth", "maxWidth", "minHeight", "maxHeight"],
    derive: (bounds, ctx) => (Object.keys(bounds) as (keyof typeof bounds)[]).flatMap((bound) => {
      const value = bounds[bound];
      if (value === undefined) return [];
      return [draft("sizeBound", { bound, value: value === "none" ? "none" : bindableRequest(value, ctx.gate.tokens) }, pathOf(ctx, [bound]), "own-size", layoutField("bounds"), lockedBy(ctx, "instance.size-bounds"))];
    }),
  },
  mode: {
    authoredBy: [LAYOUT_WORD("mode")],
    derive: (mode, ctx) => [draft("layoutMode", mode, pathOf(ctx, [LAYOUT_WORD("mode")]), "container", layoutField("mode"),
      ctx.instance.ownWritesLockedBy ? { realizeOnly: "instance.layout-mode-change" } : ctx.instance.isInstanceRoot ? { realizeOnly: "instance.root-layout-mode" } : "writable")],
  },
  gridTemplateColumns: {
    authoredBy: [LAYOUT_WORD("gridTemplateColumns")],
    derive: (tracks, ctx) => [draft("gridTracks", { axis: "horizontal", tracks }, pathOf(ctx, [LAYOUT_WORD("gridTemplateColumns")]), "container", layoutField("gridTemplateColumns"))],
  },
  gridTemplateRows: {
    authoredBy: [LAYOUT_WORD("gridTemplateRows")],
    derive: (tracks, ctx) => [draft("gridTracks", { axis: "vertical", tracks }, pathOf(ctx, [LAYOUT_WORD("gridTemplateRows")]), "container", layoutField("gridTemplateRows"))],
  },
  gridColumn: {
    authoredBy: [LAYOUT_WORD("gridColumn")],
    derive: (cell, ctx) => [draft("gridPlacement", { axis: "horizontal", anchor: cell.anchor, span: cell.span }, pathOf(ctx, [LAYOUT_WORD("gridColumn")]), "placement", layoutField("gridColumn"))],
  },
  gridRow: {
    authoredBy: [LAYOUT_WORD("gridRow")],
    derive: (cell, ctx) => [draft("gridPlacement", { axis: "vertical", anchor: cell.anchor, span: cell.span }, pathOf(ctx, [LAYOUT_WORD("gridRow")]), "placement", layoutField("gridRow"))],
  },
  justifySelf: {
    authoredBy: [LAYOUT_WORD("justifySelf")],
    derive: (align, ctx) => (align === "stretch" ? deriveStretch("justifySelf", ctx)
      : [draft("gridCellAlign", { axis: "horizontal", align }, pathOf(ctx, [LAYOUT_WORD("justifySelf")]), "placement", layoutField("justifySelf"))]),
  },
  alignSelf: {
    authoredBy: [LAYOUT_WORD("alignSelf")],
    derive: (align, ctx) => (align === "stretch" ? deriveStretch("alignSelf", ctx)
      : [draft("gridCellAlign", { axis: "vertical", align: CELL_ALIGN_NATIVE[align] }, pathOf(ctx, [LAYOUT_WORD("alignSelf")]), "placement", layoutField("alignSelf"))]),
  },
  zIndex: {
    authoredBy: [LAYOUT_WORD("zIndex")],
    derive: (index, ctx) => [draft("zIndex", index, pathOf(ctx, [LAYOUT_WORD("zIndex")]), "structural", layoutField("zIndex"), lockedBy(ctx, "instance.child-list"))],
  },
  justifyContent: {
    authoredBy: [LAYOUT_WORD("justifyContent")],
    derive: (justify, ctx) => [draft("justifyContent", justify, pathOf(ctx, [LAYOUT_WORD("justifyContent")]), "container", layoutField("justifyContent"))],
  },
  alignItems: {
    authoredBy: [LAYOUT_WORD("alignItems")],
    derive: (align, ctx) => [align === "stretch"
      ? draft("alignItemsStretch", {}, pathOf(ctx, [LAYOUT_WORD("alignItems")]), "container", layoutField("alignItems"))
      : draft("alignItems", align, pathOf(ctx, [LAYOUT_WORD("alignItems")]), "container", layoutField("alignItems"))],
  },
  gap: {
    authoredBy: [LAYOUT_WORD("gap")],
    derive: (gap, ctx) => {
      const { tokens } = ctx.gate;
      const request = typeof gap === "number" || isTokenRef(gap)
        ? { row: bindableRequest(gap as Bindable, tokens), column: bindableRequest(gap as Bindable, tokens) }
        : { row: bindableRequest((gap as { row: Bindable }).row, tokens), column: bindableRequest((gap as { column: Bindable }).column, tokens) };
      return [draft("gap", request, pathOf(ctx, [LAYOUT_WORD("gap")]), "container", layoutField("gap"))];
    },
  },
  wrap: { authoredBy: [LAYOUT_WORD("wrap")], derive: (wrap, ctx) => [draft("wrap", wrap, pathOf(ctx, [LAYOUT_WORD("wrap")]), "container", layoutField("wrap"))] },
  padding: {
    authoredBy: [LAYOUT_WORD("padding")],
    derive: (padding, ctx) => [draft("padding", edgesRequest(padding, ctx.gate.tokens), pathOf(ctx, [LAYOUT_WORD("padding")]), "container", layoutField("padding"))],
  },
  sizing: {
    authoredBy: ["width", "height"],
    derive: (sizing, ctx) => [...deriveAxisSize("horizontal", sizing, ctx), ...deriveAxisSize("vertical", sizing, ctx)],
  },
  dimensions: { foldedInto: "sizing" },
  percentSize: { foldedInto: "sizing" },
  designedSize: { foldedInto: "sizing" },
  aspectRatio: {
    authoredBy: ["aspectRatio"],
    derive: (ratio, ctx) => [draft("aspectRatio", ratio, pathOf(ctx, ["aspectRatio"]), "aspect-ratio", layoutField("aspectRatio"), lockedBy(ctx, "instance.aspect-lock"))],
  },
  constraints: {
    authoredBy: ["constraints"],
    derive: (constraints, ctx) => LAYOUT_AXES.flatMap(([axis, , key]) => {
      const spelled = constraints[key];
      if (spelled === undefined) return [];
      const value = (axis === "horizontal" ? CONSTRAINT_H : CONSTRAINT_V)[spelled];
      return [draft("constraint", { axis, value, spelled }, pathOf(ctx, ["constraints"]), "constraints", layoutField("constraints"), lockedBy(ctx, "instance.constraints"))];
    }),
  },
  // Only when written: a `left`/`top` implies "absolute" to execute itself, and its offset holds it.
  position: {
    authoredBy: ["position"],
    derive: (position, ctx) => (ctx.plan.authored.has("position")
      ? [draft("positioning", position, pathOf(ctx, ["position"]), "placement", layoutField("position"), lockedBy(ctx, "instance.positioning"))]
      : []),
  },
  left: {
    authoredBy: ["left"],
    derive: (left, ctx) => [draft("positionOffset", { axis: "horizontal", offset: { px: left } }, pathOf(ctx, ["left"]), "placement", offsetFields("left"), lockedBy(ctx, "instance.transform"))],
  },
  top: {
    authoredBy: ["top"],
    derive: (top, ctx) => [draft("positionOffset", { axis: "vertical", offset: { px: top } }, pathOf(ctx, ["top"]), "placement", offsetFields("top"), lockedBy(ctx, "instance.transform"))],
  },
  percentPos: {
    authoredBy: ["left", "top"],
    derive: (pos, ctx) => LAYOUT_AXES.flatMap(([axis, , key, word]) => {
      const percent = pos[key];
      return percent === undefined ? [] : [draft("positionOffset", { axis, offset: { percent } }, pathOf(ctx, [word]), "percent-position", offsetFields("percentPos"), lockedBy(ctx, "instance.transform"))];
    }),
  },
};

// Whether `word` (or a word inside it, for a partial bag) is one the plan states.
function authors(ctx: DerivationContext, word: string): boolean {
  if (ctx.plan.authored.has(word)) return true;
  for (const path of ctx.plan.authored) if (path.startsWith(word + ".")) return true;
  return false;
}

function deriveFields<P extends object>(
  bag: P, table: { readonly [K in keyof P]-?: PropDerivation<any> | LayoutDerivation<any> }, ctx: DerivationContext,
): ObligationDraft[] {
  const out: ObligationDraft[] = [];
  for (const key of Object.keys(bag) as (keyof P)[]) {
    const value = bag[key];
    const derivation = table[key];
    if (value === undefined || !("derive" in derivation)) continue;
    if (ctx.authoredOnly && !derivation.authoredBy.some((word) => authors(ctx, word))) continue;
    out.push(...derivation.derive(value as never, ctx));
  }
  return out;
}

/**
 * The node-local obligations of one compiled plan: every field its patch carries. The instance and
 * component halves are their own derivers'; the caller records all three against one target.
 */
export function deriveEditPlanObligations(plan: EditPlan, gate: GateResources, site: ObligationDerivationSite, prefix = ""): ObligationDraft[] {
  const ctx: DerivationContext = { ...site, plan, gate, prefix };
  const drafts = deriveFields(plan.patch, PROP_OBLIGATION_DERIVATIONS, ctx);
  if (plan.patch.layout) drafts.push(...deriveFields(plan.patch.layout, LAYOUT_OBLIGATION_DERIVATIONS, ctx));
  return drafts;
}

/**
 * The words a node the walk built owes once it sits under `parent`: the ones its spec states, never
 * what its creation injected. An instance adds the half its `instance` plan stamped; the binding
 * bag, which the declaring verb writes after the walk, is observed by bare name like an edit's.
 */
export function deriveBuiltNodeObligations(wn: BuiltNode, node: SceneNode, gate: GateResources, parent: BaseNode, instance?: InstancePlan): ObligationDraft[] {
  const patch: WriteProps = {};
  // An svg's paints recolour the art inside its canvas (themeImportedArt); the canvas itself stays unpainted.
  const art = wn.vector?.kind === "svg" ? new Set<keyof WriteProps>(["fills", "strokes"]) : undefined;
  for (const key of Object.keys(PROP_OBLIGATION_DERIVATIONS) as (keyof WriteProps)[]) {
    if (wn[key] !== undefined && !art?.has(key)) (patch as Record<string, unknown>)[key] = wn[key];
  }
  const delta = (wn.source ?? {}) as EditPlan["delta"];
  const plan: EditPlan = { node, patch, delta, authored: wordPathsOf(delta) };
  const site: ObligationDerivationSite = {
    instance: instanceContextOf(node),
    parentMode: layoutModeOf(parent as { layoutMode?: string }),
    onPage: parent.type === "PAGE",
  };
  const ctx: DerivationContext = { ...site, plan, gate, prefix: "", authoredOnly: true };
  const drafts = deriveFields(patch, PROP_OBLIGATION_DERIVATIONS, ctx);
  // A built container's stretch is owed by each child it reached (deriveBuiltStretchObligations):
  // one sized across keeps its size, so the container word holds no rule over every child.
  if (patch.layout) drafts.push(...deriveFields(patch.layout.alignItems === "stretch" ? { ...patch.layout, alignItems: undefined } : patch.layout, LAYOUT_OBLIGATION_DERIVATIONS, ctx));
  if (instance) drafts.push(...deriveBuiltInstanceObligations(node, instance, gate));
  return [...drafts, ...deriveBindingObligations(wn.componentPropertyReferences)].map((d) => ({ ...d, writePoint: "build" as const }));
}

// A stamped instance's property values (its variant is the component it was stamped from) and
// every override's words, each on the sublayer its path names.
function deriveBuiltInstanceObligations(node: SceneNode, instance: InstancePlan, gate: GateResources): ObligationDraft[] {
  const siteOf = overrideObligationSite(node);
  return [
    ...Object.entries(instance.properties).map(([name, value]) => draft("componentPropertyValue", { name, value }, "componentProperties." + bareName(name), "build", [])),
    ...instance.overrides.flatMap((override) => deriveEditPlanObligations(override.plan, gate, siteOf(override.plan), overrideWordPath(override.path) + ".")
      .map((d) => ({ ...d, sublayer: override.path }))),
  ];
}

/** The fill a built parent's `alignItems: "stretch"` gave one child, attributed to that parent. */
export function deriveBuiltStretchObligations(axis: Axis): ObligationDraft[] {
  return [draft("axisSize", { axis, intent: { fill: true } }, LAYOUT_WORD("alignItems"), "build", [{ axis }])];
}

/** Where an instance edit's override plans land: on locked sublayers, under their own parents. */
export type OverrideSiteOf = (plan: EditPlan) => ObligationDerivationSite;

/**
 * An instance delta's component half: the component it shows, its property values, its exposure,
 * and every override's words, each on the sublayer its path names once the call lands.
 */
function deriveInstanceEditObligations(
  node: SceneNode, words: InstanceEditWords, instance: InstanceEditPlan, gate: GateResources, siteOf: OverrideSiteOf,
): ObligationDraft[] {
  const out: ObligationDraft[] = [];
  if (words.componentId != null) {
    const component = instance.becomes;
    out.push(draft("instanceComponent", { componentId: component.id, componentName: component.name, sublayerPaths: expectedSublayerIds(node, component) }, "componentId", "retarget", []));
  }
  for (const [name, value] of Object.entries(instance.properties)) {
    out.push(draft("componentPropertyValue", { name, value }, "componentProperties." + bareName(name), "retarget", [{ word: `property:${name}` }]));
  }
  if (words.exposed !== undefined) out.push(draft("exposedInstance", words.exposed, "exposed", "retarget", [{ word: "exposed" }]));
  for (const override of instance.overrides) {
    const drafts = deriveEditPlanObligations(override.plan, gate, siteOf(override.plan), overrideWordPath(override.path) + ".");
    out.push(...drafts.map((d) => ({ ...d, sublayer: override.path })));
  }
  return out;
}

const DEFINITION_TYPES: Record<string, string> = { ...PROPERTY_TYPES, variant: "VARIANT" };

/**
 * A component delta's definition and binding words. Each property is observed by its bare name, so
 * an add's suffix, which only Figma mints, never has to be known.
 */
function deriveComponentEditObligations(node: SceneNode, words: ComponentEditWords): ObligationDraft[] {
  const out: ObligationDraft[] = [];
  if (words.description !== undefined) out.push(draft("componentDescription", words.description, "description", "definitions", [{ word: "description" }]));
  const live = propertyDefinitionsOf(node as { componentPropertyDefinitions?: Record<string, any> });
  for (const [name, entry] of Object.entries(words.propertyDefinitions ?? {})) {
    const path = "propertyDefinitions[" + JSON.stringify(name) + "]";
    if (entry === null) {
      // By the full id it is filed under: a rename landing on the freed name is another property.
      const matches = matchPropertyNames(name, live);
      if (matches.length !== 1) continue; // the definition plan refused it already
      out.push(draft("propertyDefinition", { delete: matches[0] }, path, "definitions", [{ word: `definition:${name}` }]));
      continue;
    }
    if (entry.name != null) {
      const matches = matchPropertyNames(name, live);
      if (matches.length !== 1) continue; // the definition plan refused it already
      out.push(draft("propertyDefinition", { declare: entry.name.trim(), figmaType: live[matches[0]].type, replaces: matches[0] }, path, "definitions", [{ word: `definition:${name}` }]));
      continue;
    }
    if (entry.type !== undefined) out.push(draft("propertyDefinition", { declare: bareName(name), figmaType: DEFINITION_TYPES[entry.type] }, path, "definitions", [{ word: `definition:${name}` }]));
  }
  out.push(...deriveBindingObligations(words.componentPropertyReferences));
  return out;
}

/**
 * What flcm.component and flcm.variants declare on the node they mint: its name, description and
 * properties, each property by the bare name the author gave it.
 */
export function deriveDeclarationObligations(words: { name?: string; description?: string }, definitions: readonly { name: string; figmaType: string }[] = []): ObligationDraft[] {
  return [
    ...(words.name == null ? [] : [draft("name", words.name, "name", "structural", [])]),
    ...(words.description == null ? [] : [draft("componentDescription", words.description, "description", "structural", [])]),
    ...definitions.map(({ name, figmaType }) => draft("propertyDefinition", { declare: name, figmaType }, "propertyDefinitions[" + JSON.stringify(name) + "]", "structural", [])),
  ];
}

/** Which property each bound field names once the call lands, by bare name; null is unbound. */
function deriveBindingObligations(refs: ComponentPropertyBindingEdit | ComponentPropertyBinding | undefined): ObligationDraft[] {
  return Object.entries((refs ?? {}) as Record<string, string | null | undefined>).flatMap(([field, name]) => (name === undefined ? [] : [
    draft("propertyBinding", { wire: BINDING_FIELD_WIRE_KEYS[field].wire, name: name === null ? null : bareName(name) }, "componentPropertyReferences." + field, "binding", [{ word: `binding:${field}` }]),
  ]));
}

/** The drafts, held against `target` and attributed to the call site `subject`. */
export function obligationsOnTarget(drafts: readonly ObligationDraft[], target: ObligationTarget, subject: string): Obligation[] {
  return drafts.map(({ kind, request, path, writePoint, carries, writability, sublayer }) => {
    const source: AuthoredWordSource = { subject, path };
    return { kind, request, source, writePoint, carries, writability, target: sublayer === undefined ? target : { instance: target, path: sublayer } };
  });
}

/**
 * The realize-only words of `plan` (what the instance write policy made of it where it lands), as
 * checks the gate observes against `plan.node`: the live layer, or the definition sublayer a
 * projected plan compiled on (call-obligations.ts).
 */
export function realizeOnlyChecksOf(
  plan: EditPlan, realizeOnly: RealizeOnlyFields, gate: GateResources, site: ObligationDerivationSite, subject: string, context: InstanceContextFacts,
): RealizeOnlyCheck[] {
  if (!realizeOnly.size) return [];
  const who = describeNodeIdentity(plan.node);
  return deriveEditPlanObligations(plan, gate, site).flatMap((d) => {
    const field = d.carries.map(patchFieldKey).find((key) => realizeOnly.has(key));
    if (!field) return [];
    const { rule, word } = realizeOnly.get(field)!;
    return [{ obligation: obligationsOnTarget([d], { node: plan.node }, subject)[0], rule, word, who, context }];
  });
}

/** Where a live node's words land when the call leaves it where it is: its own context and parent. */
export function liveObligationSite(node: SceneNode, parentLayout?: WriteLayout): ObligationDerivationSite {
  const parent = node.parent;
  return {
    instance: instanceContextOf(node),
    parentMode: effectiveLayoutMode(parentLayout ?? {}, parent && "layoutMode" in parent ? (parent as { layoutMode?: string }) : undefined),
    onPage: parent?.type === "PAGE",
  };
}

/** An override's site: a sublayer of `instance`, whose own writes the instance's component locks. */
function overrideObligationSite(instance: SceneNode): OverrideSiteOf {
  return (plan) => {
    const parent = plan.node.parent;
    return {
      instance: { ownWritesLockedBy: { node: instance, projected: false }, isInstanceRoot: false },
      parentMode: layoutModeOf(parent && "layoutMode" in parent ? (parent as { layoutMode?: string }) : undefined),
      onPage: false,
    };
  };
}

/** Every obligation of one edit delta: the node's own words, its instance half and its component half. */
export function deriveEditObligations(full: EditPlan, instance: InstanceEditPlan | undefined, gate: GateResources, site: ObligationDerivationSite): ObligationDraft[] {
  return [
    ...deriveEditPlanObligations(full, gate, site),
    ...(full.instanceWords && instance ? deriveInstanceEditObligations(full.node, full.instanceWords, instance, gate, overrideObligationSite(full.node)) : []),
    ...(full.componentWords ? deriveComponentEditObligations(full.node, full.componentWords) : []),
  ];
}

/**
 * The obligations prepare can derive before its font and image loads, for captureReadDependencies
 * (call-obligations.ts): the hint plan's node-local and instance words. Not annotations, whose
 * categories resolve after those loads; not a font, which resolves against the fonts they load;
 * not the component half, which only the gate's planning refuses with its own words.
 */
export function deriveConcurrentEditObligations(plan: EditPlan, instance: InstanceEditPlan | undefined, tokens: ResolvedTokens, site: ObligationDerivationSite, subject: string): Obligation[] {
  const strip = (p: EditPlan): EditPlan => ({ ...p, componentWords: undefined, patch: { ...p.patch, annotations: undefined } });
  const hinted = instance && { ...instance, overrides: instance.overrides.map((o) => ({ ...o, plan: strip(o.plan) })) };
  return obligationsOnTarget(deriveEditObligations(strip(plan), hinted, { fonts: {}, tokens }, site), { node: plan.node }, subject)
    .filter((o) => !FONT_RESOLVED_KINDS.has(o.kind));
}

const FONT_RESOLVED_KINDS: ReadonlySet<ObligationKind> = new Set(["fontIdentity", "textRuns"]);

/** Where a tree puts a live node it names: under the parent it is attached to. */
export function deriveParentageObligations(parent: BaseNode): ObligationDraft[] {
  return [draft("parentage", { parent: { node: parent as SceneNode } }, "id", "structural", [])];
}

/** A live node's words a tree states beside its edit delta: its key, its path data and its bindings. */
export function deriveLiveEntryObligations(key: string | undefined, pathData: VectorPaths | undefined, refs: ComponentPropertyBinding | undefined): ObligationDraft[] {
  return [
    ...(key === undefined ? [] : [draft("pluginKey", key, "key", "after-binding", [{ prop: "key" }])]),
    ...(pathData === undefined ? [] : [draft("vectorPaths", { paths: pathData }, "vectorPaths", "vector-path", [{ prop: "vector" }])]),
    ...deriveBindingObligations(refs),
  ];
}
