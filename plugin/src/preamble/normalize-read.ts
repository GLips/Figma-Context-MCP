// normalize-read — `flcm.fromRead(spec)`: the SimplifiedNode a `get` returns, re-authored as constructor
// CALLS. This is the last stretch of the read↔write seam: everything else in the surface already speaks
// one vocabulary, and this module is where a whole READ subtree becomes a writable one.
//
// It emits calls, never IR. ADR-0012 makes the constructors the only authoring dialect — render refuses
// any WriteNode they didn't mint — so there is no raw-IR shortcut to take even if it were tempting: the
// normalizer maps read fields onto `frame()`/`text()`/… props and lets the one validated compile do the
// building. Everything it knows is the STRUCTURAL remap (type names, children arrays, the textStyle/runs
// nesting, geometry → size words); every string leaf is handed to css.ts or straight to a constructor,
// so no second parser lives here.
//
// VALUE-level legality is NOT this module's call. Read's layout unions carry spellings the canvas can't
// realize ("baseline", "stretch" on justifyContent) and the constructors are the stated authority on
// which values are realizable (src/core/transformers/layout/common.ts). So a read-legal/write-illegal
// VALUE rides through and the constructor names the supported set. `mode: "grid"` is the one exception,
// and deliberately: grid is a container KIND, not a value choice — every grid-only word is already
// refused in LAYOUT_WORD_DISPOSITIONS, so the mode gets the matching voice and the clone remedy.
//
// It is a VERB, not a dispatch rule. A `get` result carries a live `id` exactly as a handle does, so
// letting a structural verb normalize implicitly would mean guessing "copy this" from "move this" —
// the ambiguity that already produced a silent destructive bug. `fromRead` output is constructor-built,
// so `append(other, flcm.fromRead(spec))` classifies as a spec on provenance alone, and a RAW spec keeps
// being refused (structure.ts) with a pointer here.
//
// FIDELITY IS THE CONTRACT. Anything the read shape carries that the write surface has no word for fails
// LOUD by name, pointing at flcm.clone — the live-duplicate path that copies a node whole. The only
// silent drops are fields that are purely DERIVED (their information is already elsewhere in the same
// spec), each named in READ_FIELD_DISPOSITIONS with why.
//
// THE CEILING, stated so it isn't mistaken for a promise: this module can only refuse what the read shape
// CARRIES. State the READ side already dropped is invisible here and rebuilds as the flcm default with no
// error — `clipsContent`, a paint's blendMode, an image paint's opacity/rotation/filters, and the ORDER of
// a node's effect stack are all known cases (each recorded in the plan's Left open, each a read-side fix).
// A node whose fidelity depends on one of them is a flcm.clone case, and the agent has no way to tell from
// the spec. Do not add a guess here to paper over one: the fix belongs where the information was lost.

import { WriteNode, WriteChild } from "./ir.js";
import { frame, text, rect, ellipse, line } from "./flcm.js";
import { length } from "./css.js";
import type { SimplifiedNode, SimplifiedLayout } from "~/core/index.js";

// The read types that have an flcm constructor. Read renames VECTOR → IMAGE-SVG and collapses SVG-heavy
// containers into it, so no read type maps to flcm.svg/flcm.path: neither markup nor path data survives
// the read (see UNAUTHORABLE_TYPES).
type AuthorableReadType = "FRAME" | "TEXT" | "RECTANGLE" | "ELLIPSE" | "LINE";

// Why each non-createable read type has no spec rebuild. Types outside both tables get the generic
// message — the set of node types Figma can produce is open, and a new one is not a normalizer bug.
const UNAUTHORABLE_TYPES: Record<string, string> = {
  "IMAGE-SVG": "the read shape flattens a VECTOR (and SVG-heavy containers) into IMAGE-SVG, which carries no path data or markup to rebuild from",
  GROUP: "a GROUP is a selection wrapper with no flcm constructor — its children carry the layout, so there is nothing to author",
  INSTANCE: "an INSTANCE is bound to its main component, and a rebuild from props would produce a detached lookalike that stops tracking the component",
  COMPONENT: "a COMPONENT is a definition other nodes instantiate — rebuilding its props would produce a plain frame, not a component",
  COMPONENT_SET: "a COMPONENT_SET is a variant container — rebuilding its props would produce a plain frame, not a component set",
};

