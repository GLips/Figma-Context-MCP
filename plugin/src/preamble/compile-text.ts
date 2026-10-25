/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// compile-text — the TEXT compiler and the text vocabulary it shares with edit: text styles, runs
// (markdown or explicit), case, clamp and hyperlinks.

import type { Accepted } from "./authoring-input.js";
import { keySet, WORD_GROUPS, WORD_VALUES, type WordValue } from "./vocabulary.js";
import { BuiltNode, WriteProps, WriteTextStyle, WriteTextRun, TextAlign, TextDecoration, WriteTextCase } from "./ir.js";
import { parseInlineMarkdown, MdSegment } from "./markdown.js";
import { length, lineHeight, letterSpacing, isPercent } from "./css.js";
import { rejectUnknownKeys, own, oneOf, words, assertEnum } from "./validate.js";
import { compileStyleRef, compileBindable, refuseTokenInput } from "./tokens.js";
import { FlcmError } from "./flcm-error.js";

// The authoring surface (verb Props + gradient/effects sugar) is defined ONCE in schema.ts as zod schemas
// with per-field docs; these are the z.infer'd types. Imported `import type` ONLY so schema.ts's zod is
// erased by esbuild and never reaches the sandbox bundle. Change a prop by editing the schema, not here.
import type { FrameProps, TextProps, TextRunInput, StyleDeltaInput } from "./schema.js";
import { mapCssWord, assertScalarType, base, compilePaintSlot, buildLayout, compilePaintWord, locatedParse } from "./compile-nodes.js";
import { compileBindings } from "./compile-component-words.js";

// CSS text-transform / font-variant-caps -> Figma's ONE textCase enum. Two author words, one slot,
// which is why compileTextCase refuses a style naming both rather than letting the later key win.
const TEXT_TRANSFORM: Record<WordValue<"textTransform">, WriteTextCase> = {
  uppercase: "UPPER", lowercase: "LOWER", capitalize: "TITLE", none: "ORIGINAL",
};
const FONT_VARIANT: Record<WordValue<"fontVariant">, WriteTextCase> = {
  "small-caps": "SMALL_CAPS", "all-small-caps": "SMALL_CAPS_FORCED",
};

// `at` is the style's spec path (a node's textStyle, or a run's style), as in every text compile below.
function compileTextCase(c: { textTransform?: unknown; fontVariant?: unknown }, at: string): WriteTextCase | undefined {
  if (c.textTransform != null && c.fontVariant != null) {
    throw new FlcmError(
      "authoring",
      "textTransform and fontVariant are two CSS properties for Figma's one text-case setting, so they can't both be set — name whichever you mean. " +
        '(To clear a small-caps, use textTransform: "none".)',
      { path: at },
    );
  }
  if (c.textTransform != null) return mapCssWord(at + ".textTransform", c.textTransform, TEXT_TRANSFORM);
  if (c.fontVariant != null) return mapCssWord(at + ".fontVariant", c.fontVariant, FONT_VARIANT);
  return undefined;
}

const TEXT_ALIGN_VERTICAL: ReadonlySet<NonNullable<WriteTextStyle["textAlignVertical"]>> = new Set(WORD_VALUES.textAlignVertical);

// A hyperlink leaf: an author URL string, or the read form ({ type: "URL", url }) so a `get` result
// round-trips without the caller unwrapping it. A NODE link — Figma's other kind, a jump to another
// node in the design — has no authored form at all, so it rejects BY NAME instead of dropping the
// link silently and handing back a node the agent believes still carries it.
function parseHyperlink(value: unknown, path: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const h = value as { type?: unknown; url?: unknown };
    if (h.type === "URL" && typeof h.url === "string" && h.url.trim()) return h.url;
    if (h.type === "NODE") {
      throw new FlcmError("authoring", "that is a NODE hyperlink (a jump to another node in the design) — Figma has no way for a plugin to author one. Point it at a URL, or drop the field.", { path });
    }
  }
  throw new FlcmError("authoring", 'must be a non-empty URL string, or the read form { type: "URL", url } — got ' + JSON.stringify(value) + ".", { path });
}

