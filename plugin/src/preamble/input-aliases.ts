import { parseGridPlacement, parseGridTracks, serializeGridTracks, type GridTrack } from "./grid-tracks.js";

type Bag = Record<string, unknown>;
interface AliasRule {
  keys: readonly string[];
  path: readonly [string] | readonly [string, string];
  types?: readonly string[];
  group?: "child" | "container";
  combine?: (values: readonly unknown[], canonical: unknown, subject: string) => unknown;
}
const cellAlignment = { AUTO: "auto", MIN: "start", CENTER: "center", MAX: "end" } as const;
function conflict(subject: string): never { throw new Error(subject + ": conflicting alias and canonical values; supply one value or equivalent duplicates."); }
function mergeValue(value: unknown, canonical: unknown, subject: string): unknown {
  if (canonical !== undefined && !Object.is(canonical, value)) conflict(subject);
  return value;
}
function placementAlias([anchor, span]: readonly unknown[], canonical: unknown, subject: string): string {
  if (anchor !== undefined && (typeof anchor !== "number" || !Number.isSafeInteger(anchor) || anchor < 0 || !Number.isSafeInteger(anchor + 1))) throw new Error(subject + ": anchor index must be a non-negative integer.");
  if (span !== undefined && (typeof span !== "number" || !Number.isSafeInteger(span) || span < 1)) throw new Error(subject + ": span must be a positive integer.");
  const placement = canonical === undefined ? undefined : parseGridPlacement(canonical, subject);
  if (anchor !== undefined && placement?.anchor !== undefined && anchor !== placement.anchor) conflict(subject);
  if (span !== undefined && placement && span !== placement.span) conflict(subject);
  const line = anchor === undefined ? placement?.anchor : anchor as number;
  const extent = span === undefined ? placement?.span ?? 1 : span as number;
  return line === undefined ? "span " + extent : String(line + 1) + (extent === 1 ? "" : " / span " + extent);
}
function alignmentAlias([value]: readonly unknown[], canonical: unknown, subject: string): unknown {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(cellAlignment, value)) throw new Error(subject + ": native cell alignment must be AUTO, MIN, CENTER or MAX.");
  return mergeValue(cellAlignment[value as keyof typeof cellAlignment], canonical, subject);
}
function nativeTracks(raw: unknown, subject: string): GridTrack[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error(subject + ": native tracks must be a non-empty array.");
  return raw.map(track => {
    if (!track || typeof track !== "object" || !["HUG", "FIXED", "FLEX"].includes(track.type)) throw new Error(subject + ": native tracks need type HUG, FIXED or FLEX.");
    if (track.type === "HUG") return { type: "HUG" };
    const value = track.type === "FLEX" ? track.value ?? 1 : track.value;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (track.type === "FLEX" && value === 0)) throw new Error(subject + ": FIXED/FLEX tracks need a finite size, positive for FLEX.");
    return { type: track.type, value };
  });
}
function templateAlias([sizing, tracks]: readonly unknown[], canonical: unknown, subject: string): string {
  const text = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(subject + ": sizing needs a track template string.");
    return serializeGridTracks(parseGridTracks(value, subject));
  };
  let template = canonical === undefined ? undefined : text(canonical);
  for (const value of [sizing === undefined ? undefined : text(sizing), tracks === undefined ? undefined : serializeGridTracks(nativeTracks(tracks, subject))]) {
    if (value !== undefined) template = mergeValue(value, template, subject) as string;
  }
  return template!;
}

