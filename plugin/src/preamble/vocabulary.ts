/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// vocabulary — THE flcm authoring word list: which words exist, which values an enum word takes,
// which word groups compose each node type, and what the prelude does with every word a read emits.
//
// Zod-free and figma-free, like ir.ts, so both sides read it as runtime data: the sandbox's gates build
// their closed sets from it, and schema.ts types every zod field table AGAINST it with an exact-key
// check (schema.ts `fieldsFor`). A word added here and not there — or there and not here — is a
// compile error at every depth, so no drift test mirrors one list against another.
import type { SimplifiedLayout, SimplifiedNode } from "@framelink/core";
import type { EditableType, WriteType } from "./ir.js";
import { INPUT_ALIASES } from "./input-aliases.js";

// ---- Native grid spellings (input-aliases.ts). The rule table owns them; they join the groups below
// as input-only words, which the prelude rewrites to their canonical word before any gate. ----
type AliasRules = typeof INPUT_ALIASES;
type AliasWord<G extends "child" | "container"> = {
  [K in keyof AliasRules]: AliasRules[K] extends { group: G; keys: readonly (infer W)[] } ? W : never;
}[keyof AliasRules];
function aliasWords<G extends "child" | "container">(group: G): readonly AliasWord<G>[] {
  return Object.values(INPUT_ALIASES).flatMap((rule) => ("group" in rule && rule.group === group ? [...rule.keys] : [])) as AliasWord<G>[];
}
const CHILD_ALIASES = aliasWords("child");
const CONTAINER_ALIASES = aliasWords("container");

export const BOUND_WORDS = ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const;
const PLACEMENT = [...CHILD_ALIASES, "layout", "left", "top", "position", "constraints"] as const;
const CHILD_LAYOUT = [...CHILD_ALIASES, "gridColumn", "gridRow", "justifySelf", "alignSelf", "zIndex"] as const;
const CONTAINER_LAYOUT = [...CONTAINER_ALIASES, "mode", "gridTemplateColumns", "gridTemplateRows", "gap", "wrap", "padding", "justifyContent", "alignItems"] as const;

// The word groups. A node type's vocabulary is a row of these (TYPE_WORD_GROUPS); the bags a verb
// takes beside a node (flcm.image opts, flcm.component options, …) are groups of their own.
export const WORD_GROUPS = {
  annotation: ["annotations"],
  shared: ["name", "key", "opacity", "mixBlendMode", "visible", "locked"],
  size: [...PLACEMENT, ...BOUND_WORDS, "width", "height", "aspectRatio"],
  placement: PLACEMENT,
  appearance: ["fill", "stroke", "strokeWidth", "strokeAlign", "borderRadius", "effects", "rotation"],
  ellipse: ["fill", "stroke", "strokeWidth", "strokeAlign", "effects", "rotation"],
  frame: [...CONTAINER_ALIASES, "layout", "clip", "clipsContent"],
  layout: [...CONTAINER_LAYOUT, ...CHILD_LAYOUT],
  childLayout: CHILD_LAYOUT,
  containerLayout: CONTAINER_LAYOUT,
  text: ["text", "textStyle", "fill", "boldWeight", "fontSize"],
  textStyle: [
    "style", "fontFamily", "fontWeight", "fontSize", "fontStyle", "lineHeight", "letterSpacing", "textDecoration",
    "textTransform", "fontVariant", "textAlign", "textAlignVertical", "paragraphSpacing", "paragraphIndent", "listSpacing",
    "hyperlink", "lineClamp",
  ],
  run: [
    "fontWeight", "fontSize", "fontFamily", "fontStyle", "lineHeight", "letterSpacing", "textDecoration", "textTransform",
    "fontVariant", "paragraphSpacing", "paragraphIndent", "listSpacing", "color", "hyperlink",
  ],
  line: [...PLACEMENT, "stroke", "strokeWidth", "width", "rotation"],
  path: ["vectorPaths", "d", "scale", "fill", "stroke", "strokeWidth", "strokeAlign", "effects", "rotation"],
  svg: ["svg", "fill", "stroke"],
  instance: ["componentProperties", "overrides", "exposed"],
  swap: ["componentId"],
  slotContent: ["children"],
  binding: ["componentPropertyReferences"],
  componentOptions: ["name", "description", "propertyDefinitions"],
  componentDefinition: ["description", "propertyDefinitions"],
  propertyDefinition: ["type", "name"],
  variantEntry: ["component", "variant"],
  variantsOptions: ["name", "description"],
  image: ["scaleMode", "placeholder", "opacity", "rotation", "filters", "blendMode"],
  gradient: ["type", "stops", "angle", "at"],
  effects: ["shadow", "blur", "backgroundBlur", "glass", "noise", "texture", "progressiveBlur", "progressiveBackgroundBlur"],
} as const;
export type WordGroup = keyof typeof WORD_GROUPS;
export type GroupWord<G extends WordGroup> = (typeof WORD_GROUPS)[G][number];