// Read-shape text leaves that are NOT authoring input, so a spread `{ ...node.textStyle, fontSize: 18 }`
// still compiles instead of dying on the closed-set gate. Two dispositions, deliberately different:
//   • IGNORED — purely DERIVED, its information already elsewhere in the same style, so dropping it
//     loses nothing. `fontVariantName` ("Bold Italic") IS fontWeight + fontStyle, restated as Figma's
//     own label; there is nothing to write that the triple doesn't already say.
//   • REFUSED — real state the plugin API cannot write. Named with its reason, because silently
//     dropping it would hand back a node the agent believes carries it (ADR-0003).
const IGNORED_READ_TEXT_LEAVES = ["fontVariantName"];
const REFUSED_READ_TEXT_LEAVES: Record<string, string> = {
  opentypeFlags: "OpenType features are read-only to a plugin — TextNode.openTypeFeatures has no setter and no setRange* counterpart [verified, plugin-typings 1.133]",
};
// A RUN's refusals add the two alignment words. Both are legal on the BASE (they're whole-node
// properties, which is exactly the point) but a run delta can carry them too — the read side emits them
// as inverse overrides of a non-default base — and Figma has no setRangeTextAlignHorizontal/Vertical
// [verified, plugin-typings 1.133], so one span cannot align differently from its node. Named here rather
// than left to the unknown-prop gate, which would diagnose a real read leaf as a typo.
const REFUSED_RUN_TEXT_LEAVES: Record<string, string> = {
  ...REFUSED_READ_TEXT_LEAVES,
  textAlign: "horizontal alignment is a whole-node property in Figma (no setRangeTextAlignHorizontal), so a single run can't set it — move it to the node's textStyle",
  textAlignVertical: "vertical alignment is a whole-node property in Figma (no setRangeTextAlignVertical), so a single run can't set it — move it to the node's textStyle",
};

// The closed set each text-style carrier accepts as INPUT: its own words plus the derived read leaves
// it drops. Built from the vocabulary groups so the tolerated extras stay
// visibly separate from the authoring surface — they are not props, and the docs must not list them.
// `value` is the read's resolved literal beside a `style`, ignored; compileTextStyleWords refuses it alone.
const TEXTSTYLE_INPUT_KEYS = keySet(WORD_GROUPS.textStyle, IGNORED_READ_TEXT_LEAVES, ["value"]);
const RUN_INPUT_KEYS = keySet(WORD_GROUPS.run, IGNORED_READ_TEXT_LEAVES);

function rejectUnauthorableTextLeaves(c: object, at: string, refused: Record<string, string> = REFUSED_READ_TEXT_LEAVES): void {
  for (const leaf of Object.keys(refused)) {
    if (c.hasOwnProperty(leaf)) {
      throw new FlcmError("authoring", "flcm can't write this — " + refused[leaf] + ". Drop it from the style.", { path: at + "." + leaf });
    }
  }
}

// What a text style sets on its own: the words refused beside `style` on a node, and refused on a run
// of a node whose style this call sets (the queued style link would overwrite them).
const TEXT_STYLE_COVERED_WORDS = [
  "fontFamily", "fontWeight", "fontSize", "fontStyle", "lineHeight", "letterSpacing", "textDecoration",
  "textTransform", "fontVariant", "paragraphSpacing", "paragraphIndent", "listSpacing",
];

