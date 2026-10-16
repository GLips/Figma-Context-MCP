/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { awaitNative, currentHost } from "./host.js";
import { sceneFigma as figma } from "./scene-access.js";
// fonts — resolve every text node's (family, weight) to a real, loaded Figma font style, and preload
// them before render() builds any text.
//
// Fonts must be loaded before a TextNode's characters/size are set or the plugin throws. In the
// compilers are pure data and never touch fonts; only render() creates live
// nodes, and it's async — so loading lives here as a plain async function render() awaits. Keeping it
// out of module top level (no top-level await) is what lets the whole preamble bundle as a synchronous
// IIFE, which keeps every internal helper closure-private. Never move it to module scope.
//
// The snap is a real listAvailableFontsAsync nearest-style match (replacing the old fixed 4-Inter-weight
// bucket): a numeric/named weight resolves to the nearest AVAILABLE style of the requested family across
// the full weight ladder, and an unknown family falls back to Inter. We load exactly the styles this
// render needs, once per RUN — never trusting a load an earlier run made, so a cold session can't
// throw. Not once per verb: in a background window Figma answers only a handful of loadFontAsync
// calls per run and leaves the next pending forever (seen live: the 7th, every run), so each
// redundant call is a chance to stall the run.
//
// The load pass returns a FontMap that render() threads on the RenderCtx through the build walk — load
// and resolve agree on the `key()` of each (family, weight) by construction, with no module-level state.

import { WriteNode, WriteChild, WriteProps, WriteTextStyle, namesFontIdentity, isTokenRef } from "./ir.js";
import { variableLiteral, variableValues, styleFor, tokenKey, type ResolvedTokens } from "./tokens.js";
import type { Bindable, StyleRef, VariableRef } from "./ir.js";

// Every font this run has loaded, by Figma's own (family, style) label. Per-run, like every
// piece of preamble state: the preamble is eval'd fresh inside each run's wrapper, and a font a
// PREVIOUS run loaded is deliberately not trusted — Figma's font state is session-global, but
// "looks loaded" is the heisenbug the load pass already refuses to gamble on. The ledger exists
// for one reader: assertTextEditFontsLoaded, the gate that proves a verb's prepare-time load still
// covers the text it is about to reflow.
const loadedFonts = new Set<string>();

function fontLabel(font: { family: string; style: string }): string {
  return font.family + "\u0000" + font.style;
}

// Each style's load this run, settled or in flight, so concurrent verbs share one call. A failed
// load is forgotten, so a later verb may try it again.
const fontLoads = new Map<string, Promise<void>>();

// A run's caches belong to its run: its host and its document. Each run evals a fresh preamble, so
// in the plugin this never resets mid-run; in-process tests reuse one module across runs and mock
// documents, and must not share.
let cachesFor: { host: unknown; figma: unknown } = { host: null, figma: null };
function useRunCaches(): void {
  const host = currentHost();
  const current = (globalThis as { figma?: unknown }).figma;
  if (host === cachesFor.host && current === cachesFor.figma) return;
  cachesFor = { host, figma: current };
  loadedFonts.clear();
  fontLoads.clear();
  availableFonts = null;
}

function loadFont(font: { family: string; style: string }): Promise<void> {
  useRunCaches();
  const label = fontLabel(font);
  let load = fontLoads.get(label);
  if (!load) {
    load = awaitNative("font-load", () => figma.loadFontAsync(font)).then(() => {
      loadedFonts.add(label);
    });
    fontLoads.set(label, load);
    load.catch(() => fontLoads.delete(label));
  }
  return load;
}

// The available fonts, listed once per run for the same reason: a list is one more call to stall on.
let availableFonts: Promise<Font[]> | null = null;

function listAvailableFonts(): Promise<Font[]> {
  useRunCaches();
  if (!availableFonts) {
    const listing = awaitNative("font-list", () => figma.listAvailableFontsAsync());
    availableFonts = listing;
    listing.catch(() => {
      if (availableFonts === listing) availableFonts = null;
    });
  }
  return availableFonts;
}