// The keys of the objects nested inside a word's value.
export const NESTED_WORDS = {
  annotationEntry: ["text", "category", "properties"],
  imageFilters: ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"],
  pad: ["x", "y", "top", "right", "bottom", "left"],
  gap: ["row", "column"],
  sides: ["top", "right", "bottom", "left"],
  corners: ["topLeft", "topRight", "bottomRight", "bottomLeft"],
  constraints: ["x", "y"],
  vectorPath: ["data", "windingRule"],
  gradientAt: ["x", "y"],
  // The string form of `effects` (ir.ts WriteCssEffects): the frozen CSS spellings.
  cssEffects: ["boxShadow", "filter", "backdropFilter", "textShadow"],
} as const;
export type NestedWord<K extends keyof typeof NESTED_WORDS> = (typeof NESTED_WORDS)[K][number];

// The values each enum word takes. Some are deliberately narrower than CSS — the realizable subset
// (no space-around, no oblique) — so the docs and the runtime gate offer the same closed set.
export const WORD_VALUES = {
  mode: ["row", "column", "grid", "none"],
  justifyContent: ["flex-start", "flex-end", "center", "space-between"],
  alignItems: ["flex-start", "flex-end", "center", "stretch", "baseline"],
  justifySelf: ["start", "center", "end", "auto", "stretch"],
  alignSelf: ["center", "stretch", "start", "end", "auto"],
  position: ["absolute", "none"],
  constraintX: ["left", "center", "right", "stretch", "scale", "none"],
  constraintY: ["top", "center", "bottom", "stretch", "scale", "none"],
  strokeAlign: ["inside", "outside", "center"],
  fontStyle: ["italic", "normal"],
  textDecoration: ["underline", "line-through", "none"],
  textAlign: ["left", "center", "right", "justify"],
  textAlignVertical: ["top", "center", "bottom"],
  textTransform: ["uppercase", "lowercase", "capitalize", "none"],
  fontVariant: ["small-caps", "all-small-caps"],
  scaleMode: ["FILL", "FIT", "CROP", "TILE"],
  gradientType: ["linear", "radial"],
  propertyType: ["boolean", "text", "instance_swap", "slot"],
  windingRule: ["NONZERO", "EVENODD", "NONE"],
  noiseType: ["monotone", "duotone", "multitone"],
} as const;
export type WordValue<K extends keyof typeof WORD_VALUES> = (typeof WORD_VALUES)[K][number];

