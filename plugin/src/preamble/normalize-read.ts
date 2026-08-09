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

import { WriteNode, WriteChild, Edges } from "./ir.js";
import { frame, text, rect, ellipse, line } from "./flcm.js";
import { boxShorthand } from "./css.js";
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
//              are one size word, left + top + position are one `absolute`).
//   • "drop" — purely derived; its information is already elsewhere in the same spec.
//   • refuse — real state with no authoring word. Named, with the reason.
type ReadFieldDisposition = "use" | "drop" | { refuse: string };

const READ_FIELD_DISPOSITIONS: Record<keyof SimplifiedNode, ReadFieldDisposition> = {
  // Identity of the node that was READ. A rebuild is a new node — carrying the id forward is what would
  // make a copy look like a move.
  id: "drop",
  name: "use",
  type: "use",
  // The weight `**bold**` stands for in `text`. Derived from the runs it annotates, and the rebuild's
  // bold resolves through fonts.ts the same way the original's did.
  boldWeight: "drop",
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
const TYPE_SCOPED_FIELDS = ["fills", "strokes", "strokeWidth", "borderRadius", "effects", "rotation", "layout", "children", "text", "textStyle"];

const SHAPE_FIELDS = ["fills", "strokes", "strokeWidth", "borderRadius", "effects", "rotation"];

const AUTHORABLE_BY_TYPE: Record<AuthorableReadType, readonly string[]> = {
  FRAME: [...SHAPE_FIELDS, "layout", "children"],
  // A TEXT's paint is its `color` word, and its vocabulary is otherwise the text one: no stroke, no
  // radius, no effects, no rotation (schema.ts TextSchema = shared + size + text).
  TEXT: ["fills", "text", "textStyle"],
  RECTANGLE: SHAPE_FIELDS,
  ELLIPSE: SHAPE_FIELDS,
  // A LINE paints with `stroke` and sizes on `length` alone (schema.ts LineSchema).
  LINE: ["strokes", "strokeWidth", "rotation"],
};

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
  assertFieldsAuthorable(n, type, subject);

  const props: Record<string, unknown> = {};
  if (n.name != null) props.name = n.name;
  if (n.opacity != null) props.opacity = n.opacity;
  Object.assign(props, sizeProps(n, type, subject));

  switch (type) {
    case "FRAME": {
      Object.assign(props, appearanceProps(n, subject));
      if (n.layout != null) props.layout = layoutProps(n.layout, subject);
      const children = (n.children ?? []).map((child, i) => buildFromRead(child, childSubject(subject, child, i)));
      return frame(props, children as WriteChild[]);
    }
    case "TEXT": {
      // The read shape puts a text node's base color in `fills`, like every other node's paint; the write
      // surface spells it `color` (schema.ts TEXT_FIELDS) because a TEXT has no other paint slot.
      if (n.fills != null) props.color = paintProps(n.fills, subject + ".fills");
      if (n.textStyle != null) props.textStyle = assertInline(n.textStyle, "textStyle", subject);
      return text(textContent(n.text, subject), props);
    }
    case "RECTANGLE":
      Object.assign(props, appearanceProps(n, subject));
      return rect(props);
    case "ELLIPSE":
      Object.assign(props, appearanceProps(n, subject));
      return ellipse(props);
    case "LINE":
      if (n.strokes != null) props.stroke = paintProps(n.strokes, subject + ".strokes");
      if (n.strokeWidth != null) props.strokeWidth = singleValue(n.strokeWidth, subject + ".strokeWidth", "one uniform stroke width, not per-side weights");
      if (n.rotation != null) props.rotation = n.rotation;
      return line(props);
    default:
      return type satisfies never;
  }
}

function childSubject(subject: string, child: SimplifiedNode | undefined, i: number): string {
  return subject + " > " + JSON.stringify(child?.name ?? child?.type ?? `child[${i}]`);
}

