// bridge — the ONE mutation authority: every property lands on a live Figma node through the appliers
// here, whether the node was just built (the render walk below) or resolved as a live edit target.
// Every mutating verb drives these same exported appliers — never a parallel application path, so a
// paint compiled for create and for edit cannot diverge. It consumes ONLY the typed IR currency — it
// never sees a CSS string leaf and never imports css.ts; the boundary parsed everything into types
// upstream, so here a gap is already a number, a fill already a PaintSpec, an effect already an
// EffectSpec. The constructors in flcm.ts only build inert POJOs.
//
// Appliers touch only the fields PRESENT on their spec, and a `'prop' in node` guard skips only
// vocabulary a node KIND lacks (an ellipse has no cornerRadius). A Figma refusal on a field the node
// does carry THROWS — the plugin's own error names the setter — and the aftermath belongs to the
// mutating-verb scaffold (mutation-lock.ts, where the commit-then-undo rollback lands), never to a
// catch here. A deliberate skip must be a named, documented rule, never a swallowed catch.
//
// Nodes are typed `any` deliberately: the plugin typings model dozens of SceneNode variants, but the
// appliers cover a small additive vocabulary, so fighting the union with casts at every line would add
// noise without safety.

import { WriteType, WriteNode, WriteProps, WriteLayout, Justify, Align, TextAlign, TextDecoration, Sizing, Identity, Handle, PaintSpec, ImageSpec, namesFontIdentity } from "./ir.js";
import {
  assertLayoutRealizableForType, assertPercentResolvable, assertSizingResolvesAgainstParentFrame, assertNoParentRelativeWordsUnderGrid, ParentFlowFacts,
  assertTextFillHeightInFlow,
} from "./layout-legality.js";
import { toFigmaPaint } from "./paint.js";
import { toFigmaEffects } from "./effects.js";
import { resolveFont, resolveFontStrict, FontMap } from "./fonts.js";
import { normalizePathData } from "./path.js";
import { writeKey, identityOf } from "./identity.js";
import { pixelRound, convertSizing } from "@framelink/core";

// The resource half of the walk context — what an applier resolves against, split out so an exported
// applier demands only what it reads: `fonts` is the preloaded FontMap, `images` the url → base64 map
// of bytes the server fetched+validated (an image PaintSpec resolves to a plugin ImagePaint against
// it). An edit caller supplies these for a live target without fabricating walk state.
export interface RenderResources {
  fonts: FontMap;
  images: Record<string, string>;
}

// The full walk context: resources plus render-only accumulation. `pending` collects every
// percent/anchor child during the walk, resolved in one post-walk pass once the tree's fill/hug sizes
// have settled (see resolvePercents). `keyed` collects LIVE NODES, not Handles: nothing about a node's
// geometry is trustworthy mid-walk (see settleHandles), so handles are minted in one pass after the
// walk instead of stamped and then patched.
export interface RenderCtx extends RenderResources {
  keyed: Record<string, any>;
  pending: PendingResolve[];
}

// A deferred percent/anchor resolution: the built (provisional) child node, its RAW layout (percent intent
// intact), and its live parent. Collected during the walk and applied in resolvePercents after the whole
// tree is assembled — the only point at which `parent`'s realized fill/hug size is readable off the canvas.
interface PendingResolve { node: any; layout: WriteLayout; parent: any }

// The ONE terse-intent -> plugin-enum maps (the IR carries terse intent; this is the single place it's
// resolved). `stretch` is absent from ALIGN by design: Figma has no container-level cross-stretch enum, so
// we SYNTHESIZE CSS's `align-items: stretch` per-child instead (see applyChildFill's crossStretch path) —
// each auto-sized child gets layoutAlign STRETCH on the parent's counter axis. Absorbing that divergence
// in code (not documenting it as a footgun) is exactly ADR-0003's contract.
const JUSTIFY: Record<Justify, string> = { start: "MIN", center: "CENTER", end: "MAX", between: "SPACE_BETWEEN" };
const ALIGN: Partial<Record<Align, string>> = { start: "MIN", center: "CENTER", end: "MAX" };
const TEXT_ALIGN: Record<TextAlign, "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED"> = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFIED" };
// CSS text-decoration-line → Figma's TextDecoration enum. "none" is the enum's own NONE, used by a
// per-run inverse override that clears an inherited base decoration.
const DECORATION: Record<TextDecoration, "UNDERLINE" | "STRIKETHROUGH" | "NONE"> = { underline: "UNDERLINE", "line-through": "STRIKETHROUGH", none: "NONE" };
// The author's vertical-alignment words → Figma's enum. Node-level only (no setRange* counterpart),
// unlike every other text word here — see WriteTextStyle.textAlignVertical.
const VERTICAL_ALIGN: Record<"top" | "center" | "bottom", "TOP" | "CENTER" | "BOTTOM"> = { top: "TOP", center: "CENTER", bottom: "BOTTOM" };

// The frame layoutModes that place their own children — the plugin-side spelling of the core's hasAutoLayout.
const AUTO_LAYOUT_MODES = ["HORIZONTAL", "VERTICAL", "GRID"];

// The one write-side answer to "does this node lay out flow children along an axis pair?"
// (layoutGrow/layoutAlign, primary/counter sizing modes, ABSOLUTE lifting). GRID is deliberately
// OUTSIDE: it has no authoring word, so create never produces it, and the edit context matrix hasn't
// assigned its cells — when it does, this predicate is where the rule lands, not six inlined
// comparisons. AUTO_LAYOUT_MODES above differs on purpose: for read-side geometry a GRID parent DOES
// place its children, so left/top stay omitted.
function isRowColumnAutoLayout(node: any): boolean {
  return node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL";
}