// ---- Which groups compose each node type. ONE row per type, read by create (the compiler entry in
// compile-tree.ts), by edit (edit-plan.ts's per-type gate), by the schema's composed Props types and by
// the generated per-type doc lists — so the four cannot disagree on what a type takes.
//
// Edit's row is create's row minus CREATE_ONLY_WORDS; types no compiler builds are edit-only rows.
//
// INSTANCE combines frame-like root overrides with instance controls and the componentId target.
//
// `binding` (`componentPropertyReferences`) composes into every type that can BE a component's
// sublayer. Not onto COMPONENT/COMPONENT_SET: Figma has no component inside a component, so a
// component's own binding would name a property of something that can't exist. Not onto SLOT either:
// a slot is what an INSTANCE shows for a bound frame, and the binding lives on that frame back in the
// definition.
//
// COMPONENT and COMPONENT_SET take a FRAME's words because their root IS a frame, plus
// `componentDefinition` — the two words that change what the component DECLARES. SLOT takes the frame
// surface without them. The type row is not the instance policy: on an instance's slot Figma ignores
// a layoutMode change, while gap, padding, fills and fill/hug land and its child list stays open
// [verified live; instance-write-policy.ts refuses the rest].
// Annotation support follows https://developers.figma.com/docs/plugins/api/Annotation/, widened by
// what a live document answers: GROUP and SECTION carry no annotations, but a SLOT does [verified live].
export const TYPE_WORD_GROUPS = {
  FRAME: ["annotation", "shared", "size", "appearance", "frame", "binding"],
  TEXT: ["annotation", "shared", "size", "text", "binding"],
  RECTANGLE: ["annotation", "shared", "size", "appearance", "binding"],
  ELLIPSE: ["annotation", "shared", "size", "ellipse", "binding"],
  LINE: ["annotation", "shared", "line", "binding"],
  VECTOR: ["annotation", "shared", "size", "path", "binding"],
  INSTANCE: ["annotation", "shared", "size", "appearance", "frame", "instance", "swap", "binding"],
  COMPONENT: ["annotation", "shared", "size", "appearance", "frame", "componentDefinition"],
  COMPONENT_SET: ["annotation", "shared", "size", "appearance", "frame", "componentDefinition"],
  POLYGON: ["shared", "annotation"],
  STAR: ["shared", "annotation"],
  SLOT: ["annotation", "shared", "size", "appearance", "frame"],
} as const satisfies Record<EditableType, readonly WordGroup[]>;

// VECTOR's second create row: an svg import. A live svg-born vector is edited with VECTOR's row —
// path's words are the only vocabulary the type has once the markup is parsed.
export const SVG_WORD_GROUPS = ["annotation", "shared", "size", "svg", "binding"] as const satisfies readonly WordGroup[];

// The words a create row has and edit refuses, each with why. The reference prints these reasons.
export const CREATE_ONLY_WORDS = {
  key: "it is how later calls address the node, and re-keying could mint a duplicate address; set it in the render that creates the node, or rename the node with `name`",
  d: "path geometry; redraw a live path by placing `{ id, d }` with a placement verb (see values)",
  vectorPaths: "path geometry; redraw a live path by placing `{ id, d }` with a placement verb (see values)",
  scale: "path geometry; redraw a live path by placing `{ id, d }` with a placement verb (see values)",
  svg: "imported markup becomes a frame of vectors; to change the art, `replace` the node with a new svg VECTOR",
} as const;
type CreateOnlyWord = keyof typeof CREATE_ONLY_WORDS;

export type RowWord<R extends readonly WordGroup[]> = (typeof WORD_GROUPS)[R[number]][number];
type NodeRow = (typeof TYPE_WORD_GROUPS)[EditableType] | typeof SVG_WORD_GROUPS;
/** Every word some node type is authored with. */
export type NodeWord = RowWord<NodeRow>;
/** Every word flcm.edit takes on some node type. */
export type EditWord = Exclude<RowWord<(typeof TYPE_WORD_GROUPS)[EditableType]>, CreateOnlyWord>;

/**
 * One closed key set from raw word lists — a nested shape's (NESTED_WORDS) or a gate's input-only
 * extras beside a group. A set that is exactly whole groups goes through wordsOf instead.
 */
export function keySet(...groups: readonly (readonly string[])[]): ReadonlySet<string> {
  return new Set(groups.flat());
}

/** The closed key set of whole WORD_GROUPS — every gate built from groups alone reads them here. */
export function wordsOf(groups: readonly WordGroup[]): ReadonlySet<string> {
  return new Set(groups.flatMap((group) => WORD_GROUPS[group]));
}

function withoutCreateOnly(words: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...words].filter((word) => !Object.prototype.hasOwnProperty.call(CREATE_ONLY_WORDS, word)));
}

function typeRow(type: string): readonly WordGroup[] | undefined {
  return Object.prototype.hasOwnProperty.call(TYPE_WORD_GROUPS, type) ? TYPE_WORD_GROUPS[type as EditableType] : undefined;
}

/** What flcm.edit takes on a node of this type; undefined for a type with no row of its own. */
export function editWordsOf(type: string): ReadonlySet<string> | undefined {
  const row = typeRow(type);
  return row && withoutCreateOnly(wordsOf(row));
}

