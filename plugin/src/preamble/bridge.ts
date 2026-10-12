/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { warnings } from "./warnings.js";
import { LAYOUT_MODES, layoutModeOf, effectiveLayoutMode, childLayout, placementKind, fillReading, type ChildLayout } from "./layout-mode.js";
import { behaviorForMode, layoutBehavior, applySiblingOrder, growImplicitGridRows } from "./layout-native.js";
import { hasContainerLayout } from "./vocabulary.js";
import type { LiveTreeNode } from "./live-tree.js";
import { sceneFigma as figma } from "./scene-access.js";
import type { ExposureWrite } from "./instance-exposure.js";
import type { NodeSpec } from "./schema.js";
import { applyBounds, assertBounds } from "./size-bounds.js";
import { resizeWithDiagnostics, trackSizing } from "./sizing-diagnostics.js";
import { warnBackgroundBlurWithoutFill } from "./background-blur-diagnostics.js";
// bridge — the ONE mutation authority: every property lands on a live Figma node through the appliers
// here, whether the node was just built (the render walk below) or resolved as a live edit target.
// Every mutating verb drives these same exported appliers — never a parallel application path, so a
// paint compiled for create and for edit cannot diverge. It consumes ONLY the typed IR currency — it
// never sees a CSS string leaf and never imports css.ts; the boundary parsed everything into types
// upstream, so here a gap is already a number, a fill already a WritePaint, an effect already an
// WriteEffect. The compilers (compile-*.ts) only build plain frozen POJOs.
//
// Appliers touch only the fields PRESENT on their node, and a `'prop' in node` guard skips only
// vocabulary a node KIND lacks (an ellipse has no cornerRadius). A Figma refusal on a field the node
// does carry THROWS — the plugin's own error names the setter — and the aftermath belongs to the
// mutating-verb scaffold (mutation-lock.ts, where the commit-then-undo rollback lands), never to a
// catch here. A deliberate skip must be a named, documented rule, never a swallowed catch.
//
// Nodes are typed `any` deliberately: the plugin typings model dozens of SceneNode variants, but the
// appliers cover a small additive vocabulary, so fighting the union with casts at every line would add
// noise without safety.

import { applyAnnotations } from "./annotation-categories.js";
import { WriteType, WriteNode, BuiltNode, LiveRef, WriteProps, WriteLayout, TextAlign, TextDecoration, Sizing, Identity, Handle, WritePaint, PaintSite, WriteImage, WriteImageUrl, paintSitesOf, ComponentPropertyBinding, CornerRadii, Edges, Bindable, VariableRef, namesFontIdentity, isTokenRef, textOfRuns } from "./ir.js";
import { writeBindable, unbindField, variableFor, variableLiteral, styleFor, type ResolvedTokens } from "./tokens.js";
import { queueStyleLink, settlePivot, type ApplySpan } from "./apply-span.js";
import { own } from "./validate.js";
import {
  assertLayoutRealizableForType, assertGridSizing, assertPercentResolvable, assertSizingResolvesAgainstParentFrame, foldDesignedSizeForPage, ParentFlowFacts,
  assertTextFillHeightInFlow, assertLineSizingInFlow, assertLineFillUnrotated, assertInheritedRectangleDimensions,
} from "./layout-legality.js";
import { toFigmaPaint, imagePaintAdjustments } from "./paint.js";
import { toFigmaEffects } from "./effects.js";
import { resolveFont, resolveFontStrict, fontDivergences, textStyleFont, FontMap } from "./fonts.js";
import { writeKey, identityOf, isSlotHole, describeNodeIdentity } from "./identity.js";
import { pixelRound, convertSizing } from "@framelink/core";
import { MutatingVerbError, NodeBuildError } from "./verb-error.js";
import { unrotatedCornerOf } from "./pivot.js";

// The resource half of the walk context — what an applier resolves against, split out so an exported
// applier demands only what it reads: `fonts` is the preloaded FontMap, `images` the url → base64 map
// of bytes the server fetched+validated (an image WritePaint resolves to a plugin ImagePaint against
// it). An edit caller supplies these for a live target without fabricating walk state. The verb's
// gate builds it; apply adds the lock's span (ApplyResources).
export interface RenderResources {
  live: ReadonlyMap<LiveRef, LiveTreeNode>;
  fonts: FontMap;
  images: Record<string, string>;
  // Every token the verb's IR names, resolved in prepare — the apply span binds from here, never looks up.
  tokens: ResolvedTokens;
  // Instance plans are keyed by the private IR node that the build walk consumes.
  instances: InstancePlans;
}

/** The resources inside the sealed span: what the gate resolved, plus the span the appliers defer into. */
export interface ApplyResources extends RenderResources {
  span: ApplySpan;
}

export type InstancePlans = ReadonlyMap<WriteNode, InstancePlan>;

// What render needs to stamp one instance. `component` is the exact main component (a variant
// already selected — the property values that pick it are not repeated in `properties`);
// `properties` are ready for setProperties, in Figma's own suffixed names. `applyOverrides` is a
// closure rather than data because an override is an edit of one sublayer, applied through
// edit-plan.ts's staged appliers — and edit-plan.ts imports FROM this module, so the stages arrive here as
// a function instead of an import. It takes the whole walk context, not just the resources: an
// override at a SLOT's path builds that slot's content through attachBuiltChild, whose keys
// and pending percents belong to the SAME walk as the instance's siblings.
export interface InstancePlan {
  component: any;
  properties: Record<string, string | boolean>;
  applyOverrides: (instance: any, ctx: RenderCtx) => void;
}

// Keys detect duplicate addresses; binding records connect compiled property references to the
// live nodes that receive them. Pending geometry is the span's (settleApplySpan).
export interface RenderCtx extends ApplyResources {
  exposures: ExposureWrite[];
  keys: Set<string>;
  // The id each placed node's spec gets back, by spec: the verb's AuthoredTree is a copy of the
  // spec with these filled in (compile-tree.ts placedTreeOf), never the IR written over.
  placedIds: Map<NodeSpec, string>;
  // Every node the walk built that carries a `componentPropertyReferences` bag, paired with it.
  // Collected DURING the walk along with keys because only the walk knows which live node a compiled
  // node became — a built→live pairing recovered afterwards would have to guess past falsy children
  // and an svg's synthesized frame.
  //
  // OPTIONAL on purpose, and the absence is the enforcement: only a verb with a declaring component
  // behind it — flcm.component, or an insert landing inside one — has anywhere for a binding to
  // point, so only those pass a list. Every other tree-taking verb omits it (and so does an insert
  // landing anywhere else), and buildNode then throws on a bound node rather than
  // pushing it into a list nobody reads — a dropped authoring word would be wrong pixels with no
  // error, which is the one outcome this surface never allows. Their prepares refuse the tree first
  // (assertNoComponentPropertyBindings); this is the backstop for the next verb that forgets to.
  bindings?: BoundLiveNode[];
}

/** One built node and the raw binding bag the WriteNode behind it carried. */
export interface BoundLiveNode { node: any; refs: ComponentPropertyBinding }

const TEXT_ALIGN: Record<TextAlign, "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED"> = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFIED" };
// CSS text-decoration-line → Figma's TextDecoration enum. "none" is the enum's own NONE, used by a
// per-run inverse override that clears an inherited base decoration.
const DECORATION: Record<TextDecoration, "UNDERLINE" | "STRIKETHROUGH" | "NONE"> = { underline: "UNDERLINE", "line-through": "STRIKETHROUGH", none: "NONE" };
// The author's vertical-alignment words → Figma's enum. Node-level only (no setRange* counterpart),
// unlike every other text word here — see WriteTextStyle.textAlignVertical.
const VERTICAL_ALIGN: Record<"top" | "center" | "bottom", "TOP" | "CENTER" | "BOTTOM"> = { top: "TOP", center: "CENTER", bottom: "BOTTOM" };

function isAutoLayout(node: any): boolean { return layoutModeOf(node).kind !== "free"; }
function isFrameLike(node: any): boolean { return hasContainerLayout(node.type); }

// A node's geometry in the read verbs' spelling (ir.Handle). width/height are the measured px, rounded the
// way the core rounds every number it emits so both producers hand the agent one currency. left/top (and
// the `position` marker) are emitted ONLY when the parent's auto-layout doesn't already place the node —
// the exact rule read.projectSlim inherits from core's NodeGeometry (isInAutoLayoutFlow). A page child gets
// neither: its parent has no box to be relative to, so the coordinates would be canvas trivia.
//
// The numbers are the node's OWN geometry — width/height exclude rotation (relativeTransform has unit axes,
// so a rotated node's size is unchanged) and left/top are its UNROTATED corner's container-parent offset —
// flcm turns about the centre (pivot.ts), so that corner, not Figma's translation, is what left/top author.
// That is also what the read side means by width/height/left/top, so a 40px-wide rect rotated 15° reads back 40 wide and writes back
// 40 wide. The page-space AABB (44.85 for that rect) belongs to neither side: read carries it separately on
// the snapshot for the questions that genuinely want a page-space box.
//
// That container-parent offset derives from the raw node.x/node.y, which Figma states relative to the nearest FRAME
// and NOT to an intervening GROUP — where the read side subtracts the group's own corner instead. The two
// can't disagree here: every node render creates enters the doc on the page and is reparented only into a
// frame render built itself, so a minted handle never has a group above it. find/get take their left/top
// from the core's simplified node (read.projectSlim), which is already the group-aware answer.
function geometryOf(node: any): Omit<Handle, keyof Identity> {
  const geometry: Omit<Handle, keyof Identity> = { width: pixelRound(node.width), height: pixelRound(node.height) };
  if (node.minWidth != null) geometry.minWidth = pixelRound(node.minWidth);
  if (node.maxWidth != null) geometry.maxWidth = pixelRound(node.maxWidth);
  if (node.minHeight != null) geometry.minHeight = pixelRound(node.minHeight);
  if (node.maxHeight != null) geometry.maxHeight = pixelRound(node.maxHeight);
  const intent = intentOf(node);
  if (intent) geometry.intent = intent;
  const parent = node.parent;
  const parentPlacesIt = !!parent && isAutoLayout(parent) && node.layoutPositioning !== "ABSOLUTE";
  if (parent && parent.type !== "PAGE" && !parentPlacesIt) {
    if (node.layoutPositioning === "ABSOLUTE") geometry.position = "absolute";
    const corner = unrotatedCornerOf(node);
    geometry.left = pixelRound(corner.x);
    geometry.top = pixelRound(corner.y);
  }
  return geometry;
}

// The sizing rule behind a node's measured size, on the axes the layout owns. Only "fill" and "hug" are
// reported: those are the axes that will re-measure on their own, so an agent needs to know the number it's
// holding is a snapshot. A FIXED axis says nothing (the measurement is the intent) and neither does an axis
// Figma reports nothing for. The words come from the core's own convertSizing over the live sizing flags,
// which is EXACTLY how the read side reaches fill/hug (resolveAxisDimension returns the word before any of
// its fixed/root machinery runs) — so this is the same answer `find` gives, not a parallel derivation.
function intentOf(node: any): Handle["intent"] {
  const intent: NonNullable<Handle["intent"]> = {};
  const horizontal = convertSizing(node.layoutSizingHorizontal);
  const vertical = convertSizing(node.layoutSizingVertical);
  if (horizontal === "fill" || horizontal === "hug") intent.width = horizontal;
  if (vertical === "fill" || vertical === "hug") intent.height = vertical;
  return intent.width || intent.height ? intent : undefined;
}

// Mint the JSON-safe reference for one live node. Identity (id/name/type/key/text) comes from identityOf —
// the shared reader, so a render Handle and a read SlimHandle can't disagree on how key/text are pulled;
// `key` is read back from the pluginData stampKey wrote during the walk. Exported for edit, which
// returns the target's handle with FRESH post-apply geometry — same mint, one currency.
export function mintHandle(node: any): Handle {
  return { ...identityOf(node), ...geometryOf(node) };
}