function assertAuthorableType(type: unknown, subject: string): AuthorableReadType {
  if (typeof type !== "string" || !type) {
    throw new Error(subject + ": the spec has no `type` — pass a node from flcm.get (the read shape always names its type).");
  }
  if (type in AUTHORABLE_BY_TYPE) return type as AuthorableReadType;
  const why = UNAUTHORABLE_TYPES[type];
  throw new Error(
    subject + ": " + type + " nodes have no authored form — " +
      (why || "flcm's constructors build FRAME/TEXT/RECTANGLE/ELLIPSE/LINE (plus svg/path from markup you supply), and this is none of them") +
      ". " + CLONE_REMEDY,
  );
}

// The two closed-set gates, run before anything is built so an unauthorable field rejects the WHOLE call
// rather than half a subtree. Both are the same shape: look the key up, refuse or drop or keep.
function assertFieldsAuthorable(n: Record<string, unknown>, type: AuthorableReadType, subject: string): void {
  const authorable = AUTHORABLE_BY_TYPE[type];
  for (const field of Object.keys(n)) {
    if (n[field] == null) continue; // an explicitly-undefined key is absence, not a claim
    const disposition = (READ_FIELD_DISPOSITIONS as Record<string, ReadFieldDisposition | undefined>)[field];
    if (!disposition) {
      throw new Error(subject + ": unknown read field `" + field + "` — that is not part of the read shape flcm.get returns. Pass the spec through unmodified, or author the node with the flcm constructors.");
    }
    if (typeof disposition === "object") {
      throw new Error(subject + ": `" + field + "` has no authored form — " + disposition.refuse + ". " + CLONE_REMEDY);
    }
    if (disposition === "use" && TYPE_SCOPED_FIELDS.indexOf(field) !== -1 && authorable.indexOf(field) === -1) {
      throw new Error(subject + ": this " + type + " carries `" + field + "`, which flcm's " + type + " vocabulary has no word for. " + CLONE_REMEDY);
    }
  }
}

// ---- geometry -> the size words ----

function sizeProps(n: SimplifiedNode, type: AuthorableReadType, subject: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const width = axisSize(n.width, n.designedWidth, subject + ".width");
  if (type === "LINE") {
    // A LINE sizes on `length` alone — LineSchema has no width/height, and the constructor ignores the
    // cross axis, so the read height (always ~0 on a line) is dropped rather than refused.
    if (typeof width === "number") props.length = width;
  } else {
    if (width !== undefined) props.width = width;
    const height = axisSize(n.height, n.designedHeight, subject + ".height");
    // A TEXT's height follows its content and wrap in flcm — which is exactly what read's "hug" says, so
    // the word is redundant, not lost. A FIXED text height IS state flcm can't author: it rides through
    // and the create gate rejects it by name (layout-legality.ts), with the remedy in its own words.
    if (height !== undefined && !(type === "TEXT" && height === "hug")) props.height = height;
  }
  // `left`/`top` are emitted whenever the parent's auto-layout doesn't already place the node — with
  // `position: "absolute"` under an auto-layout parent, without it under a free-form one. `absolute` is
  // the one authoring word for both: under a free-form parent the bridge writes x/y natively and the
  // ABSOLUTE positioning flag is inert (bridge.applyChildPosition).
  if (n.left != null || n.top != null) {
    const absolute: { x?: number; y?: number } = {};
    if (n.left != null) absolute.x = n.left;
    if (n.top != null) absolute.y = n.top;
    props.absolute = absolute;
  }
  return props;
}

