import type {
  NodeSnapshot,
  SnapshotHyperlink,
  SnapshotPaint,
  SnapshotText,
  SnapshotTextRun,
  SnapshotTextStyle,
} from "~/core/snapshot.js";
import { isVisible, pixelRound } from "~/core/utils.js";
import { flattenSolidFills, parsePaint, type SimplifiedFill } from "~/core/transformers/style.js";

/**
 * Canonical text-style vocabulary (see docs/canonical-vocabulary.md). Used both
 * as a node's base `textStyle` and — as a delta over that base — for a styled
 * run's residual style. Fields that only make sense as a per-run inverse
 * override (`fontStyle: "normal"`, `textDecoration: "none"`,
 * `textTransform: "none"`) never appear on the base, where defaults are omitted.
 */
export type SimplifiedTextStyle = Partial<{
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  fontStyle: "italic" | "normal";
  // The Figma-named variant ("Bold Italic", "Condensed") — informational.
  // Renamed from the wire's `fontStyle`, which collided with the CSS meaning.
  fontVariantName: string;
  lineHeight: string;
  letterSpacing: string;
  // "left" is the omitted default on the base; run deltas may carry it as an
  // inverse override.
  textAlign: "left" | "center" | "right" | "justify";
  textAlignVertical: "center" | "bottom";
  textTransform: "uppercase" | "lowercase" | "capitalize" | "none";
  // CSS font-variant-caps — carries Figma's SMALL_CAPS / SMALL_CAPS_FORCED,
  // split out of the wire's single textCase enum.
  fontVariant: "small-caps" | "all-small-caps";
  textDecoration: "underline" | "line-through" | "none";
  hyperlink: SnapshotHyperlink;
  // Only non-zero flags are emitted; defaults stay out of the value so two nodes
  // that differ only in default flag values still dedupe.
  opentypeFlags: Record<string, number>;
  paragraphSpacing: number;
  paragraphIndent: number;
  listSpacing: number;
  // Per-run text color override — run deltas only, never the base (a TEXT
  // node's `fills` carries base color like every other node). An array only for
  // a genuinely stacked span paint that can't flatten to one color.
  color: SimplifiedFill | SimplifiedFill[];
}>;

/**
 * A run's style slot: a styles-table ref string when the delta is shared by 2+
 * runs (compressed output), or the inline delta object itself.
 */
export type TextRunStyle = string | SimplifiedTextStyle;

/**
 * One segment of a text node's content: a bare string for a plain (or
 * markdown-expressible) segment, or a `[text, style]` tuple for a span whose
 * residual style markdown cannot express. Markdown renders inside the tuple's
 * text; the style is a delta over the node's base `textStyle`.
 */
export type TextRun = string | [text: string, style: TextRunStyle];

export function isTextNode(n: NodeSnapshot): boolean {
  return n.type === "TEXT";
}

export function hasTextStyle(n: NodeSnapshot): n is NodeSnapshot & { text: SnapshotText } {
  return !!n.text && Object.keys(n.text.style).length > 0;
}

// Letter-spacing is emitted as a font-size-relative `em` so it pastes straight
// into CSS and lets native targets (iOS/Flutter) resolve to absolute units by
// multiplying the fontSize in the same textStyle. We round to 4 decimals rather
// than reuse `pixelRound` (2 dp): letter-spacing fractions are O(0.01), where
// 0.01em is ~0.16px at a 16px font — coarse enough to visibly shift tracking.
// 4 dp preserves the precision the old "%" form carried (0.01% = 0.0001em).
function emRound(value: number): number {
  return Number(value.toFixed(4));
}

function convertTextAlign(
  align: string | undefined,
): "left" | "center" | "right" | "justify" | undefined {
  switch (align) {
    case "LEFT":
      return "left";
    case "CENTER":
      return "center";
    case "RIGHT":
      return "right";
    case "JUSTIFIED":
      return "justify";
    default:
      return undefined;
  }
}

function convertTextAlignVertical(align: string | undefined): "center" | "bottom" | undefined {
  // "TOP" is the omitted default.
  if (align === "CENTER") return "center";
  if (align === "BOTTOM") return "bottom";
  return undefined;
}