// Mint every handle render() returns, AFTER the walk. Timing is the whole point: nothing geometric is
// settled while the tree is being built — buildFrame re-covers fill/percent/absolute children in the
// post-applyOwnSize `covers` pass, frames hug their content bottom-up as the walk unwinds, and every node
// is created as a page child and reparented only when it's appended (so mid-walk even "does the parent
// place this node?" — which decides whether left/top exist at all — answers wrong). Minting once here is
// what keeps a returned handle from ever carrying a provisional value.
function stampKey(node: any, wn: BuiltNode, ctx: RenderCtx): void {
  if (typeof wn.key !== "string") return;
  // No verb name: the same walk runs under render AND under every structural insert verb, and
  // naming the wrong one sends the agent looking at a call it didn't make.
  if (ctx.keys.has(wn.key)) throw new Error('flcm: duplicate key "' + wn.key + '" — keys must be unique within one call.');
  writeKey(node, wn.key);
  ctx.keys.add(wn.key);
}

// Resolve one WritePaint to a plugin Paint. An image paint needs raster BYTES (prefetched from the
// server into ctx.images, keyed by url) turned into an imageHash via figma.createImage — a figma.*
// call, so it lives HERE in the bridge, not in the figma-free paint.ts. Every other paint maps purely.
function paintOf(paint: WritePaint, ctx: RenderResources): Paint {
  if (paint.kind === "image") return imagePaint(paint, ctx);
  // A bound solid is bound on the PAINT, before the stack is assigned: a literal paint written over a
  // bound one drops the binding, so the bound paint has to be the one that lands.
  if (paint.kind === "solid" && paint.colorVariable) {
    return figma.variables.setBoundVariableForPaint(toFigmaPaint(paint) as SolidPaint, "color", variableFor(paint.colorVariable, ctx.tokens));
  }
  return toFigmaPaint(paint);
}

// THE order flip, and the only place either side of it is known. An authored stack is TOP FIRST (CSS
// order, and the order a read emits); Figma stores a node's `fills`/`strokes` bottom first, so the last
// element is what you see on top. Walking backwards is that reversal. An empty stack maps to `[]` — the
// compiled removal word — with no branch of its own. It takes a SITE, never a bare stack: only a
// stack paintSitesOf yields was image-prefetched.
function toFigmaPaintStack({ stack }: PaintSite, ctx: RenderResources): Paint[] {
  const paints: Paint[] = [];
  for (let i = stack.length - 1; i >= 0; i--) paints.push(paintOf(stack[i], ctx));
  return paints;
}

function imagePaint(paint: WriteImage, ctx: RenderResources): Paint {
  // A hash-backed paint names bytes the document already holds (a read-form fill rebuilt through the
  // compilers), so there is nothing to fetch and nothing to create — the paint just points at it.
  if ("hash" in paint) {
    const tile = paint.scalingFactor != null ? { scalingFactor: paint.scalingFactor } : {};
    return { type: "IMAGE", scaleMode: paint.scaleMode, imageHash: paint.hash, ...tile, ...imagePaintAdjustments(paint) };
  }
  const b64 = ctx.images[paint.url];
  if (typeof b64 !== "string") {
    // Every url on a paint site (paintSitesOf) is prefetched before any node is built, so a miss is
    // a paint that reached here some other way — fail loud rather than paint a blank fill.
    throw new Error('flcm.image: no fetched bytes for "' + paint.url + '" — the image was not resolved before render.');
  }
  const img = figma.createImage(figma.base64Decode(b64));
  return { type: "IMAGE", scaleMode: paint.scaleMode, imageHash: img.hash, ...imagePaintAdjustments(paint) };
}

// Persist an image fill's source + placeholder flag on the node (pluginData) so a later read/codegen pass
// can tell a stand-in from a real asset and recover its src — the one content case whose semantics don't
// survive geometry alone. Only the fill (a node's background) is recorded; an image stroke is exotic.
//
// The stack's TOPMOST url-backed image is the node's image: the composite this serves is a photo under a
// legibility scrim, where the photo is not entry 0, and a stack of two photographs has one provenance
// slot to describe both anyway.
const namesImageSource = (paint: WritePaint): paint is WriteImageUrl => paint.kind === "image" && "url" in paint;

function stampImageData(node: any, wn: WriteProps): void {
  if (!wn.fills) return; // no fill in this write — whatever provenance exists still describes the live paint
  const fill = wn.fills.find(namesImageSource);
  if (!fill) {
    // An edit replaced an image fill with a solid/gradient — or cleared it (fill:"none" compiles to
    // an empty array): the provenance no longer describes the live paint, so wipe it ("" deletes
    // the pluginData entry) instead of leaving a stale url. A HASH-backed image lands here too, and
    // deliberately: it was rebuilt from a read shape, which carries no source url, so there is no
    // src to record — and leaving the previous node's url would describe the wrong asset.
    node.setPluginData("flcm/image", "");
    return;
  }
  node.setPluginData("flcm/image", JSON.stringify({ url: fill.url, placeholder: fill.placeholder }));
}

// Additive appearance: only fields present on the WriteNode are touched. Property guards skip what a node
// kind lacks (an ellipse has no cornerRadius). Creation defaults (omitted fill -> transparent) live in
// the builders, NOT here — so an edit patch through this applier can never turn key-absence into a write.
export function applyPaint(node: any, wn: WriteProps, ctx: ApplyResources): void {
  // A PRESENT-but-empty stack is the compiled removal word ("none") — write the clear; skipping
  // empties would make removal an unspeakable intent (the ADR-0003 silent no-op).
  for (const site of paintSitesOf(wn)) if (site.at !== "runFills") node[site.at] = toFigmaPaintStack(site, ctx);
  if (wn.strokeWeight != null) applyStrokeWeight(node, wn.strokeWeight, ctx.tokens);
  if (wn.strokeAlign != null && "strokeAlign" in node) node.strokeAlign = wn.strokeAlign;
  if (wn.borderRadius) applyCornerRadii(node, wn.borderRadius, ctx.tokens);
  if (wn.effects && "effects" in node) node.effects = toFigmaEffects(wn.effects);
  applyStyleSlots(node, wn, ctx);
  // The `in` guard matters for edit targets: a SliceNode carries no MinimalBlendMixin at all.
  if (wn.opacity !== undefined && "opacity" in node) writeBindable(node, "opacity", wn.opacity, ctx.tokens);
  if (typeof wn.clip === "boolean" && "clipsContent" in node) node.clipsContent = wn.clip;
  stampImageData(node, wn);
  // AFTER the writes, and only when this write was about appearance: the diagnostic asks the LIVE node
  // whether blur and fill ended up contradicting each other, so an edit naming one of them is judged
  // against the other's existing value. Gated on presence so a layout-only edit doesn't re-report a
  // node's standing state on every touch.
  if (wn.fills || wn.effects) warnBackgroundBlurWithoutFill(node);
}

// Strokes split like corners: `strokeWeight` sets every side at once, the four per-side properties
// (IndividualStrokesMixin) are the only route to differing sides. The compiler only emits Edges for
// a type that has them, so there is no per-side fallback here.
const STROKE_SIDE_FIELDS = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"] as const;
const CORNER_FIELDS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"] as const;

function applyStrokeWeight(node: any, w: Bindable | Edges<Bindable>, tokens: ResolvedTokens | undefined): void {
  if (typeof w === "number" || isTokenRef(w)) {
    // A uniform literal replaces per-side bindings too, which unbinding strokeWeight alone leaves.
    if (typeof w === "number") for (const side of STROKE_SIDE_FIELDS) unbindField(node, side);
    if ("strokeWeight" in node) writeBindable(node, "strokeWeight", w, tokens);
    return;
  }
  writeBindable(node, "strokeTopWeight", w.top, tokens);
  writeBindable(node, "strokeRightWeight", w.right, tokens);
  writeBindable(node, "strokeBottomWeight", w.bottom, tokens);
  writeBindable(node, "strokeLeftWeight", w.left, tokens);
}

// Figma splits one concept over two APIs: `cornerRadius` writes all four at once (and READS back as
// figma.mixed once they differ), while the four per-corner properties are the only route to differing
// corners — RectangleCornerMixin, which every type flcm lets carry a radius has. Uniform still goes
// through `cornerRadius` so a corner-bearing node outside that mixin (POLYGON, STAR, VECTOR) keeps
// working if the edit vocabulary ever widens to it.
function applyCornerRadii(node: any, r: CornerRadii<Bindable>, tokens: ResolvedTokens | undefined): void {
  if (r.topLeft === r.topRight && r.topRight === r.bottomRight && r.bottomRight === r.bottomLeft) {
    // As with strokes: a uniform literal replaces per-corner bindings that unbinding cornerRadius leaves.
    if (!isTokenRef(r.topLeft)) for (const corner of CORNER_FIELDS) unbindField(node, corner);
    if ("cornerRadius" in node) writeBindable(node, "cornerRadius", r.topLeft, tokens);
    return;
  }
  if (!("topLeftRadius" in node)) {
    throw new Error("flcm: a " + node.type + " has one radius for all four corners — per-corner borderRadius has no equivalent on it.");
  }
  writeBindable(node, "topLeftRadius", r.topLeft, tokens);
  writeBindable(node, "topRightRadius", r.topRight, tokens);
  writeBindable(node, "bottomRightRadius", r.bottomRight, tokens);
  writeBindable(node, "bottomLeftRadius", r.bottomLeft, tokens);
}

// Each style slot lands its values now, in the sealed span, so everything apply measures after this
// sees the styled node; the link itself is queued for the lock (async-only under dynamic-page).
function applyStyleSlots(node: any, wn: WriteProps, ctx: ApplyResources): void {
  const styles = wn.styles;
  if (!styles) return;
  if (styles.fill) {
    node.fills = (styleFor(styles.fill, ctx.tokens) as PaintStyle).paints;
    if ("setPluginData" in node) node.setPluginData("flcm/image", ""); // a style's paints carry no flcm image source
    queueStyleLink(ctx.span, node, "fill", styleFor(styles.fill, ctx.tokens).id);
  }
  if (styles.stroke) {
    node.strokes = (styleFor(styles.stroke, ctx.tokens) as PaintStyle).paints;
    queueStyleLink(ctx.span, node, "stroke", styleFor(styles.stroke, ctx.tokens).id);
  }
  if (styles.effect && "effects" in node) {
    node.effects = (styleFor(styles.effect, ctx.tokens) as EffectStyle).effects;
    queueStyleLink(ctx.span, node, "effect", styleFor(styles.effect, ctx.tokens).id);
  }
}

function applyContainer(node: any, layout: WriteLayout, tokens: ResolvedTokens | undefined): void {
  if (!isFrameLike(node)) return;
  const previous = layoutModeOf(node);
  const next = effectiveLayoutMode(layout, node);
  // Disable wrapping under the old mode before a direction change; only live rows accept the setter.
  if (layout.wrap === false && previous.word === "row") node.layoutWrap = "NO_WRAP";
  if (layout.mode !== undefined) {
    if (next.kind !== "free" && previous.word !== next.word) layoutBehavior(node).clearChildren(node);
    node.layoutMode = next.native;
  }
  layoutBehavior(node).container(node, layout, previous, tokens);
  if (layout.padding) {
    const p = layout.padding;
    writeBindable(node, "paddingTop", p.top, tokens);
    writeBindable(node, "paddingRight", p.right, tokens);
    writeBindable(node, "paddingBottom", p.bottom, tokens);
    writeBindable(node, "paddingLeft", p.left, tokens);
  }
}