// fontFamily / fontWeight / fontSize, shared by the base and a run: each a literal or a variable
// (STRING for the family, FLOAT for the numbers — Figma binds a weight as a number).
function compileTextFontWords(c: Record<string, unknown>, ts: WriteTextStyle, at: string): void {
  if (c.fontSize != null) ts.fontSize = compileBindable(c.fontSize, at + ".fontSize", "FLOAT", (v: unknown) => { assertScalarType(v, "number", at + ".fontSize"); return v as number; });
  // The one non-scalar-typed leaf: a number (700) or a name ("bold"). Anything else must reject —
  // wantWeight would silently read it as 400, a whole-node reset to regular.
  if (c.fontWeight != null) {
    ts.fontWeight = compileBindable(c.fontWeight, at + ".fontWeight", "FLOAT", (v: unknown) => {
      if (typeof v !== "number" && typeof v !== "string") {
        throw new FlcmError("authoring", 'must be a number (400, 700), a weight name ("bold", "semibold"), or { variable } — got ' + JSON.stringify(v) + ".", { path: at + ".fontWeight" });
      }
      return v;
    });
  }
  if (c.fontFamily != null) ts.fontFamily = compileBindable(c.fontFamily, at + ".fontFamily", "STRING", (v: unknown) => { assertScalarType(v, "string", at + ".fontFamily"); return v as string; });
}

// The text words a BASE style and a RUN delta share — casing, paragraph metrics, links. Written once
// because Figma applies every one of them per range (setRangeTextCase/setRangeParagraph*/…), so the
// two carriers differ only in which range they cover, never in what the word means.
function compileSharedTextWords(c: Record<string, unknown>, ts: WriteTextStyle, at: string): void {
  const textCase = compileTextCase(c, at);
  if (textCase) ts.textCase = textCase;
  if (c.paragraphSpacing != null) ts.paragraphSpacing = compileBindable(c.paragraphSpacing, at + ".paragraphSpacing", "FLOAT", lengthAt(at + ".paragraphSpacing"));
  if (c.paragraphIndent != null) ts.paragraphIndent = compileBindable(c.paragraphIndent, at + ".paragraphIndent", "FLOAT", lengthAt(at + ".paragraphIndent"));
  if (c.listSpacing != null) {
    refuseTokenInput(c.listSpacing, at + ".listSpacing", "listSpacing has no variable binding in Figma");
    ts.listSpacing = lengthAt(at + ".listSpacing")(c.listSpacing as number | string);
  }
}

function lengthAt(path: string): (v: number | string) => number {
  return (v) => locatedParse(() => length(v), path);
}

// The textStyle word compile every text carrier rides — TEXT's base and an edit delta alike
// (one vocabulary, one parser). One word in the group is deliberately NOT compiled here: lineClamp
// validates against a width the two callers know differently (create: the authored width; edit: the
// live wrap state), so each reads cfg.lineClamp itself. (`boldWeight` is a node-level word, not a
// style: it is the CONTENT-compile convention for what `**` resolves to, so it rides into
// compileTextContent and never onto the IR.)
// Exported for edit-plan.ts.
export function compileTextStyleWords(cfg: unknown, at: string): WriteTextStyle {
  // QuickJS boundary: a present-but-malformed value must reject the whole call, not read as absence.
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
    throw new FlcmError("authoring", "must be an object like { fontSize, fontWeight, … } — got " + JSON.stringify(cfg) + ".", { path: at });
  }
  const c = cfg as NonNullable<TextProps["textStyle"]>;
  rejectUnauthorableTextLeaves(c, at);
  rejectUnknownKeys(c, TEXTSTYLE_INPUT_KEYS, at);
  const ts: WriteTextStyle = {};
  const raw = c as Record<string, unknown>;
  if (raw.value !== undefined && raw.style == null) {
    throw new FlcmError("authoring", "`value` is what a read's text `style` resolves to, and is only accepted beside `style`. Give the properties themselves (fontSize, fontWeight, …).", { path: at + ".value" });
  }
  if (raw.style != null) {
    const covered = TEXT_STYLE_COVERED_WORDS.filter((word) => raw[word] != null);
    if (covered.length) {
      throw new FlcmError(
        "authoring",
        "a text style sets " + covered.join(", ") + " itself, so " + (covered.length === 1 ? "it" : "they") +
          " can't be set beside `style` — drop " + (covered.length === 1 ? "it" : "them") + ", or drop `style` and give every property literally. Only textAlign, textAlignVertical, hyperlink and lineClamp can be set beside a style.",
        { path: at },
      );
    }
    ts.style = compileStyleRef(raw.style, at + ".style", "TEXT");
  }
  compileTextFontWords(raw, ts, at);
  if (c.fontStyle != null) ts.fontStyle = assertEnum(at + ".fontStyle", c.fontStyle, FONT_STYLE);
  if (c.lineHeight != null) ts.lineHeight = compileBindable(c.lineHeight, at + ".lineHeight", "FLOAT", (v: number | string) => locatedParse(() => lineHeight(v), at + ".lineHeight"));
  if (c.letterSpacing != null) ts.letterSpacing = compileBindable(c.letterSpacing, at + ".letterSpacing", "FLOAT", (v: number | string) => locatedParse(() => letterSpacing(v), at + ".letterSpacing"));
  if (c.textDecoration != null) ts.textDecoration = assertEnum(at + ".textDecoration", c.textDecoration, TEXT_DECORATION);
  if (c.textAlign != null) ts.textAlign = assertEnum(at + ".textAlign", c.textAlign, TEXT_ALIGN);
  if (c.textAlignVertical != null) ts.textAlignVertical = assertEnum(at + ".textAlignVertical", c.textAlignVertical, TEXT_ALIGN_VERTICAL);
  if (c.hyperlink != null) ts.hyperlink = parseHyperlink(c.hyperlink, at + ".hyperlink");
  compileSharedTextWords(c as Record<string, unknown>, ts, at);
  return ts;
}

