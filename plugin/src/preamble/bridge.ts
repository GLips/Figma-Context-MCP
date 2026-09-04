// bridge — the render walk: a WriteNode tree -> live Figma nodes via the plugin API. This is where the
// typed IR currency is mapped onto plugin calls. It consumes ONLY the typed currency — it never sees a
// CSS string leaf and never imports css.ts; the boundary parsed everything into types upstream, so here
// a gap is already a number, a fill already a PaintSpec, an effect already an EffectSpec. It is the one
// place nodes are created/mutated; the constructors in flcm.ts only build inert POJOs.
//
// Nodes are typed `any` deliberately: the plugin typings model dozens of SceneNode variants, but the
// walk applies a small additive vocabulary guarded by `'prop' in node` / try-catch, so fighting the
// union with casts at every line would add noise without safety.

import { WriteType, WriteNode, WriteLayout, Justify, Align, TextAlign, TextDecoration, Sizing, Identity, Handle, PaintSpec, ImageSpec } from "./ir.js";
import { toFigmaPaint } from "./paint.js";
import { toFigmaEffects } from "./effects.js";
import { resolveFont, resolveFontStrict, FontMap } from "./fonts.js";
import { normalizePathData } from "./path.js";
import { writeKey, identityOf } from "./identity.js";
import { pixelRound, convertSizing } from "~/core/index.js";

