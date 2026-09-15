// Trees cross the authoring boundary once. Only this private compile produces IR.
import type { WriteNode, WriteChild } from "./ir.js";
import type { NodeSpec, FrameProps, TextProps, ShapeProps, EllipseProps, LineProps, PathProps, SvgProps, InstanceProps } from "./schema.js";
import type { SimplifiedLayout } from "@framelink/core";
import { assertNoComponentPropertyBindings, compileFrame, compileText, compileRectangle, compileEllipse, compileLine, compileInstance, compileSvg, compilePath } from "./flcm.js";
import { own } from "./validate.js";

const CLONE_REMEDY = "Use flcm.clone(target) for a faithful live copy.";
type ReadFieldDisposition = { refuse: string };
const READ_FIELD_DISPOSITIONS: Record<string, ReadFieldDisposition> = {
  template: { refuse: "this is a compressed template reference; read the expanded node with flcm.get" },
  strokeDashes: { refuse: "flcm strokes are solid; there is no dash-pattern word. Remove strokeDashes to author a solid stroke" },
  aspectRatio: { refuse: "flcm sizes width and height independently; there is no proportions-lock word. Remove aspectRatio and set both dimensions" },
};

/** Copy author data so compilation and returned identities never mutate a reusable template. */
export function copySpec<T>(value: T, path = "spec", ancestors = new Set<object>()): T {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error(path + ": expected plain data.");
    return value;
  }
  if (ancestors.has(value)) throw new Error(path + ": cyclic data is not a tree.");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error(path + ": expected a plain object.");
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((v, i) => copySpec(v, path + "[" + i + "]", ancestors))
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copySpec(v, path + "." + k, ancestors)]));
  ancestors.delete(value);
  return result as T;
}

export function compileTree(input: unknown, subject: string): WriteNode {
  const ids = new Set<string>();
  const keys = new Set<string>();
  return visit(copySpec(input, subject), subject);
  function visit(raw: unknown, at: string): WriteNode {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(at + ": expected a plain node spec.");
    const src = raw as Record<string, unknown>;
    if (src.id !== undefined && (typeof src.id !== "string" || !src.id.trim())) throw new Error(at + ".id must be a non-empty live node id.");
    if (typeof src.id === "string") {
      if (ids.has(src.id)) throw new Error(at + ".id: duplicate live identity " + src.id + ".");
      ids.add(src.id);
    }
    if (typeof src.key === "string" && src.key) {
      if (keys.has(src.key)) throw new Error(at + ".key: duplicate key " + JSON.stringify(src.key) + ".");
      keys.add(src.key);
    }
    const { id, type, children, ...words } = src;
    if (children !== undefined && !Array.isArray(children)) throw new Error(at + ".children must be an array of node specs.");
    const props = readyNodeWords(words, at);
    const compiledChildren = (children as unknown[] | undefined)?.map((child, i) => visit(child, at + ".children[" + i + "]"));
    if (props.overrides && typeof props.overrides === "object" && !Array.isArray(props.overrides)) {
      props.overrides = Object.fromEntries(Object.entries(props.overrides).map(([path, delta]) => {
        if (!delta || typeof delta !== "object" || !Array.isArray(delta.children)) return [path, delta];
        return [path, { ...delta, children: delta.children.map((child: unknown, i: number) => {
          const where = at + ".overrides[" + JSON.stringify(path) + "].children[" + i + "]";
          const compiled = visit(child, where);
          assertNoComponentPropertyBindings(compiled, where);
          return compiled;
        }) }];
      }));
    }
    try {
      let tree: WriteNode;
      if (id !== undefined) {
        if (type !== undefined && typeof type !== "string") throw new Error("type must be a string.");
        tree = { type: "UNRESOLVED", liveId: id as string, authoring: props };
      } else {
        switch (type) {
          case "FRAME": tree = compileFrame(props as FrameProps); break;
          case "TEXT": tree = compileText(props as TextProps); break;
          case "RECTANGLE": tree = compileRectangle(props as ShapeProps); break;
          case "ELLIPSE": tree = compileEllipse(props as EllipseProps); break;
          case "LINE": tree = compileLine(props as LineProps); break;
          case "INSTANCE": tree = compileInstance(props as InstanceProps & { componentId: string }); break;
          case "VECTOR": {
            if ((props.svg !== undefined) === (props.d !== undefined)) throw new Error("VECTOR needs exactly one of svg (markup) or d (path data).");
            if (props.svg !== undefined) { const { svg, ...rest } = props; tree = compileSvg(svg, rest as SvgProps); }
            else tree = compilePath(props as PathProps);
            break;
          }
          default: throw new Error("type must be FRAME, TEXT, RECTANGLE, ELLIPSE, LINE, VECTOR, or INSTANCE. " + CLONE_REMEDY);
        }
        if (compiledChildren?.length && type !== "FRAME") throw new Error(String(type) + " does not accept children; instance content belongs in slot overrides.");
      }
      if (children !== undefined) tree.children = compiledChildren;
      tree.source = src as NodeSpec;
      tree.sourcePath = at;
      return tree;
    } catch (cause) { throw new Error(at + ": " + (cause instanceof Error ? cause.message : String(cause))); }
  }
}