// Every field of the read shape, with its disposition. Typed as an EXACT Record over `keyof
// SimplifiedNode`, which is the drift guard: a field added to (or removed from) the read shape fails
// plugin typecheck here until someone decides what the write side does with it. That is the whole reason
// this table exists as a table — the builder below reads the "use" fields by name, and without the
// exhaustive Record a new read field would just be ignored.
//   • "use"  — the builder maps it onto an authoring prop (possibly with siblings: width + designedWidth
//              are one size word, left + top + position are one `absolute`). NOTE the limit of the
//              guard: the Record forces a DISPOSITION, not a consumer. A "use" field the builder never
//              reads is still a silent drop — the tests below pin each one.
//   • "drop" — purely derived; its information is already elsewhere in the same spec.
//   • refuse — real state with no authoring word. Named, with the reason.
type ReadFieldDisposition = "use" | "drop" | { refuse: string };

const READ_FIELD_DISPOSITIONS: Record<keyof SimplifiedNode, ReadFieldDisposition> = {
  // Identity of the node that was READ. A rebuild is a new node — carrying the id forward is what would
  // make a copy look like a move.
  id: "drop",
  name: "use",
  type: "use",
  // NOT derived, despite reading like it: the read side omits a run's explicit `fontWeight` exactly when
  // it matches this value (core/transformers/text.ts classifyRun), so `boldWeight` is the ONLY carrier of
  // the weight `**` stands for. Dropping it re-rendered every Semi Bold emphasis at 700.
  boldWeight: "use",
  layout: "use",
  text: "use",
  textStyle: "use",
  fills: "use",
  strokes: "use",
  strokeWidth: "use",
  effects: "use",
  opacity: "use",
  borderRadius: "use",
  children: "use",
  width: "use",
  height: "use",
  designedWidth: "use",
  designedHeight: "use",
  position: "use",
  left: "use",
  top: "use",
  rotation: "use",
  template: {
    refuse: "`template` is a COMPRESSED read's back-reference into the design's `templates` table, so this node's body isn't here at all. flcm.get returns the expanded shape — re-read the node with it",
  },
  strokeDashes: {
    refuse: "flcm strokes are solid — there is no dash-pattern word",
  },
  strokeAlign: {
    refuse: 'flcm strokes align INSIDE (the CSS `border` an author writes); "outside" and "center" have no word',
  },
  aspectRatio: {
    refuse: "a locked aspect ratio (Figma's constrain-proportions) has no flcm word — the rebuild would silently stop holding its proportions",
  },
  componentId: {
    refuse: "this node is a component instance, and flcm cannot author one — a rebuild from props would be a detached lookalike",
  },
  componentProperties: {
    refuse: "component property VALUES belong to an instance, and flcm cannot author instances",
  },
  componentPropertyReferences: {
    refuse: "a component property BINDING (this node's text/visibility driven by a component prop) has no flcm word",
  },
};

// Which read fields each authorable type has a word for. The universal ones — name/opacity/type and the
// whole geometry group — are handled for every type and deliberately absent here; this table is only the
// per-type half, so a `strokes` on a TEXT (whose vocabulary is textStyle + color) fails by name instead
// of vanishing.
const SHAPE_FIELDS = ["fills", "strokes", "strokeWidth", "effects", "rotation"];

