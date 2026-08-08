// fonts — resolve every text node's (family, weight) to a real, loaded Figma font style, and preload
// them before render() builds any text.
//
// Fonts must be loaded before a TextNode's characters/size are set or the plugin throws. In the
// inert-spec model the constructors are pure data and never touch fonts; only render() creates live
// nodes, and it's async — so loading lives here as a plain async function render() awaits. Keeping it
// out of module top level (no top-level await) is what lets the whole preamble bundle as a synchronous
// IIFE, which keeps every internal helper closure-private. Never move it to module scope.
//
// The snap is a real listAvailableFontsAsync nearest-style match (replacing the old fixed 4-Inter-weight
// bucket): a numeric/named weight resolves to the nearest AVAILABLE style of the requested family across
// the full weight ladder, and an unknown family falls back to Inter. We load exactly the styles this
// render needs, every render — font state is session-global, so a "looks loaded, skip" optimization
// only throws on a cold session; an idempotent reload is the price of that heisenbug never happening.
//
// The load pass returns a FontMap that render() threads on the RenderCtx through the build walk — load
// and resolve agree on the `key()` of each (family, weight) by construction, with no module-level state.

import { WriteNode, WriteChild, WriteProps, WriteTextStyle, namesFontIdentity } from "./ir.js";

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
function key(family: string | undefined, weight: number | string | undefined, italic: boolean): string {
  return (family || DEFAULT_FAMILY) + "|" + (weight == null ? "" : weight) + "|" + (italic ? "i" : "");
}

interface FontNeed { family?: string; weight?: number | string; italic?: boolean }

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

// Every font an edit's mutating span will touch, loaded BEFORE the mutation lock: fonts gate every
// reflowing text mutation, not just characters — size, clamp, and style writes throw on an unloaded
// font too. Two halves: the LIVE fonts (all range fonts when mixed — the reflow re-lays existing
// ranges), and the AUTHORED triples the appliers will resolve (loadFontsForTree over a synthetic
// one-node tree, so edit preloads exactly the way render does).
export async function loadFontsForTextEdit(node: TextNode, patch: WriteProps): Promise<FontMap> {
  const reflows =
    patch.text != null || patch.runs || patch.textStyle || patch.maxLines != null ||
    (patch.layout && (patch.layout.sizing || patch.layout.dimensions || patch.layout.percentSize));
  if (!reflows) return {};
  const live = node.fontName === figma.mixed ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName as FontName];
  await Promise.all(live.map((f) => figma.loadFontAsync(f)));
  const needsAuthored = namesFontIdentity(patch.textStyle) || (patch.runs || []).some((r) => namesFontIdentity(r.style));
  if (!needsAuthored) return {};
  return loadFontsForTree({ type: "TEXT", textStyle: patch.textStyle, runs: patch.runs });
}

export async function loadFontsForTree(tree: WriteNode): Promise<FontMap> {
  const avail = await figma.listAvailableFontsAsync();
  const byFamily: Record<string, string[]> = {};
  for (const { fontName } of avail) {
    (byFamily[fontName.family] || (byFamily[fontName.family] = [])).push(fontName.style);
  }
  const fallbackFamily = byFamily[DEFAULT_FAMILY] ? DEFAULT_FAMILY : avail.length ? avail[0].fontName.family : DEFAULT_FAMILY;

  const resolved: FontMap = {};
  const needs: FontNeed[] = [];
  collectText(tree, needs);
  for (const need of needs) {
    const k = key(need.family, need.weight, !!need.italic);
    if (resolved[k]) continue;
    const family = need.family && byFamily[need.family] ? need.family : fallbackFamily;
    const style = nearestStyle(byFamily[family] || ["Regular"], wantWeight(need.weight), !!need.italic);
    try {
      await figma.loadFontAsync({ family, style });
      resolved[k] = { family, style };
    } catch (e) {
      // The matched style label can still be rejected (label drift); fall back to Regular rather than
      // taking down the whole render over one node's font.
      await figma.loadFontAsync({ family, style: "Regular" }).catch(() => {});
      resolved[k] = { family, style: "Regular" };
    }
  }
  return resolved;
}

function collectText(wn: WriteChild, needs: FontNeed[]): void {
  if (!wn || typeof wn !== "object") return;
  if (wn.type === "TEXT") {
    const ts = wn.textStyle || {};
    needs.push({ family: ts.fontFamily, weight: ts.fontWeight, italic: ts.fontStyle === "italic" });
    // Each rich-text run may carry its own (family, weight, italic); preload those too so the bridge's
    // per-range setRangeFontName has the exact style loaded — a run that reaches the bridge with an
    // unloaded font fails loud (resolveFontStrict) rather than silently rendering in the base style.
    // The run's style carries the EFFECTIVE (family, weight, italic) triple whenever it changes any of
    // them (flcm.ts's compileRun), so this key matches what the bridge asks for.
    for (const run of wn.runs || []) {
      const rs = run.style || {};
      needs.push({ family: rs.fontFamily, weight: rs.fontWeight, italic: rs.fontStyle === "italic" });
    }
  }
  for (const kid of wn.children || []) collectText(kid, needs);
}

// Resolve an authored (family, weight) to a loaded style. The build walk only asks for pairs that the
// load pass already collected from the same tree, so a miss falls back to the default.
export function resolveFont(fonts: FontMap, family: string | undefined, weight: number | string | undefined, italic = false): { family: string; style: string } {
  return fonts[key(family, weight, italic)] || { family: DEFAULT_FAMILY, style: "Regular" };
}

// Strict resolve for a rich-text RUN: a run's font MUST have been preloaded (loadFontsForTree collects
// every run's pair). A miss means the run would otherwise render in the node's base style — the exact
// silent divergence ADR-0003 forbids — so throw a specific error instead of falling back. render() always
// preloads, so this fires only on an internal inconsistency, not normal authored input.
export function resolveFontStrict(fonts: FontMap, family: string | undefined, weight: number | string | undefined, italic = false): { family: string; style: string } {
  const font = fonts[key(family, weight, italic)];
  if (!font) {
    throw new Error("flcm.text: a run's font (" + (family || DEFAULT_FAMILY) + ", weight " + (weight == null ? "default" : weight) + (italic ? ", italic" : "") + ") was not loaded before render — the run would silently render in the base style. This is an internal error; report it.");
  }
  return font;
}