/**
 * Split the wire's single textCase enum into the two CSS concepts it conflates:
 * text-transform (case mapping) and font-variant-caps (small caps).
 */
function convertTextCase(textCase: string | undefined): {
  textTransform?: "uppercase" | "lowercase" | "capitalize";
  fontVariant?: "small-caps" | "all-small-caps";
} {
  switch (textCase) {
    case "UPPER":
      return { textTransform: "uppercase" };
    case "LOWER":
      return { textTransform: "lowercase" };
    case "TITLE":
      return { textTransform: "capitalize" };
    case "SMALL_CAPS":
      return { fontVariant: "small-caps" };
    case "SMALL_CAPS_FORCED":
      return { fontVariant: "all-small-caps" };
    default:
      return {};
  }
}

function convertTextDecoration(
  decoration: string | undefined,
): "underline" | "line-through" | undefined {
  if (decoration === "UNDERLINE") return "underline";
  if (decoration === "STRIKETHROUGH") return "line-through";
  return undefined;
}

export function extractTextStyle(n: NodeSnapshot): SimplifiedTextStyle | undefined {
  if (!hasTextStyle(n)) return undefined;
  const style = n.text.style;
  const textStyle: SimplifiedTextStyle = {};

  if (style.fontFamily !== undefined) textStyle.fontFamily = style.fontFamily;
  if (style.fontWeight !== undefined) textStyle.fontWeight = style.fontWeight;
  if (style.fontSize !== undefined) textStyle.fontSize = style.fontSize;
  if (style.italic) textStyle.fontStyle = "italic";
  if (style.fontStyle) textStyle.fontVariantName = style.fontStyle;

  const lineHeight = formatLineHeight(style, style.fontSize);
  if (lineHeight) textStyle.lineHeight = lineHeight;
  if (style.letterSpacing && style.fontSize) {
    textStyle.letterSpacing = `${emRound(style.letterSpacing / style.fontSize)}em`;
  }

  const textAlign = convertTextAlign(style.textAlignHorizontal);
  if (textAlign && textAlign !== "left") textStyle.textAlign = textAlign;
  const textAlignVertical = convertTextAlignVertical(style.textAlignVertical);
  if (textAlignVertical) textStyle.textAlignVertical = textAlignVertical;

  const { textTransform, fontVariant } = convertTextCase(style.textCase);
  if (textTransform) textStyle.textTransform = textTransform;
  if (fontVariant) textStyle.fontVariant = fontVariant;

  const textDecoration = convertTextDecoration(style.textDecoration);
  if (textDecoration) textStyle.textDecoration = textDecoration;

  if (style.hyperlink) textStyle.hyperlink = style.hyperlink;

  const opentypeFlags = pickNonZeroFlags(style.opentypeFlags);
  if (opentypeFlags) textStyle.opentypeFlags = opentypeFlags;
  if (style.paragraphSpacing && style.paragraphSpacing > 0) {
    textStyle.paragraphSpacing = style.paragraphSpacing;
  }
  if (style.paragraphIndent && style.paragraphIndent > 0) {
    textStyle.paragraphIndent = style.paragraphIndent;
  }
  if (style.listSpacing && style.listSpacing > 0) {
    textStyle.listSpacing = style.listSpacing;
  }

  return Object.keys(textStyle).length ? textStyle : undefined;
}

function pickNonZeroFlags(
  flags: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!flags) return undefined;
  const nonZero: Record<string, number> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (v) nonZero[k] = v;
  }
  return Object.keys(nonZero).length ? nonZero : undefined;
}

/**
 * Format Figma's line-height fields into a CSS string that preserves the
 * unit the designer actually specified, or omit when the text uses "auto".
 *
 *   INTRINSIC_% → undefined (auto — follows the font's intrinsic metrics;
 *                 `lineHeightPx` is just the computed value for whichever
 *                 font the node happens to use, not user intent)
 *   PIXELS      → "24px"  from `lineHeightPx`
 *   FONT_SIZE_% → "1.5em" from `lineHeightPercentFontSize`
 *
 * Relative line-height is emitted as `em` (not `%`) to match letterSpacing and
 * give one canonical font-size-relative form: it pastes straight into CSS and
 * native targets resolve it by multiplying the fontSize in the same textStyle.
 * Absolute line-height stays `px`. Falls back to an em conversion when the unit
 * is missing (older API responses) so the output is never worse than before.
 * All numeric values are rounded via `pixelRound` so floating-point noise like
 * Figma's `16.94318199157715` doesn't leak through.
 */
