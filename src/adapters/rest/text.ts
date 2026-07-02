import type { Node as FigmaDocumentNode, Paint, TypeStyle } from "@figma/rest-api-spec";
import type { SnapshotText, SnapshotTextRun, SnapshotTextStyle } from "~/core/snapshot.js";
import { decodePaints } from "./paint.js";
import { stableStringify } from "~/utils/common.js";

/**
 * REST text decode — the adapter half that resolves a TEXT node's wire override
 * tables (`characterStyleOverrides` + `styleOverrideTable`) into a plan-neutral
 * `SnapshotText`: per-line runs, each with its style delta against the base.
 * The wire tables never reach the core (Invariant 2); the core only classifies +
 * renders these runs.
 *
 * The run algorithm (splitLines → computeRunsForLine → computeDelta → merge) is
 * behavior-critical and gated byte-for-byte by the goldens: change it only with
 * a matching goldens diff, never as a casual cleanup.
 */

/** Internal run carrying the raw wire delta; converted to SnapshotTextRun on emit. */
type Run = {
  text: string;
  delta: Partial<TypeStyle>;
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

export function decodeText(node: FigmaDocumentNode): SnapshotText | undefined {
  if (node.type !== "TEXT") return undefined;

  const text = node as unknown as {
    characters?: string;
    style?: TypeStyle;
    characterStyleOverrides?: number[];
    styleOverrideTable?: Record<string, TypeStyle>;
    lineTypes?: Array<"NONE" | "ORDERED" | "UNORDERED">;
    lineIndentations?: number[];
  };

  const characters = text.characters ?? "";
  const lineTypes = Array.isArray(text.lineTypes) ? text.lineTypes : [];
  const lineIndentations = Array.isArray(text.lineIndentations) ? text.lineIndentations : [];
  const baseStyle = text.style;

  // No base style → the delta pipeline can't run; the core emits the characters
  // as plain escaped text. Emit an empty style so the core takes that path.
  // (Real Figma TEXT nodes always have `style` per the API spec.)
  if (!baseStyle) {
    return { characters, style: {}, lines: [], lineTypes, lineIndentations };
  }

  const style = decodeTextStyle(baseStyle);
  const overrides = text.characterStyleOverrides ?? [];
  const overrideTable = (text.styleOverrideTable ?? {}) as Record<string, TypeStyle>;

  // Split into code points so a surrogate pair stays with its run.
  const codePoints = Array.from(characters);
  const lines = splitLines(codePoints, overrides).map((line) =>
    computeRunsForLine(line.codePoints, line.overrides, overrideTable, baseStyle).map(
      toSnapshotRun,
    ),
  );

  return { characters, style, lines, lineTypes, lineIndentations };
}

/** Convert a raw run into the emitted snapshot run — decoding delta fills. */
function toSnapshotRun(run: Run): SnapshotTextRun {
  return { text: run.text, delta: decodeTextStyle(run.delta) };
}

/**
 * Retype a wire style bag to `SnapshotTextStyle`, decoding `fills` (Paint →
 * SnapshotPaint) so the core never touches REST paints. Other fields carry
 * through structurally (raw numeric/enum values); any unmapped keys ride along
 * harmlessly — the core's classifier reads only the ones it knows.
 */
function decodeTextStyle(style: Partial<TypeStyle>): SnapshotTextStyle {
  const fills = (style as { fills?: Paint[] }).fills;
  return {
    ...(style as SnapshotTextStyle),
    ...(fills ? { fills: decodePaints(fills) } : {}),
  };
}

/**
 * Split characters into lines at `\n` / `\u2029` (paragraph separator — the
 * Figma API allows both). Each line carries its slice of the overrides
 * array. The newline character itself is discarded along with its override.
 *
 * The returned line count matches what Figma's `lineTypes` /
 * `lineIndentations` arrays expect: a trailing newline produces an empty
 * final line.
 */
function splitLines(
  codePoints: string[],
  overrides: number[],
): Array<{ codePoints: string[]; overrides: number[] }> {
  const lines: Array<{ codePoints: string[]; overrides: number[] }> = [];
  let lineStart = 0;
  for (let i = 0; i <= codePoints.length; i++) {
    const ch = i < codePoints.length ? codePoints[i] : null;
    if (ch === "\n" || ch === "\u2029" || ch === null) {
      lines.push({
        codePoints: codePoints.slice(lineStart, i),
        overrides: overrides.slice(lineStart, i),
      });
      lineStart = i + 1;
    }
  }
  return lines;
}

/**
 * Compute the merged run list for a single line — split by override
 * boundaries, diff each range against the base style, merge adjacent runs
 * with equal deltas.
 *
 * Kept separate so the list-aware caller can run the run pipeline once per line
 * without duplicating the merge logic, and so the trailing-zero handling
 * (`overrides[i] ?? 0`) operates on the caller's per-line slice of the overrides
 * array rather than the whole.
 */
function computeRunsForLine(
  codePoints: string[],
  overrides: number[],
  overrideTable: Record<string, TypeStyle>,
  baseStyle: TypeStyle,
): Run[] {
  if (codePoints.length === 0) return [];

  const rawRuns: Run[] = [];
  let runStart = 0;
  for (let i = 0; i <= codePoints.length; i++) {
    // Trailing entries of characterStyleOverrides can be omitted, in which
    // case they implicitly mean override ID 0 (base style). Past-end sentinel
    // is -1 so we always close the final run on the last iteration.
    const currentId = i < codePoints.length ? (overrides[i] ?? 0) : -1;
    const startId = runStart < codePoints.length ? (overrides[runStart] ?? 0) : 0;
    if ((i === codePoints.length || currentId !== startId) && i > runStart) {
      rawRuns.push({
        text: codePoints.slice(runStart, i).join(""),
        delta: computeDelta(startId, overrideTable, baseStyle),
      });
      runStart = i;
    }
  }

  const runs: Run[] = [];
  for (const run of rawRuns) {
    const prev = runs[runs.length - 1];
    if (prev && deltasEqual(prev.delta, run.delta)) {
      prev.text += run.text;
    } else {
      runs.push({ ...run });
    }
  }
  return runs;
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
  return stableStringify(a) === stableStringify(b);
}