// The text prop compiles to plain content or styled runs for both create and edit. Both the runs-array and plain-string forms flow through the markdown parser (markdown.ts):
// a plain string may carry `**bold**` or literal escapes; a runs-array entry's text is markdown
// too. `base` is the style each styled run layers over (create: the authored textStyle; edit: the
// delta's textStyle enriched with the live node's font identity, so a run that only bolds inherits
// the family the node actually uses). A plain string that parses to a single flagless segment
// stays plain `text`; anything richer becomes `runs`. `at` is the node's spec path. Exported for edit-plan.ts.
export function compileTextContent(content: unknown, base: WriteTextStyle, at: string, boldWeight?: number | string): { text?: string; runs?: WriteTextRun[] } {
  if (boldWeight != null && typeof boldWeight !== "number" && typeof boldWeight !== "string") {
    throw new FlcmError("authoring", 'must be a number (400, 700) or a weight name ("bold", "semibold") — got ' + JSON.stringify(boldWeight) + ".", { path: at + ".boldWeight" });
  }
  const textAt = at + ".text";
  if (Array.isArray(content)) {
    const runs = compileRuns(content, base, textAt, boldWeight);
    return runs.length ? { runs } : { text: "" };
  }
  const segs = parseMarkdownAt(plainString(content), textAt);
  if (segs.length === 1 && isPlainSeg(segs[0])) return { text: segs[0].text };
  if (!segs.length) return { text: "" };
  return { runs: segs.map((seg) => compileRun(seg.text, mergeDelta(seg, {}, boldWeight), base, textAt)) };
}

export function compileText(props: Accepted<TextProps>, at: string): BuiltNode {
  const content = props.text;
  const wn: BuiltNode = { type: "TEXT" };
  base(wn, props, at);
  compileBindings(wn, props, "TEXT", at);
  // The text's paint is `fill`, like every other node's. "none" is the same removal word edit takes.
  if (props.fill != null) compilePaintSlot(wn, props.fill, "fill", at);
  const cfg = (props.textStyle ?? {}) as NonNullable<TextProps["textStyle"]>;
  const ts = compileTextStyleWords(cfg, at + ".textStyle");
  if (Object.keys(ts).length) wn.textStyle = ts;
  // An absent `text` stays absent: the builder writes "" for it anyway, and a binding reads the
  // absence as "no content of its own", so the layer takes its property's default (component.ts boundLayerValue).
  if (content != null) Object.assign(wn, compileTextContent(content, ts, at, props.boldWeight ?? undefined));
  else if (props.boldWeight != null) {
    throw new FlcmError("authoring", "`boldWeight` says what `**` in `text` resolves to, and this node has no `text` — pass the content as `text`, or drop it.", { path: at + ".boldWeight" });
  }
  assertRunColorsBesideFillStyle(wn, at);
  // lineClamp "none" at create is the explicit default — no clamp to remove, nothing lands.
  if (cfg.lineClamp != null && cfg.lineClamp !== "none") wn.maxLines = assertLineClamp(cfg.lineClamp, props.width, at);
  const layout = buildLayout(props as FrameProps, "TEXT", at);
  if (Object.keys(layout).length) wn.layout = layout;
  return wn;
}