const AUTHORABLE_BY_TYPE: Record<AuthorableReadType, readonly string[]> = {
  FRAME: [...SHAPE_FIELDS, "borderRadius", "layout", "children"],
  // A TEXT's paint is its `color` word, and its vocabulary is otherwise the text one: no stroke, no
  // radius, no effects, no rotation (schema.ts TextSchema = shared + size + text).
  TEXT: ["fills", "text", "textStyle", "boldWeight"],
  RECTANGLE: [...SHAPE_FIELDS, "borderRadius"],
  // An ELLIPSE has no corners: `ellipse()` compiles with radius DISABLED (compileNodeLocalProps), so
  // listing borderRadius here would accept a read value the constructor then drops on the floor. This
  // is the Record's stated limit in live code — the table forces a disposition, not a consumer, so a
  // per-type list has to match what the constructor actually reads.
  ELLIPSE: SHAPE_FIELDS,
  // A LINE paints with `stroke` and sizes on `length` alone (schema.ts LineSchema).
  LINE: ["strokes", "strokeWidth", "rotation"],
};

// The set of fields ANY type scopes — DERIVED, never hand-listed. A field outside it is universal and
// skips the per-type gate, so a hand-copy that fell behind AUTHORABLE_BY_TYPE would silently stop
// gating that field on every other type: the exact vocabulary leak this module exists to prevent.
const TYPE_SCOPED_FIELDS: readonly string[] = Object.keys(AUTHORABLE_BY_TYPE).reduce<string[]>(
  (all, type) => all.concat(AUTHORABLE_BY_TYPE[type as AuthorableReadType] as string[]),
  [],
);

// Every SimplifiedLayout word, with the same three dispositions — an exact Record for the same reason.
// The authorable five ARE flcm's `layout` prop; the rest are container config with no flcm word.
const LAYOUT_WORD_DISPOSITIONS: Record<keyof SimplifiedLayout, ReadFieldDisposition> = {
  mode: "use",
  gap: "use",
  padding: "use",
  justifyContent: "use",
  alignItems: "use",
  alignSelf: { refuse: "cross-axis self-alignment has no flcm word — a child stretches by sizing that axis \"fill\"" },
  wrap: { refuse: "flcm auto-layout does not wrap — there is no wrap word" },
  overflowScroll: { refuse: "scroll behavior (Figma's overflowDirection) has no flcm word" },
  gridTemplateColumns: { refuse: "flcm cannot author a GRID container" },
  gridTemplateRows: { refuse: "flcm cannot author a GRID container" },
  gridColumn: { refuse: "grid placement belongs to a GRID parent, which flcm cannot author" },
  gridRow: { refuse: "grid placement belongs to a GRID parent, which flcm cannot author" },
  justifySelf: { refuse: "grid self-alignment belongs to a GRID parent, which flcm cannot author" },
  zIndex: { refuse: "explicit stacking order has no flcm word — sibling order is the z-order" },
};

const CLONE_REMEDY = "Duplicate the live node with flcm.clone(target, parent) instead — it copies the node whole.";