// A rule owns the complete input tuple for one canonical word. Layout aliases accept native
// fields at node level or inside layout; gathering both scopes before rewriting preserves pairs.
export const INPUT_ALIASES = {
  clipsContent: { keys: ["clipsContent"], path: ["clip"], types: ["FRAME", "INSTANCE", "COMPONENT", "COMPONENT_SET", "SLOT"] },
  fontSize: { keys: ["fontSize"], path: ["textStyle", "fontSize"], types: ["TEXT"] },
  gridColumn: { keys: ["gridColumnAnchorIndex", "gridColumnSpan"], path: ["layout", "gridColumn"], group: "child", combine: placementAlias },
  gridRow: { keys: ["gridRowAnchorIndex", "gridRowSpan"], path: ["layout", "gridRow"], group: "child", combine: placementAlias },
  justifySelf: { keys: ["gridChildHorizontalAlign"], path: ["layout", "justifySelf"], group: "child", combine: alignmentAlias },
  alignSelf: { keys: ["gridChildVerticalAlign"], path: ["layout", "alignSelf"], group: "child", combine: alignmentAlias },
  gridTemplateColumns: { keys: ["gridColumnsSizing", "gridColumnSizes"], path: ["layout", "gridTemplateColumns"], group: "container", combine: templateAlias },
  gridTemplateRows: { keys: ["gridRowsSizing", "gridRowSizes"], path: ["layout", "gridTemplateRows"], group: "container", combine: templateAlias },
} as const satisfies Record<string, AliasRule>;
const rules: readonly AliasRule[] = Object.values(INPUT_ALIASES);
export const gridAliasKeys = (group: "child" | "container" | "all"): string[] => rules.filter(rule => rule.group && (group === "all" || rule.group === group)).flatMap(rule => [...rule.keys]);

function sameInput(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameInput((a as Bag)[key], (b as Bag)[key]));
}

export function normalizeInputAliases(bag: Bag, subject: string, type?: string): Bag {
  const out = { ...bag };
  for (const rule of rules) {
    const [root, leaf] = rule.path;
    const nested = out[root];
    const inner = nested !== null && typeof nested === "object" && !Array.isArray(nested) ? nested as Bag : undefined;
    const sources = rule.group && inner ? [out, inner] : [out];
    if (!sources.some(source => rule.keys.some(key => Object.prototype.hasOwnProperty.call(source, key)))) continue;
    const label = rule.keys.join("/");
    if (type && rule.types && !rule.types.includes(type)) throw new Error(subject + ": " + label + " is not supported on " + type + ".");
    if (leaf && nested !== undefined && !inner) throw new Error(subject + ": " + root + " must be an object when using " + label + ".");
    const target = leaf ? { ...inner } : out;
    const values = rule.keys.map(key => {
      const a = out[key], b = rule.group ? inner?.[key] : undefined;
      if (a !== undefined && b !== undefined && !sameInput(a, b)) conflict(subject + ": " + key);
      delete out[key];
      if (rule.group) delete target[key];
      return a !== undefined ? a : b;
    });
    if (values.every(value => value === undefined)) {
      if (rule.group && inner) out[root] = target;
      continue;
    }
    if (leaf) out[root] = target;
    const key = leaf ?? root;
    const at = subject + ": " + label + " and " + rule.path.join(".");
    if (rule.combine) target[key] = rule.combine(values, target[key], at);
    else {
      if (target[key] !== undefined && !Object.is(target[key], values[0])) throw new Error(subject + ": conflicting " + label + " and " + rule.path.join(".") + "; supply one value or equivalent duplicates.");
      target[key] = values[0];
    }
  }
  return out;
}

import type { WriteLayout } from "./ir.js";
import type { LayoutMode } from "./layout-mode.js";

/** Stretch is a size request on the parent's cross axis, not a second alignment implementation. */
export function normalizeChildLayoutAliases(layout: WriteLayout, parent: LayoutMode, absolute: boolean, subject: string): WriteLayout {
  if (layout.alignSelf !== "stretch") return layout;
  if (absolute || parent.kind !== "flow") throw new Error(subject + ': alignSelf "stretch" requires an in-flow row/column parent.');
  const axis = parent.cross;
  if (layout.sizing?.[axis] !== undefined && layout.sizing[axis] !== "fill") throw new Error(subject + ': alignSelf "stretch" conflicts with the authored counter-axis size; use "fill".');
  const { alignSelf: _alias, ...words } = layout;
  return { ...words, sizing: { ...layout.sizing, [axis]: "fill" } };
}
