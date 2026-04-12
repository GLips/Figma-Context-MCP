import type { Hyperlink, Node as FigmaDocumentNode, TypeStyle, Paint } from "@figma/rest-api-spec";
import { isVisible } from "~/utils/common.js";
import { hasValue } from "~/utils/identity.js";
import { parsePaint, type SimplifiedFill } from "~/transformers/style.js";

export type SimplifiedTextStyle = Partial<{
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: string;
  letterSpacing: string;
  textCase: string;
  textAlignHorizontal: string;
  textAlignVertical: string;
  italic: boolean;
  textDecoration: "STRIKETHROUGH" | "UNDERLINE";
  hyperlink: Hyperlink;
  // Only non-zero flags are emitted; defaults stay out of the ref so two nodes
  // that differ only in default flag values still dedupe.
  opentypeFlags: Record<string, number>;
  paragraphSpacing: number;
  paragraphIndent: number;
  listSpacing: number;
  // Text color overrides — only used on inline style-ref deltas, not the base
  // textStyle (the node's `fills` handles color for the whole text node via
  // visualsExtractor). Inline deltas need their own fills field because a
  // styled run can override text color within a single node.
  fills: SimplifiedFill[];
}>;

export function isTextNode(
  n: FigmaDocumentNode,
): n is Extract<FigmaDocumentNode, { type: "TEXT" }> {
  return n.type === "TEXT";
}

export function hasTextStyle(
  n: FigmaDocumentNode,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `any` needed to extract the style variant from the union
): n is FigmaDocumentNode & { style: Extract<FigmaDocumentNode, { style: any }>["style"] } {
  return hasValue("style", n) && Object.keys(n.style).length > 0;
}