// Every table in this module is indexed by an AGENT-SUPPLIED string, so a plain `table[key]` reaches
// Object.prototype: `{ type: "toString" }` passed the type gate and `{ constructor: 1 }` passed the field
// gate, both silently. Own-property only — a closed set has to actually be closed.
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// ---- the verb ----

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
  const n = spec as Record<string, unknown> & SimplifiedNode;
  const type = assertAuthorableType(n.type, subject);
  assertDispositions(n, READ_FIELD_DISPOSITIONS as Record<string, ReadFieldDisposition>, subject, "read field", {
    type,
    authorable: AUTHORABLE_BY_TYPE[type],
  });

  const props: Record<string, unknown> = {};
  if (n.name != null) props.name = n.name;
  if (n.opacity != null) props.opacity = n.opacity;
  Object.assign(props, sizeProps(n, type, subject));

  switch (type) {
    case "FRAME": {
      Object.assign(props, appearanceProps(n, subject));
      if (n.layout != null) props.layout = layoutProps(n.layout, subject);
      const kids = n.children;
      if (kids != null && !Array.isArray(kids)) {
        throw new Error(subject + ".children: expected the read shape's array of child specs — got " + JSON.stringify(kids) + ".");
      }
      const children = (kids ?? []).map((child, i) => buildFromRead(child, childSubject(subject, i, child)));
      return frame(props, children as WriteChild[]);
    }
    case "TEXT": {
      // The read shape puts a text node's base color in `fills`, like every other node's paint; the write
      // surface spells it `color` (schema.ts TEXT_FIELDS) because a TEXT has no other paint slot.
      if (n.fills != null) props.color = assertNotCompressedRef(n.fills, subject + ".fills");
      const textStyle = n.textStyle == null ? {} : assertNotCompressedRef(n.textStyle, subject + ".textStyle");
      // The read shape reports the weight `**` stands for at the NODE level; flcm spells it inside
      // textStyle. Without this the copy re-renders every emphasis at 700 (see READ_FIELD_DISPOSITIONS).
      if (n.boldWeight != null) props.textStyle = { ...(textStyle as object), boldWeight: n.boldWeight };
      else if (n.textStyle != null) props.textStyle = textStyle;
      return text(textContent(n.text, subject), props);
    }
    case "RECTANGLE":
      Object.assign(props, appearanceProps(n, subject));
      return rect(props);
    case "ELLIPSE":
      Object.assign(props, appearanceProps(n, subject));
      return ellipse(props);
    case "LINE":
      if (n.strokes != null) props.stroke = assertNotCompressedRef(n.strokes, subject + ".strokes");
      if (n.strokeWidth != null) props.strokeWidth = singleValue(n.strokeWidth, subject + ".strokeWidth", "one uniform stroke width, not per-side weights");
      if (n.rotation != null) props.rotation = n.rotation;
      return line(props);
    default:
      return type satisfies never;
  }
}

function childSubject(subject: string, i: number, child: SimplifiedNode | undefined): string {
  return subject + " > " + JSON.stringify(child?.name ?? child?.type ?? `child[${i}]`);
}

function assertAuthorableType(type: unknown, subject: string): AuthorableReadType {
  if (typeof type !== "string" || !type) {
    throw new Error(subject + ": the spec has no `type` — pass a node from flcm.get (the read shape always names its type).");
  }
  if (own(AUTHORABLE_BY_TYPE as Record<string, readonly string[]>, type)) return type as AuthorableReadType;
  const why = own(UNAUTHORABLE_TYPES, type);
  throw new Error(
    subject + ": " + type + " nodes have no authored form — " +
      (why || "flcm's constructors build FRAME/TEXT/RECTANGLE/ELLIPSE/LINE (plus svg/path from markup you supply), and this is none of them") +
      ". " + CLONE_REMEDY,
  );
}

// THE refusal. Every "flcm has no word for this" message in the module is built here, so the sentence
// and the remedy can't drift between the node-field gate, the layout-word gate and the value guards.
function refuse(subject: string, what: string, why: string): Error {
  return new Error(subject + ": `" + what + "` has no authored form — " + why + ". " + CLONE_REMEDY);
}

// The closed-set scan, run over BOTH disposition tables before anything is built, so an unauthorable
// field rejects the WHOLE call rather than half a subtree. `scoped` is the per-type narrowing the node
// gate needs and the layout gate doesn't (a layout word means the same thing on every container).
function assertDispositions(
  bag: Record<string, unknown>,
  table: Record<string, ReadFieldDisposition>,
  subject: string,
  noun: string,
  scoped?: { type: AuthorableReadType; authorable: readonly string[] },
): void {
  for (const field of Object.keys(bag)) {
    if (bag[field] == null) continue; // an explicitly-undefined key is absence, not a claim
    const disposition = own(table, field);
    if (!disposition) {
      throw new Error(
        subject + ": unknown " + noun + " `" + field + "` — that is not part of the read shape flcm.get returns. " +
          "Pass the spec through unmodified, or author the node with the flcm constructors.",
      );
    }
    if (typeof disposition === "object") throw refuse(subject, field, disposition.refuse);
    if (
      scoped && disposition === "use" &&
      TYPE_SCOPED_FIELDS.indexOf(field) !== -1 && scoped.authorable.indexOf(field) === -1
    ) {
      throw new Error(
        subject + ": this " + scoped.type + " carries `" + field + "`, which flcm's " + scoped.type +
          " vocabulary has no word for. " + CLONE_REMEDY,
      );
    }
  }
}

