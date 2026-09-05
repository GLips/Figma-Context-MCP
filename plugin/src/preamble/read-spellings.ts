// read-spellings — the read shape's own spellings, accepted at every authoring entry.
//
// A `get` result and a constructor's props are one vocabulary (docs/canonical-vocabulary.md) with a
// handful of spelling differences, each a deliberate write-side choice:
//   • a TEXT's paint is `fill` on read like every other node's; write spells it `color`.
//   • read `left`/`top` (+ `position: "absolute"`) report a free-placed node; write places one with
//     `absolute: { x, y }`, the one word for both a free-form and an auto-layout parent.
//   • read `boldWeight` sits at the node level; write nests it in `textStyle`, beside the base weight.
//   • read `text` is a field; flcm.text's content is the positional argument (edit's is `content`).
//   • read `width` on a LINE is its `length` — a LINE has no other size word.
//   • a read ROOT reports `width: "contextual"` and parks the real px in `designedWidth`.
// This module folds each read spelling onto the write one, so `{ ...spec, width: 320 }` authors as-is
// through any constructor and through `edit`, and fromRead only dispatches on `type` and recurses.
//
// The fold runs BEFORE each entry's closed-set gate (rejectUnknownKeys), so the read spellings never join
// KNOWN_KEYS or the generated doc: the write vocabulary stays one word per thing, and the read spelling
// is accepted, not advertised. Naming one thing both ways in one bag (`fills` AND `fill`) fails loud —
// a spread spec with a hand-set override is exactly where a silent "last one wins" would bite.
//
// FIDELITY IS THE CONTRACT. Real state the read shape carries that the entry has no word for fails LOUD
// by name, pointing at flcm.clone — the live-duplicate path that copies a node whole. The only silent
// drops are fields whose information is already elsewhere in the same bag, each named below with why.
//
// VALUE-level legality is NOT this module's call. Read's layout unions carry spellings the canvas can't
// realize ("baseline", "stretch" on justifyContent, `mode: "grid"`) and the constructors are the stated
// authority on which values are realizable (core/src/transformers/layout/common.ts). So a read-legal/
// write-illegal VALUE rides through and the constructor names the supported set; this module only
// rewrites the values that exist NOWHERE on the write side (a root's "contextual" size). The grid-only
// layout WORDS are refused here by name, since a word is vocabulary, not a value.
//
// THE CEILING, stated so it isn't mistaken for a promise: this module can only refuse what the read shape
// CARRIES. State the READ side already dropped is invisible here and rebuilds as the flcm default with no
// error — `clipsContent`, a paint's blendMode, an image paint's opacity/rotation/filters, and the ORDER of
// a node's effect stack are all known cases (each a read-side fix). A node whose fidelity depends on one
// of them is a flcm.clone case, and the agent has no way to tell from the spec. Do not add a guess here
// to paper over one: the fix belongs where the information was lost.

import type { SimplifiedNode, SimplifiedLayout } from "@framelink/core";
import { length } from "./css.js";

// Every field of the read shape, with its disposition. Typed as an EXACT Record over `keyof
// SimplifiedNode`, which is the drift guard: a field added to (or removed from) the read shape fails
// plugin typecheck here until someone decides what the write side does with it.
//   • "author" — the same word on both sides; rides through to the entry's own gate.
//   • "fold"   — a read spelling with a write spelling; acceptReadSpellings owns the rewrite. NOTE the
//                limit of the guard: the Record forces a DISPOSITION, not a consumer — a "fold" the code
//                never reads is still a silent drop, so the tests pin each one.
//   • "drop"   — purely derived; its information is already elsewhere in the same bag.
//   • refuse   — real state with no authoring word. Named, with the reason.
type ReadFieldDisposition = "author" | "fold" | "drop" | { refuse: string };

