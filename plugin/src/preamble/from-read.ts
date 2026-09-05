// from-read — `flcm.fromRead(spec)`: the SimplifiedNode a `get` returns, re-authored as constructor
// CALLS. Read and write are one vocabulary (docs/canonical-vocabulary.md): the same word names the same
// thing on both sides, so a single spec spreads straight into its constructor or into `edit`, and the
// read shape's read-only words (`id`, `type`, `children`, a root's `designedWidth`) are judged by the
// prelude every entry runs (validate.ts acceptAuthoringProps). What is left for this verb is what ONE
// constructor call can't take:
//   • the by-type dispatch, and the recursion into `children`, which arrive as read specs;
//   • real state flcm has no word for — refused by NAME, pointing at flcm.clone.
//
// It emits calls, never IR. ADR-0012 makes the constructors the only authoring dialect — render refuses
// any WriteNode they didn't mint — so there is no raw-IR shortcut to take even if it were tempting.
//
// It is a VERB, not a dispatch rule. A `get` result carries a live `id` exactly as a handle does, so
// letting a structural verb rebuild implicitly would mean guessing "copy this" from "move this" —
// the ambiguity that already produced a silent destructive bug. `fromRead` output is constructor-built,
// so `append(other, flcm.fromRead(spec))` classifies as a spec on provenance alone, and a RAW spec keeps
// being refused (structure.ts) with a pointer here.
//
// FIDELITY IS THE CONTRACT. Real state the read shape carries that the rebuild has no word for fails
// LOUD by name. The only silent drops are fields whose information is already elsewhere in the same
// bag, each named in the table below with why.
//
// VALUE-level legality is NOT this verb's call. Read's layout unions carry spellings the canvas can't
// realize ("baseline", "stretch" on justifyContent, `mode: "grid"`) and the constructors are the stated
// authority on which values are realizable (core/src/transformers/layout/common.ts). So a read-legal/
// write-illegal VALUE rides through and the constructor names the supported set; this verb only
// intercepts the two read artifacts a value parser would misname (a compressed read's style refs, a
// multi-value shorthand). The grid-only layout WORDS are refused here by name, since a word is
// vocabulary, not a value.
//
// THE CEILING, stated so it isn't mistaken for a promise: this verb can only refuse what the read shape
// CARRIES. State the READ side already dropped is invisible here and rebuilds as the flcm default with no
// error — `clipsContent`, a paint's blendMode, an image paint's opacity/rotation/filters, and the ORDER of
// a node's effect stack are all known cases (each a read-side fix). A node whose fidelity depends on one
// of them is a flcm.clone case, and the agent has no way to tell from the spec. Do not add a guess here
// to paper over one: the fix belongs where the information was lost.

import type { WriteNode, WriteChild } from "./ir.js";
import { frame, text, rect, ellipse, line, CONSTRUCTOR_KEYS_BY_TYPE } from "./flcm.js";
import type { SimplifiedNode, SimplifiedLayout } from "@framelink/core";
import { own } from "./validate.js";
import type { FrameProps, TextProps, ShapeProps, EllipseProps, LineProps } from "./schema.js";

// The read types that have an flcm constructor. Read renames VECTOR → IMAGE-SVG and collapses SVG-heavy
// containers into it, so no read type maps to flcm.svg/flcm.path: neither markup nor path data survives
// the read (see UNAUTHORABLE_TYPES).
type AuthorableReadType = "FRAME" | "TEXT" | "RECTANGLE" | "ELLIPSE" | "LINE";

// Why each non-createable read type has no spec rebuild. Types outside both tables get the generic
// message — the set of node types Figma can produce is open, and a new one is not a fromRead bug.
const UNAUTHORABLE_TYPES: Record<string, string> = {
  "IMAGE-SVG": "the read shape flattens a VECTOR (and SVG-heavy containers) into IMAGE-SVG, which carries no path data or markup to rebuild from",
  GROUP: "a GROUP is a selection wrapper with no flcm constructor — its children carry the layout, so there is nothing to author",
  INSTANCE: "an INSTANCE is bound to its main component, and a rebuild from props would produce a detached lookalike that stops tracking the component",
  COMPONENT: "a COMPONENT is a definition other nodes instantiate — rebuilding its props would produce a plain frame, not a component",
  COMPONENT_SET: "a COMPONENT_SET is a variant container — rebuilding its props would produce a plain frame, not a component set",
};

export const CLONE_REMEDY = "A live node keeps this under flcm.clone(target, parent), which copies it whole.";