// The fill style's link lands after the runs (the lock's queued write) and repaints every character,
// so a run color beside it would be silently overwritten. Shared by create and edit; `at` is the node's path.
export function assertRunColorsBesideFillStyle(wn: WriteProps, at: string): void {
  if (wn.styles?.fill && wn.runs?.some((run) => run.fills)) {
    throw new FlcmError("authoring", "a fill style repaints the whole text, so a run's color can't be set beside it — drop the run colors, or give the node a literal fill.", { path: at + ".text" });
  }
}

// N's shape gate, shared by create and edit so one author mistake reads one error. "none" is each
// caller's, before this: create skips it (the explicit default), edit compiles it to the removal.
// Boundedness is also the caller's — create knows the authored width, edit the live wrap state.
// `at` is the node's spec path.
export function assertLineClampCount(lineClamp: unknown, at: string): number {
  if (typeof lineClamp !== "number" || !Number.isInteger(lineClamp) || lineClamp < 1) {
    throw new FlcmError("authoring", 'must be a whole number ≥ 1 or "none" — got ' + JSON.stringify(lineClamp) + ".", { path: at + ".textStyle.lineClamp" });
  }
  return lineClamp;
}

// lineClamp clamps a text to N lines with an ending ellipsis, but truncation only bites when the text has a
// bounded width to wrap against — buildText wires a fixed/`"fill"`/`"N%"` width to height-only auto-resize,
// giving it a wrap; a width-hugging text grows sideways on one line, so there's nothing to clamp. Rather
// than let `lineClamp` be a silent no-op there (ADR-0003), reject it loud and name the fix.
function assertLineClamp(lineClamp: unknown, width: TextProps["width"], at: string): number {
  const n = assertLineClampCount(lineClamp, at);
  const bounded = typeof width === "number" || width === "fill" || isPercent(width);
  if (!bounded) {
    throw new FlcmError("authoring", 'needs a bounded width to truncate against — set width to a number, "fill", or "N%". A width-hugging text grows on one line, so there is nothing to wrap and clamp.', { path: at + ".textStyle.lineClamp" });
  }
  return n;
}

// Realizable subsets for the two enum-valued text-style leaves. zod's enums (schema.ts) are type/doc only
// and never enter the sandbox, so THESE are the runtime fail-loud gates (ADR-0003): a valid-CSS-but-
// unrealizable value (fontStyle "oblique", textDecoration "overline") is rejected naming the supported set
// rather than silently dropped.
const FONT_STYLE: ReadonlySet<WordValue<"fontStyle">> = new Set(WORD_VALUES.fontStyle);
const TEXT_DECORATION: ReadonlySet<TextDecoration> = new Set(WORD_VALUES.textDecoration);
const TEXT_ALIGN: ReadonlySet<TextAlign> = new Set(WORD_VALUES.textAlign);

// Identity-validate an enum-valued prop against its realizable set, returning the value narrowed to the
// set's member type via the `oneOf` guard (no cast at the call site). The runtime fail-loud gate for props
// whose zod enum is type/doc-only (never in the sandbox); `words` renders the allowed set, shared with the
// directional-prop gate.

// TEXT takes PLAIN text OR a runs array (see compileRuns); an object arriving first is the props —
// see text(). (A stray `**` in a plain string is NOT rejected: it is markdown now, gated on the escape
// convention — an author who wants a literal `**` writes `\*\*`, which decodes back to the literal.)
function plainString(content: unknown): string {
  return content == null ? "" : String(content);
}