// Own-axis sizing, applied AFTER children so a `hug` axis measures real content. Maps the IR's
// sizing/dimensions onto the plugin's primary/counter sizing modes (which axis is which depends on the
// frame's own direction) and resizes the fixed axes. Direction comes from the LIVE node, not the authored one:
// at create time applyContainer already set layoutMode so the two agree, and an edit delta naming only
// sizing carries no mode at all. Presence-preserving per axis — an axis the caller doesn't name keeps
// its live sizing mode; the fresh-frame hug default is the BUILDER's to inject (see buildFrame).
function applyOwnSize(f: any, layout: WriteLayout, tokens: ResolvedTokens | undefined): void {
  if (layout.bounds) { trackSizing(f); applyBounds(f, layout.bounds, tokens); }
  const sizing = layout.sizing || {};
  const dims = dimensionsForResize(f, layout.dimensions, tokens);
  const isAuto = isAutoLayout(f);

  layoutBehavior(f).ownSize(f, sizing);

  // Auto frames resize only their FIXED axes (fill/hug are computed by layout); a non-auto frame honors
  // any authored dimension — including one carried in from a `get` result without a sizing intent.
  const fixedW = isAuto ? sizing.horizontal === "fixed" : typeof dims.width === "number";
  const fixedH = isAuto ? sizing.vertical === "fixed" : typeof dims.height === "number";
  if (fixedW || fixedH) {
    const w = fixedW && typeof dims.width === "number" ? dims.width : f.width;
    const h = fixedH && typeof dims.height === "number" ? dims.height : f.height;
    resizeWithDiagnostics(f, Math.max(w, 0.01), Math.max(h, 0.01));
  }
  bindDimensions(f, layout.dimensions, tokens);
}

// A bound dimension resizes to its variable's default-mode value first, so hug/fill and the sizing
// diagnostics see a real number; bindDimensions then hands the size to the variable. A literal
// dimension drops a standing binding before the resize, or the variable would keep driving it.
function dimensionsForResize(node: any, dims: WriteLayout["dimensions"], tokens: ResolvedTokens | undefined): { width?: number; height?: number } {
  const out: { width?: number; height?: number } = {};
  for (const dim of ["width", "height"] as const) {
    const value = dims?.[dim];
    if (value === undefined) continue;
    if (isTokenRef(value)) out[dim] = Number(variableLiteral(value, tokens));
    else { unbindField(node, dim); out[dim] = value; }
  }
  return out;
}

function bindDimensions(node: any, dims: WriteLayout["dimensions"], tokens: ResolvedTokens | undefined): void {
  for (const dim of ["width", "height"] as const) {
    const value = dims?.[dim];
    if (isTokenRef(value)) writeBindable(node, dim, value, tokens);
  }
}

// Resize a child to the parent's box on its w/h:'fill' axes, instead of letting fill collapse to ~0.
// Serves two callers where layoutGrow/STRETCH can't do the sizing: an ABSOLUTE child (out of the flow, so
// fill is the natural full-bleed cover / scrim), and any child of a FREE-FORM parent (no auto-layout to
// grow against). Run once at append (against the parent's provisional hug size) and again after
// applyOwnSize gives the parent its final size.
function coverChild(parent: any, child: any, layout: WriteLayout): void {
  const s = layout.sizing || {};
  if (s.horizontal !== "fill" && s.vertical !== "fill") return;
  layoutBehavior(child).ownSize(child, {
    horizontal: s.horizontal === "fill" ? "fixed" : undefined,
    vertical: s.vertical === "fill" ? "fixed" : undefined,
  });
  const cw = s.horizontal === "fill" ? parent.width : child.width;
  const ch = s.vertical === "fill" ? parent.height : child.height;
  // A LINE's height is exactly 0 by Figma contract — resize throws on anything else [verified,
  // plugin-typings 1.133] — so the 0.01 floor (there to keep degenerate fills from the resize(0)
  // throw on area nodes) must not touch it: w:"fill" on a line is a legal full-width rule. Vertical
  // fill on a line can't be authored (LineSchema has no height word), so no rule is needed for it.
  resizeWithDiagnostics(child, Math.max(cw, 0.01), child.type === "LINE" ? 0 : Math.max(ch, 0.01));
}

// Lift an out-of-flow child (author `left`/`top`, or `position: "absolute"`) out of an auto-layout
// parent's flow (so the coordinates are honored, it can overlap siblings, and it extends past a clip)
// and apply its location. Outside auto-layout, x/y are native and the flag is inert. position:"none"
// (edit) is the inverse: the child rejoins the flow and the layout re-places it — in a free-form
// parent there is no flow to rejoin, so it's inert there.
function applyChildPosition(parent: any, child: any, layout: WriteLayout): void {
  if (layout.position === "none") {
    if ("layoutPositioning" in child) child.layoutPositioning = "AUTO";
    return;
  }
  if (layout.position !== "absolute") return;
  if (isAutoLayout(parent)) child.layoutPositioning = "ABSOLUTE";
  if (typeof layout.left === "number") child.x = layout.left;
  if (typeof layout.top === "number") child.y = layout.top;
}

// Figma's per-axis constraint enum keyed by the author's directional `constraints` (ir.ts ConstraintX/ConstraintY). Two maps
// because the axis-neutral words (center/stretch/scale) sit alongside axis-specific edges (left/right on x,
// top/bottom on y). This terse→enum mapping is the bridge's to own, like the container policy’s alignment maps.
// "none" → MIN: clearing a constraint restores Figma's default (near-edge). The auto-derived constraint
// create chose isn't stored anywhere live, so the default is the stated inverse, not a recovery.
const CONSTRAINT_H: Record<string, string> = { left: "MIN", center: "CENTER", right: "MAX", stretch: "STRETCH", scale: "SCALE", none: "MIN" };
const CONSTRAINT_V: Record<string, string> = { top: "MIN", center: "CENTER", bottom: "MAX", stretch: "STRETCH", scale: "SCALE", none: "MIN" };

// Derive one axis's Figma constraint from the child's ORIGINAL size/position intent, so a resized free-form
// parent reflows it sensibly: fill→STRETCH (grows with the parent), a percent size→SCALE (scales
// proportionally), a percent absolute position→CENTER (holds its relative spot), else MIN (pinned to the
// leading edge — Figma's default). An explicit `constraints` word wins over the derived choice.
function axisConstraint(sizing: Sizing | undefined, percentSize: number | undefined, percentPos: number | undefined, explicit: string | undefined, words: Record<string, string>): string {
  if (explicit != null) return words[explicit]; // validated at the flcm boundary
  if (sizing === "fill") return "STRETCH";
  if (percentSize != null) return "SCALE";
  if (percentPos != null) return "CENTER";
  return "MIN";
}

// Set a child's Figma constraints so a resized parent reflows it. Runs for every child that Figma governs
// by constraints: a free-form parent's children, and an ABSOLUTE (out-of-flow) child of an auto-layout
// parent. An IN-FLOW auto-layout child is skipped (it reflows via layoutGrow/STRETCH, and constraints are
// inert on it). Keys off the percent* / sizing INTENT (percentSize→SCALE, percentPos→CENTER, fill→STRETCH),
// which is why percent resolution never mutates the layout in place — the intent stays readable here even
// though the live node has already been resized to a fixed px by settleApplySpan.
function applyConstraints(child: any, rawLayout: WriteLayout | undefined): void {
  if (!("constraints" in child)) return; // an exotic node without the constraint mixin
  const l = rawLayout || {};
  const sizing = l.sizing || {};
  const pSize = l.percentSize || {};
  const pPos = l.percentPos || {};
  const explicit = l.constraints || {};
  child.constraints = {
    horizontal: axisConstraint(sizing.horizontal, pSize.width, pPos.x, explicit.x, CONSTRAINT_H),
    vertical: axisConstraint(sizing.vertical, pSize.height, pPos.y, explicit.y, CONSTRAINT_V),
  };
}

// Edit-side constraint delta, presence-preserving per axis: applyConstraints above derives and
// writes BOTH axes from create-time intent, so an edit naming only constraints.x would silently
// reset constraints.y — this reads the untouched axis and re-writes it unchanged instead.
// Deliberately NEVER re-derives constraints from a delta's size/position words the way create's
// applyConstraints does (fill→STRETCH, "N%"→SCALE): a live node may carry an authored constraint, and a
// width edit that silently rewrote it would clobber intent the delta never spoke. Under edit,
// only an explicit `constraints` word touches them.
function applyConstraintsDelta(child: any, explicit: NonNullable<WriteLayout["constraints"]>): void {
  if (!("constraints" in child)) return; // an exotic node without the constraint mixin
  const cur = child.constraints;
  child.constraints = {
    horizontal: explicit.x != null ? CONSTRAINT_H[explicit.x] : cur.horizontal,
    vertical: explicit.y != null ? CONSTRAINT_V[explicit.y] : cur.vertical,
  };
}

// THE sizing home for leaf nodes (no own auto-layout) — create's builders and edit's delta path
// both land here, so the per-kind rules can't fork: TEXT's auto-resize handshake and LINE's zero
// height. Generic shapes (and TEXT, once its auto-resize is set) resize only the named dims,
// floored at Figma's 0.01.
function applyLeafSize(node: any, layout: WriteLayout, tokens: ResolvedTokens | undefined): void {
  if (layout.bounds) { trackSizing(node); applyBounds(node, layout.bounds, tokens); }
  const sizing = layout.sizing || {};
  const dims = dimensionsForResize(node, layout.dimensions, tokens);
  if (node.type === "TEXT") {
    // textAutoResize IS a text's sizing: NONE holds a fixed box, HEIGHT wraps at a fixed width
    // and grows the height, WIDTH_AND_HEIGHT grows both. It must be set BEFORE the resize below,
    // or an auto-resizing text snaps straight back to its content. A fixed height (a number, or a
    // percent — the compile writes "fixed" beside both) fixes the whole box.
    if (sizing.vertical === "fixed") node.textAutoResize = "NONE";
    else if (sizing.horizontal === "hug") node.textAutoResize = "WIDTH_AND_HEIGHT";
    // A controlled width wraps. Only a width-hugging text needs switching: a fixed box keeps its
    // height when only the width is named.
    else if ((sizing.horizontal === "fixed" || sizing.horizontal === "fill") && node.textAutoResize === "WIDTH_AND_HEIGHT") node.textAutoResize = "HEIGHT";
    // height:"hug" undoes a fixed or flow-filled height (Figma pins a vertically filled text to
    // NONE; the parent policy's clearFill has just lifted the fill), so the height follows the
    // content under whatever width rule the text keeps. On a text that already hugs it is a no-op.
    if (sizing.vertical === "hug" && (node.textAutoResize === "NONE" || node.textAutoResize === "TRUNCATE")) node.textAutoResize = "HEIGHT";
  }
  if (node.type === "LINE") {
    if (typeof dims.width === "number") resizeWithDiagnostics(node, Math.max(dims.width, 0.01), 0);
  } else if (typeof dims.width === "number" || typeof dims.height === "number") {
    resizeWithDiagnostics(node, Math.max(typeof dims.width === "number" ? dims.width : node.width, 0.01),
                Math.max(typeof dims.height === "number" ? dims.height : node.height, 0.01));
  }
  bindDimensions(node, layout.dimensions, tokens);
}

// (The layout legality rules — percent-hug cycle, page-parent fill/percent, TEXT fill-height,
// per-type realizability — live in layout-legality.ts, the one home both verbs consult.)

/**
 * Open a build walk over `resources`. ONE per verb, never per node or per entry: the walk's key set
 * is where duplicate keys collide, so a key is unique across an editMany batch's slot content
 * exactly as it is across a rendered tree. `bindings` is opted into only by a verb with a declaring
 * component behind it (see RenderCtx.bindings).
 */
export function beginRenderWalk(resources: ApplyResources, opts?: { bindings?: boolean }): RenderCtx {
  const ctx: RenderCtx = { ...resources, keys: new Set(), exposures: [], placedIds: new Map() };
  if (opts && opts.bindings) ctx.bindings = [];
  return ctx;
}

