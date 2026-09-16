// Trees cross the authoring boundary once. Only this private compile produces IR.
import type { WriteNode, WriteChild } from "./ir.js";
import type { NodeSpec, FrameProps, TextProps, ShapeProps, EllipseProps, LineProps, PathProps, SvgProps, InstanceProps } from "./schema.js";
import { isElision } from "@framelink/core";
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
  const copied = copySpec(input, subject);
  return visit(copied, subject);
  function visit(raw: unknown, at: string): WriteNode {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(at + ": expected a plain node spec.");
    if (isElision(raw)) throw new Error(at + ": an elision marker is only valid inside a children array; it preserves existing children.");
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
    const { id, type, children: readChildren, ...words } = src;
    // Inherited instance layers are edited through path overrides; they cannot be moved as children.
    const liftedChildEdits = type === "INSTANCE" ? liftInheritedChildEdits(id, readChildren, at) : undefined;
    const children = liftedChildEdits ? undefined : readChildren;
    if (children !== undefined && !Array.isArray(children)) throw new Error(at + ".children must be an array of node specs.");
    const props = readyNodeWords(words, at);
    if (liftedChildEdits) props.overrides = mergeLiftedChildEdits(props.overrides, liftedChildEdits, at);
    const compiledChildren = (children as unknown[] | undefined)?.flatMap((child, i) => isElision(child) ? [] : [visit(child, at + ".children[" + i + "]")]);
    if (props.overrides && typeof props.overrides === "object" && !Array.isArray(props.overrides)) {
      props.overrides = Object.fromEntries(Object.entries(props.overrides).map(([path, delta]) => {
        if (!delta || typeof delta !== "object" || !Array.isArray(delta.children)) return [path, delta];
        return [path, { ...delta, children: delta.children.flatMap((child: unknown, i: number) => {
          if (isElision(child)) return [];
          const where = at + ".overrides[" + JSON.stringify(path) + "].children[" + i + "]";
          const compiled = visit(child, where);
          assertNoComponentPropertyBindings(compiled, where);
          return [compiled];
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
            if ([props.svg, props.d, props.vectorPaths].filter(value => value !== undefined).length !== 1) throw new Error("VECTOR needs exactly one of svg (markup), d (path data), or vectorPaths.");
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
    // These records describe a read, never an authored change. Omission preserves live children.
    if (key === "readOnlySource" || key === "elided") continue;
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
  alignSelf: "author", // The read word is grid-only; flow stretch is an input alias for fill.
  wrap: "author",
  overflowScroll: { refuse: "scroll behavior (Figma's overflowDirection) has no flcm word" },
  gridTemplateColumns: "author",
  gridTemplateRows: "author",
  gridColumn: "author",
  gridRow: "author",
  justifySelf: "author",
  zIndex: "author",
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
export function readyLayout(raw: unknown, subject: string): unknown {
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
    value.children = value.children.flatMap((child: unknown, i: number) => isElision(child) ? [] : [compileTree(child, at + ".overrides[" + JSON.stringify(path) + "].children[" + i + "]")]);
  }
  return snapshot;
}

// Words a read echoes onto an inherited sublayer that are the COMPONENT's, never one instance's: a
// binding says which component property drives this layer, and no override can carry it (the
// override gate refuses it by name). Lifting it would turn every round-trip into that refusal.
const ECHO_IDENTITY_WORDS = ["componentPropertyReferences"];

/**
 * Composite sublayer ids identify an inherited echo, independent of how the spec was copied. The
 * echo is discarded — omitting children preserves the live ones — but any word an author changed on
 * one would go with it, so each is lifted here to `overrides[<component-relative path>]`, the only
 * route that reaches an inherited layer. The composite id IS the path prefixed by `I<instance>;`
 * (instance.ts liveSublayerIdOf), so the rewrite is a string slice, not a read.
 *
 * Returns undefined when the children are not an inherited echo — those stay children.
 */
function liftInheritedChildEdits(id: unknown, children: unknown, at: string): Record<string, Record<string, unknown>> | undefined {
  if (children === undefined) return undefined;
  if (!Array.isArray(children)) throw new Error(at + ".children must be an array of node specs.");
  // Removing an instance's root id makes a template; its echo still names one source instance.
  const first = children.find(child => !isElision(child));
  const sourceId = id ?? (first && typeof first.id === "string" && first.id.startsWith("I") ? first.id.slice(1, first.id.indexOf(";")) : undefined);
  const prefix = typeof sourceId === "string" ? (sourceId.startsWith("I") ? sourceId : "I" + sourceId) + ";" : undefined;
  const lifted: Record<string, Record<string, unknown>> = {};
  const owned = (child: unknown, where: string): boolean => {
    if (isElision(child)) return true;
    if (!child || typeof child !== "object" || !("id" in child) || typeof child.id !== "string" || !prefix || !child.id.startsWith(prefix)) return false;
    const { id: childId, type: childType, children: grandchildren, ...rest } = child as Record<string, unknown>;
    for (const word of ECHO_IDENTITY_WORDS) delete rest[word];
    // Negative space: a pixel size echoed onto an inherited layer is the size its component and its
    // parent's layout already give it, not a resize request — and flcm has no route to resize an
    // inherited rectangle at all. A real sublayer resize is written as an explicit override; the
    // sizing INTENTS ("fill"/"hug"/"50%") stay, because those are words, not measurements.
    for (const word of ["width", "height"]) if (typeof rest[word] === "number") delete rest[word];
    const delta = readyNodeWords(rest, where);
    if (Object.keys(delta).length) lifted[(childId as string).slice(prefix.length)] = delta;
    // Slot contents have ordinary live ids and are authored through the matching override, so the
    // echo of a filled slot's content is left alone rather than lifted: it is already in place.
    if (childType === "SLOT") return true;
    return grandchildren === undefined || (Array.isArray(grandchildren) && grandchildren.every((grandchild, i) => owned(grandchild, where + ".children[" + i + "]")));
  };
  if (!children.every((child, i) => owned(child, at + ".children[" + i + "]"))) {
    throw new Error(at + ".children: inherited instance children must belong to this instance. Author sublayer changes through overrides, and slot content through overrides[path].children.");
  }
  return lifted;
}

// A read states an instance's differences BOTH ways — as `overrides` and in the echoed child — so
// the two agreeing on a word is the ordinary case and merges silently. Two DIFFERENT values for one
// word are two answers to the same question, and neither is obviously the author's: refuse naming
// the path and the word. The explicit override wins nothing; there is nothing to win.
function mergeLiftedChildEdits(authored: unknown, lifted: Record<string, Record<string, unknown>>, at: string): unknown {
  const paths = Object.keys(lifted);
  if (!paths.length) return authored;
  if (authored !== undefined && (typeof authored !== "object" || authored === null || Array.isArray(authored))) {
    throw new Error(at + ".overrides must be an object keyed by component-relative sublayer path.");
  }
  const merged: Record<string, unknown> = { ...(authored as Record<string, unknown> | undefined) };
  for (const path of paths) {
    const explicit = merged[path];
    if (explicit === undefined) { merged[path] = lifted[path]; continue; }
    if (!explicit || typeof explicit !== "object" || Array.isArray(explicit)) throw new Error(at + ".overrides[" + JSON.stringify(path) + "] must be a delta object.");
    const delta = explicit as Record<string, unknown>;
    for (const [word, value] of Object.entries(lifted[path])) {
      if (Object.prototype.hasOwnProperty.call(delta, word) && !sameAuthoredData(delta[word], value)) {
        throw new Error(
          at + ": overrides[" + JSON.stringify(path) + "]." + word + " and the inherited child at that path " +
            "give different values for the same word. Keep one of them — the child word, or the override.",
        );
      }
      delta[word] = value;
    }
  }
  return merged;
}

/** Structural equality over the plain data copySpec guarantees; key order is not a difference. */
function sameAuthoredData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  return ka.length === kb.length && ka.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameAuthoredData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