// A resolved-and-loaded style per (family, weight) key — the output of the load pass, consumed by the
// build walk via resolveFont.
export type FontMap = Record<string, { family: string; style: string }>;

const DEFAULT_FAMILY = "Inter";

// CSS-ish weight names -> numeric, for both authored weights and parsing a style label's weight.
const NAMED: Record<string, number> = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, normal: 400, regular: 400,
  book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800,
  black: 900, heavy: 900,
};

function normKey(s: string): string { return s.toLowerCase().replace(/[\s-]/g, ""); }

// A Figma style label ("Semi Bold", "Bold Italic") -> its numeric weight (italics ignored for weight).
function styleWeight(style: string): number {
  const key = normKey(style.replace(/italic|oblique/gi, ""));
  return NAMED[key] != null ? NAMED[key] : 400;
}
function isItalic(style: string): boolean { return /italic|oblique/i.test(style); }

// An authored weight (number, "bold", or numeric string) -> numeric. Defaults to 400.
function wantWeight(weight: number | string | undefined): number {
  if (typeof weight === "number") return weight;
  if (typeof weight === "string") {
    const k = normKey(weight);
    if (NAMED[k] != null) return NAMED[k];
    const n = parseFloat(weight);
    if (isFinite(n)) return n;
  }
  return 400;
}

// Nearest available style by |weight - want|, matching the requested slant (italic vs upright). The
// slant mismatch penalty (1000) dominates the weight distance, so a wanted-italic snaps to the
// nearest italic weight and a wanted-upright never picks an italic — italic is a real request now
// (author `fontStyle: "italic"` / markdown `*…*`), not something to always avoid.
function nearestStyle(styles: string[], want: number, wantItalic: boolean): string {
  let best = styles[0];
  let bestDist = Infinity;
  for (const st of styles) {
    const dist = Math.abs(styleWeight(st) - want) + (isItalic(st) === wantItalic ? 0 : 1000);
    if (dist < bestDist) { bestDist = dist; best = st; }
  }
  return best;
}

// Keyed by `family|weight|italic` exactly as both the load pass and resolveFont compute it — italic
// is part of the identity because it selects a distinct Figma style (e.g. "Bold Italic"), so an
// upright and an italic of the same (family, weight) must load and resolve separately.
//
// A bound family or weight keys by its token, not its value: the load pass resolves the variable's
// default-mode value under that key, so the apply span finds the font without the tokens in hand.
function key(family: Bindable<string> | undefined, weight: Bindable<number | string> | undefined, italic: boolean): string {
  const word = (w: Bindable<number | string> | undefined) => (isTokenRef(w) ? "{" + tokenKey(w) + "}" : w);
  return (word(family) || DEFAULT_FAMILY) + "|" + (weight == null ? "" : word(weight)) + "|" + (italic ? "i" : "");
}

// A text style's font, keyed by the style token — its font is Figma's own, loaded by exact name.
function styleKey(ref: StyleRef): string {
  return "style|" + tokenKey(ref);
}

/** The font a text style lands in, loaded by the prepare that resolved the style. */
export function textStyleFont(fonts: FontMap, ref: StyleRef): { family: string; style: string } {
  const font = fonts[styleKey(ref)];
  if (!font) throw new Error(ref.word + ": the text style's font was not loaded before the write. This is an internal error; report it.");
  return font;
}

interface FontNeed { family?: Bindable<string>; weight?: Bindable<number | string>; italic?: boolean }

function needOf(ts: WriteTextStyle): FontNeed {
  return { family: ts.fontFamily, weight: ts.fontWeight, italic: ts.fontStyle === "italic" };
}