// figma-mcp compressed read-side rich text by wrapping spans in inline style-ref tokens ({ts1}…{/ts1}); a
// retired READ format distinct from the authored runs form. Writing it back verbatim renders the tokens
// literally, so reject it on the RAW input, BEFORE markdown decode — an author who wants a literal "{ts1}"
// escapes the braces (`\{ts1\}`), which doesn't match this pattern and decodes back to the literal. Never
// re-run on decoded text, or that escaped-literal round-trip would false-positive.
function assertNotReadToken(s: string, path: string): string {
  if (/\{\/?ts\d+\}/.test(s)) {
    throw new FlcmError("authoring", "this text carries style-reference tokens ({tsN}…{/tsN}) from a compressed read. Strip the inline styling, or express the styling as a runs array.", { path });
  }
  return s;
}

// Markdown refusals (markdown.ts) don't know which text they read, so they're located here.
function parseMarkdownAt(raw: string, path: string): MdSegment[] {
  return locatedParse(() => parseInlineMarkdown(assertNotReadToken(raw, path)), path);
}

const isPlainSeg = (seg: MdSegment): boolean => !seg.bold && !seg.italic && !seg.strike && seg.hyperlink === undefined;

// Compile the author's runs array into typed WriteTextRuns. Each entry is a bare string (plain segment) or
// a `[text, StyleDelta]` tuple (a styled span) — the canonical run model, so read output re-authors
// verbatim. The entry's TEXT is itself markdown (read renders a run's decorations INSIDE its text), so it
// is parsed and may expand to several runs; each carries the entry's residual StyleDelta merged UNDER the
// markdown flags (an explicit delta field wins over the field the markdown implied — e.g. a non-canonical
// heavy weight overrides the plain `**` bold). The `{tsN}` rejection runs on the raw entry text, pre-decode.
function compileRuns(runs: TextRunInput[], baseStyle: WriteTextStyle, at: string, boldWeight?: number | string): WriteTextRun[] {
  if (!runs.length) {
    throw new FlcmError("authoring", "a runs array must be non-empty — pass at least one run (a string or a [text, style] tuple).", { path: at });
  }
  const out: WriteTextRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    let raw: string;
    let delta: StyleDeltaInput;
    if (typeof run === "string") { raw = run; delta = {}; }
    else if (Array.isArray(run) && typeof run[0] === "string") { raw = run[0]; delta = run[1] ?? {}; }
    else {
      throw new FlcmError("authoring", 'each run is a plain string or a [text, style] tuple like ["bold bit", { fontWeight: 700 }] — got ' + JSON.stringify(run) + ".", { path: at + "[" + i + "]" });
    }
    // The run delta is the grounded silent-drop site: compileRun reads a positive list and never looked at
    // the rest, so a typo'd `textTransfrom` on a run vanished. Reject it here, on the raw author delta.
    const styleAt = at + "[" + i + "][1]";
    rejectUnauthorableTextLeaves(delta, styleAt, REFUSED_RUN_TEXT_LEAVES);
    rejectUnknownKeys(delta, RUN_INPUT_KEYS, styleAt);
    for (const seg of parseMarkdownAt(raw, at + "[" + i + "]")) {
      out.push(compileRun(seg.text, mergeDelta(seg, delta, boldWeight), baseStyle, styleAt));
    }
  }
  return out;
}

// Markdown flags → StyleDelta fields, then overlay the tuple's explicit delta so an explicit field wins
// over the one the markdown implied. `\n`-decoded newlines and every other char already live in seg.text.
//
// `**` resolves to the NODE's bold weight, not a global 700. The read side compresses a bold span to
// markdown and reports the weight it stood for ONCE, on the node (`boldWeight`) — it deliberately omits
// the per-run `fontWeight` when the run matches that weight, so the node-level word is the only carrier.
// Defaulting to "bold" here regardless would re-render a Semi Bold (600) emphasis at 700: silently wrong
// pixels on the commonest mixed-weight text there is.
function mergeDelta(seg: MdSegment, explicit: StyleDeltaInput, boldWeight?: number | string): StyleDeltaInput {
  const d: StyleDeltaInput = {};
  if (seg.bold) d.fontWeight = boldWeight != null ? boldWeight : "bold";
  if (seg.italic) d.fontStyle = "italic";
  if (seg.strike) d.textDecoration = "line-through";
  if (seg.hyperlink !== undefined) d.hyperlink = seg.hyperlink;
  return { ...d, ...explicit };
}