// ---- geometry -> the size words ----

function sizeProps(n: SimplifiedNode, type: AuthorableReadType, subject: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const width = axisSize(n.width, n.designedWidth, subject + ".width");
  const height = axisSize(n.height, n.designedHeight, subject + ".height");
  assertSizeIsTheNodesOwn(n, width, height, subject);
  if (type === "LINE") {
    // A LINE sizes on `length` alone (LineSchema has no width/height). A numeric cross axis is the line's
    // ~0 bbox height and drops; a SIZING INTENT there is real state with no word — a line stretched in a
    // column reads height:"fill", and silently discarding it would rebuild a line that doesn't stretch.
    if (typeof height === "string") throw refuse(subject, "height", 'a LINE sizes only along its length, so a "' + height + '" cross axis has no flcm word');
    if (typeof width === "number") props.length = width;
  } else {
    if (width !== undefined) props.width = width;
    // A TEXT's height follows its content and wrap in flcm — which is exactly what read's "hug" says, so
    // the word is redundant, not lost. A FIXED text height IS state flcm can't author: it rides through
    // and the create gate rejects it by name (layout-legality.ts), with the remedy in its own words.
    if (height !== undefined && !(type === "TEXT" && height === "hug")) props.height = height;
  }
  // `left`/`top` are emitted whenever the parent's auto-layout doesn't already place the node — with
  // `position: "absolute"` under an auto-layout parent, without it under a free-form one. `absolute` is
  // the one authoring word for both: under a free-form parent the bridge writes x/y natively and the
  // ABSOLUTE positioning flag is inert (bridge.applyChildPosition). `position` is read explicitly rather
  // than inferred from left/top: the two travel together out of a real `get`, but the module advertises
  // spread-and-modify, where a hand-set `position` must not silently do nothing.
  if (n.position != null && n.position !== "absolute") {
    throw new Error(subject + '.position: the read shape spells only "absolute" (a node the parent\'s auto-layout does not place) — got ' + JSON.stringify(n.position) + ".");
  }
  if (n.left != null || n.top != null || n.position === "absolute") {
    const absolute: { x?: number; y?: number } = {};
    if (n.left != null) absolute.x = n.left;
    if (n.top != null) absolute.y = n.top;
    props.absolute = absolute;
  }
  return props;
}

// Read's `width`/`height` come from `absoluteBoundingBox` — the AXIS-ALIGNED bounds — while `rotation` is
// carried beside them. On an unrotated node those are the same number; on a rotated one they are not, so
// copying both would rebuild a 100×20 bar rotated 45° as an ~85×85 square rotated 45°. Wrong pixels with
// no error, which is the one thing this verb must not do — and worst on a LINE, whose `length` IS that
// width. Refuse the pair; a rotated node is a flcm.clone case until the read shape carries its own size.
function assertSizeIsTheNodesOwn(n: SimplifiedNode, width: unknown, height: unknown, subject: string): void {
  if (!n.rotation) return;
  if (typeof width !== "number" && typeof height !== "number") return;
  throw refuse(
    subject, "rotation",
    "this node is rotated " + n.rotation + "°, and the read `width`/`height` are its axis-aligned BOUNDS " +
      "rather than its own size — rebuilding from them would produce a differently-sized node",
  );
}

// One axis: a number is fixed px, "fill"/"hug" are intents that author verbatim. "contextual" is the read
// root's own artifact — Figma reports a top-level node FIXED against an absent parent, so read rewrites it
// and parks the real number in `designedWidth`. Rebuilding it as the designed px is what makes a pasted
// subtree LOOK like the one that was read; dropping the axis would hand back a differently-sized node.
function axisSize(dimension: unknown, designed: unknown, field: string): number | string | undefined {
  if (dimension == null) return undefined;
  if (dimension === "contextual") {
    return designed == null ? undefined : length(designed as number | string);
  }
  if (typeof dimension === "number" || dimension === "fill" || dimension === "hug") return dimension;
  throw new Error(field + ': expected a number, "fill", "hug", or "contextual" — got ' + JSON.stringify(dimension) + ".");
}