// `images` is the url → base64 map render() threads through the walk (bytes the server fetched+validated
// and injected between the two passes); an image PaintSpec resolves to a plugin ImagePaint against it.
// `pending` accumulates every percent/anchor child during the walk, resolved in one post-walk pass once
// the tree's fill/hug sizes have settled (see resolvePercents).
//
// `keyed` collects LIVE NODES, not Handles: nothing about a node's geometry is trustworthy mid-walk (see
// settleHandles), so handles are minted in one pass after the walk instead of stamped and then patched.
export interface RenderCtx {
  keyed: Record<string, any>;
  fonts: FontMap;
  images: Record<string, string>;
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
// `key` is read back from the pluginData stampKey wrote during the walk.
function handle(node: any): Handle {
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
  for (const key of Object.keys(keyed)) handles[key] = handle(keyed[key]);
  return { root: handle(root), keyed: handles };
}

function stampKey(node: any, wn: WriteNode, ctx: RenderCtx): void {
  if (typeof wn.key !== "string") return;
  if (wn.key in ctx.keyed) throw new Error('flcm.render: duplicate key "' + wn.key + '" — keys must be unique within a render.');
  writeKey(node, wn.key);
  ctx.keyed[wn.key] = node;
}

// Resolve one PaintSpec to a plugin Paint. An image spec needs raster BYTES (the server fetched them and
// injected ctx.images, keyed by url) turned into an imageHash via figma.createImage — a figma.* call, so
// it lives HERE in the bridge, not in the figma-free paint.ts. Every other spec maps purely.
function paintOf(spec: PaintSpec, ctx: RenderCtx): Paint {
  if (spec.kind === "image") return imagePaint(spec, ctx);
  return toFigmaPaint(spec);
}

function imagePaint(spec: ImageSpec, ctx: RenderCtx): Paint {
  const b64 = ctx.images[spec.url];
  if (typeof b64 !== "string") {
    // render() collects every image url and signals "images needed" before any node is built, so the bytes
    // are always present here on the render pass. A miss means the tree changed between passes — fail loud
    // rather than paint a blank fill.
    throw new Error('flcm.image: no fetched bytes for "' + spec.url + '" — the image was not resolved before render.');
  }
  const img = figma.createImage(figma.base64Decode(b64));
  return { type: "IMAGE", scaleMode: spec.scaleMode, imageHash: img.hash };
}

// Persist an image fill's source + placeholder flag on the node (pluginData) so a later read/codegen pass
// can tell a stand-in from a real asset and recover its src — the one content case whose semantics don't
// survive geometry alone. Only the fill (a node's background) is recorded; an image stroke is exotic.
function stampImageData(node: any, wn: WriteNode): void {
  const fill = wn.fills && wn.fills[0];
  if (!fill || fill.kind !== "image") return;
  node.setPluginData("flcm/image", JSON.stringify({ url: fill.url, placeholder: fill.placeholder }));
}

// Additive appearance: only fields present on the WriteNode are touched. Property guards skip what a node
// kind lacks (an ellipse has no cornerRadius). v1 still paints a single fill/stroke.
function applyPaint(node: any, wn: WriteNode, ctx: RenderCtx): void {
  if (wn.fills && wn.fills.length) node.fills = [paintOf(wn.fills[0], ctx)];
  if (wn.strokes && wn.strokes.length) node.strokes = [paintOf(wn.strokes[0], ctx)];
  if (wn.strokeWeight != null && "strokeWeight" in node) node.strokeWeight = wn.strokeWeight;
  if (wn.borderRadius != null && "cornerRadius" in node) node.cornerRadius = wn.borderRadius;
  if (wn.effects && "effects" in node) node.effects = toFigmaEffects(wn.effects);
  if (typeof wn.opacity === "number") node.opacity = wn.opacity;
  if (typeof wn.clip === "boolean" && "clipsContent" in node) node.clipsContent = wn.clip;
  stampImageData(node, wn);
}

function applyContainer(f: any, layout: WriteLayout): void {
  const mode = layout.mode;
  if (mode !== "row" && mode !== "column") return; // gap/pad/align are inert without auto-layout
  f.layoutMode = mode === "row" ? "HORIZONTAL" : "VERTICAL";
  if (layout.gap != null) f.itemSpacing = layout.gap;
  if (layout.padding) {
    const e = layout.padding;
    f.paddingTop = e.top; f.paddingRight = e.right; f.paddingBottom = e.bottom; f.paddingLeft = e.left;
  }
  // Unrealizable justify words are rejected at the constructor gate (flcm.ts mapLayoutWord), so for typed
  // input JUSTIFY is total and "MIN" never fires — it's only a sane default for a hand-built raw WriteNode.
  if (layout.justifyContent) f.primaryAxisAlignItems = JUSTIFY[layout.justifyContent] || "MIN";
  if (layout.alignItems && ALIGN[layout.alignItems]) f.counterAxisAlignItems = ALIGN[layout.alignItems];
}

// Own-axis sizing, applied AFTER children so a `hug` axis measures real content. Maps the IR's
// sizing/dimensions onto the plugin's primary/counter sizing modes (which axis is which depends on the
// frame's own direction) and resizes the fixed axes.
function applyOwnSize(f: any, layout: WriteLayout): void {
  const sizing = layout.sizing || {};
  const dims = layout.dimensions || {};
  const isAuto = layout.mode === "row" || layout.mode === "column";

  if (isAuto) {
    const isRow = layout.mode === "row";
    const setMode = function (val: any, isWidth: boolean) {
      if (val === "fill") return; // resolved by the parent against its own axis
      const isPrimary = isWidth === isRow;
      f[isPrimary ? "primaryAxisSizingMode" : "counterAxisSizingMode"] = val === "fixed" ? "FIXED" : "AUTO";
    };
    setMode(sizing.horizontal || "hug", true);
    setMode(sizing.vertical || "hug", false);
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
function applyChildFill(parent: any, child: any, layout: WriteLayout, parentMode: string | undefined, crossStretch: boolean): void {
  const s = layout.sizing || {};
  // Only reached for an auto-layout parent (buildFrame routes free-form children through coverChild +
  // applyConstraints instead — a free-form w/h:"fill" now actually stretches, no warn-and-ignore).
  const pIsRow = parentMode === "row";
  const fillDim = function (dim: string) {
    const alongPrimary = (dim === "width") === pIsRow;
    if (alongPrimary) child.layoutGrow = 1;
    else child.layoutAlign = "STRETCH";
    if (child.layoutMode === "HORIZONTAL" || child.layoutMode === "VERTICAL") {
      const childIsRow = child.layoutMode === "HORIZONTAL";
      if ((dim === "width") === childIsRow) {
        try { child.primaryAxisSizingMode = "FIXED"; } catch (e) { /* some nodes resist */ }
      }
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
  if (child.layoutMode === "HORIZONTAL" || child.layoutMode === "VERTICAL") {
    const isRow = child.layoutMode === "HORIZONTAL";
    if (s.horizontal === "fill") child[isRow ? "primaryAxisSizingMode" : "counterAxisSizingMode"] = "FIXED";
    if (s.vertical === "fill") child[isRow ? "counterAxisSizingMode" : "primaryAxisSizingMode"] = "FIXED";
  }
  const cw = s.horizontal === "fill" ? parent.width : child.width;
  const ch = s.vertical === "fill" ? parent.height : child.height;
  try { child.resize(Math.max(cw, 0.01), Math.max(ch, 0.01)); } catch (e) { /* some nodes resist resize */ }
}

// Lift an absolute child out of an auto-layout parent's flow (so x/y are honored, it can overlap
// siblings, and it extends past a clip) and apply its location. Outside auto-layout, x/y are native.
function applyChildPosition(parent: any, child: any, layout: WriteLayout): void {
  if (layout.position !== "absolute") return;
  if (parent.layoutMode === "HORIZONTAL" || parent.layoutMode === "VERTICAL") {
    try { child.layoutPositioning = "ABSOLUTE"; } catch (e) { /* instance may resist */ }
  }
  if (typeof layout.left === "number") child.x = layout.left;
  if (typeof layout.top === "number") child.y = layout.top;
}

// Figma's per-axis constraint enum keyed by the author's directional `pin` (ir.ts PinX/PinY). Two maps
// because the axis-neutral words (center/stretch/scale) sit alongside axis-specific edges (left/right on x,
// top/bottom on y). This terse→enum mapping is the bridge's to own, like JUSTIFY/ALIGN above.
const PIN_H: Record<string, string> = { left: "MIN", center: "CENTER", right: "MAX", stretch: "STRETCH", scale: "SCALE" };
const PIN_V: Record<string, string> = { top: "MIN", center: "CENTER", bottom: "MAX", stretch: "STRETCH", scale: "SCALE" };

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

// Reject the ONE percent case a runtime read can't break: an IN-FLOW `%`-SIZE child of an auto-layout
// parent that HUGS the same axis. The child's size both defines the hug and depends on it — a true cycle,
// so fail loud (ADR-0003) rather than snapshot a bogus number. Everything else resolves against the
// parent's realized size (see resolvePercents): a fixed/`fill` auto parent, ANY free-form parent, and an
// ABSOLUTE child (out of flow — it doesn't feed the hug, so it sizes against the hug's realized value like
// a percent position does). Called at build time (before the child node exists) so the throw doesn't
// orphan it. `parentSizing` is the parent frame's own sizing intent.
function assertPercentResolvable(childLayout: WriteLayout, parentMode: string | undefined, parentSizing: WriteLayout["sizing"]): void {
  const ps = childLayout.percentSize;
  if (!ps) return;
  const isAuto = parentMode === "row" || parentMode === "column";
  if (!isAuto || childLayout.position === "absolute") return;
  const hugsW = !parentSizing || !parentSizing.horizontal || parentSizing.horizontal === "hug";
  const hugsH = !parentSizing || !parentSizing.vertical || parentSizing.vertical === "hug";
  if ((ps.width != null && hugsW) || (ps.height != null && hugsH)) {
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
  for (const p of ctx.pending) resolveOne(p);
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

function resolveOne(p: PendingResolve): void {
  const { node, layout, parent } = p;
  // SIZE first — anchor placement below reads the child's resolved width/height.
  if (layout.percentSize) {
    const ps = layout.percentSize;
    const w = ps.width != null ? pctOf(ps.width, parent.width) : node.width;
    const h = ps.height != null ? pctOf(ps.height, parent.height) : node.height;
    // A text node ignores a width resize while it auto-sizes width (WIDTH_AND_HEIGHT) — it would just keep
    // hugging its content. Mirror buildText's fixed-width handshake so a percent-width text wraps at the
    // resolved width (height auto-fits) instead of silently dropping the percent (ADR-0003 silent-wrong).
    if (node.type === "TEXT" && ps.width != null) node.textAutoResize = "HEIGHT";
    node.resize(Math.max(w, 0.01), Math.max(h, 0.01));
  }
  // POSITION + ANCHOR — absolute children only (percentPos/anchor never set otherwise). Resolve each axis
  // (percent → px against the parent, else the authored number), then shift by the anchor so the child's
  // anchor point (not its top-left) lands on x/y.
  if (layout.position === "absolute" && (layout.percentPos || layout.anchor)) {
    const pp = layout.percentPos || {};
    let x = pp.x != null ? pctOf(pp.x, parent.width) : (layout.left ?? 0);
    let y = pp.y != null ? pctOf(pp.y, parent.height) : (layout.top ?? 0);
    const a = layout.anchor;
    if (a) {
      if (a.x === "center") x -= node.width / 2;
      else if (a.x === "right") x -= node.width;
      if (a.y === "center") y -= node.height / 2;
      else if (a.y === "bottom") y -= node.height;
    }
    node.x = x;
    node.y = y;
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
    assertPercentResolvable(cl, mode, layout.sizing);
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
      applyChildFill(f, child, cl, mode, crossStretch);
    }
  }

  applyOwnSize(f, layout);
  // Re-cover every fill child now that the frame has its final size (at append it was hug-sized).
  for (const c of covers) coverChild(f, c.child, c.layout);
  return f;
}

// Layer each rich-text run's style/fills over its slice of the already-set characters via Figma's per-range
// API. Offsets track the concatenation order the runs were joined in (buildText). A run only carries the
// fields it overrides, so we touch only those ranges — the rest inherit the node's base style. A run's font
// resolves STRICTLY (resolveFontStrict): an unloaded run font fails loud rather than silently rendering base.
function applyRuns(t: any, runs: NonNullable<WriteNode["runs"]>, ctx: RenderCtx): void {
  let start = 0;
  for (const run of runs) {
    const end = start + run.text.length;
    if (end > start) {
      const s = run.style;
      if (s) {
        // Italic is a font-name concern in Figma (the style string, e.g. "Bold Italic"), so a run that
        // changes family, weight, OR slant needs a per-range font — resolved STRICTLY against the exact
        // (family, weight, italic) fonts.ts preloaded.
        if (s.fontFamily !== undefined || s.fontWeight !== undefined || s.fontStyle !== undefined) {
          t.setRangeFontName(start, end, resolveFontStrict(ctx.fonts, s.fontFamily, s.fontWeight, s.fontStyle === "italic"));
        }
        if (typeof s.fontSize === "number") t.setRangeFontSize(start, end, s.fontSize);
        if (s.lineHeight) t.setRangeLineHeight(start, end, s.lineHeight);
        if (s.letterSpacing) t.setRangeLetterSpacing(start, end, s.letterSpacing);
        if (s.textDecoration) t.setRangeTextDecoration(start, end, DECORATION[s.textDecoration]);
      }
      if (run.fills && run.fills.length) t.setRangeFills(start, end, [paintOf(run.fills[0], ctx)]);
      if (run.hyperlink) t.setRangeHyperlink(start, end, { type: "URL", value: run.hyperlink });
    }
    start = end;
  }
}

function buildText(wn: WriteNode, ctx: RenderCtx): any {
  const t = figma.createText();
  figma.currentPage.appendChild(t);
  const ts = wn.textStyle || {};
  t.fontName = resolveFont(ctx.fonts, ts.fontFamily, ts.fontWeight, ts.fontStyle === "italic"); // loadFontsForTree preloaded this exact (family, weight, italic)
  // Characters come from the runs (concatenated) when present, else the plain string. The base font above
  // must be loaded before this assignment; runs then layer per-range over the base (applyRuns).
  t.characters = wn.runs ? wn.runs.map((r) => r.text).join("") : String(wn.text == null ? "" : wn.text);
  if (typeof ts.fontSize === "number") t.fontSize = ts.fontSize;
  if (ts.lineHeight) t.lineHeight = ts.lineHeight;
  if (ts.letterSpacing) t.letterSpacing = ts.letterSpacing;
  if (wn.fills && wn.fills.length) { t.fills = [paintOf(wn.fills[0], ctx)]; stampImageData(t, wn); }
  if (wn.effects) t.effects = toFigmaEffects(wn.effects);
  if (ts.textAlign && TEXT_ALIGN[ts.textAlign]) t.textAlignHorizontal = TEXT_ALIGN[ts.textAlign];
  // Base decoration first (whole node); runs then override their slice via setRangeTextDecoration.
  if (ts.textDecoration) t.textDecoration = DECORATION[ts.textDecoration];
  if (wn.runs) applyRuns(t, wn.runs, ctx);

  // A controlled width means the text should wrap (height-only auto-resize) rather than grow sideways.
  const sizing = (wn.layout && wn.layout.sizing) || {};
  const dims = (wn.layout && wn.layout.dimensions) || {};
  if (sizing.horizontal === "fixed" && typeof dims.width === "number") {
    t.textAutoResize = "HEIGHT";
    t.resize(Math.max(dims.width, 0.01), t.height);
  } else if (sizing.horizontal === "fill") {
    t.textAutoResize = "HEIGHT";
  }
  // Clamp to N lines with an ending ellipsis. flcm.text guarantees a bounded width when maxLines is set
  // (the handshake above gave it a wrap), so the truncation always has real lines to bite. textTruncation
  // must be "ENDING" BEFORE maxLines — Figma rejects a non-null maxLines while truncation is "DISABLED".
  if (typeof wn.maxLines === "number") {
    t.textTruncation = "ENDING";
    t.maxLines = wn.maxLines;
  }
  if (typeof wn.opacity === "number") t.opacity = wn.opacity;
  return t;
}

// Resize to any authored fixed dimensions, keeping the node's measured size on an omitted axis. The 0.01
// floor is Figma's minimum — resize(0, …) throws. Shared by every non-auto-layout leaf (shape/svg/path).
function resizeToDims(node: any, wn: WriteNode): void {
  const dims = (wn.layout && wn.layout.dimensions) || {};
  if (typeof dims.width !== "number" && typeof dims.height !== "number") return;
  node.resize(Math.max(typeof dims.width === "number" ? dims.width : node.width, 0.01),
              Math.max(typeof dims.height === "number" ? dims.height : node.height, 0.01));
}

function buildShape(node: any, wn: WriteNode, ctx: RenderCtx): any {
  figma.currentPage.appendChild(node);
  if (!wn.fills) node.fills = []; // omitted fill -> transparent
  applyPaint(node, wn, ctx);
  resizeToDims(node, wn);
  return node;
}

function buildLine(wn: WriteNode, ctx: RenderCtx): any {
  const l = figma.createLine();
  figma.currentPage.appendChild(l);
  if (wn.strokes && wn.strokes.length) l.strokes = [paintOf(wn.strokes[0], ctx)];
  l.strokeWeight = wn.strokeWeight != null ? wn.strokeWeight : 1;
  const dims = (wn.layout && wn.layout.dimensions) || {};
  if (typeof dims.width === "number") l.resize(Math.max(dims.width, 0.01), 0); // a line is width-as-length, zero height
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
  resizeToDims(frame, wn);
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
  resizeToDims(v, wn);
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
  if (typeof wn.name === "string") node.name = wn.name;
  // blendMode is on every SceneNode (BlendMixin), so the shared dispatch is its single application point —
  // no per-builder repetition (unlike opacity, which predates this). The value is already the Figma enum.
  if (typeof wn.blendMode === "string") node.blendMode = wn.blendMode;
  applyRotation(node, wn);
  stampKey(node, wn, ctx);
  return node;
}

// rotation is on every SceneNode (LayoutMixin), so — like blendMode — it applies once here after the node
// is built and sized, not per-builder. The canonical (authored) value is CSS clockwise-positive, but
// Figma's raw `node.rotation` is COUNTERclockwise-positive, so NEGATE on write: the read side negates
// Figma→CSS on emit (figma-mcp), and a read value re-authored verbatim must not flip. Omitted at 0.
function applyRotation(node: any, wn: WriteNode): void {
  if (typeof wn.rotation === "number" && "rotation" in node) node.rotation = -wn.rotation;
}