// Read keys outside the constructor vocabulary need an explicit disposition. The fresh literal's
// satisfies check requires every such key and rejects constructor words or keys absent from read.
// Optional props still contribute keys; distribute over the union to include type-specific words.
type Keys<T> = T extends unknown ? keyof T : never;
type AuthorableReadKey = Keys<FrameProps | TextProps | ShapeProps | EllipseProps | LineProps>;
type ReadFieldDisposition = "prelude" | "drop" | { refuse: string };

export const READ_FIELD_DISPOSITIONS = {
  id: "prelude",
  type: "prelude",
  children: "prelude",
  designedWidth: "prelude",
  designedHeight: "prelude",
  template: {
    refuse: "`template` is a COMPRESSED read's back-reference into the design's `templates` table, so this node's body isn't here at all. flcm.get returns the expanded shape — re-read the node with it",
  },
  strokeDashes: { refuse: "flcm strokes are solid — there is no dash-pattern word" },
  aspectRatio: { refuse: "a locked aspect ratio (Figma's constrain-proportions) has no flcm word — the rebuild would silently stop holding its proportions" },
  componentId: { refuse: "this node is a component instance, and flcm cannot author one — a rebuild from props would be a detached lookalike" },
  componentProperties: { refuse: "component property VALUES belong to an instance, and flcm cannot author instances" },
  componentPropertyReferences: { refuse: "a component property BINDING (this node's text/visibility driven by a component prop) has no flcm word" },
  propertyDefinitions: { refuse: "component property DEFINITIONS belong to a COMPONENT or COMPONENT_SET, and flcm cannot author either — a rebuild would be a plain frame that defines nothing" },
  // Which fields the designer overrode on an instance sublayer. The overridden VALUES are already in the
  // same bag (`fill`, `text`, …); this only names them, and a rebuild is detached from the component
  // either way, so there is no distinction left to carry.
  overrides: "drop",
} satisfies Record<Exclude<keyof SimplifiedNode, AuthorableReadKey>, ReadFieldDisposition>;

// Every SimplifiedLayout word, with the same dispositions — an exact Record for the same reason. The
// authorable five ARE flcm's `layout` prop; the rest are container config with no flcm word.
export const LAYOUT_WORD_DISPOSITIONS: Record<keyof SimplifiedLayout, "author" | ReadFieldDisposition> = {
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

const ALL_CONSTRUCTOR_KEYS = new Set(Object.values(CONSTRUCTOR_KEYS_BY_TYPE).flatMap(keys => [...keys]));

const CONSTRUCTOR_SUBJECTS: Record<AuthorableReadType, string> = {
  FRAME: "flcm.frame", TEXT: "flcm.text", RECTANGLE: "flcm.rect", ELLIPSE: "flcm.ellipse", LINE: "flcm.line",
};

type Builder = (spec: Record<string, unknown>, subject: string) => WriteNode;

const BUILDERS: Record<AuthorableReadType, Builder> = {
  FRAME: (spec, subject) => {
    // Children are rebuilt FIRST, each under its own path, so a refusal deep in the subtree names the
    // node it came from rather than the root.
    const { children, ...props } = spec;
    if (children != null && !Array.isArray(children)) {
      throw new Error(subject + ".children: expected the read shape's array of child specs — got " + JSON.stringify(children) + ".");
    }
    const built = (children ?? []).map((child: unknown, i: number) => buildFromRead(child, childSubject(subject, i, child)));
    return frame(props, built as WriteChild[]);
  },
  TEXT: (spec) => text(spec),
  RECTANGLE: (spec) => rect(spec),
  ELLIPSE: (spec) => ellipse(spec),
  LINE: (spec) => line(spec),
};

/**
 * flcm.fromRead — re-author a `get` result as a constructor-built spec, ready for render/append.
 * The spec is agent input at a system boundary, so every shape assumption is checked here.
 */
export function fromRead(spec: unknown): WriteNode {
  return buildFromRead(spec, "flcm.fromRead");
}

function buildFromRead(spec: unknown, subject: string): WriteNode {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(subject + ": expected a `get` result (a read spec object) — got " + JSON.stringify(spec) + ".");
  }
  const n = spec as Record<string, unknown>;
  const type = assertAuthorableType(n.type, subject);
  try {
    return BUILDERS[type](readyReadSpec(n, type, subject), subject);
  } catch (e) {
    // The constructor names itself; prefix the path so a deep refusal still says WHICH node. A child's
    // error is already prefixed by its own call, and the frame builder rebuilds children before its own
    // call, so nothing is prefixed twice.
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(message.startsWith(subject) ? message : subject + ": " + message);
  }
}