function queueSiblingOrder(span: ApplySpan, parent: any, child: any, index: number | undefined): void {
  if (index === undefined) return;
  let edits = span.siblingOrder.get(parent);
  if (!edits) span.siblingOrder.set(parent, edits = new Map());
  edits.set(child, index);
}

/**
 * Settle everything the span deferred, in the one order geometry allows: sibling order first (a
 * grid reorder moves cells), then every percent size/position against its parent's REALIZED size
 * (shallowest first, so a percent child of a percent parent reads resolved px), then the aspect
 * ratios a percent axis drives (parents first), then the centre pivots, which read the final box.
 * Each queue is drained, so the lock's closing settle after a verb's own is a no-op.
 */
export function settleApplySpan(span: ApplySpan): void {
  for (const [parent, edits] of span.siblingOrder) applySiblingOrder(parent, [...edits].map(([child, index]) => ({ child, index })));
  span.siblingOrder.clear();
  for (const p of span.percents.splice(0).sort((a, b) => depthOf(a.node) - depthOf(b.node))) resolvePercentLayout(p.parent, p.node, p.layout);
  for (const r of span.ratios.splice(0).sort((a, b) => depthOf(a.node) - depthOf(b.node))) settleAspectRatio(r.node, r.layout);
  for (const p of span.pivots.splice(0)) settlePivot(span, p.node, p.layout);
}

function depthOf(node: any): number {
  let d = 0;
  for (let p = node.parent; p; p = p.parent) d++;
  return d;
}

// A percent (0–100) of a parent axis length — the one place "N%" becomes pixels, post-walk.
function pctOf(pct: number, parentDim: number): number {
  return (pct / 100) * parentDim;
}

// Fold one child's percent size / percent position into concrete pixels against its parent's
// realized size, through the deferred settleApplySpan pass above (an edit's live node settles through
// settleLiveNodePercentSize/Position instead). Parameter order matches the sibling child-appliers
// (parent, child, layout).
function resolvePercentLayout(parent: any, child: any, layout: WriteLayout): void {
  resolvePercentSize(parent, child, layout);
  resolvePercentPosition(parent, child, layout);
}

// The SIZE half — it PRODUCES geometry, so it runs before anything that measures.
function resolvePercentSize(parent: any, child: any, layout: WriteLayout): void {
  if (layout.percentSize) {
    assertPercentResolvable({ ...layout, position: child.layoutPositioning === "ABSOLUTE" ? "absolute" : layout.position }, parentHugFacts(parent), "flcm");
    const ps = layout.percentSize;
    const w = ps.width != null ? pctOf(ps.width, parent.width) : child.width;
    const h = ps.height != null ? pctOf(ps.height, parent.height) : child.height;
    // A text node ignores a resize on any axis it auto-sizes — it would just keep hugging its content.
    // Mirror applyLeafSize's handshake so the percent lands instead of silently dropping (ADR-0003
    // silent-wrong): a percent height fixes the box; a percent width alone wraps, height auto-fitting.
    if (child.type === "TEXT") {
      if (ps.height != null) child.textAutoResize = "NONE";
      else if (ps.width != null && child.textAutoResize === "WIDTH_AND_HEIGHT") child.textAutoResize = "HEIGHT";
    }
    resizeWithDiagnostics(child, Math.max(w, 0.01), Math.max(h, 0.01));
  }
}

// The POSITION half — it CONSUMES geometry (the parent's realized size), so it runs last of everything.
// Absolute children only (percentPos is never set otherwise). Each axis is the percent resolved against
// the parent, else the authored number re-landed; an axis with neither is never touched.
function resolvePercentPosition(parent: any, child: any, layout: WriteLayout): void {
  if (layout.position !== "absolute" || !layout.percentPos) return;
  const pp = layout.percentPos;
  if (pp.x != null || layout.left != null) child.x = pp.x != null ? pctOf(pp.x, parent.width) : layout.left!;
  if (pp.y != null || layout.top != null) child.y = pp.y != null ? pctOf(pp.y, parent.height) : layout.top!;
}

// Apply a layout delta to a LIVE node the way the create walk applies a fresh child — the SAME
// appliers in the same roles, re-run against the live parent. Order matters and mirrors buildFrame's
// walk: container words first (they may change the node's own direction, which own-size mapping
// reads), then position (in/out of flow decides which appliers govern the node), flow fills and
// their unset inverses, own/leaf sizing, cover, constraints. The percent tail is
// settleLiveNodePercentSize/Position, deliberately NOT called here — both measure, so the caller
// owns when they run (see those functions).
export function applyLiveNodeLayout(node: any, wl: WriteLayout, resources: { span: ApplySpan; tokens?: ResolvedTokens }): void {
  const context = childLayout(layoutModeOf(node.parent), wl, wl.position === "absolute" || (wl.position !== "none" && node.layoutPositioning === "ABSOLUTE"), "flcm.edit");
  wl = context.layout;
  if (wl.sizing || wl.bounds || wl.percentSize) trackSizing(node);
  const parent = node.parent;
  applyContainer(node, wl, resources.tokens);
  if (!parent) return; // a parentless node (the page itself can't get here) has no child-side context
  const parentIsAuto = isAutoLayout(parent);
  // Un-fill BEFORE the position write, and regardless of the child's CURRENT positioning: an axis
  // the delta re-sizes to fixed/hug must lose the grow/stretch mark fill installed there, even when
  // the mark sits parked and inert on an absolute child — otherwise `width: 80` on it (or
  // `{ position: "none", width: 80 }` in one delta) leaves the mark to resurrect the fill the delta
  // explicitly replaced. Clearing an inert mark is free; the parent policy touches only named axes.
  if (parentIsAuto) layoutBehavior(parent).clearFill(parent, node, wl);
  applyChildPosition(parent, node, wl);
  layoutBehavior(parent).place(parent, node, context);
  queueSiblingOrder(resources.span, parent, node, wl.zIndex);
  const inFlowAuto = context.kind !== "free";
  if (inFlowAuto) {
    layoutBehavior(parent).fill(parent, node, context, false); // crossStretch is the container's own alignItems edit, never a child's
  }
  if (isAutoLayout(node) || isFrameLike(node)) applyOwnSize(node, wl, resources.tokens);
  else applyLeafSize(node, wl, resources.tokens);
  if (!inFlowAuto) coverChild(parent, node, wl);
  if (wl.constraints) applyConstraintsDelta(node, wl.constraints);
}

/**
 * The two halves of a live layout delta's percent tail, split out so a verb can order them
 * across MORE than one node. Everything that resolves a percent is a measurement, and
 * a measurement taken while writes are still landing is a number about to move: an entry centering
 * a hugging panel reads a width that another entry's content change is about to grow, and the
 * panel ends up centered on the size it used to be.
 *
 * The split is by what each half does to geometry — size PRODUCES it, position CONSUMES it — which
 * is what lets a batch interleave the text clamp (also a producer) between them. `flcm.edit` calls
 * the pair in order and sees exactly the behavior it always had.
 */
export function settleLiveNodePercentSize(node: any, wl: WriteLayout): void {
  if (node.parent && wl.percentSize) resolvePercentSize(node.parent, node, wl);
}

/**
 * Lock the node's proportions at `wl.aspectRatio` ("none" unlocks). Figma locks whatever ratio the box
 * has, so the box is brought to the ratio first: the driving axis — a "fill" or percent one, else the
 * width — keeps its size and the other follows. Runs once the sizes have landed, so it measures the
 * realized box; afterwards Figma's lock carries the pair through layout and constraint resizes.
 */
export function settleAspectRatio(node: any, wl: WriteLayout): void {
  const ratio = wl.aspectRatio;
  if (ratio === undefined) return;
  if (ratio === "none") {
    node.unlockAspectRatio();
    return;
  }
  const fills = (axis: "Horizontal" | "Vertical", pct: number | undefined) =>
    node["layoutSizing" + axis] === "FILL" || pct !== undefined;
  const heightDrives = fills("Vertical", wl.percentSize?.height) && !fills("Horizontal", wl.percentSize?.width);
  const follower = heightDrives ? "Horizontal" : "Vertical";
  // A live hug axis (create refuses an authored one) is sized by its content; resizing it would
  // silently turn it fixed. Figma can't lock an auto-resizing text at all.
  if (node["layoutSizing" + follower] === "HUG" || (node.type === "TEXT" && node.textAutoResize !== "NONE")) {
    throw new Error(
      "flcm: aspectRatio needs its " + (heightDrives ? "width" : "height") + " free to follow, but this " + node.type +
        (node.type === "TEXT" ? " sizes itself to its text" : " hugs its content on that axis") +
        ". Give the node a fixed width and height, or drop aspectRatio.",
    );
  }
  const before = { horizontal: node.layoutSizingHorizontal, vertical: node.layoutSizingVertical };
  if (heightDrives) resizeWithDiagnostics(node, Math.max(node.height * ratio, 0.01), node.height);
  else resizeWithDiagnostics(node, node.width, Math.max(node.width / ratio, 0.01));
  // resize() pins both axes; a driving "fill" axis must keep filling for the lock to follow it.
  if (before.horizontal === "FILL" && node.layoutSizingHorizontal !== "FILL") node.layoutSizingHorizontal = "FILL";
  if (before.vertical === "FILL" && node.layoutSizingVertical !== "FILL") node.layoutSizingVertical = "FILL";
  node.lockAspectRatio();
}

export function settleLiveNodePercentPosition(node: any, wl: WriteLayout): void {
  if (node.parent && wl.percentPos) resolvePercentPosition(node.parent, node, wl);
}

// The live-parent facts assertPercentResolvable needs (create computes them from the authored
// node; edit reads them off the canvas). EFFECTIVE sizing (layoutSizing*), not the internal axis
// modes: an AUTO-mode axis that the grandparent stretches reports FILL — the parent's size is
// realized from above, the child's percent resolves against it, and no cycle exists. Reading
// primary/counterAxisSizingMode here would reject that valid case as a hug.
function parentHugFacts(parent: any): ParentFlowFacts {
  const parentIsAuto = !!parent && isAutoLayout(parent);
  if (!parentIsAuto) return { mode: LAYOUT_MODES.none, hugW: false, hugH: false };
  return {
    mode: layoutModeOf(parent),
    hugW: convertSizing(parent.layoutSizingHorizontal) === "hug",
    hugH: convertSizing(parent.layoutSizingVertical) === "hug",
  };
}

// Every parent-side fact the shared layout rules consult, gathered into one value. It exists
// because the parent a child is judged against is not always the parent on the canvas: inside a
// batch the SAME call may be changing that parent, and the entries must be legal against the
// canvas the batch is creating, not the one it found.
interface ParentLayoutFacts extends ParentFlowFacts { isPage: boolean }

function liveParentLayoutFacts(parent: any): ParentLayoutFacts {
  return {
    ...parentHugFacts(parent),
    isPage: !!parent && parent.type === "PAGE",
  };
}

// Every layout delta the current verb is applying, by node id. A batch hands the WHOLE map rather
// than one parent's delta because the projection below has to reach the grandparent: a container's
// direction write clears its children's flow marks, so whether a parent's `fill` survives is the
// grandparent's answer, not the parent's.
export type BatchLayoutDeltas = Record<string, WriteLayout>;

/**
 * The parent's facts as they will stand once the verb's own deltas have landed. With no delta for
 * this parent it is exactly the live reading.
 *
 * Both directions matter and neither is cosmetic. A child set to `"fill"` under a parent the batch
 * turns into a row is LEGAL and must not be refused (the plan's done-when: order doesn't matter);
 * the same child under a parent the batch turns free-form is NOT, and Figma won't say so — it
 * stores the mark and silently never honors it, the one outcome this surface rejects everywhere
 * else. Answering from the pre-batch canvas gets both backwards.
 *
 * TWO levels deep, and no further (ADR-0013): the parent's own delta, plus the grandparent's for
 * the one question the parent cannot answer about itself (does its fill survive). Projecting the
 * whole chain would mean simulating the batch; depth-ordered apply lands the rest correctly, and
 * anything still wrong is an apply-time refusal under invariant 2. A stated rule, not a derivation
 * — a verb that widens it re-argues the ADR rather than extending this function.
 */
