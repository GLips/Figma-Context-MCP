/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Trees cross the authoring boundary once. Only this private compile produces IR.
import type { WriteNode, WriteChild, WriteType, BuiltNode } from "./ir.js";
import type { NodeSpec, AuthoredTree, FrameProps, TextProps, ShapeProps, EllipseProps, LineProps, PathProps, SvgProps, InstanceProps } from "./schema.js";
import { isElision } from "@framelink/core";
import { assertNoComponentPropertyBindings } from "./compile-component-words.js";
import { compileFrame, compileRectangle, compileEllipse, compileLine, compileInstance, compileSvg, compilePath } from "./compile-nodes.js";
import { compileText } from "./compile-text.js";
import { acceptAuthoringProps, withoutReadRecords, CLONE_REMEDY, type Accepted } from "./authoring-input.js";
import { TYPE_WORD_GROUPS, SVG_WORD_GROUPS, wordsOf, type WordGroup } from "./vocabulary.js";
import { own, showValue } from "./validate.js";

// ---- NODE_ENTRY: how a new node of each type is built. Every entry runs the same prelude
// (acceptAuthoringProps) over its type's row, ONCE, in visit(); a compiler receives only the bag it
// returned (`Accepted`), so no compiler can skip the prelude or gate against a different vocabulary. ----
interface NodeEntry {
  /** The type the prelude matches a read's `type` against. */
  type: WriteType;
  known: ReadonlySet<string>;
  compile(props: Accepted<Record<string, unknown>>): BuiltNode;
}
function nodeEntry<P>(type: WriteType, row: readonly WordGroup[], compile: (props: Accepted<P>) => BuiltNode): NodeEntry {
  return { type, known: wordsOf(row), compile: compile as NodeEntry["compile"] };
}
const NODE_ENTRY = {
  FRAME: nodeEntry<FrameProps>("FRAME", TYPE_WORD_GROUPS.FRAME, compileFrame),
  TEXT: nodeEntry<TextProps>("TEXT", TYPE_WORD_GROUPS.TEXT, compileText),
  RECTANGLE: nodeEntry<ShapeProps>("RECTANGLE", TYPE_WORD_GROUPS.RECTANGLE, compileRectangle),
  ELLIPSE: nodeEntry<EllipseProps>("ELLIPSE", TYPE_WORD_GROUPS.ELLIPSE, compileEllipse),
  LINE: nodeEntry<LineProps>("LINE", TYPE_WORD_GROUPS.LINE, compileLine),
  INSTANCE: nodeEntry<InstanceProps>("INSTANCE", TYPE_WORD_GROUPS.INSTANCE, compileInstance),
  // VECTOR's two forms: path geometry, and an svg import.
  VECTOR: nodeEntry<PathProps>("VECTOR", TYPE_WORD_GROUPS.VECTOR, compilePath),
  SVG: nodeEntry<SvgProps>("VECTOR", SVG_WORD_GROUPS, compileSvg),
} satisfies Record<WriteType | "SVG", NodeEntry>;

function nodeEntryFor(type: unknown, words: Record<string, unknown>): NodeEntry {
  if (type === "VECTOR") {
    if ([words.svg, words.d, words.vectorPaths].filter((value) => value !== undefined).length !== 1) {
      throw new Error("VECTOR needs exactly one of svg (markup), d (path data), or vectorPaths.");
    }
    return words.svg !== undefined ? NODE_ENTRY.SVG : NODE_ENTRY.VECTOR;
  }
  const entry = typeof type === "string" && type !== "SVG" ? own<NodeEntry>(NODE_ENTRY, type) : undefined;
  if (!entry) throw new Error("type must be FRAME, TEXT, RECTANGLE, ELLIPSE, LINE, VECTOR, or INSTANCE. " + CLONE_REMEDY);
  return entry;
}

/** Copy author data so compilation and returned identities never mutate a reusable template. */
function copySpec<T>(value: T, path = "spec", ancestors = new Set<object>()): T {
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
    // A present-but-undefined id is an unset variable, not "create": reading it as absent would build a new
    // node where the agent meant to edit a live one. Strip an id with `delete`, not by assigning undefined.
    if ("id" in src && (typeof src.id !== "string" || !src.id.trim())) {
      throw new Error(at + ".id must be a non-empty live node id — got " + showValue(src.id) + ". Omit id to create a node.");
    }
    if (typeof src.id === "string") {
      if (ids.has(src.id)) throw new Error(at + ".id: duplicate live identity " + src.id + ".");
      ids.add(src.id);
    }
    if (typeof src.key === "string" && src.key) {
      if (keys.has(src.key)) throw new Error(at + ".key: duplicate key " + JSON.stringify(src.key) + ".");
      keys.add(src.key);
    }
    delete src.warnings;
    const { id, type, children: readChildren, ...words } = src;
    // Inherited instance layers are edited through path overrides; they cannot be moved as children.
    const liftedChildEdits = type === "INSTANCE" ? liftInheritedChildEdits(id, readChildren, at) : undefined;
    const children = liftedChildEdits ? undefined : readChildren;
    if (children !== undefined && !Array.isArray(children)) throw new Error(at + ".children must be an array of node specs.");
    const props = withoutReadRecords(words);
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
      if (id !== undefined) {
        if (type !== undefined && typeof type !== "string") throw new Error("type must be a string.");
        // The authored words only: what the live node resolves to is the loaded live tree's (live-tree.ts).
        return { liveId: id as string, authoring: props, ...(children !== undefined && { children: compiledChildren }), source: src as NodeSpec, sourcePath: at };
      }
      const entry = nodeEntryFor(type, props);
      const tree = entry.compile(acceptAuthoringProps(props, { type: entry.type, verb: "create", known: entry.known, subject: entry.type }));
      if (compiledChildren?.length && type !== "FRAME") throw new Error(String(type) + " does not accept children; instance content belongs in slot overrides.");
      if (children !== undefined) tree.children = compiledChildren;
      tree.source = src as NodeSpec;
      tree.sourcePath = at;
      return tree;
    } catch (cause) { throw new Error(at + ": " + (cause instanceof Error ? cause.message : String(cause))); }
  }
}

/** The nodes placed directly into `tree`: its children, then the slot content its overrides state. */
export function childTreeNodes(tree: WriteNode): WriteNode[] {
  const overrides = tree.liveId !== undefined ? tree.authoring.overrides as BuiltNode["overrides"] : tree.overrides;
  const nested = Object.values(overrides ?? {}).flatMap((delta: any) => Array.isArray(delta?.children) ? delta.children : []);
  return [...(tree.children ?? []), ...nested];
}

export function treeNodes(tree: WriteChild): WriteNode[] {
  if (!tree) return [];
  return [tree, ...childTreeNodes(tree).flatMap(treeNodes)];
}

/**
 * The authored tree as it landed: a fresh copy of `source` with each placed node's id (ids are keyed
 * by the node's own spec object, recorded as it lands). The compiled tree and its source stay as authored.
 */
export function placedTreeOf(source: NodeSpec, ids: ReadonlyMap<NodeSpec, string>): AuthoredTree {
  const copyPlaced = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(copyPlaced);
    const copy = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyPlaced(v)]));
    const id = ids.get(value as NodeSpec);
    return id === undefined ? copy : { ...copy, id };
  };
  return copyPlaced(source) as AuthoredTree;
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
    const delta = withoutReadRecords(rest);
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