function childSubject(subject: string, i: number, child: unknown): string {
  const c = (child ?? {}) as { name?: unknown; type?: unknown };
  return subject + " > " + JSON.stringify(c.name ?? c.type ?? `child[${i}]`);
}

function assertAuthorableType(type: unknown, subject: string): AuthorableReadType {
  if (typeof type !== "string" || !type) {
    throw new Error(subject + ": the spec has no `type` — pass a node from flcm.get (the read shape always names its type).");
  }
  if (own(BUILDERS as Record<string, Builder>, type)) return type as AuthorableReadType;
  const why = own(UNAUTHORABLE_TYPES, type);
  throw new Error(
    subject + ": " + type + " nodes have no authored form — " +
      (why || "flcm's constructors build FRAME/TEXT/RECTANGLE/ELLIPSE/LINE (plus svg/path from markup you supply), and this is none of them") +
      ". " + CLONE_REMEDY,
  );
}

// ---- what a constructor call can't take ----

// Refuse the unauthorable, drop the derived, and hand the rest to the constructor. A key outside the
// read shape rides through untouched: the constructor's closed set names a typo in its own voice, and
// this verb has nothing to add.
function readyReadSpec(src: Record<string, unknown>, type: AuthorableReadType, subject: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = CONSTRUCTOR_KEYS_BY_TYPE[type];
  const constructorSubject = CONSTRUCTOR_SUBJECTS[type];
  for (const key of Object.keys(src)) {
    const value = src[key];
    const disposition = own(READ_FIELD_DISPOSITIONS as Record<string, ReadFieldDisposition>, key);
    // A null or undefined known key is absence, not a claim.
    if ((disposition || ALL_CONSTRUCTOR_KEYS.has(key)) && value == null) continue;
    if (disposition === "drop") continue;
    if (typeof disposition === "object") throw refuse(subject, key, disposition.refuse);
    if (disposition === "prelude") {
      out[key] = value;
      continue;
    }
    if (known.has(key)) {
      out[key] = readyAuthoredValue(key, value, subject);
      continue;
    }
    // A constructor word on the wrong type names the state a rebuild cannot carry.
    if (ALL_CONSTRUCTOR_KEYS.has(key)) throw noWord(subject, constructorSubject, known, key);
    out[key] = value;
  }
  return out;
}

// ---- the refusals ----

// THE refusal. Every "flcm has no word for this" message in the module is built here, so the sentence
// and the remedy can't drift between the node-field gate, the layout-word gate and the value guards.
function refuse(subject: string, what: string, why: string): Error {
  return new Error(subject + ": `" + what + "` has no authored form — " + why + ". " + CLONE_REMEDY);
}

function noWord(subject: string, constructorSubject: string, known: ReadonlySet<string>, readKey: string): Error {
  return new Error(
    subject + ": `" + readKey + "` is not one of " + constructorSubject + "'s words (" + [...known].join(", ") +
      "). On a node read with flcm.get this is real state a rebuild can't carry. " + CLONE_REMEDY,
  );
}

// ---- values that keep their key ----

function readyAuthoredValue(key: string, value: unknown, subject: string): unknown {
  switch (key) {
    case "layout": return readyLayout(value, subject);
    case "text": return readyTextContent(value, subject);
    case "textStyle": case "effects": case "fill": case "stroke": return assertNotCompressedRef(value, subject + "." + key);
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
function readyLayout(raw: unknown, subject: string): unknown {
  assertNotCompressedRef(raw, subject + ".layout");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const l: Record<string, unknown> = {};
  for (const word of Object.keys(raw)) {
    const value = (raw as Record<string, unknown>)[word];
    if (value == null) continue; // an explicitly-undefined word is absence, not a claim
    const disposition = own(LAYOUT_WORD_DISPOSITIONS, word);
    if (disposition && typeof disposition === "object") throw refuse(subject + ".layout", word, disposition.refuse);
    l[word] = value;
  }
  if (l.gap != null) singleValue(l.gap, subject + ".layout.gap", "one gap, not separate row and column gaps");
  return l;
}

// The read `text` field is already the canonical run model (a markdown string, or `[text, style]`
// tuples), so it re-authors verbatim. The one thing to intercept is a compressed run: a tuple whose
// style slot is a ref string rather than the delta.
function readyTextContent(raw: unknown, subject: string): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((run, i) => {
    if (Array.isArray(run)) assertNotCompressedRef(run[1], subject + ".text run[" + i + "] style");
    return run;
  });
}