function projectedParentLayoutFacts(parent: any, deltas: BatchLayoutDeltas | undefined): ParentLayoutFacts {
  const live = liveParentLayoutFacts(parent);
  const parentDelta = parent && deltas ? deltas[parent.id] : undefined;
  if (!parentDelta) return live;
  const nextMode = effectiveLayoutMode(parentDelta, parent);
  const parentIsAuto = nextMode.kind !== "free";
  const sizing = parentDelta.sizing || {};
  // Does the delta ESTABLISH a direction (off→row/column, or a row↔column flip)? Then the live
  // effective sizing is the wrong reading for an axis the delta doesn't name, in the one direction
  // that matters: it was measured under the OLD direction. A free-form frame reports "hugs nothing"
  // (nothing hugs off auto-layout) while its raw axis modes wait underneath — live, a fresh frame
  // turned row comes up primary AUTO, counter FIXED — so the instant `mode:"row"` lands its width
  // hugs, and a sibling entry's percent width against it is the cycle assertPercentResolvable
  // exists to name. Same swap on a row↔column flip: the axis each raw mode governs moves with the
  // direction.
  const establishesDirection = parentIsAuto && parentDelta.mode != null && parentDelta.mode !== layoutModeOf(parent).word;
  // A fill is a MARK on the parent, honored by the grandparent's flow — so a grandparent whose own
  // delta re-aims that flow (any direction change: applyContainer clears every child's flow marks,
  // and "none" leaves them parked and inert) stops honoring it, and the parent falls back to its
  // raw axis mode. Read from the batch, not the canvas, or the carve-out below saves a parent the
  // batch is about to un-fill.
  const grandparent = parent ? parent.parent : null;
  const grandparentDelta = grandparent && deltas ? deltas[grandparent.id] : undefined;
  const fillSurvives =
    !grandparentDelta || grandparentDelta.mode == null || grandparentDelta.mode === layoutModeOf(grandparent).word;
  const unnamedAxisHugs = function (isWidth: boolean): boolean {
    if (!parentIsAuto) return false; // hug is meaningless off auto-layout
    // The live effective reading holds unless the batch invalidates what produced it — either the
    // parent's own direction moved (so each raw mode governs a different axis now) or its fill
    // stopped being honored. Then read the raw modes, exactly as applyOwnSize will.
    if (!establishesDirection && fillSurvives) return isWidth ? live.hugW : live.hugH;
    // Fill is realized from ABOVE, so where it survives it still isn't a hug (the same case
    // parentHugFacts reads effective sizing for).
    if (fillSurvives && convertSizing(parent[isWidth ? "layoutSizingHorizontal" : "layoutSizingVertical"]) === "fill") return false;
    return behaviorForMode(nextMode).rawHugs(parent, isWidth ? "horizontal" : "vertical");
  };
  return {
    isPage: live.isPage, // a props-only delta never reparents
    mode: effectiveLayoutMode(parentDelta, parent),
    hugW: sizing.horizontal !== undefined ? parentIsAuto && sizing.horizontal === "hug" : unnamedAxisHugs(true),
    hugH: sizing.vertical !== undefined ? parentIsAuto && sizing.vertical === "hug" : unnamedAxisHugs(false),
  };
}

// The live-facts gate every mutating verb consults before its entry seal — one question ("can
// these layout words land on this node under THAT parent?"), asked against an EXPLICIT
// destination. The RULES all live in layout-legality.ts (the one authority, so verbs cannot
// drift); this function's job is purely to supply the facts the pure rules can't read.
// The parent's facts are a PARAMETER, not read from `node.parent`, because that is exactly what a
// structural verb changes — a moved node's layout was legal where it sat, not necessarily where it
// lands — and what a batch verb projects.
//
//   `isContainer`   — will the node itself lay out row/column children (edit: live-or-delta mode).
//   `isOutOfFlow`   — the node's EFFECTIVE positioning after this call. A delta rarely names
//                     a placement word, so an already-ABSOLUTE child threads its live positioning: out
//                     of flow it doesn't feed the parent's hug, and the percent cycle can't form.
function assertLayoutLandsUnderParent(
  parent: ParentLayoutFacts, nodeType: string, wl: WriteLayout, isContainer: AutoLayoutMixin["layoutMode"] | undefined, isOutOfFlow: boolean, subject: string, nodeLocalValidated = false, liveWrap = false,
): void {
  const context = childLayout(parent.mode, wl, isOutOfFlow, subject);
  wl = context.layout;
  if (parent.isPage) {
    assertSizingResolvesAgainstParentFrame(wl, false, subject);
  }
  if (!nodeLocalValidated) assertLayoutRealizableForType(nodeType, wl, isContainer, subject, liveWrap);
  assertTextFillHeightInFlow(nodeType, wl, parent.mode.kind !== "free", isOutOfFlow, subject);
  assertLineSizingInFlow(nodeType, wl, parent.mode, isOutOfFlow, subject);
  if (wl.percentSize) {
    assertPercentResolvable({ ...wl, position: isOutOfFlow ? "absolute" : wl.position }, parent, subject);
  }
}

// ---- The three verb-facing spellings of the gate. Each derives the facts itself, so a caller
// never assembles them (two adjacent booleans a call site could swap) and never needs the
// primitives above. ----

// Edit: the destination is where the node already sits. `subject` names the calling verb the way
// the other two spellings take it — `edit` and `editMany` compile through one pipeline, and an
// entry rejected inside a batch must say which verb the agent actually called. `deltas` is every
// layout delta THIS verb is applying, keyed by node id, so the ancestors this node is judged
// against are the ones the call is creating (see projectedParentLayoutFacts); a lone `edit` passes
// none and is judged against the live canvas. `projection.mode` is the node's OWN container mode
// after this same call — an INSTANCE the delta swaps or re-variants takes the incoming component's
// auto-layout mode before its root words land, so reading the live mode would both refuse a gap the
// swap makes legal and accept one it makes meaningless. Undefined for every other delta, which has
// no way to change its own mode mid-call.
export interface EditLayoutProjection {
  mode?: AutoLayoutMixin["layoutMode"];
  wrap?: boolean;
  /** Overrides compiled against a definition will land inside an instance of this component. */
  instanceDefinition?: SceneNode;
}

export function assertLayoutDeltaResolvable(
  node: any, wl: WriteLayout, subject: string, deltas?: BatchLayoutDeltas, projection?: EditLayoutProjection,
): void {
  assertBounds(wl.bounds, node, subject);
  const outOfFlow = wl.position === "absolute" || (wl.position !== "none" && node.layoutPositioning === "ABSOLUTE");
  const parent = projectedParentLayoutFacts(node.parent, deltas);
  const mode = projection?.mode === undefined ? node.layoutMode : projection.mode;
  if (node.type === "RECTANGLE") {
    let owner: any = null;
    for (let parent = node.parent; parent && parent.type !== "PAGE"; parent = parent.parent) {
      // Open slot content is outside this inherited-rectangle rule. A nested instance inside
      // that content still supplies its own inherited rectangle children.
      if (isSlotHole(parent)) break;
      if (parent.type === "INSTANCE" || parent === projection?.instanceDefinition) { owner = parent; break; }
    }
    if (owner) assertInheritedRectangleDimensions(wl, subject + ": " + describeNodeIdentity(node) + " under " + describeNodeIdentity(owner));
  }
  if (node.type === "INSTANCE" && wl.mode !== undefined) {
    const requested = LAYOUT_MODES[wl.mode].native;
    if (requested !== mode) {
      throw new Error(subject + ": an instance root inherits its layout direction from its component; layout.mode " +
        JSON.stringify(wl.mode) + " does not match the resulting component's " + mode + " direction. Change the component or choose a matching variant instead. Nothing was applied.");
    }
  }
  assertGridSizing(wl, { layoutMode: mode, layoutSizingHorizontal: node.layoutSizingHorizontal, layoutSizingVertical: node.layoutSizingVertical, gridColumnSizes: node.gridColumnSizes, gridRowSizes: node.gridRowSizes }, subject);
  const isContainer = mode;
  assertLayoutLandsUnderParent(parent, node.type, wl, isContainer, outOfFlow, subject, false, projection?.wrap ?? node.layoutWrap === "WRAP");
}

// A structural verb placing a LIVE node: ask whether the words it already wears stay legal under
// `destination`, and hand them back — they're also what the post-move re-aim replays, and reading
// them twice would risk reading them AFTER the reparent, when they no longer mean the old axes.
export function assertLiveNodeLandsUnderParent(node: any, destination: any, subject: string, overrides?: WriteLayout): WriteLayout {
  const facts = liveParentLayoutFacts(destination);
  const live = liveParentRelativeWords(node);
  const wl: WriteLayout = { ...live, ...overrides };
  if (live.sizing || overrides?.sizing) wl.sizing = { ...live.sizing, ...overrides?.sizing };
  if (live.dimensions || overrides?.dimensions) wl.dimensions = { ...live.dimensions, ...overrides?.dimensions };
  rederiveCarriedFill(node, wl, overrides, placementKind(facts.mode, wl.position === "absolute"));
  assertBounds(wl.bounds, node, subject);
  assertLayoutLandsUnderParent(facts, node.type, wl, node.layoutMode, wl.position === "absolute", subject);
  return wl;
}

// A carried `fill` meant a share of its old layout. Where the node lands may read fill as the
// whole parent box instead — free-form, the page, absolute — and a 480×102 tile came out 480×2600;
// there it keeps the px it has now. Between layouts (row, column, grid) it is re-aimed instead.
// A fill this call writes is read fresh wherever the node lands.
function rederiveCarriedFill(node: any, wl: WriteLayout, overrides: WriteLayout | undefined, landing: ChildLayout["kind"]): void {
  if (fillReading(landing) === fillReading(placementKind(layoutModeOf(node.parent), node.layoutPositioning === "ABSOLUTE"))) return;
  for (const [axis, dim] of [["horizontal", "width"], ["vertical", "height"]] as const) {
    if (wl.sizing?.[axis] !== "fill" || overrides?.sizing?.[axis] !== undefined) continue;
    wl.sizing[axis] = "fixed";
    wl.dimensions = { ...wl.dimensions, [dim]: node[dim] };
  }
}

// A compiled root bound for `destination`: on a page, a read root's fill axes take their designed px
// (foldDesignedSizeForPage). Runs before assertBuiltRootLandsUnderParent, which then judges the folded words.
export function foldBuiltRootForDestination(destination: any, wn: BuiltNode): void {
  if (destination.type === "PAGE" && wn.layout) wn.layout = foldDesignedSizeForPage(wn.layout);
}

// A structural verb placing a compiled node: only its ROOT meets the destination — the interior children
// are checked against their own authored parents inside the build walk, exactly as at create.
// `deltas` is the same projection a batch hands assertLayoutDeltaResolvable: a slot's content is
// judged against the slot as the SAME override's own layout words will leave it, not as it stands.
export function assertBuiltRootLandsUnderParent(destination: any, wn: BuiltNode, subject: string, deltas?: BatchLayoutDeltas): void {
  // Instance planning validates node-local words against the resolved component/selected variant,
  // including recursively planned slot content. This gate only adds destination-relative checks.
  const wl = wn.layout || {};
  assertLayoutLandsUnderParent(projectedParentLayoutFacts(destination, deltas), wn.type, wl, undefined, wl.position === "absolute", subject, wn.type === "INSTANCE");
}