export const READ_FIELD_DISPOSITIONS: Record<keyof SimplifiedNode, ReadFieldDisposition> = {
  // Identity of the node that was READ. A rebuild is a new node — carrying the id forward is what would
  // make a copy look like a move.
  id: "drop",
  name: "author",
  type: "fold",
  // NOT derived, despite reading like it: the read side omits a run's explicit `fontWeight` exactly when
  // it matches this value (core/transformers/text.ts classifyRun), so `boldWeight` is the ONLY carrier of
  // the weight `**` stands for. Dropping it re-rendered every Semi Bold emphasis at 700.
  boldWeight: "fold",
  layout: "author",
  text: "fold",
  textStyle: "author",
  fill: "fold",
  stroke: "author",
  strokeWidth: "author",
  effects: "author",
  opacity: "author",
  borderRadius: "author",
  children: "fold",
  width: "fold",
  height: "fold",
  designedWidth: "fold",
  designedHeight: "fold",
  position: "fold",
  left: "fold",
  top: "fold",
  rotation: "author",
  template: {
    refuse: "`template` is a COMPRESSED read's back-reference into the design's `templates` table, so this node's body isn't here at all. flcm.get returns the expanded shape — re-read the node with it",
  },
  strokeDashes: { refuse: "flcm strokes are solid — there is no dash-pattern word" },
  strokeAlign: { refuse: 'flcm strokes align INSIDE (the CSS `border` an author writes); "outside" and "center" have no word' },
  aspectRatio: { refuse: "a locked aspect ratio (Figma's constrain-proportions) has no flcm word — the rebuild would silently stop holding its proportions" },
  componentId: { refuse: "this node is a component instance, and flcm cannot author one — a rebuild from props would be a detached lookalike" },
  componentProperties: { refuse: "component property VALUES belong to an instance, and flcm cannot author instances" },
  componentPropertyReferences: { refuse: "a component property BINDING (this node's text/visibility driven by a component prop) has no flcm word" },
  propertyDefinitions: { refuse: "component property DEFINITIONS belong to a COMPONENT or COMPONENT_SET, and flcm cannot author either — a rebuild would be a plain frame that defines nothing" },
  // Which fields the designer overrode on an instance sublayer. The overridden VALUES are already in the
  // same bag (`fills`, `text`, …); this only names them, and a rebuild is detached from the component
  // either way, so there is no distinction left to carry.
  overrides: "drop",
};

// Every SimplifiedLayout word, with the same dispositions — an exact Record for the same reason. The
// authorable five ARE flcm's `layout` prop; the rest are container config with no flcm word.
export const LAYOUT_WORD_DISPOSITIONS: Record<keyof SimplifiedLayout, ReadFieldDisposition> = {
  mode: "author",
  gap: "author",
  padding: "author",
  justifyContent: "author",
  alignItems: "author",
  alignSelf: { refuse: 'cross-axis self-alignment has no flcm word — a child stretches by sizing that axis "fill"' },
  wrap: { refuse: "flcm auto-layout does not wrap — there is no wrap word" },
  overflowScroll: { refuse: "scroll behavior (Figma's overflowDirection) has no flcm word" },
  gridTemplateColumns: { refuse: "flcm cannot author a GRID container" },
  gridTemplateRows: { refuse: "flcm cannot author a GRID container" },
  gridColumn: { refuse: "grid placement belongs to a GRID parent, which flcm cannot author" },
  gridRow: { refuse: "grid placement belongs to a GRID parent, which flcm cannot author" },
  justifySelf: { refuse: "grid self-alignment belongs to a GRID parent, which flcm cannot author" },
  zIndex: { refuse: "explicit stacking order has no flcm word — sibling order is the z-order" },
};

export const CLONE_REMEDY = "A live node keeps this under flcm.clone(target, parent), which copies it whole.";

// Every table in this module is indexed by an AGENT-SUPPLIED string, so a plain `table[key]` reaches
// Object.prototype: `{ type: "toString" }` passed the type gate and `{ constructor: 1 }` passed the field
// gate, both silently. Own-property only — a closed set has to actually be closed.
export function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export interface ReadSpellingContext {
  /** The node kind the bag is authored FOR: a constructor's own type, or the live target's under edit. */
  type: string;
  /** Create folds the read `text` field into the returned `content`; edit folds it onto its `content` word. */
  verb: "create" | "edit";
  /** The entry's own write vocabulary. Real read state with no word in it is refused by name. */
  known: ReadonlySet<string>;
  subject: string;
}