/** The flat edit vocabulary: the closed set a delta word is judged against before its node is known. */
export const EDIT_WORDS: ReadonlySet<EditWord> = withoutCreateOnly(
  wordsOf((Object.keys(TYPE_WORD_GROUPS) as EditableType[]).flatMap((type) => TYPE_WORD_GROUPS[type])),
) as ReadonlySet<EditWord>;

/** The frame group is the authority for container-only layout words. */
export function hasContainerLayout(type: string): boolean {
  return typeRow(type)?.includes("frame") ?? false;
}

/**
 * A section of the flcm reference, by the id both channels take (get_flcm_reference's `sections`, the
 * `reference` CLI command) and the preamble's refusals name ("the \"props\" section"). The server keys
 * its section table by this, so a section added, renamed or dropped on either side fails typecheck.
 */
export type FlcmReferenceSection =
  | "mental-model" | "layout" | "reads" | "verbs" | "props" | "annotations" | "values" | "edit" | "components" | "recipes";

// Where the reference lists a type's words: a type flcm creates has its own table in props; one it
// only edits is described against FRAME's in edit, beside the floor every row-less type gets.
const TYPE_REFERENCE_SECTION: { [T in EditableType]: T extends WriteType ? "props" : "edit" } = {
  FRAME: "props", TEXT: "props", RECTANGLE: "props", ELLIPSE: "props", LINE: "props", VECTOR: "props", INSTANCE: "props",
  COMPONENT: "edit", COMPONENT_SET: "edit", SLOT: "edit", POLYGON: "edit", STAR: "edit",
};

/** A node of this type, as a refusal names it: "a FRAME", "an INSTANCE". */
export function aNodeOfType(type: string): string {
  return (/^[AEIOU]/.test(type) ? "an " : "a ") + type;
}

/** The reference section that lists every word a node of this type takes. */
export function referenceSectionOfType(type: string): FlcmReferenceSection {
  return Object.prototype.hasOwnProperty.call(TYPE_REFERENCE_SECTION, type) ? TYPE_REFERENCE_SECTION[type as EditableType] : "edit";
}

// ---- The vocabulary a closed set is cut from, for the unknown-word gate (validate.ts rejectUnknownKeys):
// it tells a real word in the wrong place from a typo, so `lineHeight` on a TEXT is sent to textStyle
// rather than "corrected" to the nearest gated spelling, minHeight. ----
export interface WordVocabulary {
  /** Every word this kind of bag takes on some owner. One the set lacks is a real word this owner doesn't take. */
  every: ReadonlySet<string>;
  /** Why a word of `every` is missing from the set, where the vocabulary says. */
  why?: (word: string) => string | undefined;
  /** The bags nested under the set's own words, by word: a word one of them takes is pointed there. */
  nested?: Readonly<Record<string, ReadonlySet<string>>>;
  /** Spellings from CSS or Figma's API that are no flcm word, each with the flcm way to say it. */
  foreign?: Readonly<Record<string, string>>;
}

const LAYOUT_WORDS: ReadonlySet<string> = wordsOf(["layout"]);
const CHILD_LAYOUT_WORDS: ReadonlySet<string> = wordsOf(["childLayout"]);
const TEXT_STYLE_WORDS: ReadonlySet<string> = wordsOf(["textStyle"]);
// Every word a node's own bag, or a bag nested in it, takes on some type: the nested words count, since
// `lineHeight` on a FRAME is a real word a FRAME lacks, not a misspelling of `minHeight`.
const NODE_BAG_WORDS: ReadonlySet<string> = new Set([
  ...wordsOf([...Object.values(TYPE_WORD_GROUPS).flat(), ...SVG_WORD_GROUPS]),
  ...TEXT_STYLE_WORDS, ...LAYOUT_WORDS,
]);

/** A node's own bag, as a node of this type takes it under this verb. */
export function nodeBagVocabulary(type: string, verb: "create" | "edit"): WordVocabulary {
  if (verb === "create") return NODE_BAG_CREATE_VOCABULARIES[hasContainerLayout(type) ? "container" : "child"];
  return Object.prototype.hasOwnProperty.call(NODE_BAG_EDIT_VOCABULARIES, type) ? NODE_BAG_EDIT_VOCABULARIES[type as EditableType] : ROWLESS_EDIT_VOCABULARY;
}