// The layout words a LIVE node carries that MEAN SOMETHING ABOUT ITS PARENT — the only intent a
// reparent invalidates, and the only intent readable back off the canvas. "fill" survives as the
// flow marks (layoutGrow/STRETCH, reported through layoutSizing*) and out-of-flow survives as
// layoutPositioning; a percent was folded to pixels at apply and a fixed/hug axis is node-local,
// so neither is here. Feeds both halves of a structural move: the destination gate above, and the
// re-aim that re-applies the intent against the new parent's axes.
function liveParentRelativeWords(node: any): WriteLayout {
  const wl: WriteLayout = {};
  const sizing: { horizontal?: Sizing; vertical?: Sizing } = {};
  if (convertSizing(node.layoutSizingHorizontal) === "fill") sizing.horizontal = "fill";
  if (convertSizing(node.layoutSizingVertical) === "fill") sizing.vertical = "fill";
  if (sizing.horizontal || sizing.vertical) wl.sizing = sizing;
  if (node.layoutPositioning === "ABSOLUTE") wl.position = "absolute";
  return wl;
}

// Attach a live node through `place`, dropping the flow marks it wore under its OLD parent first.
// layoutGrow means "the parent's PRIMARY axis" and STRETCH "its COUNTER axis", and Figma applies a
// mark the moment the node lands: a column's width-STRETCH becomes a row's height-STRETCH, and the
// stretched size outlives clearing the mark afterwards [verified live, fig-125]. Cleared where it
// sits, the node keeps the px it has. NOT lifted, as the parent policy doesn't lift it on a
// direction flip: the hug-beats-stretch primaryAxisSizingMode pin, indistinguishable from an
// authored fixed size once written.
export function attachLiveNode(parent: any, node: any, wl: WriteLayout, place: (node: any) => void): void {
  growImplicitGridRows(parent, wl);
  node.layoutGrow = 0;
  if (node.layoutAlign === "STRETCH") node.layoutAlign = "INHERIT";
  place(node);
}

// Settle a node attachLiveNode just placed: re-apply its parent-relative intent against the new
// parent through the create/edit appliers.
export function resettleMovedNode(node: any, wl: WriteLayout, resources: { span: ApplySpan; tokens?: ResolvedTokens }): void {
  applyLiveNodeLayout(node, wl, resources);
  settleLiveNodePercentSize(node, wl);
  settleLiveNodePercentPosition(node, wl);
}

/** One positioned child waiting on its parent's final size — cover its "fill" axes, then constrain it. */
interface PositionedChildSettlement { child: any; layout: WriteLayout }

// The parent-side facts a compiled child is settled against. The flow facts are ParentFlowFacts (the
// percent rule's own shape); `crossStretch` rides along because container-level `alignItems:
// "stretch"` intent is never stored — not by Figma, not by us (see the flow policy) — so
// only a caller holding the parent's own WriteNode can state it. A caller inserting into a LIVE parent
// passes false and says so in its docs: the marks are re-synthesized by editing the container.
interface AttachParentFacts extends ParentFlowFacts {
  crossStretch: boolean;
  widthIsBounded: boolean;
  subject: string; // the verb name the shared legality rules prefix their rejections with
}

// The same facts read off a LIVE destination, for the structural insert verbs. `crossStretch` is
// FALSE here and that is a stated rule, not a reading gap: an inserted child does NOT inherit a
// stretch container's stretch, because there is nothing to inherit FROM — see AttachParentFacts
// above. The remedy is `edit(parent, { layout: { alignItems: "stretch" } })`, which re-synthesizes
// the marks over every child including the new one.
export function liveParentAttachFacts(parent: any, subject: string): AttachParentFacts {
  const flow = parentHugFacts(parent);
  return { ...flow, crossStretch: false, widthIsBounded: !flow.hugW, subject };
}

// The flow facts a built FRAME's children are judged against, from its AUTHORED words alone — the
// frame's own sizing modes don't exist until applyOwnSize runs after the children (see
// assertPercentResolvable's contract). Pure, so the gate can judge the interior before the seal.
function childFlowFactsOf(wn: BuiltNode): ParentFlowFacts & { crossStretch: boolean } {
  const layout = wn.layout || {};
  const mode = effectiveLayoutMode(layout);
  const sizing = behaviorForMode(mode).defaultSizing(layout);
  return {
    mode,
    hugW: !sizing.horizontal || sizing.horizontal === "hug",
    hugH: !sizing.vertical || sizing.vertical === "hug",
    crossStretch: layout.alignItems === "stretch",
  };
}

/**
 * Judge every built child of a built parent in `tree` against that parent's authored facts — the
 * same verdict the build walk reaches, reached in the verb's gate so a bad interior child refuses
 * with zero writes. A root meets its destination elsewhere (assertBuiltRootLandsUnderParent), and
 * slot content is judged where its instance is planned (instance.ts). A live parent's children stay
 * the walk's: its own delta can change its layout before they attach.
 */
export function assertBuiltInteriorLegal(tree: WriteNode): void {
  const facts = tree.liveId === undefined ? childFlowFactsOf(tree) : undefined;
  for (const child of tree.children ?? []) {
    if (facts && child.liveId === undefined) legalChildLayout(child, child.layout || {}, { ...facts, subject: child.sourcePath ?? "flcm" });
    assertBuiltInteriorLegal(child);
  }
}

// The child-side legality checks run inside the PARENT's buildNode, so they're attributed to the
// child here — and flagged as flcm's own refusal, which their path-prefixed messages can't say. The
// gate judges authored words (assertBuiltInteriorLegal), the walk words with the text-fill default:
// that default is legal wherever it applies, so the verdict is the same.
function legalChildLayout(wn: BuiltNode, words: WriteLayout, facts: ParentFlowFacts & { subject: string }): ChildLayout {
  try {
    const context = childLayout(facts.mode, words, words.position === "absolute", facts.subject);
    const cl = context.layout;
    // Fail loud on the one unresolvable percent (in-flow %-size against a hugging auto-layout parent)
    // before building the node, so a bad node doesn't orphan a live node on the canvas. Every other
    // percent is recorded and resolved in the post-walk pass (settleApplySpan) against realized size.
    assertPercentResolvable(cl, facts, facts.subject);
    assertTextFillHeightInFlow(wn.type, cl, facts.mode.kind !== "free", cl.position === "absolute", facts.subject);
    assertLineSizingInFlow(wn.type, cl, facts.mode, cl.position === "absolute", facts.subject);
    assertLineFillUnrotated(wn.type, cl.sizing?.horizontal === "fill", wn.rotation, facts.subject);
    return context;
  } catch (cause) {
    if (!wn.sourcePath) throw cause;
    throw new NodeBuildError(wn, wn.sourcePath, cause, { flcmRefusal: true });
  }
}

// THE attach-then-size entry: build one compiled child and settle it into `parent`. Shared by the
// create walk (parent = the frame it is assembling) and the structural insert verbs (parent = a
// live destination), so a subtree lands the same way whichever verb placed it.
//
// The ORDER is invariant 3's hazard in miniature and the whole reason this is one function: the
// child is attached BEFORE any child-side sizing runs, because "fill"/"hug" are only legal once
// the node is inside the parent that resolves them. `place` performs the attachment — appending
// at the end for create, at an index for prepend/insertBefore — so WHERE stays the caller's while
// the ordering stays here.
export function attachBuiltChild(
  parent: any, wn: WriteNode, ctx: RenderCtx, facts: AttachParentFacts, place: (child: any) => void,
  settleAfterParentSize?: PositionedChildSettlement[],
): any {
  if (wn.liveId !== undefined) return ctx.live.get(wn)!.place(parent, place, ctx);
  facts = { ...facts, subject: wn.sourcePath ?? facts.subject };
  const authored = wn.layout || {};
  const defaultTextFill = wn.type === "TEXT" && authored.sizing?.horizontal === undefined && authored.position !== "absolute" && facts.mode.word === "column" && facts.widthIsBounded;
  const words: WriteLayout = defaultTextFill ? { ...authored, sizing: { ...authored.sizing, horizontal: "fill" } } : authored;
  const context = legalChildLayout(wn, words, facts);
  const cl = context.layout;
  const child = buildNode(wn, ctx, facts.widthIsBounded);
  if (defaultTextFill) child.textAutoResize = "HEIGHT";
  // BEFORE the attach: Figma auto-places the child the moment it lands, and a grid with no free
  // cell left grows a FIXED row of its own.
  growImplicitGridRows(parent, cl);
  place(child);
  layoutBehavior(parent).place(parent, child, context);
  queueSiblingOrder(ctx.span, parent, child, cl.zIndex);
  if (cl.percentSize || cl.percentPos) {
    ctx.span.percents.push({ node: child, layout: cl, parent });
  }
  if (cl.position === "absolute") applyChildPosition(parent, child, cl);
  if (context.kind === "free") {
    coverChild(parent, child, cl);
    // A constraint is how the child reflows when the parent's box CHANGES, so writing it before the
    // parent has its final size makes Figma reflow the child by that difference — a STRETCH child
    // authored 200 wide under a still-provisional frame comes out 200 + the frame's growth. A caller
    // that will size the parent afterwards takes the marks in its own post-size pass; one attaching
    // into an already-sized live parent has no delta coming and writes them here.
    if (settleAfterParentSize) settleAfterParentSize.push({ child, layout: cl });
    else applyConstraints(child, wn.layout);
  } else {
    layoutBehavior(parent).fill(parent, child, context, facts.crossStretch);
    // An explicit constraint is STORED even in flow — constraints are inert on an in-flow auto-layout
    // child, but they govern the moment it leaves the flow, and edit's applyConstraintsDelta writes
    // the word unconditionally. applyConstraintsDelta, NOT applyConstraints: in flow, fill rides
    // layoutGrow, so deriving the unnamed axis from sizing intent (fill→STRETCH) would store a
    // constraint the author never spoke — and one the same word through edit would leave at the default.
    if (cl.constraints) applyConstraintsDelta(child, cl.constraints);
  }
  return child;
}

function buildFrame(wn: BuiltNode, ctx: RenderCtx, enclosingWidthBounded = false): any {
  const f = figma.createFrame();
  figma.currentPage.appendChild(f); // enter the doc; reparented when appended to a parent frame
  // CSS default overflow is VISIBLE; Figma's createFrame() defaults clipsContent = true. Default it off so
  // authored overflow (escaping shadows, a knob past its track, a badge past a corner) isn't silently
  // clipped — a silent divergence from the CSS mental model. applyPaint re-applies an explicit `clip`.
  f.clipsContent = false;
  const layout = wn.layout || {};
  applyContainer(f, layout, ctx.tokens);
  if (!wn.fills) f.fills = []; // omitted fill -> transparent, not a surprise white box
  applyPaint(f, wn, ctx);

  const flow = childFlowFactsOf(wn);
  const authoredSizing = behaviorForMode(flow.mode).defaultSizing(layout);
  const facts: AttachParentFacts = {
    ...flow,
    widthIsBounded: flow.mode.kind === "free" || (authoredSizing.horizontal === "fixed" && !layout.percentSize?.width) || ((authoredSizing.horizontal === "fill" || layout.percentSize?.width !== undefined) && enclosingWidthBounded),
    subject: "flcm",
  };
  // Every positioned child (absolute, or any child of a free-form parent) settles only once the frame
  // has its FINAL size: a w/h:"fill" must be re-resized against it, and a constraint must not be
  // written against the provisional one. An INSERT into a live parent needs no such pass — its
  // destination is already sized.
  const settlements: PositionedChildSettlement[] = [];
  for (const rawChild of wn.children || []) {
    if (!rawChild) continue;
    attachBuiltChild(f, rawChild, ctx, facts, (c) => f.appendChild(c), settlements);
  }

  // Creation default: a fresh auto-layout frame HUGS both axes (CSS fit-content). Like the
  // transparent-fill default above, it's the builder's to inject — the applier itself never turns
  // key-absence into a write, so an edit delta omitting an axis leaves it alone.
  applyOwnSize(f, { ...layout, sizing: { horizontal: authoredSizing.horizontal || "hug", vertical: authoredSizing.vertical || "hug" } }, ctx.tokens);
  // Settle every positioned child now that the frame has its final size (at append it was hug-sized).
  for (const s of settlements) { coverChild(f, s.child, s.layout); applyConstraints(s.child, s.layout); }
  return f;
}