// A node's geometry in the read verbs' spelling (ir.Handle). width/height are the measured px, rounded the
// way the core rounds every number it emits so both producers hand the agent one currency. left/top (and
// the `position` marker) are emitted ONLY when the parent's auto-layout doesn't already place the node —
// the exact rule read.projectSlim inherits from core's NodeGeometry (isInAutoLayoutFlow). A page child gets
// neither: its parent has no box to be relative to, so the coordinates would be canvas trivia.
//
// The numbers are the node's OWN geometry — width/height exclude rotation (relativeTransform has unit axes,
// so a rotated node's size is unchanged) and x/y are its container-parent offset. That is also what the read
// side means by width/height/left/top, so a 40px-wide rect rotated 15° reads back 40 wide and writes back
// 40 wide. The page-space AABB (44.85 for that rect) belongs to neither side: read carries it separately on
// the snapshot for the questions that genuinely want a page-space box.
//
// That container-parent offset is the raw node.x/node.y, which Figma states relative to the nearest FRAME
// and NOT to an intervening GROUP — where the read side subtracts the group's own corner instead. The two
// can't disagree here: every node render creates enters the doc on the page and is reparented only into a
// frame render built itself, so a minted handle never has a group above it. find/get take their left/top
// from the core's simplified spec (read.projectSlim), which is already the group-aware answer.
function geometryOf(node: any): Omit<Handle, keyof Identity> {
  const geometry: Omit<Handle, keyof Identity> = { width: pixelRound(node.width), height: pixelRound(node.height) };
  const intent = intentOf(node);
  if (intent) geometry.intent = intent;
  const parent = node.parent;
  const parentPlacesIt = !!parent && AUTO_LAYOUT_MODES.indexOf(parent.layoutMode) !== -1 && node.layoutPositioning !== "ABSOLUTE";
  if (parent && parent.type !== "PAGE" && !parentPlacesIt) {
    if (node.layoutPositioning === "ABSOLUTE") geometry.position = "absolute";
    geometry.left = pixelRound(node.x);
    geometry.top = pixelRound(node.y);
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
export function settleHandles(root: any, keyed: Record<string, any>): { node: Handle; keyed: Record<string, Handle> } {
  const handles: Record<string, Handle> = {};
  for (const key of Object.keys(keyed)) handles[key] = mintHandle(keyed[key]);
  return { node: mintHandle(root), keyed: handles };
}

function stampKey(node: any, wn: WriteNode, ctx: RenderCtx): void {
  if (typeof wn.key !== "string") return;
  // No verb name: the same walk runs under render AND under every structural insert verb, and
  // naming the wrong one sends the agent looking at a call it didn't make.
  if (wn.key in ctx.keyed) throw new Error('flcm: duplicate key "' + wn.key + '" — keys must be unique within one call.');
  writeKey(node, wn.key);
  ctx.keyed[wn.key] = node;
}

// Resolve one PaintSpec to a plugin Paint. An image spec needs raster BYTES (render() awaited them from
// the server mid-run into ctx.images, keyed by url) turned into an imageHash via figma.createImage — a
// figma.* call, so it lives HERE in the bridge, not in the figma-free paint.ts. Every other spec maps purely.
function paintOf(spec: PaintSpec, ctx: RenderResources): Paint {
  if (spec.kind === "image") return imagePaint(spec, ctx);
  return toFigmaPaint(spec);
}

function imagePaint(spec: ImageSpec, ctx: RenderResources): Paint {
  // A hash-backed spec names bytes the document already holds (a read-form fill rebuilt through the
  // constructors), so there is nothing to fetch and nothing to create — the paint just points at it.
  if ("hash" in spec) {
    return spec.scalingFactor != null
      ? { type: "IMAGE", scaleMode: spec.scaleMode, imageHash: spec.hash, scalingFactor: spec.scalingFactor }
      : { type: "IMAGE", scaleMode: spec.scaleMode, imageHash: spec.hash };
  }
  const b64 = ctx.images[spec.url];
  if (typeof b64 !== "string") {
    // render() collects and awaits every image url before any node is built, so the bytes are always
    // present here. A miss means collectImageUrls missed a paint site paintOf resolves (the lockstep
    // warning on collectImageUrls) — fail loud rather than paint a blank fill.
    throw new Error('flcm.image: no fetched bytes for "' + spec.url + '" — the image was not resolved before render.');
  }
  const img = figma.createImage(figma.base64Decode(b64));
  return { type: "IMAGE", scaleMode: spec.scaleMode, imageHash: img.hash };
}

// Persist an image fill's source + placeholder flag on the node (pluginData) so a later read/codegen pass
// can tell a stand-in from a real asset and recover its src — the one content case whose semantics don't
// survive geometry alone. Only the fill (a node's background) is recorded; an image stroke is exotic.
function stampImageData(node: any, wn: WriteProps): void {
  if (!wn.fills) return; // no fill in this write — whatever provenance exists still describes the live paint
  const fill = wn.fills[0];
  if (!fill || fill.kind !== "image" || !("url" in fill)) {
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
// kind lacks (an ellipse has no cornerRadius). v1 still paints a single fill/stroke. Creation defaults
// (omitted fill -> transparent) live in the builders, NOT here — so an edit patch through this applier
// can never turn key-absence into a write.
export function applyPaint(node: any, wn: WriteProps, ctx: RenderResources): void {
  // A PRESENT-but-empty array is the compiled removal word ("none") — write the clear; skipping
  // empties would make removal an unspeakable intent (the ADR-0003 silent no-op).
  if (wn.fills) node.fills = wn.fills.length ? [paintOf(wn.fills[0], ctx)] : [];
  if (wn.strokes) node.strokes = wn.strokes.length ? [paintOf(wn.strokes[0], ctx)] : [];
  if (wn.strokeWeight != null && "strokeWeight" in node) node.strokeWeight = wn.strokeWeight;
  if (wn.strokeAlign != null && "strokeAlign" in node) node.strokeAlign = wn.strokeAlign;
  if (wn.borderRadius != null && "cornerRadius" in node) node.cornerRadius = wn.borderRadius;
  if (wn.effects && "effects" in node) node.effects = toFigmaEffects(wn.effects);
  // The `in` guard matters for edit targets: a SliceNode carries no MinimalBlendMixin at all.
  if (typeof wn.opacity === "number" && "opacity" in node) node.opacity = wn.opacity;
  if (typeof wn.clip === "boolean" && "clipsContent" in node) node.clipsContent = wn.clip;
  stampImageData(node, wn);
}

// Layout mode + container props. The mode applies when PRESENT — including "none", which switches
// auto-layout OFF (children convert per Figma's own semantics; canvas is truth). The container props
// (gap/pad/justify/align) gate on the LIVE mode, not the spec's: a delta naming only `gap` lands on
// an already-auto frame instead of silently skipping — spec-gating was create-only truth.
function applyContainer(f: any, layout: WriteLayout): void {
  const mode = layout.mode;
  if (mode === "row" || mode === "column") {
    const next = mode === "row" ? "HORIZONTAL" : "VERTICAL";
    // Any direction-establishing write — row↔column flip, or NONE→row/column over children still
    // carrying marks from an earlier auto-layout life — re-aims the stored flow marks: layoutGrow
    // and STRETCH keep meaning "primary"/"counter", and those axes just moved. Clear BOTH under the
    // OLD mode before the write. A stated rule, not a derivation; create never triggers it (a
    // fresh frame has no children when its mode is set).
    if (f.layoutMode !== next) clearContainerFlowMarks(f);
    f.layoutMode = next;
  } else if (mode === "none") f.layoutMode = "NONE";
  if (!isRowColumnAutoLayout(f)) return; // gap/pad/align are inert without auto-layout
  if (layout.gap != null) f.itemSpacing = layout.gap;
  if (layout.padding) {
    const e = layout.padding;
    f.paddingTop = e.top; f.paddingRight = e.right; f.paddingBottom = e.bottom; f.paddingLeft = e.left;
  }
  // Unrealizable justify words are rejected at the constructor gate (flcm.ts mapCssWord), so
  // JUSTIFY is total over everything that can arrive here.
  if (layout.justifyContent) f.primaryAxisAlignItems = JUSTIFY[layout.justifyContent];
  if (layout.alignItems) {
    // "stretch" has no counterAxisAlignItems enum — it's synthesized per-child (see the walk).
    // Writing any OTHER value clears every child mark: container-stretch intent is never stored
    // (not by Figma, not by us), so "was stretch" is unknowable and the clear is unconditional.
    if (layout.alignItems === "stretch") setContainerStretchMarks(f);
    else {
      clearContainerStretchMarks(f);
      if (ALIGN[layout.alignItems]) f.counterAxisAlignItems = ALIGN[layout.alignItems];
    }
  }
}

// The edit-side semantics of alignItems:"stretch" — create synthesizes the per-child marks at build
// (applyChildFill's crossStretch), so at create time this walks zero children and the per-child path
// does the work; at edit time the children exist and this re-synthesizes over them. Setting marks
// EVERY in-flow child (a child that must keep a fixed counter size gets its own fixed edit after) —
// Figma state cannot distinguish a container-stretched child from one that asked for counter-axis
// fill (create deliberately routes both through fillDim), so the rule is stated, not derived. The
// hug-beats-stretch pin fillDim installs on a child whose own primary axis is the parent's counter
// axis is set alongside.
function setContainerStretchMarks(f: any): void {
  const pIsRow = f.layoutMode === "HORIZONTAL";
  for (const child of f.children || []) {
    if (child.layoutPositioning === "ABSOLUTE") continue;
    child.layoutAlign = "STRETCH";
    if (isRowColumnAutoLayout(child) && (child.layoutMode === "HORIZONTAL") !== pIsRow) child.primaryAxisSizingMode = "FIXED";
  }
}

// The inverse under the SAME stated rule: a non-stretch alignItems clears EVERY counter-axis
// STRETCH mark (container-stretch intent is never stored, so "was stretch" is unknowable), and
// lifts the crossing-child hug-beats-stretch pin it installed. ABSOLUTE children included —
// unlike the SET walk, which skips them (stretch never governs out-of-flow), the CLEAR must reach
// a mark parked on an absolute child, or position:"none" later resurrects a stretch the container
// no longer asks for.
function clearContainerStretchMarks(f: any): void {
  const pIsRow = f.layoutMode === "HORIZONTAL";
  for (const child of f.children || []) {
    if (child.layoutAlign !== "STRETCH") continue;
    child.layoutAlign = "INHERIT";
    if (isRowColumnAutoLayout(child) && (child.layoutMode === "HORIZONTAL") !== pIsRow) child.primaryAxisSizingMode = "AUTO";
  }
}

// Direction-change cleanup (see applyContainer's mode write): both flow marks — layoutGrow along
// the old primary AND STRETCH along the old counter — go, on EVERY child, ABSOLUTE ones included:
// a mark parked on an out-of-flow child is inert now but would rejoin the flow via position:"none"
// meaning the NEW direction's axis. The crossing-child pin is lifted only when the OLD mode names
// a real direction; under NONE that FIXED is indistinguishable from an authored fixed size, so it
// stays (the same live-state ambiguity that makes the stretch rules stated, not derived).
function clearContainerFlowMarks(f: any): void {
  const oldIsAuto = isRowColumnAutoLayout(f);
  const pIsRow = f.layoutMode === "HORIZONTAL";
  for (const child of f.children || []) {
    child.layoutGrow = 0;
    if (child.layoutAlign !== "STRETCH") continue;
    child.layoutAlign = "INHERIT";
    if (oldIsAuto && isRowColumnAutoLayout(child) && (child.layoutMode === "HORIZONTAL") !== pIsRow) child.primaryAxisSizingMode = "AUTO";
  }
}

// Own-axis sizing, applied AFTER children so a `hug` axis measures real content. Maps the IR's
// sizing/dimensions onto the plugin's primary/counter sizing modes (which axis is which depends on the
// frame's own direction) and resizes the fixed axes. Direction comes from the LIVE node, not the spec:
// at create time applyContainer already set layoutMode so the two agree, and an edit delta naming only
// sizing carries no mode at all. Presence-preserving per axis — an axis the spec doesn't name keeps
// its live sizing mode; the fresh-frame hug default is the BUILDER's to inject (see buildFrame).
function applyOwnSize(f: any, layout: WriteLayout): void {
  const sizing = layout.sizing || {};
  const dims = layout.dimensions || {};
  const isAuto = isRowColumnAutoLayout(f);

  if (isAuto) {
    const isRow = f.layoutMode === "HORIZONTAL";
    const setMode = function (val: any, isWidth: boolean) {
      if (val == null) return; // axis not named — leave the live mode alone
      if (val === "fill") return; // resolved by the parent against its own axis
      const isPrimary = isWidth === isRow;
      f[isPrimary ? "primaryAxisSizingMode" : "counterAxisSizingMode"] = val === "fixed" ? "FIXED" : "AUTO";
    };
    setMode(sizing.horizontal, true);
    setMode(sizing.vertical, false);
  }

  // Auto frames resize only their FIXED axes (fill/hug are computed by layout); a non-auto frame honors
  // any authored dimension — including one carried in from a `get` result without a sizing intent.
  const fixedW = isAuto ? sizing.horizontal === "fixed" : typeof dims.width === "number";
  const fixedH = isAuto ? sizing.vertical === "fixed" : typeof dims.height === "number";
  if (fixedW || fixedH) {
    const w = fixedW && typeof dims.width === "number" ? dims.width : f.width;
    const h = fixedH && typeof dims.height === "number" ? dims.height : f.height;
    f.resize(Math.max(w, 0.01), Math.max(h, 0.01));
  }
}

// Resolve a NON-absolute child's `fill` intent against the parent's axis. Along the parent's primary
// axis -> layoutGrow; along its counter axis -> layoutAlign STRETCH. The non-obvious part: if the
// filled dimension is the CHILD's own primary axis, the child hugs its content there and hug WINS over
// STRETCH — so the child's primaryAxisSizingMode must be pinned FIXED or the fill silently still hugs.
// (Grounded live in the prior spike; preserved here.)
// PRECONDITION the caller routes, this function trusts: `parent` is a row/column auto-layout frame.
// A free-form parent's children take coverChild + applyConstraints instead (that's the class split
// buildFrame walks and edit re-derives); called with a free-form parent the flow props land inert.
// `crossStretch` is a parameter because container-level stretch intent is never stored — not by
// Figma, not by us — so only the caller knows it (create reads the authored alignItems; edit's
// stretch child-walk passes its own verdict).
function applyChildFill(parent: any, child: any, layout: WriteLayout, crossStretch: boolean): void {
  const s = layout.sizing || {};
  const pIsRow = parent.layoutMode === "HORIZONTAL";
  const fillDim = function (dim: string) {
    const alongPrimary = (dim === "width") === pIsRow;
    if (alongPrimary) child.layoutGrow = 1;
    else child.layoutAlign = "STRETCH";
    if (isRowColumnAutoLayout(child)) {
      const childIsRow = child.layoutMode === "HORIZONTAL";
      if ((dim === "width") === childIsRow) child.primaryAxisSizingMode = "FIXED";
    }
  };
  if (s.horizontal === "fill") fillDim("width");
  if (s.vertical === "fill") fillDim("height");
  // Container alignItems:"stretch" = CSS align-items:stretch. Stretch each child on the parent's COUNTER axis
  // unless the child sets its own counter-axis size (fixed) or already fills it (handled above). Routes
  // through the SAME fillDim path (STRETCH + the hug-wins primary-axis pin), so a stretched child behaves
  // identically to one that asked for counter-axis fill — the divergence is absorbed, not documented.
  if (crossStretch) {
    const counterDim = pIsRow ? "height" : "width";
    const counterSizing = pIsRow ? s.vertical : s.horizontal;
    if (counterSizing !== "fixed" && counterSizing !== "fill") fillDim(counterDim);
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
  if (isRowColumnAutoLayout(child)) {
    const isRow = child.layoutMode === "HORIZONTAL";
    if (s.horizontal === "fill") child[isRow ? "primaryAxisSizingMode" : "counterAxisSizingMode"] = "FIXED";
    if (s.vertical === "fill") child[isRow ? "counterAxisSizingMode" : "primaryAxisSizingMode"] = "FIXED";
  }
  const cw = s.horizontal === "fill" ? parent.width : child.width;
  const ch = s.vertical === "fill" ? parent.height : child.height;
  // A LINE's height is exactly 0 by Figma contract — resize throws on anything else [verified,
  // plugin-typings 1.133] — so the 0.01 floor (there to keep degenerate fills from the resize(0)
  // throw on area nodes) must not touch it: w:"fill" on a line is a legal full-width rule. Vertical
  // fill on a line can't be authored (LineSchema has no height word), so no rule is needed for it.
  child.resize(Math.max(cw, 0.01), child.type === "LINE" ? 0 : Math.max(ch, 0.01));
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
  if (isRowColumnAutoLayout(parent)) child.layoutPositioning = "ABSOLUTE";
  if (typeof layout.left === "number") child.x = layout.left;
  if (typeof layout.top === "number") child.y = layout.top;
}

// Figma's per-axis constraint enum keyed by the author's directional `pin` (ir.ts PinX/PinY). Two maps
// because the axis-neutral words (center/stretch/scale) sit alongside axis-specific edges (left/right on x,
// top/bottom on y). This terse→enum mapping is the bridge's to own, like JUSTIFY/ALIGN above.
// "none" → MIN: clearing a pin restores Figma's default (near-edge). The auto-derived constraint
// create chose isn't stored anywhere live, so the default is the stated inverse, not a recovery.
const PIN_H: Record<string, string> = { left: "MIN", center: "CENTER", right: "MAX", stretch: "STRETCH", scale: "SCALE", none: "MIN" };
const PIN_V: Record<string, string> = { top: "MIN", center: "CENTER", bottom: "MAX", stretch: "STRETCH", scale: "SCALE", none: "MIN" };

// Derive one axis's Figma constraint from the child's ORIGINAL size/position intent, so a resized free-form
// parent reflows it sensibly: fill→STRETCH (grows with the parent), a percent size→SCALE (scales
// proportionally), a percent absolute position→CENTER (holds its relative spot), else MIN (pinned to the
// leading edge — Figma's default). An explicit `pin` wins over the derived choice.
function axisConstraint(sizing: Sizing | undefined, percentSize: number | undefined, percentPos: number | undefined, pinDir: string | undefined, pinMap: Record<string, string>): string {
  if (pinDir != null) return pinMap[pinDir]; // validated at the flcm boundary
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
// though the live node has already been resized to a fixed px by resolvePercents.
function applyConstraints(child: any, rawLayout: WriteLayout | undefined): void {
  if (!("constraints" in child)) return; // an exotic node without the constraint mixin
  const l = rawLayout || {};
  const sizing = l.sizing || {};
  const pSize = l.percentSize || {};
  const pPos = l.percentPos || {};
  const pin = l.pin || {};
  child.constraints = {
    horizontal: axisConstraint(sizing.horizontal, pSize.width, pPos.x, pin.x, PIN_H),
    vertical: axisConstraint(sizing.vertical, pSize.height, pPos.y, pin.y, PIN_V),
  };
}

// Edit-side constraint delta, presence-preserving per axis: applyConstraints above derives and
// writes BOTH axes from create-time intent, so an edit naming only pin.x would silently reset
// pin.y — this reads the untouched axis and re-writes it unchanged instead.
// Deliberately NEVER re-derives constraints from a delta's size/position words the way create's
// applyConstraints does (fill→STRETCH, "N%"→SCALE): a live node may carry an authored pin, and a
// width edit that silently rewrote it would clobber intent the delta never spoke. Under edit,
// only an explicit `pin` word touches constraints.
function applyPinDelta(child: any, pin: NonNullable<WriteLayout["pin"]>): void {
  if (!("constraints" in child)) return; // an exotic node without the constraint mixin
  const cur = child.constraints;
  child.constraints = {
    horizontal: pin.x != null ? PIN_H[pin.x] : cur.horizontal,
    vertical: pin.y != null ? PIN_V[pin.y] : cur.vertical,
  };
}

// The unset inverse of applyChildFill — create only ever SETS the flow-fill marks, so edit adds the
// deliberate reverse: an axis explicitly re-sized to fixed/hug clears the mark fill installed there
// (layoutGrow along the parent's primary axis, layoutAlign STRETCH on its counter), or the old fill
// keeps governing and the new size is a lie. The hug-beats-stretch primary-axis pin fillDim
// installed is NOT lifted here — applyOwnSize runs after and maps the named axis's sizing onto the
// child's own mode, which is exactly that lift. Presence-preserving: only axes the delta names.
function clearChildFlowFill(parent: any, child: any, layout: WriteLayout): void {
  const s = layout.sizing || {};
  const pIsRow = parent.layoutMode === "HORIZONTAL";
  const clearDim = (dim: "width" | "height", val: Sizing | undefined): void => {
    if (val !== "fixed" && val !== "hug") return;
    if ((dim === "width") === pIsRow) child.layoutGrow = 0;
    else if (child.layoutAlign === "STRETCH") child.layoutAlign = "INHERIT";
  };
  clearDim("width", s.horizontal);
  clearDim("height", s.vertical);
}

// THE sizing home for leaf nodes (no own auto-layout) — create's builders and edit's delta path
// both land here, so the per-kind rules can't fork: TEXT's wrap handshake (a controlled width
// wraps; "hug" restores grow-sideways) and LINE's zero height. Generic shapes resize only the
// named dims, floored at Figma's 0.01. The TEXT branch reads no height ON PURPOSE: an authored TEXT height rejects upstream
// (layout-legality.ts assertLayoutRealizableForType, consulted by buildLayout and edit alike),
// so none reaches here; the branch shape just makes ignoring it structural.
function applyLeafSize(node: any, layout: WriteLayout): void {
  const sizing = layout.sizing || {};
  const dims = layout.dimensions || {};
  if (node.type === "TEXT") {
    if (sizing.horizontal === "fixed" || sizing.horizontal === "fill") node.textAutoResize = "HEIGHT";
    else if (sizing.horizontal === "hug") node.textAutoResize = "WIDTH_AND_HEIGHT";
    if (typeof dims.width === "number") node.resize(Math.max(dims.width, 0.01), node.height);
    return;
  }
  if (node.type === "LINE") {
    if (typeof dims.width === "number") node.resize(Math.max(dims.width, 0.01), 0);
    return;
  }
  if (typeof dims.width === "number" || typeof dims.height === "number") {
    node.resize(Math.max(typeof dims.width === "number" ? dims.width : node.width, 0.01),
                Math.max(typeof dims.height === "number" ? dims.height : node.height, 0.01));
  }
}

// (The layout legality rules — percent-hug cycle, page-parent fill/percent, TEXT fill-height,
// per-type realizability — live in layout-legality.ts, the one home both verbs consult.)

// Post-walk pass: fold every collected percent size / percent position / anchor into concrete pixels
// against each parent's REALIZED size. Runs after the whole tree is built and appended, so a `fill`/`hug`
// parent's size is finally readable off the canvas (the ordering hazard: doing this at walk time would
// predate the fill/hug pin and reintroduce the unknown-parent-size problem this replaces). Ancestor-first
// (shallowest depth first) so a percent child of a percent parent reads its parent's already-resolved px.
export function resolvePercents(ctx: RenderCtx): void {
  ctx.pending.sort((a, b) => depthOf(a.node) - depthOf(b.node));
  for (const p of ctx.pending) resolvePercentLayout(p.parent, p.node, p.layout);
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

// Fold one child's percent size / percent position / anchor into concrete pixels against its parent's
// realized size. Render calls this through the deferred resolvePercents pass above; the edit path
// calls it directly — at edit time the parent's realized size already exists, so there is no deferral
// to ride. Parameter order matches the sibling child-appliers (parent, child, layout).
function resolvePercentLayout(parent: any, child: any, layout: WriteLayout): void {
  resolvePercentSize(parent, child, layout);
  resolvePercentPosition(parent, child, layout);
}

// The SIZE half — it PRODUCES geometry, so it runs before anything that measures.
function resolvePercentSize(parent: any, child: any, layout: WriteLayout): void {
  if (layout.percentSize) {
    const ps = layout.percentSize;
    const w = ps.width != null ? pctOf(ps.width, parent.width) : child.width;
    const h = ps.height != null ? pctOf(ps.height, parent.height) : child.height;
    // A text node ignores a width resize while it auto-sizes width (WIDTH_AND_HEIGHT) — it would just keep
    // hugging its content. Mirror buildText's fixed-width handshake so a percent-width text wraps at the
    // resolved width (height auto-fits) instead of silently dropping the percent (ADR-0003 silent-wrong).
    if (child.type === "TEXT" && ps.width != null) child.textAutoResize = "HEIGHT";
    child.resize(Math.max(w, 0.01), Math.max(h, 0.01));
  }
}

// The POSITION half — it CONSUMES geometry (the parent's realized size, and the node's own for the
// anchor shift), so it runs last of everything.
function resolvePercentPosition(parent: any, child: any, layout: WriteLayout): void {
  // POSITION + ANCHOR — absolute children only (percentPos/anchor never set otherwise). Resolve each axis
  // (percent → px against the parent, else the authored number), then shift by the anchor so the child's
  // anchor point (not its top-left) lands on x/y. STRICTLY per axis: an axis with no authored coordinate
  // is never touched — anchoring off the LIVE coordinate would subtract the offset again on every
  // re-apply (the relative-delta drift the absolute-values contract forbids), and applyAbsolute rejects
  // an anchor axis without its coordinate for the same reason.
  if (layout.position === "absolute" && (layout.percentPos || layout.anchor)) {
    const pp = layout.percentPos || {};
    const a = layout.anchor || {};
    if (pp.x != null || layout.left != null) {
      let x = pp.x != null ? pctOf(pp.x, parent.width) : layout.left!;
      if (a.x === "center") x -= child.width / 2;
      else if (a.x === "right") x -= child.width;
      child.x = x;
    }
    if (pp.y != null || layout.top != null) {
      let y = pp.y != null ? pctOf(pp.y, parent.height) : layout.top!;
      if (a.y === "center") y -= child.height / 2;
      else if (a.y === "bottom") y -= child.height;
      child.y = y;
    }
  }
}

// Apply a layout delta to a LIVE node the way the create walk applies a fresh child — the SAME
// appliers in the same roles, re-run against the live parent. Order matters and mirrors buildFrame's
// walk: container words first (they may change the node's own direction, which own-size mapping
// reads), then position (in/out of flow decides which appliers govern the node), flow fills and
// their unset inverses, own/leaf sizing, cover, pin. The percent/anchor tail is
// settleLiveNodePercentSize/Position, deliberately NOT called here — both measure, so the caller
// owns when they run (see those functions).
export function applyLiveNodeLayout(node: any, wl: WriteLayout): void {
  const parent = node.parent;
  applyContainer(node, wl);
  if (!parent) return; // a parentless node (the page itself can't get here) has no child-side context
  const parentIsAuto = isRowColumnAutoLayout(parent);
  // Un-fill BEFORE the position write, and regardless of the child's CURRENT positioning: an axis
  // the delta re-sizes to fixed/hug must lose the grow/stretch mark fill installed there, even when
  // the mark sits parked and inert on an absolute child — otherwise `width: 80` on it (or
  // `{ position: "none", width: 80 }` in one delta) leaves the mark to resurrect the fill the delta
  // explicitly replaced. Clearing an inert mark is free; clearChildFlowFill touches only named axes.
  if (parentIsAuto) clearChildFlowFill(parent, node, wl);
  applyChildPosition(parent, node, wl);
  const inFlowAuto = parentIsAuto && node.layoutPositioning !== "ABSOLUTE";
  if (inFlowAuto) {
    applyChildFill(parent, node, wl, false); // crossStretch is the container's own alignItems edit, never a child's
  }
  if (isRowColumnAutoLayout(node) || node.type === "FRAME") applyOwnSize(node, wl);
  else applyLeafSize(node, wl);
  if (!inFlowAuto) coverChild(parent, node, wl);
  if (wl.pin) applyPinDelta(node, wl.pin);
}

/**
 * The two halves of a live layout delta's percent/anchor tail, split out so a verb can order them
 * across MORE than one node. Everything that resolves a percent or an anchor is a measurement, and
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

export function settleLiveNodePercentPosition(node: any, wl: WriteLayout): void {
  if (node.parent && (wl.percentPos || wl.anchor)) resolvePercentPosition(node.parent, node, wl);
}

// The live-parent facts assertPercentResolvable needs (create computes them from the authored
// spec; edit reads them off the canvas). EFFECTIVE sizing (layoutSizing*), not the internal axis
// modes: an AUTO-mode axis that the grandparent stretches reports FILL — the parent's size is
// realized from above, the child's percent resolves against it, and no cycle exists. Reading
// primary/counterAxisSizingMode here would reject that valid case as a hug.
function parentHugFacts(parent: any): ParentFlowFacts {
  const parentIsAuto = !!parent && isRowColumnAutoLayout(parent);
  if (!parentIsAuto) return { parentIsAuto: false, hugW: false, hugH: false };
  return {
    parentIsAuto,
    hugW: convertSizing(parent.layoutSizingHorizontal) === "hug",
    hugH: convertSizing(parent.layoutSizingVertical) === "hug",
  };
}

// Every parent-side fact the shared layout rules consult, gathered into one value. It exists
// because the parent a child is judged against is not always the parent on the canvas: inside a
// batch the SAME call may be changing that parent, and the entries must be legal against the
// canvas the batch is creating, not the one it found.
export interface ParentLayoutFacts extends ParentFlowFacts { isGrid: boolean; isPage: boolean }

function liveParentLayoutFacts(parent: any): ParentLayoutFacts {
  return {
    ...parentHugFacts(parent),
    isGrid: !!parent && parent.layoutMode === "GRID",
    isPage: !!parent && parent.type === "PAGE",
  };
}

// Every layout delta the current verb is applying, by node id. A batch hands the WHOLE map rather
// than one parent's delta because the projection below has to reach the grandparent: a container's
// direction write clears its children's flow marks, so whether a parent's `fill` survives is the
// grandparent's answer, not the parent's.
export type BatchLayoutDeltas = Record<string, WriteLayout>;

// A container's direction as the layout vocabulary spells it. GRID reads "none" on purpose: the
// vocabulary can only say none/row/column, so any authored mode replaces a grid outright.
function liveDirectionWord(f: any): "row" | "column" | "none" {
  if (!f) return "none";
  return f.layoutMode === "HORIZONTAL" ? "row" : f.layoutMode === "VERTICAL" ? "column" : "none";
}

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
  const parentIsAuto = parentDelta.mode != null ? parentDelta.mode !== "none" : live.parentIsAuto;
  const sizing = parentDelta.sizing || {};
  // Does the delta ESTABLISH a direction (off→row/column, or a row↔column flip)? Then the live
  // effective sizing is the wrong reading for an axis the delta doesn't name, in the one direction
  // that matters: it was measured under the OLD direction. A free-form frame reports "hugs nothing"
  // (nothing hugs off auto-layout) while its primary/counterAxisSizingMode sit at Figma's AUTO
  // default — so the instant `mode:"row"` lands it hugs BOTH axes, and a sibling entry's percent
  // against it is the cycle assertPercentResolvable exists to name. Same swap on a row↔column flip:
  // the axis each raw mode governs moves with the direction.
  const establishesDirection = parentIsAuto && parentDelta.mode != null && parentDelta.mode !== liveDirectionWord(parent);
  const nextIsRow = parentDelta.mode != null ? parentDelta.mode === "row" : parent.layoutMode === "HORIZONTAL";
  // A fill is a MARK on the parent, honored by the grandparent's flow — so a grandparent whose own
  // delta re-aims that flow (any direction change: applyContainer clears every child's flow marks,
  // and "none" leaves them parked and inert) stops honoring it, and the parent falls back to its
  // raw axis mode. Read from the batch, not the canvas, or the carve-out below saves a parent the
  // batch is about to un-fill.
  const grandparent = parent ? parent.parent : null;
  const grandparentDelta = grandparent && deltas ? deltas[grandparent.id] : undefined;
  const fillSurvives =
    !grandparentDelta || grandparentDelta.mode == null || grandparentDelta.mode === liveDirectionWord(grandparent);
  const unnamedAxisHugs = function (isWidth: boolean): boolean {
    if (!parentIsAuto) return false; // hug is meaningless off auto-layout
    // The live effective reading holds unless the batch invalidates what produced it — either the
    // parent's own direction moved (so each raw mode governs a different axis now) or its fill
    // stopped being honored. Then read the raw modes, exactly as applyOwnSize will.
    if (!establishesDirection && fillSurvives) return isWidth ? live.hugW : live.hugH;
    // Fill is realized from ABOVE, so where it survives it still isn't a hug (the same case
    // parentHugFacts reads effective sizing for).
    if (fillSurvives && convertSizing(parent[isWidth ? "layoutSizingHorizontal" : "layoutSizingVertical"]) === "fill") return false;
    const isPrimary = isWidth === nextIsRow;
    return parent[isPrimary ? "primaryAxisSizingMode" : "counterAxisSizingMode"] === "AUTO";
  };
  return {
    isPage: live.isPage, // a props-only delta never reparents
    // Any authored mode replaces GRID: the vocabulary can only spell none/row/column.
    isGrid: live.isGrid && parentDelta.mode == null,
    parentIsAuto,
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
  parent: ParentLayoutFacts, nodeType: string, wl: WriteLayout, isContainer: boolean, isOutOfFlow: boolean, subject: string,
): void {
  if (parent.isPage) {
    assertSizingResolvesAgainstParentFrame(wl, false, subject);
  }
  assertLayoutRealizableForType(nodeType, wl, isContainer, subject);
  assertTextFillHeightInFlow(nodeType, wl, parent.parentIsAuto, isOutOfFlow, subject);
  assertNoParentRelativeWordsUnderGrid(wl, parent.isGrid, subject);
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
// none and is judged against the live canvas.
export function assertLayoutDeltaResolvable(node: any, wl: WriteLayout, subject: string, deltas?: BatchLayoutDeltas): void {
  const outOfFlow = wl.position === "absolute" || (wl.position !== "none" && node.layoutPositioning === "ABSOLUTE");
  const parent = projectedParentLayoutFacts(node.parent, deltas);
  assertLayoutLandsUnderParent(parent, node.type, wl, isRowColumnAutoLayout(node), outOfFlow, subject);
}

// A structural verb placing a LIVE node: ask whether the words it already wears stay legal under
// `destination`, and hand them back — they're also what the post-move re-aim replays, and reading
// them twice would risk reading them AFTER the reparent, when they no longer mean the old axes.
export function assertLiveNodeLandsUnderParent(node: any, destination: any, subject: string): WriteLayout {
  const wl = liveParentRelativeWords(node);
  assertLayoutLandsUnderParent(liveParentLayoutFacts(destination), node.type, wl, isRowColumnAutoLayout(node), wl.position === "absolute", subject);
  return wl;
}

// A structural verb placing a SPEC: only its ROOT meets the destination — the interior children
// are checked against their own authored parents inside the build walk, exactly as at create.
export function assertSpecRootLandsUnderParent(destination: any, wn: WriteNode, subject: string): void {
  const wl = wn.layout || {};
  assertLayoutLandsUnderParent(liveParentLayoutFacts(destination), wn.type, wl, wl.mode === "row" || wl.mode === "column", wl.position === "absolute", subject);
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

// Settle a node that just changed parents: drop the flow marks it wore under its OLD parent, then
// re-apply its parent-relative intent against the new one through the create/edit appliers. The
// clear is load-bearing and unconditional — layoutGrow means "the parent's PRIMARY axis" and
// STRETCH means "its COUNTER axis", so a row→column move silently re-aims a width-fill into a
// height-fill unless both marks go first (the same re-aim clearContainerFlowMarks does when a
// container flips direction). NOT lifted, for the same reason it isn't there: the
// hug-beats-stretch primaryAxisSizingMode pin, which is indistinguishable from an authored fixed
// size once written.
export function resettleMovedNode(node: any, wl: WriteLayout): void {
  node.layoutGrow = 0;
  if (node.layoutAlign === "STRETCH") node.layoutAlign = "INHERIT";
  applyLiveNodeLayout(node, wl);
  settleLiveNodePercentSize(node, wl);
  settleLiveNodePercentPosition(node, wl);
}

// Which appliers govern a child under a given parent: a POSITIONED child (any ABSOLUTE child, or
// any child of a free-form parent) is covered + constrained; an IN-FLOW auto-layout child reflows
// via layoutGrow/STRETCH instead, on which constraints are inert. One predicate, because the
// create walk both routes on it and records the covered children for its second cover pass.
function isPositionedChild(parentIsAuto: boolean, cl: WriteLayout): boolean {
  return cl.position === "absolute" || !parentIsAuto;
}

// The parent-side facts a spec child is settled against. The flow facts are ParentFlowFacts (the
// percent rule's own shape); `crossStretch` rides along because container-level `alignItems:
// "stretch"` intent is never stored — not by Figma, not by us (see setContainerStretchMarks) — so
// only a caller holding the parent's SPEC can state it. A caller inserting into a LIVE parent
// passes false and says so in its docs: the marks are re-synthesized by editing the container.
export interface SpecParentFacts extends ParentFlowFacts {
  crossStretch: boolean;
  subject: string; // the verb name the shared legality rules prefix their rejections with
}

// The same facts read off a LIVE destination, for the structural insert verbs. `crossStretch` is
// FALSE here and that is a stated rule, not a reading gap: an inserted child does NOT inherit a
// stretch container's stretch, because there is nothing to inherit FROM — see SpecParentFacts
// above. The remedy is `edit(parent, { layout: { alignItems: "stretch" } })`, which re-synthesizes
// the marks over every child including the new one.
export function liveParentSpecFacts(parent: any, subject: string): SpecParentFacts {
  return { ...parentHugFacts(parent), crossStretch: false, subject };
}

// THE attach-then-size entry: build one spec child and settle it into `parent`. Shared by the
// create walk (parent = the frame it is assembling) and the structural insert verbs (parent = a
// live destination), so a subtree lands the same way whichever verb placed it.
//
// The ORDER is invariant 3's hazard in miniature and the whole reason this is one function: the
// child is attached BEFORE any child-side sizing runs, because "fill"/"hug" are only legal once
// the node is inside the parent that resolves them. `place` performs the attachment — appending
// at the end for create, at an index for prepend/insertBefore — so WHERE stays the caller's while
// the ordering stays here.
export function attachSpecChild(
  parent: any, wn: WriteNode, ctx: RenderCtx, facts: SpecParentFacts, place: (child: any) => void,
): any {
  const cl = wn.layout || {};
  // Fail loud on the one unresolvable percent (in-flow %-size against a hugging auto-layout parent)
  // before building the node, so a bad spec doesn't orphan a live node on the canvas. Every other
  // percent/anchor is recorded and resolved in the post-walk pass (resolvePercents) against realized size.
  assertPercentResolvable(cl, facts, facts.subject);
  assertTextFillHeightInFlow(wn.type, cl, facts.parentIsAuto, cl.position === "absolute", facts.subject);
  const child = buildNode(wn, ctx);
  place(child);
  if (cl.percentSize || cl.percentPos || (cl.position === "absolute" && cl.anchor)) {
    ctx.pending.push({ node: child, layout: cl, parent });
  }
  if (cl.position === "absolute") applyChildPosition(parent, child, cl);
  if (isPositionedChild(facts.parentIsAuto, cl)) {
    coverChild(parent, child, cl);
    applyConstraints(child, wn.layout);
  } else {
    applyChildFill(parent, child, cl, facts.crossStretch);
    // An explicit pin is STORED even in flow — constraints are inert on an in-flow auto-layout
    // child, but they govern the moment it leaves the flow, and edit's applyPinDelta writes the
    // word unconditionally. applyPinDelta, NOT applyConstraints: in flow, fill rides layoutGrow,
    // so deriving the unnamed axis from sizing intent (fill→STRETCH) would store a constraint
    // the author never spoke — and one the same pin through edit would leave at the default.
    if (cl.pin) applyPinDelta(child, cl.pin);
  }
  return child;
}

function buildFrame(wn: WriteNode, ctx: RenderCtx): any {
  const f = figma.createFrame();
  figma.currentPage.appendChild(f); // enter the doc; reparented when appended to a parent frame
  // CSS default overflow is VISIBLE; Figma's createFrame() defaults clipsContent = true. Default it off so
  // authored overflow (escaping shadows, a knob past its track, a badge past a corner) isn't silently
  // clipped — a silent divergence from the CSS mental model. applyPaint re-applies an explicit `clip`.
  f.clipsContent = false;
  const layout = wn.layout || {};
  applyContainer(f, layout);
  if (!wn.fills) f.fills = []; // omitted fill -> transparent, not a surprise white box
  applyPaint(f, wn, ctx);

  const mode = layout.mode;
  const isAutoParent = mode === "row" || mode === "column";
  // The hug facts answer from the AUTHORED spec — the frame's live sizing modes don't exist until
  // applyOwnSize runs after the children (see assertPercentResolvable's contract).
  const specSizing = layout.sizing || {};
  const facts: SpecParentFacts = {
    parentIsAuto: isAutoParent,
    hugW: !specSizing.horizontal || specSizing.horizontal === "hug",
    hugH: !specSizing.vertical || specSizing.vertical === "hug",
    crossStretch: layout.alignItems === "stretch",
    subject: "flcm",
  };
  // Children whose w/h:"fill" must be re-resized after the frame gets its FINAL size (at append it was
  // hug-sized): every covered child, absolute or free-form. coverChild no-ops without a fill. An
  // INSERT into a live parent needs no such pass — its destination is already sized.
  const covers: { child: any; layout: WriteLayout }[] = [];
  for (const rawSpec of wn.children || []) {
    if (!rawSpec) continue; // falsy child entries skipped, so `cond && flcm.text(...)` works
    const cl = rawSpec.layout || {};
    const child = attachSpecChild(f, rawSpec, ctx, facts, (c) => f.appendChild(c));
    if (isPositionedChild(isAutoParent, cl)) covers.push({ child, layout: cl });
  }

  // Creation default: a fresh auto-layout frame HUGS both axes (CSS fit-content). Like the
  // transparent-fill default above, it's the builder's to inject — the applier itself never turns
  // key-absence into a write, so an edit delta omitting an axis leaves it alone.
  applyOwnSize(f, { ...layout, sizing: { horizontal: specSizing.horizontal || "hug", vertical: specSizing.vertical || "hug" } });
  // Re-cover every fill child now that the frame has its final size (at append it was hug-sized).
  for (const c of covers) coverChild(f, c.child, c.layout);
  return f;
}

// Layer each rich-text run's style/fills over its slice of the already-set characters via Figma's per-range
// API. Offsets track the concatenation order the runs were joined in (buildText). A run only carries the
// fields it overrides, so we touch only those ranges — the rest inherit the node's base style. A run's font
// resolves STRICTLY (resolveFontStrict): an unloaded run font fails loud rather than silently rendering base.
function applyRuns(t: any, runs: NonNullable<WriteNode["runs"]>, ctx: RenderResources): void {
  let start = 0;
  for (const run of runs) {
    const end = start + run.text.length;
    if (end > start) {
      const s = run.style;
      if (s) {
        // Italic is a font-name concern in Figma (the style string, e.g. "Bold Italic"), so a run that
        // changes family, weight, OR slant needs a per-range font — resolved STRICTLY against the exact
        // (family, weight, italic) fonts.ts preloaded.
        if (namesFontIdentity(s)) {
          t.setRangeFontName(start, end, resolveFontStrict(ctx.fonts, s.fontFamily, s.fontWeight, s.fontStyle === "italic"));
        }
        if (typeof s.fontSize === "number") t.setRangeFontSize(start, end, s.fontSize);
        if (s.lineHeight) t.setRangeLineHeight(start, end, s.lineHeight);
        if (s.letterSpacing) t.setRangeLetterSpacing(start, end, s.letterSpacing);
        if (s.textDecoration) t.setRangeTextDecoration(start, end, DECORATION[s.textDecoration]);
        // Casing and paragraph metrics are per-range in Figma exactly as the font is, which is why
        // they are run words at all (the read side surfaces them per segment for the same reason).
        if (s.textCase) t.setRangeTextCase(start, end, s.textCase);
        if (typeof s.paragraphSpacing === "number") t.setRangeParagraphSpacing(start, end, s.paragraphSpacing);
        if (typeof s.paragraphIndent === "number") t.setRangeParagraphIndent(start, end, s.paragraphIndent);
        if (typeof s.listSpacing === "number") t.setRangeListSpacing(start, end, s.listSpacing);
      }
      // Present-but-empty is the compiled "none" — a real transparent write over the slice, not a skip.
      if (run.fills) t.setRangeFills(start, end, run.fills.length ? [paintOf(run.fills[0], ctx)] : []);
      if (run.hyperlink) t.setRangeHyperlink(start, end, { type: "URL", value: run.hyperlink });
    }
    start = end;
  }
}

// The text-word applier both carriers ride — buildText for a fresh node, edit for a live one —
// so a text style compiled for create and for edit cannot land differently. Presence-only: the
// base font writes ONLY when the style names a font-identity word (an edit's fontSize nudge must
// not re-write fontName from a default triple; buildText writes the creation default itself when
// the spec names none). Order is load-bearing: font before characters (Figma refuses characters on
// an unloaded font; the caller preloaded exactly this triple), characters before runs (the setRange
// offsets address slices of them). Node-level fills are applyPaint's — the caller must run it
// BEFORE this so range fills land over, not under, the base fill.
export function applyTextProps(t: any, wn: WriteProps, ctx: RenderResources): void {
  const ts = wn.textStyle || {};
  if (namesFontIdentity(ts)) {
    t.fontName = resolveFont(ctx.fonts, ts.fontFamily, ts.fontWeight, ts.fontStyle === "italic");
  }
  if (wn.runs) t.characters = wn.runs.map((r) => r.text).join("");
  else if (wn.text != null) t.characters = String(wn.text);
  if (typeof ts.fontSize === "number") t.fontSize = ts.fontSize;
  if (ts.lineHeight) t.lineHeight = ts.lineHeight;
  if (ts.letterSpacing) t.letterSpacing = ts.letterSpacing;
  if (ts.textAlign && TEXT_ALIGN[ts.textAlign]) t.textAlignHorizontal = TEXT_ALIGN[ts.textAlign];
  if (ts.textAlignVertical) t.textAlignVertical = VERTICAL_ALIGN[ts.textAlignVertical];
  // Base decoration/casing/paragraph metrics first (whole node); runs then override their slice via
  // the matching setRange* below.
  if (ts.textDecoration) t.textDecoration = DECORATION[ts.textDecoration];
  if (ts.textCase) t.textCase = ts.textCase;
  if (typeof ts.paragraphSpacing === "number") t.paragraphSpacing = ts.paragraphSpacing;
  if (typeof ts.paragraphIndent === "number") t.paragraphIndent = ts.paragraphIndent;
  if (typeof ts.listSpacing === "number") t.listSpacing = ts.listSpacing;
  // A whole-node link is a range write like a run's — over every character. Guarded on non-empty
  // characters because Figma refuses a zero-width range, and an empty text has nothing to link.
  if (ts.hyperlink && t.characters.length) t.setRangeHyperlink(0, t.characters.length, { type: "URL", value: ts.hyperlink });
  if (wn.runs) applyRuns(t, wn.runs, ctx);
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

function buildText(wn: WriteNode, ctx: RenderCtx): any {
  const t = figma.createText();
  figma.currentPage.appendChild(t);
  // The creation default is the builder's: a fresh text ALWAYS ends up with a written base font —
  // applyTextProps's font write is presence-gated (edit's rule), so when the spec names no identity
  // word, create writes the resolveFont fallback triple itself (loadFontsForTree preloaded it).
  if (!namesFontIdentity(wn.textStyle)) t.fontName = resolveFont(ctx.fonts, undefined, undefined, false);
  // Present-but-empty is the compiled "none" — write the clear (live createText seeds a default
  // black fill, so skipping would leave the "unfilled" text black).
  if (wn.fills) {
    t.fills = wn.fills.length ? [paintOf(wn.fills[0], ctx)] : [];
    if (wn.fills.length) stampImageData(t, wn);
  }
  if (wn.effects) t.effects = toFigmaEffects(wn.effects);
  applyTextProps(t, { ...wn, text: wn.text == null ? "" : wn.text }, ctx);
  applyLeafSize(t, wn.layout || {});
  // flcm.text guarantees a bounded width when maxLines is set (the handshake above gave it a
  // wrap), so the truncation always has real lines to bite.
  applyTextClamp(t, wn.maxLines);
  if (typeof wn.opacity === "number") t.opacity = wn.opacity;
  return t;
}


function buildShape(node: any, wn: WriteNode, ctx: RenderCtx): any {
  figma.currentPage.appendChild(node);
  if (!wn.fills) node.fills = []; // omitted fill -> transparent
  applyPaint(node, wn, ctx);
  applyLeafSize(node, wn.layout || {});
  return node;
}

function buildLine(wn: WriteNode, ctx: RenderCtx): any {
  const l = figma.createLine();
  figma.currentPage.appendChild(l);
  // Present-but-empty is the compiled "none" — write the clear (live createLine seeds a default
  // black stroke, so skipping would leave the line stroked, not unstroked).
  if (wn.strokes) l.strokes = wn.strokes.length ? [paintOf(wn.strokes[0], ctx)] : [];
  l.strokeWeight = wn.strokeWeight != null ? wn.strokeWeight : 1;
  applyLeafSize(l, wn.layout || {});
  if (typeof wn.opacity === "number") l.opacity = wn.opacity;
  return l;
}

// A VECTOR WriteNode carries exactly one of svg-markup / path-data (flcm.ts guarantees this), and each
// drives a different plugin call. svg → createNodeFromSvg (a FRAME of vectors, colors baked in); path →
// createVector + vectorPaths (one themeable vector). Both fail loud on unparseable input rather than
// leaving a silent empty node.
function buildVector(wn: WriteNode, ctx: RenderCtx): any {
  if (typeof wn.svg === "string") return buildSvg(wn, wn.svg);
  if (typeof wn.pathData === "string") return buildPath(wn, wn.pathData, ctx);
  throw new Error("flcm: a VECTOR node carries neither svg markup nor path data (flcm.svg/flcm.path guarantee one).");
}

function buildSvg(wn: WriteNode, markup: string): any {
  let frame: any;
  try {
    frame = figma.createNodeFromSvg(markup);
  } catch (e: any) {
    throw new Error("flcm.svg: Figma could not parse the SVG markup — " + (e && e.message ? e.message : String(e)));
  }
  figma.currentPage.appendChild(frame);
  // createNodeFromSvg returns a FrameNode, which inherits Figma's clipsContent=true default — so vector art
  // that bleeds past its viewBox gets clipped. The generic clip-default fix lives in buildFrame (the
  // createFrame path); this frame never traverses it, so clear it here too (CSS overflow is visible by
  // default). See buildFrame for the rationale.
  frame.clipsContent = false;
  applyLeafSize(frame, wn.layout || {});
  if (typeof wn.opacity === "number") frame.opacity = wn.opacity;
  return frame;
}

function buildPath(wn: WriteNode, pathData: string, ctx: RenderCtx): any {
  // Figma's vectorPaths parser accepts only absolute M/L/C/Q/Z, so normalize the full SVG command set
  // (H V S T A + relatives) into that subset first. Do this BEFORE creating the node so malformed input
  // fails loud without orphaning an empty vector on the canvas.
  const normalized = normalizePathData(pathData);
  const v = figma.createVector();
  figma.currentPage.appendChild(v);
  if (!wn.fills) v.fills = []; // omitted fill -> transparent, like the other primitives (no surprise default)
  // figma.createVector() seeds a new vector with a default black 1px stroke (createRectangle/Frame don't).
  // Clear it when the author passed no stroke, else a fill-only path renders silently outlined — a
  // surprise-default that breaks rect/frame parity and the "path is like a rect with no fill" mental model.
  if (!wn.strokes) v.strokes = [];
  try {
    v.vectorPaths = [{ windingRule: "NONZERO", data: normalized }];
  } catch (e: any) {
    throw new Error('flcm.path: Figma could not parse the path data "' + pathData + '" — ' + (e && e.message ? e.message : String(e)));
  }
  applyPaint(v, wn, ctx);
  applyLeafSize(v, wn.layout || {});
  return v;
}

// The createable allow-list AND the dispatch in one table — `Record<WriteType, …>` makes TS reject any
// createable type that lacks a builder (or a builder for a non-createable type), so the two can't drift.
// A type outside the table falls through to the loud error in buildNode.
const BUILDERS: Record<WriteType, (wn: WriteNode, ctx: RenderCtx) => any> = {
  FRAME: (wn, ctx) => buildFrame(wn, ctx),
  TEXT: (wn, ctx) => buildText(wn, ctx),
  RECTANGLE: (wn, ctx) => buildShape(figma.createRectangle(), wn, ctx),
  ELLIPSE: (wn, ctx) => buildShape(figma.createEllipse(), wn, ctx),
  LINE: (wn, ctx) => buildLine(wn, ctx),
  VECTOR: (wn, ctx) => buildVector(wn, ctx),
};

// Build one node and its subtree. Percent size/position is NOT resolved here — the node is built at a
// provisional size and buildFrame records it in ctx.pending for the post-walk resolvePercents pass (which
// needs the fully-assembled tree to read realized parent sizes). Returns the live node.
export function buildNode(wn: WriteNode, ctx: RenderCtx): any {
  const build = BUILDERS[wn.type];
  if (!build) {
    throw new Error('flcm: cannot create a "' + wn.type + '" node — createable types are ' + Object.keys(BUILDERS).join(", ") + ".");
  }
  // Provenance was authenticated tree-wide in render's PREPARE (assertConstructorBuiltTree),
  // before any resource load — and the constructors deep-freeze their output, so the tree apply
  // walks here is byte-for-byte the one prepare authenticated. No re-check per node.
  const node = build(wn, ctx);
  applySceneProps(node, wn);
  stampKey(node, wn, ctx);
  return node;
}

// The root is the page's child, and the page is a free-form parent — so the SAME child-side
// appliers run for it that buildFrame runs for a free-form child: `left`/`top` land as canvas
// coordinates, an explicit pin is stored (inert until the root is dragged into a frame, like any
// page child's constraints), an anchor rides the pending pass. Without this, position words on
// the root would validate fine and silently not land — while edit applies the same words to a
// page child, the exact per-verb divergence layout-legality.ts exists to forbid. ("fill" and
// percents on the root reject upstream in render's page-parent check; they never reach here.)
export function placeRootOnPage(root: any, wl: WriteLayout, ctx: RenderCtx): void {
  if (wl.position === "absolute") {
    applyChildPosition(figma.currentPage, root, wl);
    if (wl.anchor) ctx.pending.push({ node: root, layout: wl, parent: figma.currentPage });
  }
  if (wl.pin) applyConstraints(root, wl);
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
  if (typeof wn.rotation === "number" && "rotation" in node) node.rotation = -wn.rotation;
  if (typeof wn.visible === "boolean") node.visible = wn.visible;
  if (typeof wn.locked === "boolean") node.locked = wn.locked;
}