export function extractTextStyle(n: FigmaDocumentNode) {
  if (hasTextStyle(n)) {
    const style = n.style;
    const textStyle: SimplifiedTextStyle = {
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontSize: style.fontSize,
      lineHeight:
        "lineHeightPx" in style && style.lineHeightPx && style.fontSize
          ? `${style.lineHeightPx / style.fontSize}em`
          : undefined,
      letterSpacing:
        style.letterSpacing && style.letterSpacing !== 0 && style.fontSize
          ? `${(style.letterSpacing / style.fontSize) * 100}%`
          : undefined,
      textCase: style.textCase,
      textAlignHorizontal: style.textAlignHorizontal,
      textAlignVertical: style.textAlignVertical,
      italic: "italic" in style && style.italic ? true : undefined,
      textDecoration:
        "textDecoration" in style &&
        (style.textDecoration === "STRIKETHROUGH" || style.textDecoration === "UNDERLINE")
          ? style.textDecoration
          : undefined,
      hyperlink: "hyperlink" in style && style.hyperlink ? style.hyperlink : undefined,
      opentypeFlags: pickNonZeroFlags("opentypeFlags" in style ? style.opentypeFlags : undefined),
      paragraphSpacing:
        "paragraphSpacing" in style && style.paragraphSpacing && style.paragraphSpacing > 0
          ? style.paragraphSpacing
          : undefined,
      paragraphIndent:
        "paragraphIndent" in style && style.paragraphIndent && style.paragraphIndent > 0
          ? style.paragraphIndent
          : undefined,
      listSpacing:
        "listSpacing" in style && style.listSpacing && style.listSpacing > 0
          ? style.listSpacing
          : undefined,
    };
    return textStyle;
  }
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

// ---------------------------------------------------------------------------
// Rich text (inline formatting)
// ---------------------------------------------------------------------------

/**
 * Callback used by `buildFormattedText` to register a style-ref delta for a
 * styled run and receive the inline ID (e.g. `ts1`) that should wrap the run
 * in the output. Keeping the side effects (ID generation, globalVars mutation,
 * dedup) in the caller lets this module stay a near-pure transformer.
 */
export type RegisterInlineTextStyle = (delta: SimplifiedTextStyle) => string;

export type BuildFormattedTextResult = {
  text: string;
  /**
   * Numeric font weight that `**` maps to in `text`. Only present when the
   * node has per-character bold overrides, so the consumer knows what weight
   * the markdown bold represents.
   */
  boldWeight?: number;
};

type Run = {
  /**
   * Raw character range for this run — not yet escaped or wrapped.
   * Stored as an array of code points so we can slice the characters string
   * without splitting surrogate pairs when handling emoji / astral chars.
   */
  text: string;
  overrideId: number;
  /** Deduped delta against the base style (only properties that actually differ). */
  delta: Partial<TypeStyle>;
};

type Classification = {
  isBold: boolean;
  isItalic: boolean;
  isStrike: boolean;
  /** URL for `[text](url)` rendering — only set for `type: "URL"` hyperlinks. */
  urlLink?: string;
  /** Delta to wrap in `{tsN}...{/tsN}` — undefined when no style-ref props remain. */
  refDelta?: SimplifiedTextStyle;
};

/**
 * Fields ignored by the delta computation. These are either book-keeping
 * (semanticWeight, semanticItalic, isOverrideOverTextStyle) that don't affect
 * visual output, or fields we explicitly don't carry into the simplified
 * representation (fontPostScriptName, boundVariables).
 */
const IGNORED_TYPE_STYLE_FIELDS = new Set([
  "semanticWeight",
  "semanticItalic",
  "isOverrideOverTextStyle",
  "fontPostScriptName",
  "boundVariables",
]);

/**
 * Build a formatted markdown + inline style-ref representation of a text
 * node's mixed character formatting.
 *
 * Algorithm (matches `docs/plans/2026-04-08-feat-rich-text-styling-plan.md`):
 *   1. Split characters into runs based on `characterStyleOverrides`.
 *   2. For each run, compute its delta against the base `style` (dropping any
 *      override property that equals the base — those are no-ops).
 *   3. Merge adjacent runs whose deltas are identical.
 *   4. Determine the canonical `boldWeight` — the heavier fontWeight that
 *      appears across the most characters. This is what plain `**` maps to.
 *   5. Classify each run's delta into markdown (bold/italic/strike/URL link)
 *      + residual style-ref properties.
 *   6. Render each run: escape raw text, wrap style-ref deltas on the outside,
 *      markdown markers on the inside.
 *
 * Why markdown on the inside: `{ts1}**text**{/ts1}` keeps markdown markers
 * contiguous and lets the style ref describe a visual region decorated by
 * markdown within it. The reverse nesting would fragment markdown across
 * every style boundary.
 */
export function buildFormattedText(
  node: FigmaDocumentNode,
  registerStyle: RegisterInlineTextStyle,
): BuildFormattedTextResult {
  if (!isTextNode(node)) {
    return { text: "" };
  }
  const characters = node.characters ?? "";
  if (characters.length === 0) {
    return { text: "" };
  }

  // Split characters into code points so a surrogate pair stays with its run.
  const codePoints = Array.from(characters);
  const overrides = node.characterStyleOverrides ?? [];
  const overrideTable = (node.styleOverrideTable ?? {}) as Record<string, TypeStyle>;
  // Mock/test fixtures can omit `style` on text nodes. Treat that as an empty
  // base style so the algorithm still works (every override becomes its own
  // delta against `{}`).
  const baseStyle = ((node as { style?: TypeStyle }).style ?? {}) as TypeStyle;

  // --- Step 1+2: runs with per-run deltas ---------------------------------
  const rawRuns: Run[] = [];
  let runStart = 0;
  for (let i = 0; i <= codePoints.length; i++) {
    // Trailing entries of characterStyleOverrides can be omitted, in which
    // case they implicitly mean override ID 0 (base style). Past-end sentinel
    // is -1 so we always close the final run on the last iteration.
    const currentId = i < codePoints.length ? (overrides[i] ?? 0) : -1;
    const startId = runStart < codePoints.length ? (overrides[runStart] ?? 0) : 0;
    if (i === codePoints.length || currentId !== startId) {
      rawRuns.push({
        text: codePoints.slice(runStart, i).join(""),
        overrideId: startId,
        delta: computeDelta(startId, overrideTable, baseStyle),
      });
      runStart = i;
    }
  }

  // --- Step 3: merge adjacent runs with identical deltas ------------------
  const runs: Run[] = [];
  for (const run of rawRuns) {
    const prev = runs[runs.length - 1];
    if (prev && deltasEqual(prev.delta, run.delta)) {
      prev.text += run.text;
    } else {
      runs.push({ ...run });
    }
  }

  // --- Step 4: determine boldWeight ---------------------------------------
  const boldWeight = detectBoldWeight(runs, baseStyle);

  // --- Step 5+6: classify + render ----------------------------------------
  let output = "";
  for (const run of runs) {
    const classification = classifyRun(run.delta, baseStyle, boldWeight);
    output += renderRun(run.text, classification, registerStyle);
  }

  return boldWeight !== undefined ? { text: output, boldWeight } : { text: output };
}

/**
 * Compute the delta for an override ID against the base style.
 *
 * Returns only the properties that differ from the base. Override ID 0 and
 * missing entries both mean "no delta". We filter out no-op overrides — e.g.
 * a leftover `fontWeight: 400` in the override table when the base is already
 * 400 — because they would otherwise produce empty style refs.
 */
function computeDelta(
  overrideId: number,
  overrideTable: Record<string, TypeStyle>,
  baseStyle: TypeStyle,
): Partial<TypeStyle> {
  if (overrideId === 0) return {};
  const override = overrideTable[String(overrideId)];
  if (!override) return {};

  const delta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(override)) {
    if (IGNORED_TYPE_STYLE_FIELDS.has(key)) continue;
    if (value === undefined) continue;
    const baseValue = (baseStyle as Record<string, unknown>)[key];
    if (JSON.stringify(baseValue) === JSON.stringify(value)) continue;
    delta[key] = value;
  }
  return delta as Partial<TypeStyle>;
}

