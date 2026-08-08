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
import { toFigmaPaint } from "./paint.js";
import { toFigmaEffects } from "./effects.js";
import { resolveFont, resolveFontStrict, FontMap } from "./fonts.js";
import { normalizePathData } from "./path.js";
import { writeKey, identityOf } from "./identity.js";
import { pixelRound, convertSizing } from "~/core/index.js";

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
// so a rotated node's size is unchanged) and x/y are its container-parent offset. The read side instead
// derives both from `absoluteBoundingBox`, the page-space AABB, which for a ROTATED node is a larger box at
// a different origin: the two agree on every unrotated node and diverge on a rotated one. Deliberate — a
// 40px-wide rect rotated 15° is 40 wide, and the AABB's 44.85 is the read side's to fix (see fig-0qsz),
// not a number to reproduce here.
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
export function settleHandles(root: any, keyed: Record<string, any>): { root: Handle; keyed: Record<string, Handle> } {
  const handles: Record<string, Handle> = {};
  for (const key of Object.keys(keyed)) handles[key] = mintHandle(keyed[key]);
  return { root: mintHandle(root), keyed: handles };
}

function stampKey(node: any, wn: WriteNode, ctx: RenderCtx): void {
  if (typeof wn.key !== "string") return;
  if (wn.key in ctx.keyed) throw new Error('flcm.render: duplicate key "' + wn.key + '" — keys must be unique within a render.');
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
  if (!fill || fill.kind !== "image") {
    // An edit replaced an image fill with a solid/gradient — or cleared it (fill:"none" compiles to
    // an empty array): the provenance no longer describes the live paint, so wipe it ("" deletes
    // the pluginData entry) instead of leaving a stale url.
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
  // Unrealizable justify words are rejected at the constructor gate (flcm.ts mapLayoutWord), so for typed
  // input JUSTIFY is total and "MIN" never fires — it's only a sane default for a hand-built raw WriteNode.
  if (layout.justifyContent) f.primaryAxisAlignItems = JUSTIFY[layout.justifyContent] || "MIN";
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
// a mark parked on an absolute child, or absolute:"none" later resurrects a stretch the container
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
// a mark parked on an out-of-flow child is inert now but would rejoin the flow via absolute:"none"
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

// Lift an absolute child out of an auto-layout parent's flow (so x/y are honored, it can overlap
// siblings, and it extends past a clip) and apply its location. Outside auto-layout, x/y are native.
// position:"none" (edit's absolute:"none") is the inverse: the child rejoins the flow and the
// layout re-places it — in a free-form parent there is no flow to rejoin, so it's inert there.
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
// wraps; "hug" restores grow-sideways; height is ignored exactly as fixed-height text always was)
// and LINE's zero height. Generic shapes resize only the named dims, floored at Figma's 0.01.
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

// Reject the ONE percent case a runtime read can't break: an IN-FLOW `%`-SIZE child of an auto-layout
// parent that HUGS the same axis. The child's size both defines the hug and depends on it — a true cycle,
// so fail loud (ADR-0003) rather than snapshot a bogus number. Everything else resolves against the
// parent's realized size (see resolvePercentLayout): a fixed/`fill` auto parent, ANY free-form parent,
// and an ABSOLUTE child (out of flow — it doesn't feed the hug, so it sizes against the hug's realized
// value like a percent position does).
//
// Takes the parent as BOOLEAN FACTS, not a node or a spec, because the two callers know them from
// different places: the create walk asks before the child (or the parent's sizing modes) exists, so it
// answers from the authored spec; the edit path answers from the live flags (isRowColumnAutoLayout +
// convertSizing of layoutSizingHorizontal/Vertical). Reading a parent here would break the first caller.
function assertPercentResolvable(childLayout: WriteLayout, parentIsAutoLayout: boolean, parentHugsW: boolean, parentHugsH: boolean): void {
  const ps = childLayout.percentSize;
  if (!ps) return;
  if (!parentIsAutoLayout || childLayout.position === "absolute") return;
  if ((ps.width != null && parentHugsW) || (ps.height != null && parentHugsH)) {
    throw new Error('flcm: a percent w/h ("N%") on an in-flow child of an auto-layout (row/column) parent that HUGS that axis is a cycle — the child\'s size both sets and depends on the parent\'s. Give the parent a fixed or "fill" size on that axis, use "fill"/"hug" on the child, or lift it out with `absolute`.');
  }
}

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
  // SIZE first — anchor placement below reads the child's resolved width/height.
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
// appliers in the same roles, re-run against the live parent (which is why percents resolve
// directly here: the parent's realized size already exists, no deferred pass to ride). Order
// matters and mirrors buildFrame's walk: container words first (they may change the node's own
// direction, which own-size mapping reads), then position (in/out of flow decides which appliers
// govern the node), flow fills and their unset inverses, own/leaf sizing, cover, percents, pin.
export function applyLiveNodeLayout(node: any, wl: WriteLayout): void {
  const parent = node.parent;
  applyContainer(node, wl);
  if (!parent) return; // a parentless node (the page itself can't get here) has no child-side context
  const parentIsAuto = isRowColumnAutoLayout(parent);
  // Un-fill BEFORE the position write, and regardless of the child's CURRENT positioning: an axis
  // the delta re-sizes to fixed/hug must lose the grow/stretch mark fill installed there, even when
  // the mark sits parked and inert on an absolute child — otherwise `width: 80` on it (or
  // `{ absolute: "none", width: 80 }` in one delta) leaves the mark to resurrect the fill the delta
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
  if (wl.percentSize || wl.percentPos || wl.anchor) resolvePercentLayout(parent, node, wl);
  if (wl.pin) applyPinDelta(node, wl.pin);
}

// The live-parent facts assertPercentResolvable needs (create computes them from the authored
// spec; edit reads them off the canvas). EFFECTIVE sizing (layoutSizing*), not the internal axis
// modes: an AUTO-mode axis that the grandparent stretches reports FILL — the parent's size is
// realized from above, the child's percent resolves against it, and no cycle exists. Reading
// primary/counterAxisSizingMode here would reject that valid case as a hug.
function parentHugFacts(parent: any): { parentIsAuto: boolean; hugW: boolean; hugH: boolean } {
  const parentIsAuto = !!parent && isRowColumnAutoLayout(parent);
  if (!parentIsAuto) return { parentIsAuto: false, hugW: false, hugH: false };
  return {
    parentIsAuto,
    hugW: convertSizing(parent.layoutSizingHorizontal) === "hug",
    hugH: convertSizing(parent.layoutSizingVertical) === "hug",
  };
}

// The edit path's prepare-phase gate (before the entry seal) for layout words that only mean
// something against the LIVE tree —
// every reject fires before the first canvas write. The live facts a pure compile can't see:
//   - "fill"/"N%" resolve against a parent's bounded size, and a PAGE has none (page.width doesn't
//     exist — the resize would be NaN, and Figma's throw wouldn't name the real mistake);
//   - "hug" sizes to measured content, which only an auto-layout container or TEXT has — anywhere
//     else it would silently mean nothing (create tolerates that historic looseness; edit rejects);
//   - a TEXT's own height follows content + wrap (create silently drops an authored text height —
//     a pre-existing create quirk — but an edit accepting one would mint a no-op undo step);
//   - container words are inert without auto-layout (applyContainer gates on the live mode), so a
//     gap-only delta on a free-form or grid frame must reject, not silently commit;
//   - the hug-cycle percent guard needs the child's EFFECTIVE flow position: a delta rarely names
//     `absolute`, so an already-ABSOLUTE child threads its live positioning — out of flow it
//     doesn't feed the parent's hug, and the cycle can't form.
export function assertLayoutDeltaResolvable(node: any, wl: WriteLayout): void {
  const parent = node.parent;
  const s = wl.sizing || {};
  if (parent && parent.type === "PAGE" && (s.horizontal === "fill" || s.vertical === "fill" || wl.percentSize || wl.percentPos)) {
    throw new Error('flcm.edit: "fill" and "N%" resolve against a parent frame, and this node\'s parent is the page — a page has no bounded size. Use pixel dimensions, or move the node into a frame first.');
  }
  const willBeAuto = wl.mode === "row" || wl.mode === "column" || (wl.mode == null && isRowColumnAutoLayout(node));
  if (s.horizontal === "hug" || s.vertical === "hug") {
    if (!willBeAuto && node.type !== "TEXT") {
      throw new Error('flcm.edit: "hug" sizes to content, which only an auto-layout (row/column) container or text can measure — a ' + node.type + " without auto-layout has no content size. Use pixel dimensions, or set layout: { mode: \"row\"|\"column\" } in the same edit.");
    }
  }
  if (node.type === "TEXT" && (s.vertical === "fixed" || s.vertical === "hug")) {
    throw new Error("flcm.edit: a TEXT's height follows its content and wrap — edit `width` (the text re-wraps and the height follows), or use height: \"fill\" inside an auto-layout parent.");
  }
  // TEXT height:"fill" is realized by the parent's flow (layoutGrow/STRETCH). Out of flow —
  // free-form parent, or absolute — it would fall to coverChild's resize, which a text node in
  // WIDTH_AND_HEIGHT ignores: the height silently doesn't stick, so reject instead.
  if (node.type === "TEXT" && s.vertical === "fill") {
    const willBeAbsolute = wl.position === "absolute" || (wl.position !== "none" && node.layoutPositioning === "ABSOLUTE");
    if (!parent || !isRowColumnAutoLayout(parent) || willBeAbsolute) {
      throw new Error('flcm.edit: a TEXT can only fill its height as an in-flow child of a row/column auto-layout parent — out of flow its height follows content. Edit `width`, or return it to flow first.');
    }
  }
  if (wl.gap != null || wl.padding || wl.justifyContent || wl.alignItems) {
    if (!willBeAuto) {
      throw new Error('flcm.edit: layout gap/padding/justifyContent/alignItems need an auto-layout (row/column) container — this frame ' + (wl.mode === "none" ? 'won\'t be one after mode: "none"' : "isn't one") + '. Name layout: { mode: "row" } (or "column") in the same edit.');
    }
  }
  // GRID is outside the authored context matrix (see isRowColumnAutoLayout's note): flcm can't
  // create one, and its cells' semantics are unassigned — so the PARENT-RELATIVE words reject
  // under a grid parent rather than silently landing with free-form semantics ("fill" would cover
  // the whole grid frame). Node-local words (fixed px, "hug", own container props) stay legal.
  if (parent && parent.layoutMode === "GRID") {
    if (s.horizontal === "fill" || s.vertical === "fill" || wl.percentSize || wl.percentPos || wl.position || wl.pin || wl.anchor) {
      throw new Error('flcm.edit: this node\'s parent is a GRID container, which the edit vocabulary doesn\'t cover — "fill", percents, absolute, and pin have no assigned meaning there. Use fixed pixel sizes, or edit the parent.');
    }
  }
  if (wl.percentSize) {
    const facts = parentHugFacts(parent);
    const position = wl.position != null ? wl.position : node.layoutPositioning === "ABSOLUTE" ? "absolute" : undefined;
    assertPercentResolvable({ ...wl, position }, facts.parentIsAuto, facts.hugW, facts.hugH);
  }
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
  const crossStretch = layout.alignItems === "stretch";
  const isAutoParent = mode === "row" || mode === "column";
  // The hug facts answer from the AUTHORED spec — the frame's live sizing modes don't exist until
  // applyOwnSize runs after the children (see assertPercentResolvable's contract).
  const specSizing = layout.sizing || {};
  const parentHugsW = !specSizing.horizontal || specSizing.horizontal === "hug";
  const parentHugsH = !specSizing.vertical || specSizing.vertical === "hug";
  // Children whose w/h:"fill" must be re-resized after the frame gets its FINAL size (at append it was
  // hug-sized): every covered child, absolute or free-form. coverChild no-ops without a fill.
  const covers: { child: any; layout: WriteLayout }[] = [];
  const kids = wn.children || [];
  for (const rawSpec of kids) {
    if (!rawSpec) continue; // falsy child entries skipped, so `cond && flcm.text(...)` works
    const cl = rawSpec.layout || {};
    // Fail loud on the one unresolvable percent (in-flow %-size against a hugging auto-layout parent)
    // before building the node, so a bad spec doesn't orphan a live node on the canvas. Every other
    // percent/anchor is recorded and resolved in the post-walk pass (resolvePercents) against realized size.
    assertPercentResolvable(cl, isAutoParent, parentHugsW, parentHugsH);
    const child = buildNode(rawSpec, ctx);
    f.appendChild(child);
    if (cl.percentSize || cl.percentPos || (cl.position === "absolute" && cl.anchor)) {
      ctx.pending.push({ node: child, layout: cl, parent: f });
    }
    if (cl.position === "absolute") applyChildPosition(f, child, cl);
    // A positioned child is governed by Figma constraints: any ABSOLUTE child (lifted out of flow, so it
    // honors constraints even under auto-layout — that's how a badge pins to a corner), or any child of a
    // FREE-FORM parent. It's covered (w/h:"fill" stretches to the parent box) and gets constraints derived
    // from its raw layout. An IN-FLOW auto-layout child instead reflows via layoutGrow/STRETCH
    // (applyChildFill), on which constraints are inert.
    if (cl.position === "absolute" || !isAutoParent) {
      coverChild(f, child, cl);
      covers.push({ child, layout: cl });
      applyConstraints(child, rawSpec.layout);
    } else {
      applyChildFill(f, child, cl, crossStretch);
    }
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
  // Base decoration first (whole node); runs then override their slice via setRangeTextDecoration.
  if (ts.textDecoration) t.textDecoration = DECORATION[ts.textDecoration];
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
  const node = build(wn, ctx);
  applySceneProps(node, wn);
  stampKey(node, wn, ctx);
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
  if (typeof wn.rotation === "number" && "rotation" in node) node.rotation = -wn.rotation;
  if (typeof wn.visible === "boolean") node.visible = wn.visible;
  if (typeof wn.locked === "boolean") node.locked = wn.locked;
}