export function readyNodeWords(src: Record<string, unknown>, subject: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    const disposition = own(READ_FIELD_DISPOSITIONS, key);
    if (value != null && disposition) throw refuse(subject, key, disposition.refuse);
    out[key] = readyAuthoredValue(key, value, subject);
  }
  return out;
}

export function treeNodes(tree: WriteChild): WriteNode[] {
  if (!tree) return [];
  const nested = Object.values(tree.overrides ?? tree.authoring?.overrides ?? {}).flatMap((delta: any) => Array.isArray(delta?.children) ? delta.children : []);
  return [tree, ...[...(tree.children ?? []), ...nested].flatMap(treeNodes)];
}

export const LAYOUT_WORD_DISPOSITIONS: Record<keyof SimplifiedLayout, "author" | ReadFieldDisposition> = {
  mode: "author",
  gap: "author",
  padding: "author",
  justifyContent: "author",
  alignItems: "author",
  alignSelf: { refuse: 'cross-axis self-alignment has no flcm word — a child stretches by sizing that axis "fill"' },
  wrap: "author",
  overflowScroll: { refuse: "scroll behavior (Figma's overflowDirection) has no flcm word" },
  gridTemplateColumns: { refuse: "flcm cannot author a GRID container" },
  gridTemplateRows: { refuse: "flcm cannot author a GRID container" },
  gridColumn: { refuse: "grid placement belongs to a GRID parent, which flcm cannot author" },
  gridRow: { refuse: "grid placement belongs to a GRID parent, which flcm cannot author" },
  justifySelf: { refuse: "grid self-alignment belongs to a GRID parent, which flcm cannot author" },
  zIndex: { refuse: "explicit stacking order has no flcm word — sibling order is the z-order" },
};

// ---- the refusals ----

// THE refusal. Every "flcm has no word for this" message in the module is built here, so the sentence
// and the remedy can't drift between the node-field gate, the layout-word gate and the value guards.
function refuse(subject: string, what: string, why: string): Error {
  return new Error(subject + ": `" + what + "` has no authored form — " + why + ". " + CLONE_REMEDY);
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
    field + ' is a styles-table REFERENCE (like "fill_a1b2c3d4"), not a value — that read came from a COMPRESSED read. ' +
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

// The layout bag keeps its key and its authorable words verbatim (`gap` is a metric the compiler
// parses, `padding` takes read's box shorthand directly); this only refuses the words with no flcm
// form. Unknown words are the compiler's closed set to name.
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

/** Edit deltas may contain trees only under instance slot overrides. */
export function compileDeltaTrees<T>(delta: T, at: string): T {
  const snapshot = copySpec(delta, at);
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const bag = snapshot as Record<string, unknown>;
  if (!bag.overrides || typeof bag.overrides !== "object" || Array.isArray(bag.overrides)) return snapshot;
  for (const [path, value] of Object.entries(bag.overrides)) {
    if (!value || typeof value !== "object" || !Array.isArray(value.children)) continue;
    value.children = value.children.map((child: unknown, i: number) => compileTree(child, at + ".overrides[" + JSON.stringify(path) + "].children[" + i + "]"));
  }
  return snapshot;
}