function deltasEqual(a: Partial<TypeStyle>, b: Partial<TypeStyle>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Pick the numeric weight that `**` should map to when a node has bold
 * overrides: the heavier-than-base weight that covers the most characters.
 * Ties break toward the heavier weight so `600 vs 800` at equal usage picks
 * `800`.
 */
function detectBoldWeight(runs: Run[], baseStyle: TypeStyle): number | undefined {
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
 * Split a run's delta into markdown decorations and residual style-ref props.
 *
 * Markdown handles: bold (fontWeight > base), italic (italic:true when base is
 * not italic), strikethrough, URL hyperlinks. A run can fall into *both*
 * buckets — bold + red text produces `{ts1}**text**{/ts1}` where `ts1` carries
 * the fills delta.
 *
 * Inverse overrides (regular on a bold base, non-italic on an italic base)
 * can't be expressed in markdown, so they fall through into the style-ref
 * delta as explicit `fontWeight` / `italic` properties.
 */
function classifyRun(
  delta: Partial<TypeStyle>,
  baseStyle: TypeStyle,
  boldWeight: number | undefined,
): Classification {
  const c: Classification = { isBold: false, isItalic: false, isStrike: false };
  const refDelta: SimplifiedTextStyle = {};
  let hasRefProps = false;

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
          // ref so the consumer can realize the actual weight.
          if (boldWeight !== undefined && w !== boldWeight) {
            refDelta.fontWeight = w;
            hasRefProps = true;
          }
        } else {
          // Lighter-than-base override — markdown can't remove bold, so emit
          // as a style ref with the explicit weight.
          refDelta.fontWeight = w;
          hasRefProps = true;
        }
        break;
      }
      case "italic": {
        const italic = value as boolean;
        if (italic && !baseItalic) {
          c.isItalic = true;
        } else if (!italic && baseItalic) {
          refDelta.italic = false;
          hasRefProps = true;
        }
        break;
      }
      case "textDecoration": {
        const td = value as "NONE" | "STRIKETHROUGH" | "UNDERLINE";
        if (td === "STRIKETHROUGH") {
          c.isStrike = true;
        } else if (td === "UNDERLINE") {
          refDelta.textDecoration = "UNDERLINE";
          hasRefProps = true;
        }
        // `NONE` as an override slipped past computeDelta only if the base
        // had decoration; it's a no-op for our output in that case because we
        // render on top of the base, not instead of it.
        break;
      }
      case "hyperlink": {
        const link = value as Hyperlink;
        if (link.type === "URL" && link.url) {
          c.urlLink = link.url;
        } else {
          // NODE hyperlinks have no markdown equivalent — carry through as a
          // style-ref property so the consumer can at least see the link.
          refDelta.hyperlink = link;
          hasRefProps = true;
        }
        break;
      }
      case "fills": {
        const paints = value as Paint[];
        const fills = paints
          .filter(isVisible)
          .map((p) => parsePaint(p, false))
          .reverse();
        if (fills.length) {
          refDelta.fills = fills;
          hasRefProps = true;
        }
        break;
      }
      case "fontFamily": {
        refDelta.fontFamily = value as string;
        hasRefProps = true;
        break;
      }
      case "fontSize": {
        refDelta.fontSize = value as number;
        hasRefProps = true;
        break;
      }
      case "letterSpacing": {
        const ls = value as number;
        if (ls && effectiveFontSize) {
          refDelta.letterSpacing = `${(ls / effectiveFontSize) * 100}%`;
          hasRefProps = true;
        }
        break;
      }
      case "lineHeightPx": {
        const lh = value as number;
        if (lh && effectiveFontSize) {
          refDelta.lineHeight = `${lh / effectiveFontSize}em`;
          hasRefProps = true;
        }
        break;
      }
      case "textCase": {
        refDelta.textCase = value as string;
        hasRefProps = true;
        break;
      }
      case "textAlignHorizontal": {
        refDelta.textAlignHorizontal = value as string;
        hasRefProps = true;
        break;
      }
      case "textAlignVertical": {
        refDelta.textAlignVertical = value as string;
        hasRefProps = true;
        break;
      }
      case "opentypeFlags": {
        const nonZero = pickNonZeroFlags(value as Record<string, number>);
        if (nonZero) {
          refDelta.opentypeFlags = nonZero;
          hasRefProps = true;
        }
        break;
      }
      case "paragraphSpacing": {
        if (typeof value === "number" && value > 0) {
          refDelta.paragraphSpacing = value;
          hasRefProps = true;
        }
        break;
      }
      case "paragraphIndent": {
        if (typeof value === "number" && value > 0) {
          refDelta.paragraphIndent = value;
          hasRefProps = true;
        }
        break;
      }
      case "listSpacing": {
        if (typeof value === "number" && value > 0) {
          refDelta.listSpacing = value;
          hasRefProps = true;
        }
        break;
      }
      // Unknown / unmapped TypeStyle fields are ignored — they either don't
      // have a visual effect we preserve today (e.g. textAutoResize) or
      // don't appear as per-run overrides in practice.
      default:
        break;
    }
  }

  if (hasRefProps) c.refDelta = refDelta;
  return c;
}