/** Whether a word is a node's at all — some type's bag word, or a word the read shape emits. */
export function isNodeWord(word: string): boolean {
  return NODE_BAG_WORDS.has(word) || nodeWordDisposition(word) !== undefined;
}

// The mistakes an agent most often makes on a node, said the flcm way at create and edit alike:
// "unknown prop" would misdiagnose them, and no spelling near them is the word they mean.
const POSITION_SPELLING = "position is not spelled with bare x/y — use `left`/`top` (naming either also lifts the node out of an auto-layout flow; `position: \"none\"` returns it), and `constraints` for how it responds to a parent resize";
const FILL_SPELLING = "a node's color, text included, is its `fill`";
const NODE_FOREIGN_SPELLINGS: Readonly<Record<string, string>> = {
  x: POSITION_SPELLING,
  y: POSITION_SPELLING,
  color: FILL_SPELLING,
  background: FILL_SPELLING,
  backgroundColor: FILL_SPELLING,
};
// Built once: every props-taking entry asks for one, and the gate's happy path allocates nothing.
const nodeBag = (layout: ReadonlySet<string>, why?: WordVocabulary["why"]): WordVocabulary => ({ every: NODE_BAG_WORDS, nested: { textStyle: TEXT_STYLE_WORDS, layout }, why, foreign: NODE_FOREIGN_SPELLINGS });
const NODE_BAG_CREATE_VOCABULARIES = { container: nodeBag(LAYOUT_WORDS), child: nodeBag(CHILD_LAYOUT_WORDS) };
// A create-only word says why only on a type whose create rows have it: `d` on a FRAME is a word a
// FRAME lacks, not path geometry it could have had. A row-less type's create row is the shared floor.
const createOnlyReasonOn = (created: ReadonlySet<string>) => (word: string): string | undefined =>
  created.has(word) && Object.prototype.hasOwnProperty.call(CREATE_ONLY_WORDS, word)
    ? "it is set only when the node is created — " + CREATE_ONLY_WORDS[word as CreateOnlyWord]
    : undefined;
const editBag = (layout: ReadonlySet<string>, created: readonly WordGroup[]): WordVocabulary => nodeBag(layout, createOnlyReasonOn(wordsOf(created)));
const NODE_BAG_EDIT_VOCABULARIES = Object.fromEntries(
  (Object.keys(TYPE_WORD_GROUPS) as EditableType[]).map((type) => [type, editBag(hasContainerLayout(type) ? LAYOUT_WORDS : CHILD_LAYOUT_WORDS, type === "VECTOR" ? [...TYPE_WORD_GROUPS.VECTOR, ...SVG_WORD_GROUPS] : TYPE_WORD_GROUPS[type])]),
) as Record<EditableType, WordVocabulary>;
const ROWLESS_EDIT_VOCABULARY = editBag(CHILD_LAYOUT_WORDS, ["shared"]);

/**
 * The bag edit's type-blind gate judges against (validate.ts rejectNonDeltaWords). It sees only words
 * that are no node word at all, so only the spellings and the nearest words matter here.
 */
export const TYPE_BLIND_NODE_VOCABULARY: WordVocabulary = NODE_BAG_CREATE_VOCABULARIES.container;

/** A node's `layout` bag: a container word on a node that only sits in a flow is real, not a typo. */
export const LAYOUT_VOCABULARY: WordVocabulary = { every: LAYOUT_WORDS };

// ---- The binding word's fields: which node types may bind each, the component property type it
// demands, and — for the refusal's second sentence — why it belongs where it does. `visible` has no
// owner: every node has one, so it is never the wrong node's word. The key Figma stores each under is
// component-properties.ts's (BINDING_FIELD_WIRE_KEYS), keyed exhaustively by these fields.
export const BINDABLE_FIELDS = {
  visible: { types: "any", propertyType: "boolean" },
  text: { types: ["TEXT"], propertyType: "text", owner: "`text` drives a TEXT node's content, so it belongs to TEXT" },
  componentId: {
    types: ["INSTANCE"], propertyType: "instance_swap",
    owner: "`componentId` is an instance-swap property re-pointing an INSTANCE, so it belongs to INSTANCE",
  },
  slot: {
    types: ["FRAME"], propertyType: "slot",
    owner: "`slot` marks the FRAME that IS the slot (an instance shows it as a SLOT holding that frame's content), so it belongs to FRAME",
  },
} as const satisfies Record<string, { types: "any" | readonly WriteType[]; propertyType: WordValue<"propertyType">; owner?: string }>;
export type BindableField = keyof typeof BINDABLE_FIELDS;