export interface FoldedProps {
  props: Record<string, unknown>;
  /** Create only: the read `text` field, handed to flcm.text as its positional content. */
  content?: unknown;
}

/**
 * Fold the read shape's spellings in `bag` onto the write ones. Keys outside the read shape (write-only
 * words, typos) ride through untouched for the entry's own closed-set gate to judge; a non-object rides
 * through whole for the same reason (the gate names the object-vs-value mistake).
 */
export function acceptReadSpellings(bag: unknown, ctx: ReadSpellingContext): FoldedProps {
  if (bag === null || typeof bag !== "object" || Array.isArray(bag)) return { props: bag as Record<string, unknown> };
  const src = bag as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const folded: FoldedProps = { props: out };
  const { subject, type } = ctx;

  // A read key that lands on a DIFFERENT write key. The bag is the authority on conflicts: the same
  // thing named both ways is refused rather than resolved.
  const land = (readKey: string, writeKey: string, value: unknown): void => {
    if (src[writeKey] != null) {
      throw new Error(subject + ": `" + readKey + "` and `" + writeKey + "` name the same thing (the read shape's spelling and flcm's) — pass one.");
    }
    if (!ctx.known.has(writeKey)) throw noWord(ctx, readKey);
    out[writeKey] = value;
  };
  // A read key that keeps its name — still has to be a word THIS entry reads.
  const keep = (key: string, value: unknown): void => {
    if (!ctx.known.has(key)) throw noWord(ctx, key);
    out[key] = value;
  };

  for (const key of Object.keys(src)) {
    const value = src[key];
    const disposition = own(READ_FIELD_DISPOSITIONS as Record<string, ReadFieldDisposition>, key);
    if (!disposition) { out[key] = value; continue; }
    // An explicitly-undefined READ key is absence, not a claim. A write word keeps its null so the
    // entry's own rule for it applies (edit refuses a delta that compiles to nothing).
    if (value == null) { if (ctx.known.has(key)) out[key] = value; continue; }
    if (disposition === "drop") continue;
    if (typeof disposition === "object") throw refuse(subject, key, disposition.refuse);
    if (disposition === "author") {
      keep(key, foldAuthoredValue(key, value, subject));
      continue;
    }
    switch (key) {
      case "type":
        if (value !== type) {
          throw new Error(
            subject + ": the spec is a " + String(value) + ", not a " + type + ". " +
              (ctx.verb === "create" ? "flcm.fromRead(spec) builds by the spec's own type." : "Edit the node it was read from, or pass only the fields to change."),
          );
        }
        break;
      case "fill":
        assertNotCompressedRef(value, subject + ".fill");
        if (type === "TEXT") land("fill", "color", value);
        else keep("fill", value);
        break;
      case "text":
        if (ctx.verb === "edit") land("text", "content", foldTextContent(value, subject));
        else if (type !== "TEXT") throw noWord(ctx, "text");
        else folded.content = foldTextContent(value, subject);
        break;
      case "children":
        throw new Error(
          subject + ": `children` here are read specs, not built nodes. " +
            (ctx.verb === "create"
              ? "flcm.fromRead(spec) rebuilds the whole subtree; or build the children with the constructors and pass them as the second argument."
              : "A tree changes through the structure verbs (append, move, remove), not an edit."),
        );
      // The geometry words fold as a GROUP (an axis is width + designedWidth; a placement is left + top +
      // position), so they wait for the bag to be fully read.
      case "boldWeight": case "width": case "height": case "designedWidth": case "designedHeight":
      case "position": case "left": case "top":
        break;
      default:
        throw new Error(subject + ": no fold for read field `" + key + "` (read-spellings.ts).");
    }
  }

  foldSize(src, ctx, keep, land);
  foldPlacement(src, ctx, land);
  if (src.boldWeight != null) foldBoldWeight(src, out, ctx, keep);
  return folded;
}

// ---- the refusals ----

// THE refusal. Every "flcm has no word for this" message in the module is built here, so the sentence
// and the remedy can't drift between the node-field gate, the layout-word gate and the value guards.
function refuse(subject: string, what: string, why: string): Error {
  return new Error(subject + ": `" + what + "` has no authored form — " + why + ". " + CLONE_REMEDY);
}