// ---- appearance ----

function appearanceProps(n: SimplifiedNode, subject: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (n.fills != null) props.fill = assertNotCompressedRef(n.fills, subject + ".fills");
  if (n.strokes != null) props.stroke = assertNotCompressedRef(n.strokes, subject + ".strokes");
  if (n.strokeWidth != null) props.strokeWidth = singleValue(n.strokeWidth, subject + ".strokeWidth", "one uniform stroke width, not per-side weights");
  if (n.borderRadius != null) props.borderRadius = singleValue(n.borderRadius, subject + ".borderRadius", "one uniform corner radius, not per-corner radii");
  if (n.effects != null) props.effects = assertNotCompressedRef(n.effects, subject + ".effects");
  if (n.rotation != null) props.rotation = n.rotation;
  return props;
}

// Every non-scalar read slot (fills/strokes/effects/layout/textStyle) is a REF string when the read was
// compressed and an array/object otherwise, so a string here is unambiguous — and worth its own message,
// since handing "style_a1b2c3d4" to a value parser reads as a malformed value, not a wrong read mode.
// Everything else passes through as the read shape it already is: a paint slot stays the read ARRAY that
// compilePaintWord unwraps, and which owns the stacked-paint refusal (flcm paints one).
function assertNotCompressedRef<T>(value: T, field: string): T {
  if (typeof value === "string") throw compressedRef(field);
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

// ---- layout ----

function layoutProps(raw: unknown, subject: string): Record<string, unknown> {
  const l = assertNotCompressedRef(raw, subject + ".layout") as SimplifiedLayout & Record<string, unknown>;
  if (typeof l !== "object" || l === null || Array.isArray(l)) {
    throw new Error(subject + ".layout: expected the read shape's layout object — got " + JSON.stringify(raw) + ".");
  }
  for (const word of Object.keys(l)) {
    if (l[word] == null) continue;
    const disposition = own(LAYOUT_WORD_DISPOSITIONS as Record<string, ReadFieldDisposition>, word);
    if (!disposition) {
      throw new Error(subject + ".layout: unknown word `" + word + "` — that is not part of the read shape's layout group.");
    }
    if (typeof disposition === "object") throw refuse(subject + ".layout", word, disposition.refuse);
  }
  const props: Record<string, unknown> = {};
  if (l.mode != null) {
    if (l.mode === "grid") {
      throw new Error(
        subject + '.layout.mode is "grid", and flcm cannot author a GRID container — its auto-layout words are row/column only. ' + CLONE_REMEDY,
      );
    }
    props.mode = l.mode;
  }
  // Both ride through as the CSS strings they already are — `gap` is a metric the constructor parses, and
  // `padding` takes read's box shorthand ("12px 16px") directly, so no second decode lives here.
  if (l.gap != null) props.gap = singleValue(l.gap, subject + ".layout.gap", "one gap, not separate row and column gaps");
  if (l.padding != null) props.padding = l.padding;
  if (l.justifyContent != null) props.justifyContent = l.justifyContent;
  if (l.alignItems != null) props.alignItems = l.alignItems;
  return props;
}

// ---- text ----

// A text node's content is flcm.text's POSITIONAL first argument, and the read `text` field is already the
// canonical run model (a markdown string, or `[text, style]` tuples) — so it re-authors verbatim. The one
// thing to intercept is a compressed run: a tuple whose style slot is a ref string rather than the delta.
function textContent(raw: unknown, subject: string): unknown {
  if (raw == null) return "";
  if (!Array.isArray(raw)) return raw;
  return raw.map((run, i) => {
    if (Array.isArray(run) && typeof run[1] === "string") throw compressedRef(subject + ".text run[" + i + "] style");
    return run;
  });
}