/** The binding bag: a field another node type binds is refused with why it belongs there. */
export const BINDING_VOCABULARY: WordVocabulary = {
  every: new Set(Object.keys(BINDABLE_FIELDS)),
  why: (word) => (Object.prototype.hasOwnProperty.call(BINDABLE_FIELDS, word) ? (BINDABLE_FIELDS[word as BindableField] as { owner?: string }).owner : undefined),
};

/** Which fields a node of this type may bind, `visible` first — in order, for a refusal to list. */
export function bindableFieldsOf(type: string): readonly BindableField[] {
  return (Object.keys(BINDABLE_FIELDS) as BindableField[]).filter((field) => {
    const types: "any" | readonly string[] = BINDABLE_FIELDS[field].types;
    return types === "any" || types.includes(type);
  });
}

// ---- What the prelude does with each word a read emits (ADR-0007: read words are write words, judged
// once, in the prelude every props-taking entry runs — authoring-input.ts).
//   author   — an authoring word; the entry's closed set judges it.
//   identity — the entry's own: `id` is live identity, `type` must match, `children` is placement.
//   context  — a read root's designed size: dropped, except as a page fallback beside a "fill" axis.
//   record   — describes the read, never a change; dropped wherever it appears.
//   refuse   — read-only state with no authored form, refused by name with its reason.
// Keyed by the read shape exhaustively, and typed so a word some row authors MUST be "author" and no
// other word may be: a read word that gains a write form changes its row here, at compile time.
export type ReadWordDisposition = "author" | "identity" | "context" | "record" | { refuse: string };
type DispositionsFor<K extends string> = { [W in K]: W extends NodeWord ? "author" : Exclude<ReadWordDisposition, "author"> };

export const NODE_WORD_DISPOSITIONS: DispositionsFor<keyof SimplifiedNode> = {
  id: "identity",
  type: "identity",
  children: "identity",
  designedWidth: "context",
  designedHeight: "context",
  warnings: "record",
  readOnlySource: "record",
  elided: "record",
  comments: "record",
  template: { refuse: "this is a compressed template reference; read the expanded node with flcm.get" },
  strokeDashes: { refuse: "flcm strokes are solid and have no dash pattern" },
  name: "author", locked: "author", visible: "author", opacity: "author", mixBlendMode: "author",
  annotations: "author", clip: "author", constraints: "author", layout: "author",
  minWidth: "author", maxWidth: "author", minHeight: "author", maxHeight: "author",
  width: "author", height: "author", aspectRatio: "author", position: "author", left: "author", top: "author", rotation: "author",
  d: "author", vectorPaths: "author",
  text: "author", textStyle: "author", boldWeight: "author",
  fill: "author", stroke: "author", strokeWidth: "author", strokeAlign: "author", effects: "author", borderRadius: "author",
  exposed: "author", componentId: "author", componentProperties: "author", componentPropertyReferences: "author", overrides: "author",
};

export const LAYOUT_WORD_DISPOSITIONS: { [W in keyof SimplifiedLayout]: W extends GroupWord<"layout"> ? "author" : { refuse: string } } = {
  mode: "author",
  gap: "author",
  padding: "author",
  justifyContent: "author",
  alignItems: "author",
  alignSelf: "author", // The read word is grid-only; flow stretch is an input alias for fill.
  wrap: "author",
  overflowScroll: { refuse: "scroll behavior (Figma's overflowDirection) has no flcm property" },
  gridTemplateColumns: "author",
  gridTemplateRows: "author",
  gridColumn: "author",
  gridRow: "author",
  justifySelf: "author",
  zIndex: "author",
};

export function nodeWordDisposition(word: string): ReadWordDisposition | undefined {
  return Object.prototype.hasOwnProperty.call(NODE_WORD_DISPOSITIONS, word)
    ? NODE_WORD_DISPOSITIONS[word as keyof SimplifiedNode]
    : undefined;
}