// A word that IS in the read shape but not in this entry's vocabulary: a `strokes` on a TEXT, an
// `effects` on a LINE, a `borderRadius` on an ELLIPSE. Named as the type's missing word, not "unknown
// prop" — on a spec from flcm.get it is real state the rebuild would silently not have.
function noWord(ctx: ReadSpellingContext, readKey: string): Error {
  return new Error(
    ctx.subject + ": `" + readKey + "` is not one of " + ctx.subject + "'s words (" + [...ctx.known].join(", ") +
      "). On a node read with flcm.get this is real state a rebuild can't carry. " + CLONE_REMEDY,
  );
}

// ---- values that keep their key ----

function foldAuthoredValue(key: string, value: unknown, subject: string): unknown {
  switch (key) {
    case "layout": return foldLayout(value, subject);
    case "textStyle": case "effects": case "stroke": return assertNotCompressedRef(value, subject + "." + key);
    case "strokeWidth": return singleValue(value, subject + ".strokeWidth", "one uniform stroke width, not per-side weights");
    case "borderRadius": return singleValue(value, subject + ".borderRadius", "one uniform corner radius, not per-corner radii");
    default: return value;
  }
}

// Every style slot (fill/stroke/effects/layout/textStyle) is a REF string when the read was compressed,
// minted as `<prefix>_<8 hex>` (core/src/style-table.ts). The exact mint shape is matched — not "any
// string" — because `fill: "#FFF"` is a paint, and only the ref shape is worth its own message: handed
// to a value parser it reads as a malformed value, not a wrong read mode.
const STYLE_REF = /^(layout|style|fill|effect)_[0-9a-f]{8}/;

function assertNotCompressedRef<T>(value: T, field: string): T {
  if (typeof value === "string" && STYLE_REF.test(value)) throw compressedRef(field);
  return value;
}

function compressedRef(field: string): Error {
  return new Error(
    field + ' is a styles-table REFERENCE (like "fill_a1b2c3d4"), not a value — that spec came from a COMPRESSED read. ' +
      "flcm.get returns the expanded shape with every value inline; re-read the node with flcm.get, or resolve the ref against the design's `styles` table first.",
  );
}

// A read metric that flcm spells with ONE value. Read emits a CSS shorthand when the sides/corners differ
// ("1px 2px", "8px 8px 0px 0px"); flcm has one word for the whole node, so the multi-value form is real
// state with no authored form rather than something to average or take the first of.
function singleValue(value: unknown, field: string, whatFlcmHas: string): unknown {
  if (typeof value === "string" && /\s/.test(value.trim())) {
    throw new Error(field + " is " + JSON.stringify(value) + ", and flcm authors " + whatFlcmHas + ". " + CLONE_REMEDY);
  }
  return value;
}

// The layout bag keeps its key and its authorable words verbatim (`gap` is a metric the constructor
// parses, `padding` takes read's box shorthand directly); this only refuses the words with no flcm
// form. Unknown words are the constructor's closed set to name.
function foldLayout(raw: unknown, subject: string): unknown {
  assertNotCompressedRef(raw, subject + ".layout");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const l: Record<string, unknown> = {};
  for (const word of Object.keys(raw)) {
    const value = (raw as Record<string, unknown>)[word];
    if (value == null) continue; // an explicitly-undefined word is absence, not a claim
    const disposition = own(LAYOUT_WORD_DISPOSITIONS as Record<string, ReadFieldDisposition>, word);
    if (disposition && typeof disposition === "object") throw refuse(subject + ".layout", word, disposition.refuse);
    l[word] = value;
  }
  if (l.gap != null) singleValue(l.gap, subject + ".layout.gap", "one gap, not separate row and column gaps");
  return l;
}

// ---- text ----

// The read `text` field is already the canonical run model (a markdown string, or `[text, style]`
// tuples), so it re-authors verbatim. The one thing to intercept is a compressed run: a tuple whose
// style slot is a ref string rather than the delta.
function foldTextContent(raw: unknown, subject: string): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((run, i) => {
    if (Array.isArray(run)) assertNotCompressedRef(run[1], subject + ".text run[" + i + "] style");
    return run;
  });
}