// A need with its bound words read off the tokens: the default mode's value first (the font the
// node is written in, and the one its key resolves to), then every other mode's — a mode switch
// re-fonts the node, and Figma refuses an unloaded font.
function literalNeeds(need: FontNeed, tokens: ResolvedTokens | undefined): { family?: string; weight?: number | string }[] {
  const values = <T>(word: Bindable<T> | undefined, cast: (v: unknown) => T): (T | undefined)[] =>
    isTokenRef(word) ? [cast(variableLiteral(word as VariableRef, tokens)), ...variableValues(word as VariableRef, tokens).map(cast)] : [word];
  const out: { family?: string; weight?: number | string }[] = [];
  for (const family of values(need.family, String)) for (const weight of values(need.weight, Number)) out.push({ family, weight });
  return out;
}

// A live FontName decoded into authored font words — the ONLY translation from Figma's combined
// style label ("Bold Italic" carries weight AND slant in one string) back into the (family, weight,
// slant) triple this module keys on. Label grammar lives here, beside NAMED/styleWeight, so a new
// label shape is handled once — edit's live-node enrichment must ride this, never re-parse.
export function liveFontWords(fontName: { family: string; style: string }): WriteTextStyle {
  return {
    fontFamily: fontName.family,
    fontWeight: styleWeight(fontName.style),
    fontStyle: isItalic(fontName.style) ? "italic" : "normal",
  };
}

// One edit entry's node + compiled delta — the unit the load below works over. Deliberately ANY
// SceneNode, not just TEXT: the filter belongs here, beside the reflow filter it sits next to, so
// no caller has to know that a non-text entry contributes nothing.
export interface EditFontNeed { node: SceneNode; patch: WriteProps }

// Whether a compiled delta re-lays the text: fonts gate every reflowing text mutation, not just
// characters — size, clamp, and style writes throw on an unloaded font too.
//
// Deliberately keyed on the WORD GROUP (`patch.textStyle` whole), not on individual style leaves:
// a new text word added inside textStyle is covered the day it lands, and cannot ship as a write
// that throws at apply time because nobody remembered to register it here. A new TOP-LEVEL text
// word (a sibling of `text`/`runs`/`maxLines`) gets no such cover and MUST be added below.
function textEditReflows(patch: WriteProps): boolean {
  return (
    patch.text != null || !!patch.runs || !!patch.textStyle || patch.maxLines != null ||
    !!(patch.layout && (patch.layout.sizing || patch.layout.dimensions || patch.layout.percentSize))
  );
}

// Every font a mutating verb's span will touch, loaded in its read-only PREPARE phase (before the
// entry seal). Two halves: the LIVE fonts (all range fonts when mixed — the reflow re-lays existing
// ranges), and the AUTHORED triples the appliers will resolve (loadFontsForTree over a synthetic
// tree, so an edit preloads exactly the way render does).
//
// Plural because a BATCH is one verb: N entries share one listAvailableFontsAsync inside
// loadFontsForTree and one Promise.all over the live fonts, instead of paying a serial round trip
// per entry. The `edits` are prepare's HINT — plans compiled against the node as it stood before
// the round trip; the gate compiles again and assertTextEditFontsLoaded proves this load still
// covers what it compiled.
//
// `built` are the compiled trees the same verb will BUILD (an instance delta's slot content): their
// fonts are a tree's, and they join the authored half so the verb still pays one load.
export async function loadFontsForTextEdits(edits: readonly EditFontNeed[], built: readonly WriteNode[] = [], tokens?: ResolvedTokens): Promise<FontMap> {
  const reflowing = edits.filter(({ node, patch }) => node.type === "TEXT" && textEditReflows(patch));
  if (!reflowing.length && !built.length) return {};
  const live: FontName[] = [];
  for (const { node } of reflowing) live.push(...liveFontsOf(node as TextNode));
  await Promise.all(live.map(loadFont));
  const authored = reflowing.filter(
    ({ patch }) => patch.textStyle?.style || namesFontIdentity(patch.textStyle) || (patch.runs || []).some((r) => namesFontIdentity(r.style)),
  );
  if (!authored.length && !built.length) return {};
  return loadFontsForTree({
    type: "FRAME",
    children: [...authored.map(({ patch }): WriteChild => ({ type: "TEXT", textStyle: patch.textStyle, runs: patch.runs })), ...built],
  }, tokens);
}