// Stamp a component. Everything the node DOESN'T name stays the component's — no clip/fill/hug
// defaults (buildFrame's are creation defaults for a blank frame; on an instance each would be a
// root-level override the author never wrote, silently unlinking that field from the component).
// Order: properties before overrides, since a property can swap a nested instance or hide a
// sublayer and the override paths were resolved against the tree the properties produce. The
// child-side words (position, fill, constraints) are attachBuiltChild's, after the caller places the node.
function buildInstance(wn: BuiltNode, ctx: RenderCtx): any {
  const plan = ctx.instances.get(wn);
  if (!plan) throw new Error("flcm: an INSTANCE node reached the build walk without a resolved plan. This is an internal error; report it.");
  const inst = plan.component.createInstance();
  figma.currentPage.appendChild(inst); // enter the doc; reparented when appended to a parent frame
  if (Object.keys(plan.properties).length) inst.setProperties(plan.properties);
  applyPaint(inst, wn, ctx);
  if (wn.layout) {
    applyContainer(inst, wn.layout, ctx.tokens);
    applyOwnSize(inst, wn.layout, ctx.tokens);
  }
  if (wn.exposed !== undefined) ctx.exposures.push({ node: inst, value: wn.exposed });
  plan.applyOverrides(inst, ctx);
  return inst;
}

// Layer each rich-text run's style/fills over its slice of the already-set characters via Figma's per-range
// API. Offsets track the concatenation order the runs were joined in (buildText). A run only carries the
// fields it overrides, so we touch only those ranges — the rest inherit the node's base style. A run's font
// resolves STRICTLY (resolveFontStrict): an unloaded run font fails loud rather than silently rendering base.
function applyRuns(t: any, runs: NonNullable<WriteProps["runs"]>, sites: readonly PaintSite[], ctx: RenderResources): void {
  const runFills = new Map(sites.flatMap((site) => site.at === "runFills" ? [[site.run, site] as const] : []));
  // Read once: a literal run write clears a binding only where the node has one, so plain text
  // pays no extra writes. Runs never overlap, so a binding laid by an earlier run is never in the way.
  const bound = t.boundVariables || {};
  const unbindRange = (start: number, end: number, field: VariableBindableTextField): void => {
    if (bound[field]) t.setRangeBoundVariable(start, end, field, null);
  };
  let start = 0;
  for (const [i, run] of runs.entries()) {
    const end = start + run.text.length;
    if (end > start) {
      const s = run.style;
      if (s) {
        // Italic is a font-name concern in Figma (the style string, e.g. "Bold Italic"), so a run that
        // changes family, weight, OR slant needs a per-range font — resolved STRICTLY against the exact
        // (family, weight, italic) fonts.ts preloaded.
        if (namesFontIdentity(s)) {
          const italic = s.fontStyle === "italic";
          const font = resolveFontStrict(ctx.fonts, s.fontFamily, s.fontWeight, italic);
          if (s.fontFamily !== undefined && !isTokenRef(s.fontFamily)) unbindRange(start, end, "fontFamily");
          if (s.fontWeight !== undefined && !isTokenRef(s.fontWeight)) unbindRange(start, end, "fontWeight");
          t.setRangeFontName(start, end, font);
          warnFontDivergences(t, "a run", fontDivergences(s.fontFamily, s.fontWeight, italic, font));
        }
        const range = (field: VariableBindableTextField, value: Bindable<unknown> | undefined, write: () => void): void => {
          if (value === undefined) return;
          if (isTokenRef(value)) t.setRangeBoundVariable(start, end, field, variableFor(value as VariableRef, ctx.tokens));
          else {
            unbindRange(start, end, field);
            write();
          }
        };
        // After the font name, which a bound family or weight then binds over.
        range("fontFamily", isTokenRef(s.fontFamily) ? s.fontFamily : undefined, () => {});
        range("fontWeight", isTokenRef(s.fontWeight) ? s.fontWeight : undefined, () => {});
        range("fontSize", s.fontSize, () => t.setRangeFontSize(start, end, s.fontSize));
        range("lineHeight", s.lineHeight, () => t.setRangeLineHeight(start, end, s.lineHeight));
        range("letterSpacing", s.letterSpacing, () => t.setRangeLetterSpacing(start, end, s.letterSpacing));
        if (s.textDecoration) t.setRangeTextDecoration(start, end, DECORATION[s.textDecoration]);
        // Casing and paragraph metrics are per-range in Figma exactly as the font is, which is why
        // they are run words at all (the read side surfaces them per segment for the same reason).
        if (s.textCase) t.setRangeTextCase(start, end, s.textCase);
        range("paragraphSpacing", s.paragraphSpacing, () => t.setRangeParagraphSpacing(start, end, s.paragraphSpacing));
        range("paragraphIndent", s.paragraphIndent, () => t.setRangeParagraphIndent(start, end, s.paragraphIndent));
        if (typeof s.listSpacing === "number") t.setRangeListSpacing(start, end, s.listSpacing);
      }
      // Present-but-empty is the compiled "none" — a real transparent write over the slice, not a skip.
      const fills = runFills.get(i);
      if (fills) t.setRangeFills(start, end, toFigmaPaintStack(fills, ctx));
      if (run.hyperlink) t.setRangeHyperlink(start, end, { type: "URL", value: run.hyperlink });
    }
    start = end;
  }
}

// A substituted family or snapped weight still renders, so it is a warning rather than an error: the
// agent learns the text is not in the font it wrote, without losing a build over a missing font.
function warnFontDivergences(t: any, where: string, divergences: ReturnType<typeof fontDivergences>): void {
  for (const { prop, authored, realized } of divergences) {
    warnings.add({
      id: t.id, prop: "textStyle." + prop, authored, realized,
      message: "No available font matches " + where + "'s " + prop + ", so flcm used the nearest one Figma has.",
    });
  }
}

// The text-word applier both carriers ride — buildText for a fresh node, edit for a live one —
// so a text style compiled for create and for edit cannot land differently. Presence-only: the
// base font writes ONLY when the style names a font-identity word (an edit's fontSize nudge must
// not re-write fontName from a default triple; buildText writes the creation default itself when
// the node names none). Order is load-bearing: font before characters (Figma refuses characters on
// an unloaded font; the caller preloaded exactly this triple), characters before runs (the setRange
// offsets address slices of them). Node-level fills are applyPaint's — the caller must run it
// BEFORE this so range fills land over, not under, the base fill.
export function applyTextProps(t: any, wn: WriteProps, ctx: ApplyResources): void {
  const ts = wn.textStyle || {};
  const textStyle = ts.style ? (styleFor(ts.style, ctx.tokens) as TextStyle) : undefined;
  if (ts.style) t.fontName = textStyleFont(ctx.fonts, ts.style);
  else if (namesFontIdentity(ts)) {
    // A literal family or weight replaces its binding; a bound one binds over the font below.
    if (ts.fontFamily !== undefined && !isTokenRef(ts.fontFamily)) unbindField(t, "fontFamily");
    if (ts.fontWeight !== undefined && !isTokenRef(ts.fontWeight)) unbindField(t, "fontWeight");
    const italic = ts.fontStyle === "italic";
    t.fontName = resolveFont(ctx.fonts, ts.fontFamily, ts.fontWeight, italic);
    warnFontDivergences(t, "the text", fontDivergences(ts.fontFamily, ts.fontWeight, italic, t.fontName));
  }
  if (wn.runs) t.characters = textOfRuns(wn.runs);
  else if (wn.text != null) t.characters = String(wn.text);
  // A bound family or weight binds over the literal font written above (both are loaded in every mode).
  if (isTokenRef(ts.fontFamily)) writeBindable(t, "fontFamily", ts.fontFamily, ctx.tokens);
  if (isTokenRef(ts.fontWeight)) writeBindable(t, "fontWeight", ts.fontWeight, ctx.tokens);
  if (ts.fontSize !== undefined) writeBindable(t, "fontSize", ts.fontSize, ctx.tokens);
  if (ts.lineHeight) writeBindable(t, "lineHeight", ts.lineHeight, ctx.tokens);
  if (ts.letterSpacing) writeBindable(t, "letterSpacing", ts.letterSpacing, ctx.tokens);
  if (textStyle) applyTextStyleValues(t, textStyle);
  if (ts.textAlign && TEXT_ALIGN[ts.textAlign]) t.textAlignHorizontal = TEXT_ALIGN[ts.textAlign];
  if (ts.textAlignVertical) t.textAlignVertical = VERTICAL_ALIGN[ts.textAlignVertical];
  // Base decoration/casing/paragraph metrics first (whole node); runs then override their slice via
  // the matching setRange* below.
  if (ts.textDecoration) t.textDecoration = DECORATION[ts.textDecoration];
  if (ts.textCase) t.textCase = ts.textCase;
  if (ts.paragraphSpacing !== undefined) writeBindable(t, "paragraphSpacing", ts.paragraphSpacing, ctx.tokens);
  if (ts.paragraphIndent !== undefined) writeBindable(t, "paragraphIndent", ts.paragraphIndent, ctx.tokens);
  if (typeof ts.listSpacing === "number") t.listSpacing = ts.listSpacing;
  // A whole-node link is a range write like a run's — over every character. Guarded on non-empty
  // characters because Figma refuses a zero-width range, and an empty text has nothing to link.
  if (ts.hyperlink && t.characters.length) t.setRangeHyperlink(0, t.characters.length, { type: "URL", value: ts.hyperlink });
  if (wn.runs) applyRuns(t, wn.runs, paintSitesOf(wn), ctx);
  if (textStyle) queueStyleLink(ctx.span, t, "text", textStyle.id);
}

// What a text style sets, written now so the text measures styled inside the sealed span; the lock's
// queued link (setTextStyleIdAsync) then attaches the style itself. The compiler refused every word
// this covers, so nothing authored is overwritten.
function applyTextStyleValues(t: any, style: TextStyle): void {
  t.fontSize = style.fontSize;
  t.lineHeight = style.lineHeight;
  t.letterSpacing = style.letterSpacing;
  t.textDecoration = style.textDecoration;
  t.textCase = style.textCase;
  t.paragraphSpacing = style.paragraphSpacing;
  t.paragraphIndent = style.paragraphIndent;
  if (style.listSpacing !== undefined) t.listSpacing = style.listSpacing;
}

// TEXT clamp writes, applied AFTER sizing (truncation needs the wrap to exist). Setting: "ENDING"
// must precede maxLines — Figma rejects a non-null maxLines while truncation is "DISABLED".
// Removal ("none", edit's word) reverses that order: null the count while truncation still
// stands, then disable.
export function applyTextClamp(t: any, maxLines: WriteProps["maxLines"]): void {
  if (maxLines == null) return;
  if (maxLines === "none") {
    t.maxLines = null;
    t.textTruncation = "DISABLED";
    return;
  }
  t.textTruncation = "ENDING";
  t.maxLines = maxLines;
}

function buildText(wn: BuiltNode, ctx: RenderCtx): any {
  const t = figma.createText();
  figma.currentPage.appendChild(t);
  // The creation default is the builder's: a fresh text ALWAYS ends up with a written base font —
  // applyTextProps's font write is presence-gated (edit's rule), so when the node names no identity
  // word, create writes the resolveFont fallback triple itself (loadFontsForTree preloaded it).
  if (!wn.textStyle?.style && !namesFontIdentity(wn.textStyle)) t.fontName = resolveFont(ctx.fonts, undefined, undefined, false);
  // An omitted fill keeps createText's seeded black — the text default, unlike a shape's transparent one.
  applyPaint(t, wn, ctx);
  applyTextProps(t, { ...wn, text: wn.text == null ? "" : wn.text }, ctx);
  applyLeafSize(t, wn.layout || {}, ctx.tokens);
  // TEXT guarantees a bounded width when maxLines is set (the handshake above gave it a
  // wrap), so the truncation always has real lines to bite.
  applyTextClamp(t, wn.maxLines);
  return t;
}