// One axis: a number is fixed px, "fill"/"hug" are intents that author verbatim. "contextual" is the read
// root's own artifact — Figma reports a top-level node FIXED against an absent parent, so read rewrites it
// and parks the real number in `designedWidth`. Rebuilding it as the designed px is what makes a pasted
// subtree LOOK like the one that was read; dropping the axis would hand back a differently-sized node.
function axisSize(dimension: unknown, designed: unknown, field: string): number | string | undefined {
  if (dimension == null) return undefined;
  if (dimension === "contextual") {
    return designed == null ? undefined : lengthOf(designed, field.replace(/\.(width|height)$/, ".designed$1"));
  }
  if (typeof dimension === "number" || dimension === "fill" || dimension === "hug") return dimension;
  throw new Error(field + ': expected a number, "fill", "hug", or "contextual" — got ' + JSON.stringify(dimension) + ".");
}

function lengthOf(value: unknown, field: string): number {
  const m = /^(-?\d+(\.\d+)?)px$/.exec(String(value).trim());
  if (!m) throw new Error(field + ': expected a px string like "320px" — got ' + JSON.stringify(value) + ".");
  return parseFloat(m[1]);
}

// ---- appearance ----

function appearanceProps(n: SimplifiedNode, subject: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (n.fills != null) props.fill = paintProps(n.fills, subject + ".fills");
  if (n.strokes != null) props.stroke = paintProps(n.strokes, subject + ".strokes");
  if (n.strokeWidth != null) props.strokeWidth = singleValue(n.strokeWidth, subject + ".strokeWidth", "one uniform stroke width, not per-side weights");
  if (n.borderRadius != null) props.borderRadius = singleValue(n.borderRadius, subject + ".borderRadius", "one uniform corner radius, not per-corner radii");
  if (n.effects != null) props.effects = assertInline(n.effects, "effects", subject);
  if (n.rotation != null) props.rotation = n.rotation;
  return props;
}

// A paint slot passes through as the read ARRAY it already is — compilePaintWord unwraps it, and owns the
// stacked-paint refusal (flcm paints one). Only the compressed-ref case is this module's to catch.
function paintProps(value: unknown, field: string): unknown {
  if (typeof value === "string") throw compressedRef(field);
  return value;
}

// The object-valued read slots (layout/textStyle/effects) are a REF string when the read was compressed.
// Their inline form is always an object, so a string here is unambiguous — and worth its own message,
// since handing "style_a1b2c3d4" to a value parser reads as a malformed value, not a wrong read mode.
function assertInline<T>(value: T, field: string, subject: string): T {
  if (typeof value === "string") throw compressedRef(subject + "." + field);
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
  const l = assertInline(raw, "layout", subject) as SimplifiedLayout & Record<string, unknown>;
  if (typeof l !== "object" || l === null || Array.isArray(l)) {
    throw new Error(subject + ".layout: expected the read shape's layout object — got " + JSON.stringify(raw) + ".");
  }
  for (const word of Object.keys(l)) {
    if (l[word] == null) continue;
    const disposition = (LAYOUT_WORD_DISPOSITIONS as Record<string, ReadFieldDisposition | undefined>)[word];
    if (!disposition) {
      throw new Error(subject + ".layout: unknown word `" + word + "` — that is not part of the read shape's layout group.");
    }
    if (typeof disposition === "object") {
      throw new Error(subject + ".layout." + word + " has no authored form — " + disposition.refuse + ". " + CLONE_REMEDY);
    }
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
  // gap and padding cross a units boundary: read spells both as CSS strings, flcm's `gap` takes one
  // metric and its `padding` takes NUMBERS (never "px" strings), so the shorthand is decoded here.
  if (l.gap != null) props.gap = singleValue(l.gap, subject + ".layout.gap", "one gap, not separate row and column gaps");
  if (l.padding != null) props.padding = paddingEdges(l.padding, subject + ".layout.padding");
  if (l.justifyContent != null) props.justifyContent = l.justifyContent;
  if (l.alignItems != null) props.alignItems = l.alignItems;
  return props;
}

function paddingEdges(value: unknown, field: string): Edges {
  if (typeof value !== "string") {
    throw new Error(field + ': expected the read shape\'s CSS padding string (e.g. "12px 16px") — got ' + JSON.stringify(value) + ".");
  }
  return boxShorthand(value, field);
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