// The fonts a TEXT node carries right now — every range's when mixed, since a reflow re-lays them all.
function liveFontsOf(node: TextNode): FontName[] {
  return node.fontName === figma.mixed ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName as FontName];
}

/**
 * The GATE side of loadFontsForTextEdits: prove, in the sync stretch before the seal, that what
 * prepare loaded covers what this delta — compiled a moment ago against the LIVE node — is about
 * to write. Two halves, mirroring the load: the node's live fonts (a reflow throws on an unloaded
 * one), and every authored triple the appliers will resolve. A miss means the node's font changed
 * during the resource round trip, so the delta was enriched against an identity that is gone — or
 * the agent's own family isn't loaded, which the load pass makes impossible. Refused with zero
 * writes rather than left to resolveFont's silent default-family fallback, the one outcome this
 * surface never allows.
 */
export function assertTextEditFontsLoaded(node: SceneNode, patch: WriteProps, fonts: FontMap, subject: string): void {
  if (node.type !== "TEXT" || !textEditReflows(patch)) return;
  const t = node as TextNode;
  const who = JSON.stringify(t.name) + " (id " + JSON.stringify(t.id) + ")";
  for (const font of liveFontsOf(t)) {
    if (loadedFonts.has(fontLabel(font))) continue;
    throw new Error(
      subject + ": the font of " + who + " changed to " + font.family + " " + font.style +
        " while this call was loading fonts and images, so the delta was resolved against a node that no longer exists in that state. Nothing was applied — re-run the call.",
    );
  }
  const authored: FontNeed[] = [];
  if (namesFontIdentity(patch.textStyle)) authored.push(needOf(patch.textStyle!));
  for (const run of patch.runs || []) if (run.style && namesFontIdentity(run.style)) authored.push(needOf(run.style));
  const style = patch.textStyle?.style;
  if (style && !fonts[styleKey(style)]) {
    throw new Error(subject + ": " + who + " sets a text style whose font this call did not load. This is an internal error; report it.");
  }
  for (const need of authored) {
    if (fonts[key(need.family, need.weight, !!need.italic)]) continue;
    throw new Error(
      subject + ": " + who + " needs " + (isTokenRef(need.family) ? "its bound family" : need.family || DEFAULT_FAMILY) + " (weight " + (need.weight == null ? "default" : need.weight) + (need.italic ? ", italic" : "") +
        "), which this call did not load — the text's font changed while the call was loading fonts and images. Nothing was applied — re-run the call.",
    );
  }
}

export async function loadFontsForTree(tree: WriteNode, tokens?: ResolvedTokens): Promise<FontMap> {
  const avail = await listAvailableFonts();
  const byFamily: Record<string, string[]> = {};
  for (const { fontName } of avail) {
    (byFamily[fontName.family] || (byFamily[fontName.family] = [])).push(fontName.style);
  }
  const fallbackFamily = byFamily[DEFAULT_FAMILY] ? DEFAULT_FAMILY : avail.length ? avail[0].fontName.family : DEFAULT_FAMILY;

  const resolved: FontMap = {};
  const needs: FontNeed[] = [];
  const styles: StyleRef[] = [];
  collectText(tree, needs, styles);
  for (const ref of styles) {
    const font = (styleFor(ref, tokens) as TextStyle).fontName;
    await loadFont(font);
    resolved[styleKey(ref)] = font;
  }
  const loadNearest = async (want: { family?: string; weight?: number | string }, italic: boolean) => {
    const family = want.family && byFamily[want.family] ? want.family : fallbackFamily;
    const style = nearestStyle(byFamily[family] || ["Regular"], wantWeight(want.weight), italic);
    try {
      await loadFont({ family, style });
      return { family, style };
    } catch (e) {
      // The matched style label can still be rejected (label drift); fall back to Regular rather than
      // taking down the whole render over one node's font.
      await loadFont({ family, style: "Regular" }).catch(() => {});
      return { family, style: "Regular" };
    }
  };
  for (const need of needs) {
    const k = key(need.family, need.weight, !!need.italic);
    if (resolved[k]) continue;
    const [first, ...otherModes] = literalNeeds(need, tokens);
    resolved[k] = await loadNearest(first, !!need.italic);
    for (const other of otherModes) await loadNearest(other, !!need.italic);
  }
  return resolved;
}