// The read shape reports the weight `**` stands for at the NODE level; flcm spells it inside textStyle.
function foldBoldWeight(
  src: Record<string, unknown>, out: Record<string, unknown>, ctx: ReadSpellingContext,
  keep: (key: string, value: unknown) => void,
): void {
  if (ctx.type !== "TEXT") throw noWord(ctx, "boldWeight");
  const textStyle = out.textStyle;
  if (textStyle != null && typeof textStyle === "object" && (textStyle as Record<string, unknown>).boldWeight != null) {
    throw new Error(ctx.subject + ": `boldWeight` and `textStyle.boldWeight` name the same thing (the read shape's spelling and flcm's) — pass one.");
  }
  keep("textStyle", { ...(textStyle as object | null), boldWeight: src.boldWeight });
}

// ---- geometry ----

function foldSize(
  src: Record<string, unknown>, ctx: ReadSpellingContext,
  keep: (key: string, value: unknown) => void, land: (readKey: string, writeKey: string, value: unknown) => void,
): void {
  const { subject, type } = ctx;
  const width = axisSize(src.width, src.designedWidth);
  const height = axisSize(src.height, src.designedHeight);
  if (type === "LINE") {
    // A LINE sizes on `length` alone. Read reports its cross axis as `height: 0` — the only value a
    // LINE node has, restated — so that drops; a SIZING INTENT there is real state with no word (a line
    // stretched in a column reads height:"fill"), and silently discarding it would rebuild a line that
    // doesn't stretch.
    if (typeof height === "string") throw refuse(subject, "height", 'a LINE sizes only along its length, so a "' + height + '" cross axis has no flcm word');
    if (height !== undefined && height !== 0) keep("height", height); // not read's word for a line: the gate names it
    if (width !== undefined) land("width", "length", width);
    return;
  }
  if (width !== undefined) keep("width", width);
  // A created TEXT's height follows its content — which is exactly what "hug" says, so at create the
  // word is the default restated and drops, whether it came from a read or a hand. Under edit it rides
  // through: an edit is a delta, and a height word on a live text is a request the gate answers in its
  // own voice (layout-legality.ts). A FIXED text height IS state flcm can't author: it rides through in
  // both verbs and that gate rejects it by name.
  if (height !== undefined && !(type === "TEXT" && height === "hug" && ctx.verb === "create")) keep("height", height);
}

// One axis. Every write-side value (px, "fill", "hug", a percent) rides through for the constructor to
// judge; the one rewrite is "contextual", the read root's own artifact — Figma reports a top-level node
// FIXED against an absent parent, so read rewrites it and parks the real number in `designedWidth`.
// Rebuilding it as the designed px is what makes a pasted subtree LOOK like the one that was read;
// dropping the axis would hand back a differently-sized node.
function axisSize(dimension: unknown, designed: unknown): unknown {
  if (dimension === "contextual") return designed == null ? undefined : length(designed as number | string);
  return dimension == null ? undefined : dimension;
}

// `left`/`top` are emitted whenever the parent's auto-layout doesn't already place the node — with
// `position: "absolute"` under an auto-layout parent, without it under a free-form one. `absolute` is
// the one authoring word for both: under a free-form parent the bridge writes x/y natively and the
// ABSOLUTE positioning flag is inert (bridge.applyChildPosition). `position` is read explicitly rather
// than inferred from left/top: the two travel together out of a real `get`, but spread-and-modify is
// the advertised path, where a hand-set `position` must not silently do nothing.
function foldPlacement(
  src: Record<string, unknown>, ctx: ReadSpellingContext,
  land: (readKey: string, writeKey: string, value: unknown) => void,
): void {
  if (src.position != null && src.position !== "absolute") {
    throw new Error(ctx.subject + '.position: the read shape spells only "absolute" (a node the parent\'s auto-layout does not place) — got ' + JSON.stringify(src.position) + ".");
  }
  if (src.left == null && src.top == null && src.position == null) return;
  const absolute: { x?: unknown; y?: unknown } = {};
  if (src.left != null) absolute.x = src.left;
  if (src.top != null) absolute.y = src.top;
  land(src.position != null ? "position" : src.left != null ? "left" : "top", "absolute", absolute);
}