type LineHeightSource = {
  lineHeightPx?: number;
  lineHeightUnit?: string;
  lineHeightPercentFontSize?: number;
};

function formatLineHeight(
  source: LineHeightSource,
  fontSize: number | undefined,
): string | undefined {
  const { lineHeightUnit, lineHeightPx, lineHeightPercentFontSize } = source;

  if (lineHeightUnit === "INTRINSIC_%") return undefined;

  if (lineHeightUnit === "PIXELS" && lineHeightPx) {
    return `${pixelRound(lineHeightPx)}px`;
  }

  if (lineHeightUnit === "FONT_SIZE_%" && lineHeightPercentFontSize) {
    return `${pixelRound(lineHeightPercentFontSize / 100)}em`;
  }

  if (lineHeightPx && fontSize) {
    return `${pixelRound(lineHeightPx / fontSize)}em`;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Rich text (inline formatting)
// ---------------------------------------------------------------------------

/**
 * Callback used by `buildFormattedText` to register a styled run's residual
 * delta and receive the run tuple's style slot back: a styles-table ref string
 * (compressed output; count-gated by the compression pass like every other style)
 * or the delta itself for inline emission. Keeping the side effects (dedup,
 * styles-table mutation) in the caller lets this module stay a near-pure
 * transformer.
 */
type RegisterRunStyle = (delta: SimplifiedTextStyle) => TextRunStyle;

type BuildFormattedTextResult = {
  /**
   * Plain (or markdown-only) text degrades to a single string; the run array
   * appears only when some span carries a style markdown cannot express.
   */
  text?: string | TextRun[];
  /**
   * Numeric font weight that `**` maps to in `text`. Only present when the
   * node has per-character bold overrides, so the consumer knows what weight
   * the markdown bold represents.
   */
  boldWeight?: number;
};

type Classification = {
  isBold: boolean;
  isItalic: boolean;
  isStrike: boolean;
  /** URL for `[text](url)` rendering — only set for `type: "URL"` hyperlinks. */
  urlLink?: string;
  /** Residual delta the run tuple carries — undefined when markdown covers everything. */
  refDelta?: SimplifiedTextStyle;
};

/**
 * Render a text node's decoded runs as markdown text plus `[text, style]`
 * tuples for the arbitrary-style residual.
 *
 * The wire override tables are already resolved into `node.text` runs by the
 * adapter (see src/adapters/rest/text.ts); this function only:
 *   1. Determines the canonical `boldWeight` — the heavier fontWeight that
 *      appears across the most characters across all lines. This is what
 *      plain `**` maps to.
 *   2. Classifies each run's delta into markdown (bold/italic/strike/URL link)
 *      + residual delta properties, then renders: escape raw text, apply
 *      markdown markers, and emit either a plain string segment or a
 *      `[text, style]` tuple when a residual delta exists. Markdown renders
 *      inside the tuple's text, so the tuple's style describes the whole
 *      visual region including its markdown decorations.
 *   3. Prepends a list marker to each line based on `lineTypes` /
 *      `lineIndentations` (ordered `1.`, unordered `-`, nested with 2-space
 *      CommonMark indent).
 *   4. Joins lines with a literal `\n` (two characters, backslash + n). Real
 *      newlines in the output would cause the YAML serializer to emit a
 *      block scalar with per-line indentation — one indent level per nesting
 *      depth, multiplied by every line. Literal `\n` keeps each string
 *      segment on a single YAML plain scalar.
 */
export function buildFormattedText(
  node: NodeSnapshot,
  registerStyle: RegisterRunStyle,
): BuildFormattedTextResult {
  const text = node.text;
  if (!text || text.characters.length === 0) {
    return {};
  }

  const perLineRuns = text.lines;

  // No base style → emit characters as-is (escaped). The adapter signals this by
  // leaving `lines` empty (a text node with no `style` — synthetic fixtures only;
  // real Figma TEXT nodes always have one, so the run pipeline runs). Gating on
  // empty `lines` rather than an empty `style` object keeps a present-but-empty
  // style running the pipeline, matching the pre-carve `!node.style` check.
  // `escapeMarkdown` still rewrites real newlines to a literal `\n` so multi-line
  // plain text stays compact in YAML.
  if (perLineRuns.length === 0) {
    return { text: escapeMarkdown(text.characters) };
  }

  const baseStyle = text.style;

  // boldWeight is detected once across every run in every line — `**` maps
  // to a single canonical weight for the whole text node, not per-line.
  const boldWeight = detectBoldWeight(perLineRuns.flat(), baseStyle);

  const listState = new ListState();
  const segments: TextRun[] = [];
  // Glue plain text onto a preceding plain segment so line separators and list
  // markers never spawn their own array entries.
  const pushPlain = (s: string): void => {
    if (!s) return;
    const last = segments[segments.length - 1];
    if (typeof last === "string") {
      segments[segments.length - 1] = last + s;
    } else {
      segments.push(s);
    }
  };

  for (let i = 0; i < perLineRuns.length; i++) {
    // Join lines with a literal `\n` (backslash + n, two chars). See the
    // `escapeMarkdown` comment for why real newlines aren't used.
    if (i > 0) pushPlain("\\n");
    const type = text.lineTypes[i] ?? "NONE";
    const depth = text.lineIndentations[i] ?? 0;
    pushPlain(listState.advance(type, depth));
    for (const run of perLineRuns[i]) {
      const classification = classifyRun(run.delta, baseStyle, boldWeight);
      const rendered = renderRunMarkdown(run.text, classification);
      if (classification.refDelta) {
        segments.push([rendered, registerStyle(classification.refDelta)]);
      } else {
        pushPlain(rendered);
      }
    }
  }

  const result: BuildFormattedTextResult = {};
  if (segments.length === 1 && typeof segments[0] === "string") {
    result.text = segments[0];
  } else if (segments.length > 0) {
    result.text = segments;
  }
  if (boldWeight !== undefined) result.boldWeight = boldWeight;
  return result;
}

/**
 * Tracks ordered-list counters across lines so `1. / 2. / 3.` numbering is
 * correct even with nested lists and non-list interruptions.
 *
 * Counter scope rules:
 *   - Counters at depths *deeper* than the current line are cleared — moving
 *     shallower closes any nested lists below.
 *   - A non-ORDERED line at depth d (UNORDERED or NONE) clears depth d's
 *     counter, so a subsequent ORDERED line there restarts at 1.
 *   - Counters at depths *shallower* than the current line are untouched —
 *     an outer ordered list continues across nested interruptions.
 */
class ListState {
  private counters = new Map<number, number>();

  /**
   * Mutates the counter state and returns the list prefix for the next line.
   * Named `advance` (not `nextPrefix`) to telegraph the side effect — two
   * calls with the same arguments return different strings as the counter
   * increments.
   */
  advance(type: "NONE" | "ORDERED" | "UNORDERED", depth: number): string {
    for (const k of Array.from(this.counters.keys())) {
      if (k > depth) this.counters.delete(k);
    }

    // CommonMark nests lists with 2-space indentation per level. Plain
    // (NONE) lines are not indented — list-adjacent prose sits at column 0.
    const indent = "  ".repeat(depth);

    if (type === "ORDERED") {
      const n = (this.counters.get(depth) ?? 0) + 1;
      this.counters.set(depth, n);
      return `${indent}${n}. `;
    }

    if (type === "UNORDERED") {
      this.counters.delete(depth);
      return `${indent}- `;
    }

    this.counters.delete(depth);
    return "";
  }
}

/**
 * Pick the numeric weight that `**` should map to when a node has bold
 * overrides: the heavier-than-base weight that covers the most characters.
 * Ties break toward the heavier weight so `600 vs 800` at equal usage picks
 * `800`.
 */
function detectBoldWeight(
  runs: SnapshotTextRun[],
  baseStyle: SnapshotTextStyle,
): number | undefined {
  const baseWeight = baseStyle.fontWeight ?? 400;
  const counts = new Map<number, number>();
  for (const run of runs) {
    const w = run.delta.fontWeight;
    if (typeof w === "number" && w > baseWeight) {
      counts.set(w, (counts.get(w) ?? 0) + run.text.length);
    }
  }
  if (counts.size === 0) return undefined;
  let bestWeight: number | undefined;
  let bestCount = -1;
  for (const [weight, count] of counts) {
    if (count > bestCount || (count === bestCount && weight > (bestWeight ?? 0))) {
      bestWeight = weight;
      bestCount = count;
    }
  }
  return bestWeight;
}

/**
 * Split a run's delta into markdown decorations and the residual delta the run
 * tuple carries.
 *
 * Markdown handles: bold (fontWeight > base), italic (italic:true when base is
 * not italic), strikethrough, URL hyperlinks. A run can fall into *both*
 * buckets — bold + red text produces `["**text**", { color: "#FF0000" }]`,
 * where the delta carries the color and markdown carries the bold.
 *
 * Inverse overrides (regular on a bold base, non-italic on an italic base,
 * decoration removal) can't be expressed in markdown, so they ride the delta
 * as explicit `fontWeight` / `fontStyle: "normal"` / `textDecoration: "none"`
 * properties.
 */
function classifyRun(
  delta: SnapshotTextStyle,
  baseStyle: SnapshotTextStyle,
  boldWeight: number | undefined,
): Classification {
  const c: Classification = { isBold: false, isItalic: false, isStrike: false };
  const refDelta: SimplifiedTextStyle = {};

  const baseWeight = baseStyle.fontWeight ?? 400;
  const baseItalic = baseStyle.italic === true;

  // Effective fontSize for unit conversions (em, %) — the override may carry
  // its own fontSize, otherwise fall back to the base.
  const effectiveFontSize =
    typeof delta.fontSize === "number" ? delta.fontSize : (baseStyle.fontSize ?? 0);

  for (const [key, rawValue] of Object.entries(delta)) {
    const value = rawValue as unknown;
    switch (key) {
      case "fontWeight": {
        const w = value as number;
        if (w > baseWeight) {
          c.isBold = true;
          // A heavy weight that doesn't match the canonical bold weight still
          // renders as `**`, but also carries an explicit fontWeight in the
          // delta so the consumer can realize the actual weight.
          if (boldWeight !== undefined && w !== boldWeight) {
            refDelta.fontWeight = w;
          }
        } else {
          // Lighter-than-base override — markdown can't remove bold, so emit
          // the explicit weight in the delta.
          refDelta.fontWeight = w;
        }
        break;
      }
      case "italic": {
        const italic = value as boolean;
        if (italic && !baseItalic) {
          c.isItalic = true;
        } else if (!italic && baseItalic) {
          // Inverse override: a non-italic span on an italic base.
          refDelta.fontStyle = "normal";
        }
        break;
      }
      case "textDecoration": {
        const td = value as "NONE" | "STRIKETHROUGH" | "UNDERLINE";
        const baseDecoration = baseStyle.textDecoration;
        if (td === "STRIKETHROUGH") {
          c.isStrike = true;
          // If the base had UNDERLINE, the inherited underline still applies
          // on top of our `~~` — carry the decoration explicitly so the run is
          // only strikethrough, matching the designer's intent.
          if (baseDecoration === "UNDERLINE") {
            refDelta.textDecoration = "line-through";
          }
        } else if (td === "UNDERLINE") {
          refDelta.textDecoration = "underline";
        } else if (td === "NONE" && baseDecoration) {
          // Inverse override: the base had decoration and this run removes
          // it. Markdown can't express decoration removal, so emit an
          // explicit "none" the consumer can use to suppress the inherited base.
          refDelta.textDecoration = "none";
        }
        break;
      }
      case "hyperlink": {
        const link = value as SnapshotHyperlink;
        if (link.type === "URL" && link.url) {
          c.urlLink = link.url;
        } else {
          // NODE hyperlinks have no markdown equivalent — carry through in the
          // delta so the consumer can at least see the link.
          refDelta.hyperlink = link;
        }
        break;
      }
      case "fills": {
        const color = foldRunColor(value as SnapshotPaint[]);
        if (color !== undefined) {
          refDelta.color = color;
        }
        break;
      }
      case "fontFamily": {
        refDelta.fontFamily = value as string;
        break;
      }
      case "fontStyle": {
        // The wire's fontStyle is the named variant like "Bold Italic". It's
        // informational — italic/fontWeight carry the actual visual data.
        // Pass through so the consumer sees the exact variant name.
        refDelta.fontVariantName = value as string;
        break;
      }
      case "fontSize": {
        refDelta.fontSize = value as number;
        break;
      }
      case "letterSpacing": {
        const ls = value as number;
        if (ls && effectiveFontSize) {
          refDelta.letterSpacing = `${emRound(ls / effectiveFontSize)}em`;
        }
        break;
      }
      case "lineHeightPx":
      case "lineHeightUnit":
      case "lineHeightPercent":
      case "lineHeightPercentFontSize": {
        // Line-height is a multi-field concept (px/unit/%). Any of the four
        // landing in the delta means the run's effective line-height
        // differs from the base. Resolve the merged shape (override wins
        // per field) and format once — running `formatLineHeight` on each
        // case would emit duplicate deltas for the same logical change.
        if (refDelta.lineHeight !== undefined) break;
        const merged: LineHeightSource = {
          lineHeightPx: delta.lineHeightPx ?? baseStyle.lineHeightPx,
          lineHeightUnit: delta.lineHeightUnit ?? baseStyle.lineHeightUnit,
          lineHeightPercentFontSize:
            delta.lineHeightPercentFontSize ?? baseStyle.lineHeightPercentFontSize,
        };
        const formatted = formatLineHeight(merged, effectiveFontSize);
        if (formatted) {
          refDelta.lineHeight = formatted;
        }
        break;
      }
      case "textCase": {
        const textCase = value as string;
        const { textTransform, fontVariant } = convertTextCase(textCase);
        if (textTransform) refDelta.textTransform = textTransform;
        if (fontVariant) refDelta.fontVariant = fontVariant;
        // Inverse override: ORIGINAL over a transformed base clears the
        // inherited transform — CSS "none", mirroring textDecoration's inverse.
        if (textCase === "ORIGINAL" && convertTextCase(baseStyle.textCase).textTransform) {
          refDelta.textTransform = "none";
        }
        break;
      }
      case "textAlignHorizontal": {
        const textAlign = convertTextAlign(value as string);
        // Deltas emit "left" too — it's an inverse override of a non-left base.
        if (textAlign) refDelta.textAlign = textAlign;
        break;
      }
      case "textAlignVertical": {
        const textAlignVertical = convertTextAlignVertical(value as string);
        if (textAlignVertical) refDelta.textAlignVertical = textAlignVertical;
        break;
      }
      case "opentypeFlags": {
        const nonZero = pickNonZeroFlags(value as Record<string, number>);
        if (nonZero) refDelta.opentypeFlags = nonZero;
        break;
      }
      // paragraphSpacing / paragraphIndent / listSpacing are passed through
      // to the delta but intentionally NOT consumed during the markdown
      // rendering itself. Markdown has no representation for pixel-valued
      // vertical whitespace, and conflating `paragraphIndent` with the
      // list-nesting indent we already use for `lineIndentations` would
      // corrupt list structure. Consumers that need these values read them
      // off the delta directly.
      case "paragraphSpacing": {
        if (typeof value === "number" && value > 0) refDelta.paragraphSpacing = value;
        break;
      }
      case "paragraphIndent": {
        if (typeof value === "number" && value > 0) refDelta.paragraphIndent = value;
        break;
      }
      case "listSpacing": {
        if (typeof value === "number" && value > 0) refDelta.listSpacing = value;
        break;
      }
      // Unknown / unmapped TypeStyle fields are ignored — they either don't
      // have a visual effect we preserve today (e.g. textAutoResize) or
      // don't appear as per-run overrides in practice.
      default:
        break;
    }
  }

  if (Object.keys(refDelta).length > 0) c.refDelta = refDelta;
  return c;
}

/**
 * Fold a run's visible fill paints into the delta's `color` value. Same folding
 * as node fills — an all-solid stack flattens to the one color a viewer sees —
 * but unlike node `fills` (always an array) a single value unwraps to a bare
 * scalar per the spec: only a genuinely mixed stack stays an array.
 */
function foldRunColor(runPaints: SnapshotPaint[]): SimplifiedFill | SimplifiedFill[] | undefined {
  const paints = runPaints.filter(isVisible);
  const flattened = flattenSolidFills(paints);
  if (flattened !== null) return flattened;
  const parsed = paints.map((p) => parsePaint(p, false)).reverse();
  if (parsed.length === 0) return undefined;
  return parsed.length === 1 ? parsed[0] : parsed;
}

/**
 * Characters that must be escaped to avoid being interpreted as markdown.
 *
 * Escaping happens BEFORE wrappers are inserted — otherwise a literal `*`
 * from user text would become an accidental italic marker once wrapped.
 * Backslash is included so `\` in user text doesn't merge with our own
 * escapes.
 *
 * Real newlines and paragraph separators get rewritten to a literal `\n`
 * (two characters, backslash + n). Emitting real newlines would force the
 * YAML serializer to wrap the value in a block scalar whose every line
 * inherits the parent's indentation — for a text node 4 levels deep
 * that's 8+ wasted spaces per line. The literal form keeps the whole
 * string on a single YAML plain scalar regardless of nesting depth.
 * Backslash is already escaped by the first pass so user content that
 * literally contains `\n` stays unambiguous (it becomes `\\n`).
 *
 * Round-trip contract (both producers, now in one repo): flcm's markdown
 * PARSER on the write edge (`plugin/src/preamble/markdown.ts`) is the exact
 * inverse — `\*` is a literal asterisk, the two-character `\n` is a line break,
 * `\\n` is a literal backslash-n. Text read here and re-authored through
 * `flcm.text()` must reproduce the original characters. This escape set is the
 * canonical definition of that convention (the vocabulary spec that pinned it
 * is superseded by this code).
 */
const MARKDOWN_ESCAPE_CHARS = /[\\*_~[\](){}]/g;

function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_ESCAPE_CHARS, "\\$&").replace(/[\n\u2029]/g, "\\n");
}