// Compile one run's (already-decoded text, StyleDelta) over the node base into a typed WriteTextRun. Font
// resolution is effective-at-construction: a run changing family, weight, OR slant carries the complete
// (family, weight, fontStyle) triple so fonts.ts preloads the exact style and the bridge applies it via
// setRangeFontName — italic is a font-name concern in Figma, not a separate call. A run that only inherits
// base italic carries no per-range font (the base font is already italic). textDecoration and hyperlink are
// independent Figma calls. The `{tsN}` guard is NOT re-run here — the text is already decoded (see
// assertNotReadToken); it was checked on the raw input in compileRuns / text().
// `at` is the run's style path: a tuple's `[1]`, or the text itself for a markdown-only run.
function compileRun(str: string, delta: StyleDeltaInput, baseStyle: WriteTextStyle, at: string): WriteTextRun {
  const out: WriteTextRun = { text: str };
  if (baseStyle.style) {
    const covered = TEXT_STYLE_COVERED_WORDS.filter((word) => (delta as Record<string, unknown>)[word] != null);
    if (covered.length) {
      throw new FlcmError(
        "authoring",
        "this call sets the node's text style, which covers " + covered.join(", ") +
          " — the style is applied after the runs and would overwrite them. Style the run's color or link only, or drop textStyle.style (markdown ** / * / ~~ set fontWeight, fontStyle and textDecoration).",
        { path: at },
      );
    }
  }
  // The run's own font words compile first, so the effective triple below reads bound and literal alike.
  const fontWords: WriteTextStyle = {};
  compileTextFontWords(delta as Record<string, unknown>, fontWords, at);
  const style: WriteTextStyle = {};
  const italic = delta.fontStyle != null
    ? assertEnum(at + ".fontStyle", delta.fontStyle, FONT_STYLE)
    : baseStyle.fontStyle;
  if (delta.fontFamily != null || delta.fontWeight != null || delta.fontStyle != null) {
    // CONTRACT: a run changing any of the (family, weight, slant) triple carries the COMPLETE
    // effective triple — fontFamily is assigned even when the base has none (the key is present
    // with an undefined value). Edit's mixed-base guard reads exactly that presence; don't "tidy"
    // the undefined assignment away.
    style.fontFamily = fontWords.fontFamily !== undefined ? fontWords.fontFamily : baseStyle.fontFamily;
    style.fontWeight = fontWords.fontWeight !== undefined ? fontWords.fontWeight : baseStyle.fontWeight;
    if (italic != null) style.fontStyle = italic;
  }
  if (fontWords.fontSize !== undefined) style.fontSize = fontWords.fontSize;
  if (delta.lineHeight != null) style.lineHeight = compileBindable(delta.lineHeight, at + ".lineHeight", "FLOAT", (v: number | string) => locatedParse(() => lineHeight(v), at + ".lineHeight"));
  if (delta.letterSpacing != null) style.letterSpacing = compileBindable(delta.letterSpacing, at + ".letterSpacing", "FLOAT", (v: number | string) => locatedParse(() => letterSpacing(v), at + ".letterSpacing"));
  if (delta.textDecoration != null) style.textDecoration = assertEnum(at + ".textDecoration", delta.textDecoration, TEXT_DECORATION);
  compileSharedTextWords(delta as Record<string, unknown>, style, at);
  if (Object.keys(style).length) out.style = style;
  if (delta.color != null) out.fills = compilePaintWord(delta.color, at + ".color");
  // A run's link lives on the RUN, not its style: the span already IS the range setRangeHyperlink
  // needs, so it takes no per-field range of its own.
  if (delta.hyperlink != null) out.hyperlink = parseHyperlink(delta.hyperlink, at + ".hyperlink");
  return out;
}