/**
 * Characters that must be escaped to avoid being interpreted as markdown
 * (or as the inline style-ref delimiter).
 *
 * Escaping happens BEFORE wrappers are inserted — otherwise a literal `*`
 * from user text would become an accidental italic marker once wrapped.
 * Backslash is included so `\` in user text doesn't merge with our own
 * escapes.
 */
const MARKDOWN_ESCAPE_CHARS = /[\\*_~[\](){}]/g;

function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_ESCAPE_CHARS, "\\$&");
}

/**
 * Render a single run with wrappers applied outer-to-inner:
 *   {tsN} → [...]( ) → ~~ → ** → *
 *
 * This ordering ensures that when two decorations collide on one run, the
 * broader visual region (the style ref) surrounds the narrower markdown
 * decoration, and the link text contains the formatted content.
 */
function renderRun(
  rawText: string,
  c: Classification,
  registerStyle: RegisterInlineTextStyle,
): string {
  // A purely empty classification on empty text collapses to nothing; on
  // non-empty text we still emit the escaped characters so whitespace and
  // line breaks are preserved verbatim.
  let inner = escapeMarkdown(rawText);

  if (c.isItalic) inner = `*${inner}*`;
  if (c.isBold) inner = `**${inner}**`;
  if (c.isStrike) inner = `~~${inner}~~`;
  if (c.urlLink) inner = `[${inner}](${c.urlLink})`;
  if (c.refDelta) {
    const id = registerStyle(c.refDelta);
    inner = `{${id}}${inner}{/${id}}`;
  }
  return inner;
}