/**
 * CommonMark emphasis markers can't have whitespace flanking the inner text
 * (e.g. `** bold**` isn't bold). Pull any leading/trailing whitespace out of
 * the run before applying markdown wrappers so the markers hug the text.
 */
function splitEdgeWhitespace(text: string): { leading: string; core: string; trailing: string } {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match) return { leading: "", core: text, trailing: "" };
  return { leading: match[1], core: match[2], trailing: match[3] };
}

/**
 * Escape a URL for use as a markdown link destination. Parens would close the
 * destination early, and whitespace ends the URL in CommonMark — percent-
 * encode both. Note `encodeURIComponent` itself leaves `(` and `)` alone, so
 * we map them explicitly.
 */
function escapeLinkUrl(url: string): string {
  return url.replace(/[()\s]/g, (ch) => {
    if (ch === "(") return "%28";
    if (ch === ")") return "%29";
    return encodeURIComponent(ch);
  });
}

/**
 * Render a single run's text with markdown wrappers applied outer-to-inner:
 *   [...]( ) → ~~ → ** → *
 *
 * This ordering ensures that when decorations collide on one run, the link
 * text contains the formatted content. When the run also carries a residual
 * delta, the caller wraps this rendered string in a `[text, style]` tuple —
 * markdown renders inside the tuple's text, so the tuple's style describes the
 * whole decorated region.
 */
function renderRunMarkdown(rawText: string, c: Classification): string {
  const hasMarkdownWrap = c.isItalic || c.isBold || c.isStrike || c.urlLink !== undefined;
  // Pull whitespace outside any markdown wrappers so `**bold** ` instead of
  // `**bold **`. Skip the split when there's no wrapping — escaping the raw
  // string directly is all we need.
  const { leading, core, trailing } = hasMarkdownWrap
    ? splitEdgeWhitespace(rawText)
    : { leading: "", core: rawText, trailing: "" };

  let inner = escapeMarkdown(core);
  if (c.isItalic) inner = `*${inner}*`;
  if (c.isBold) inner = `**${inner}**`;
  if (c.isStrike) inner = `~~${inner}~~`;
  if (c.urlLink) inner = `[${inner}](${escapeLinkUrl(c.urlLink)})`;

  return `${escapeMarkdown(leading)}${inner}${escapeMarkdown(trailing)}`;
}