function collectText(wn: WriteChild, needs: FontNeed[], styles: StyleRef[]): void {
  if (!wn || typeof wn !== "object") return;
  // A live text's fonts are its edit delta's, loaded with the live tree (live-tree.ts).
  if (wn.liveId === undefined && wn.type === "TEXT") {
    const ts = wn.textStyle || {};
    needs.push(needOf(ts));
    if (ts.style) styles.push(ts.style);
    // Each rich-text run may carry its own (family, weight, italic); preload those too so the bridge's
    // per-range setRangeFontName has the exact style loaded — a run that reaches the bridge with an
    // unloaded font fails loud (resolveFontStrict) rather than silently rendering in the base style.
    // The run's style carries the EFFECTIVE (family, weight, italic) triple whenever it changes any of
    // them (compile-text.ts's compileRun), so this key matches what the bridge asks for.
    for (const run of wn.runs || []) needs.push(needOf(run.style || {}));
  }
  for (const kid of wn.children || []) collectText(kid, needs, styles);
}

// Resolve an authored (family, weight) to a loaded style. The build walk only asks for pairs that the
// load pass already collected from the same tree, so a miss falls back to the default.
export function resolveFont(fonts: FontMap, family: Bindable<string> | undefined, weight: Bindable<number | string> | undefined, italic = false): { family: string; style: string } {
  return fonts[key(family, weight, italic)] || { family: DEFAULT_FAMILY, style: "Regular" };
}

/** One authored font word the loaded font does not honour, in WarningRecord's prop/authored/realized shape. */
interface FontDivergence { prop: "fontFamily" | "fontWeight" | "fontStyle"; authored: string | number; realized: string }

// Where the resolved font departs from what was written: an unavailable family falls back, a weight snaps
// to the nearest style the family has, an italic the family lacks comes out upright. Only AUTHORED words
// are compared — an omitted word has no intent to depart from. The realized side is Figma's own label, so
// a style whose weight the label grammar can't read still shows what was actually bound.
// A bound word is skipped: the variable, not the author, chose the value, and it changes per mode.
export function fontDivergences(family: Bindable<string> | undefined, weight: Bindable<number | string> | undefined, italic: boolean, font: { family: string; style: string }): FontDivergence[] {
  const out: FontDivergence[] = [];
  if (isTokenRef(family)) family = undefined;
  if (isTokenRef(weight)) weight = undefined;
  if (family && family !== font.family) out.push({ prop: "fontFamily", authored: family, realized: font.family });
  if (weight != null && styleWeight(font.style) !== wantWeight(weight)) out.push({ prop: "fontWeight", authored: weight, realized: font.style });
  if (italic && !isItalic(font.style)) out.push({ prop: "fontStyle", authored: "italic", realized: font.style });
  return out;
}

// Strict resolve for a rich-text RUN: a run's font MUST have been preloaded (loadFontsForTree collects
// every run's pair). A miss means the run would otherwise render in the node's base style — the exact
// silent divergence ADR-0003 forbids — so throw a specific error instead of falling back. render() always
// preloads, so this fires only on an internal inconsistency, not normal authored input.
export function resolveFontStrict(fonts: FontMap, family: Bindable<string> | undefined, weight: Bindable<number | string> | undefined, italic = false): { family: string; style: string } {
  const font = fonts[key(family, weight, italic)];
  if (!font) {
    throw new Error("TEXT: a run's font (" + (isTokenRef(family) ? "bound family" : family || DEFAULT_FAMILY) + ", weight " + (weight == null ? "default" : weight) + (italic ? ", italic" : "") + ") was not loaded before render — the run would silently render in the base style. This is an internal error; report it.");
  }
  return font;
}