function buildShape(node: any, wn: BuiltNode, ctx: RenderCtx): any {
  figma.currentPage.appendChild(node);
  if (!wn.fills) node.fills = []; // omitted fill -> transparent
  applyPaint(node, wn, ctx);
  applyLeafSize(node, wn.layout || {}, ctx.tokens);
  return node;
}

function buildLine(wn: BuiltNode, ctx: RenderCtx): any {
  const l = figma.createLine();
  figma.currentPage.appendChild(l);
  // An omitted stroke keeps createLine's seeded black; the weight's creation default is 1.
  applyPaint(l, { ...wn, strokeWeight: wn.strokeWeight ?? 1 }, ctx);
  applyLeafSize(l, wn.layout || {}, ctx.tokens);
  return l;
}

// A VECTOR WriteNode carries one WriteVectorSource (ir.ts), and each arm drives a different plugin call:
// svg → createNodeFromSvg (a FRAME of vectors); path → createVector + vectorPaths (one themeable vector).
// Both fail loud on unparseable input rather than leaving a silent empty node.
function buildVector(wn: BuiltNode, ctx: RenderCtx): any {
  const source = wn.vector;
  if (!source) throw new Error("flcm: a VECTOR node carries no geometry (compileSvg/compilePath guarantee one).");
  return source.kind === "svg" ? buildSvg(wn, source.markup, ctx) : buildPath(wn, source, ctx);
}

function buildSvg(wn: BuiltNode, markup: string, ctx: RenderCtx): any {
  let frame: any;
  try {
    frame = figma.createNodeFromSvg(markup);
  } catch (e: any) {
    throw new Error("VECTOR: Figma could not parse the SVG markup — " + (e && e.message ? e.message : String(e)));
  }
  figma.currentPage.appendChild(frame);
  // createNodeFromSvg returns a FrameNode, which inherits Figma's clipsContent=true default — so vector art
  // that bleeds past its viewBox gets clipped. The generic clip-default fix lives in buildFrame (the
  // createFrame path); this frame never traverses it, so clear it here too (CSS overflow is visible by
  // default). See buildFrame for the rationale.
  frame.clipsContent = false;
  // BEFORE applyLeafSize: Figma applies a child's constraints during the parent's resize, so art that
  // gets SCALE only afterwards is art the authored width/height already stranded at its import size.
  themeImportedArt(frame, wn, ctx);
  applyLeafSize(frame, wn.layout || {}, ctx.tokens);
  if (wn.opacity !== undefined) writeBindable(frame, "opacity", wn.opacity, ctx.tokens);
  return frame;
}

// The imported frame is a CANVAS: resizing it must scale the art, and the author's fill/stroke must reach
// the art rather than the canvas. Both are the same walk, so they share it.
//
// Constraints: createNodeFromSvg's whole typing is `(svg: string): FrameNode` — the plugin docs state no
// default constraint at all, and say nothing about what the importer leaves on the vectors it parses. The
// editor's default for a layer is Top/Left (MIN/MIN), which would leave a 24px glyph in the top-left of a
// frame resized to 48. So set SCALE ourselves on every descendant (each is constrained against its OWN
// parent, so nested <g> frames need it too) and `edit(icon, { width: 48, height: 48 })` scales the drawing.
// Paints: only the vectors, never the containers — painting a <g>'s frame would put a backdrop behind the
// art instead of recolouring it. A present-but-empty array is the compiled "none", same as applyPaint.
function themeImportedArt(frame: any, wn: BuiltNode, ctx: RenderCtx): void {
  const paints = paintSitesOf(wn).flatMap((site) => site.at === "runFills" ? [] : [{ at: site.at, paints: toFigmaPaintStack(site, ctx) }]);
  const walk = (node: any): void => {
    if ("constraints" in node) node.constraints = { horizontal: "SCALE", vertical: "SCALE" };
    if (node.type === "VECTOR") for (const { at, paints: stack } of paints) node[at] = stack;
    if (node.children) for (const child of node.children) walk(child);
  };
  for (const child of frame.children ?? []) walk(child);
}

/** Geometry edits preserve the live vector's box unless the spec also names a new size. */
export function applyVectorPath(node: VectorNode, paths: VectorPaths): void {
  const { width, height } = node;
  node.vectorPaths = paths;
  node.resize(width, height);
}

function buildPath(wn: BuiltNode, source: { paths: VectorPaths; scale?: number }, ctx: RenderCtx): any {
  const v: any = figma.createVector();
  figma.currentPage.appendChild(v);
  if (!wn.fills) v.fills = []; // omitted fill -> transparent, like the other primitives (no surprise default)
  // figma.createVector() seeds a new vector with a default black 1px stroke (createRectangle/Frame don't).
  // Clear it when the author passed no stroke, else a fill-only path renders silently outlined — a
  // surprise-default that breaks rect/frame parity and the "path is like a rect with no fill" mental model.
  if (!wn.strokes) v.strokes = [];
  try {
    v.vectorPaths = source.paths;
  } catch (e: any) {
    // Already normalized to Figma's absolute M/L/C/Q/Z subset at compile (compile-nodes.ts compilePath); reaching
    // here means the parser rejected something the normalizer emitted, so show what it actually sent.
    throw new Error('VECTOR: Figma could not parse the path data "' + source.paths.map(p => p.data).join(" ") + '" — ' + (e && e.message ? e.message : String(e)));
  }
  applyPaint(v, wn, ctx);
  applyLeafSize(v, wn.layout || {}, ctx.tokens);
  // AFTER the paths (which set the natural box) and after applyLeafSize (whose min/max bounds should
  // clamp the scaled size, and be reported when they do). resize, not rescale: strokeWidth/effects are
  // authored in the same breath and mean the number the author wrote, not that number times `scale`.
  if (source.scale !== undefined) {
    resizeWithDiagnostics(v, Math.max(v.width * source.scale, 0.01), Math.max(v.height * source.scale, 0.01));
  }
  return v;
}

// The createable allow-list AND the dispatch in one table — `Record<WriteType, …>` makes TS reject any
// createable type that lacks a builder (or a builder for a non-createable type), so the two can't drift.
// A type outside the table falls through to the loud error in buildNode.
const BUILDERS: Record<WriteType, (wn: BuiltNode, ctx: RenderCtx, enclosingWidthBounded?: boolean) => any> = {
  FRAME: (wn, ctx, bounded) => buildFrame(wn, ctx, bounded),
  TEXT: (wn, ctx) => buildText(wn, ctx),
  RECTANGLE: (wn, ctx) => buildShape(figma.createRectangle(), wn, ctx),
  ELLIPSE: (wn, ctx) => buildShape(figma.createEllipse(), wn, ctx),
  LINE: (wn, ctx) => buildLine(wn, ctx),
  VECTOR: (wn, ctx) => buildVector(wn, ctx),
  INSTANCE: (wn, ctx) => buildInstance(wn, ctx),
};

// Build one node and its subtree. Percent size/position is NOT resolved here — the node is built at a
// provisional size and attachBuiltChild records it on the span for the post-walk settleApplySpan pass (which
// needs the fully-assembled tree to read realized parent sizes). Returns the live node.
export function buildNode(wn: BuiltNode, ctx: RenderCtx, enclosingWidthBounded?: boolean): any {
  try { return buildCompiledNode(wn, ctx, enclosingWidthBounded); }
  catch (cause) {
    // Innermost wins: the deepest node that failed is the one the verb error should name. A nested
    // verb error (slot content, a placed live child) already names it, so it passes through too.
    if (cause instanceof NodeBuildError || cause instanceof MutatingVerbError || !wn.sourcePath) throw cause;
    throw new NodeBuildError(wn, wn.sourcePath, cause);
  }
}

function buildCompiledNode(wn: BuiltNode, ctx: RenderCtx, enclosingWidthBounded?: boolean): any {
  const build = own(BUILDERS, wn.type);
  if (!build) {
    throw new Error('flcm: cannot create a "' + wn.type + '" node — createable types are ' + Object.keys(BUILDERS).join(", ") + ".");
  }
  const node = build(wn, ctx, enclosingWidthBounded);
  if (wn.source) ctx.placedIds.set(wn.source, node.id);
  for (const prop of ["width", "height"] as const) {
    const authored = wn.ignoredSize?.[prop];
    // A `get` round-trip re-authors the read's own (pixel-rounded) size, so a match is no divergence.
    if (authored === undefined || (typeof authored === "number" && pixelRound(authored) === pixelRound(node[prop]))) continue;
    warnings.add({
      id: node.id, prop, authored, realized: node[prop],
      message: "A VECTOR path is bare geometry; " + prop + " was ignored. Use `scale` for uniform sizing, or `svg` with a viewBox for a sized canvas.",
    });
  }
  const lockedPath = wn.ignoredSize?.aspectRatio;
  if (lockedPath !== undefined) {
    // A path's box is its geometry, so a ratio can only be the one it already has: a paste-back's
    // own locks again, any other is ignored like width/height.
    if (typeof lockedPath === "number" && Math.abs(node.width / node.height - lockedPath) <= 0.01) node.lockAspectRatio();
    else warnings.add({
      id: node.id, prop: "aspectRatio", authored: lockedPath, realized: pixelRound(node.width / node.height),
      message: "A VECTOR path is bare geometry; aspectRatio was ignored. Its proportions are the path's own.",
    });
  }
  if (wn.layout?.aspectRatio !== undefined) ctx.span.ratios.push({ node, layout: wn.layout });
  applySceneProps(node, wn);
  if (wn.rotation) ctx.span.pivots.push({ node });
  applyAnnotations(node, wn.annotations);
  stampKey(node, wn, ctx);
  if (wn.componentPropertyReferences) {
    if (!ctx.bindings) {
      throw new Error(
        "flcm: a node in this tree carries `componentPropertyReferences`, and this verb has no declaring component behind it for the binding to point at — that is flcm.component, or an insert landing inside a component. " +
          "(The verb's prepare should have refused the tree; reaching the build walk is a bug.)",
      );
    }
    ctx.bindings.push({ node, refs: wn.componentPropertyReferences });
  }
  return node;
}

// The props every SceneNode carries (name/blendMode/rotation/visible/locked), applied once after the
// node is built and sized — never per-builder. Create reaches this through buildNode; edit drives it
// directly on a resolved target (this is the applier a GROUP/INSTANCE edit lands through — the
// non-createable subset is mostly these words).
export function applySceneProps(node: any, wn: WriteProps): void {
  if (typeof wn.name === "string") node.name = wn.name;
  // The value is already the Figma enum (parseBlendMode mapped the CSS spelling at the boundary).
  // The `in` guard: a SliceNode has no blendMode (no MinimalBlendMixin).
  if (typeof wn.blendMode === "string" && "blendMode" in node) node.blendMode = wn.blendMode;
  // The canonical (authored) rotation is CSS clockwise-positive, but Figma's raw `node.rotation` is
  // COUNTERclockwise-positive, so NEGATE on write: the read side negates Figma→CSS on emit
  // (figma-mcp), and a read value re-authored verbatim must not flip. Omitted at 0.
  // This native setter turns about the top-left; the apply span pivots it to the centre after
  // (pivot.ts, settlePivot).
  if (typeof wn.rotation === "number" && "rotation" in node) node.rotation = -wn.rotation;
  if (typeof wn.visible === "boolean") node.visible = wn.visible;
  if (typeof wn.locked === "boolean") node.locked = wn.locked;
}
