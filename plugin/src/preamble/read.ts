/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import { sceneFigma as figma, invalidateSceneAccess } from "./scene-access.js";

import { readAnnotationCategoryNames } from "./annotation-categories.js";
import { decodeAnnotations } from "./annotations.js";
import { readCommentCounts } from "./comment-counts.js";
import { Target, FindQuery, SlimHandle, ReadPredicate, GetResult, ReadNode } from "./ir.js";
import { keyedDescendants, readKey, identityOf } from "./identity.js";
import { resolveTarget, resolveScanRoot, type ScanRoot } from "./target.js";
import { type UnreadableSink, type SceneNodeLike, type SceneTokenResolver } from "./node-to-snapshot.js";
import { readSceneDesign, type CommentCounts } from "./scene-read.js";
import { rejectUnknownKeys, showValue } from "./validate.js";
import { registerRead } from "./egress.js";
import { isReadableSceneNode, readableChildren } from "./scene-readability.js";
import { warnings } from "./warnings.js";
import { mapInBatches } from "./batches.js";
import { FIND_MATERIALIZE_CAP } from "../protocol.js";
import { TokenLookups } from "./tokens.js";
import { simplify, project, projectNames, projectReadNode, type SimplifiedNode } from "@framelink/core";

/**
 * Token names for one read. Cached per id because a token repeats across a tree — every run of a
 * bound text, every card on one fill variable. An unresolvable id (a deleted style, an unloaded
 * library variable) reads as a reference carrying its id only. Whether the name alone suffices is
 * asked of the write side's own reach, so a read pasted back binds the tokens it showed.
 */
function liveTokenResolver(): SceneTokenResolver {
  const reach = new TokenLookups();
  const cache = new Map<string, ReturnType<SceneTokenResolver>>();
  return (kind, id) => {
    const key = `${kind}:${id}`;
    let lookup = cache.get(key);
    if (!lookup) {
      lookup = kind === "style"
        ? figma.getStyleByIdAsync(id).then(async (style) => style && { name: style.name, key: style.key, nameSuffices: await reach.nameBindsStyle(style) })
        : figma.variables.getVariableByIdAsync(id).then(async (variable) => variable && { name: variable.name, nameSuffices: await reach.nameBindsVariable(variable) });
      cache.set(key, lookup);
    }
    return lookup;
  };
}

// The adapter's structural view narrows plugin typings at this boundary. The resulting data is
// complete in the sandbox; registration defers every lossy decision until host egress.
// `inContext` reads the node under its live parent (simplify's `placement`), so a nested target
// keeps the sizing and position it has as a child. A scan root takes none: it is never a hit.
async function simplifyScene(
  node: PageNode | SceneNode,
  unreadable: UnreadableSink,
  categories?: ReadonlyMap<string, string>,
  inContext = false,
): Promise<import("@framelink/core").SimplifyResult> {
  const full = await simplifyLive(node, unreadable, categories, inContext, await readCommentCounts());
  for (const node of full.nodes) registerNode(node);
  for (const entry of Object.values(full.components)) for (const node of entry.children ?? []) registerNode(node);
  registerRead(full.components, () => project(full).components);
  return full;
  function registerNode(node: SimplifiedNode): void {
    registerRead(node, () => projectNames(projectReadNode(node, full)));
    for (const child of node.children ?? []) registerNode(child);
  }
}

async function simplifyLive(
  node: PageNode | SceneNode,
  unreadable: UnreadableSink,
  categories: ReadonlyMap<string, string> | undefined,
  inContext: boolean,
  comments?: CommentCounts,
): Promise<import("@framelink/core").SimplifyResult> {
  const parent = node.parent;
  return readSceneDesign([sceneView(node)], {
    parent: inContext && parent && parent.type !== "DOCUMENT" ? sceneView(parent) : undefined,
    resolveToken: liveTokenResolver(),
    annotationCategories: categories ?? await readAnnotationCategoryNames(),
    unreadable,
    comments,
  });
}

/**
 * The adapter's structural view of a live node, checked against @figma/plugin-typings here — the
 * one place both types are in scope. Every node family must satisfy `SceneNodeLike` (an instance's
 * main component included, through `getMainComponentAsync`), so a plugin API change to a field the
 * adapter reads fails the build instead of decoding to `undefined` while parity, fed by fixtures
 * written to the view, still passes.
 */
function sceneView(node: PageNode | SceneNode): SceneNodeLike {
  return node;
}

// A skipped node must never read as absent: the agent is told what Figma listed but couldn't read.
function reportUnreadable(verb: string, unreadable: UnreadableSink): void {
  if (!unreadable.size) return;
  const ids = [...unreadable];
  const named = ids.slice(0, 5).join(", ") + (ids.length > 5 ? ` and ${ids.length - 5} more` : "");
  warnings.add({
    id: null,
    message: `flcm.${verb}: Figma could not read ${ids.length} node(s) or their contents (${named}), so this result omits them. ` +
      "They may still render on the canvas.",
  });
}

// The one place a ReadNode is minted: only a get result carries the brand that lets a read pass
// whole as a NodeSpec (ir.ts ReadNode).
const asReadNode = (node: SimplifiedNode): ReadNode => node as ReadNode;

/** Read the complete subtree, including hidden targets and instance descendants. */
export async function get(target: Target): Promise<GetResult> {
  const node = await resolveTarget(target);
  const unreadable: UnreadableSink = new Set();
  const full = await simplifyScene(node, unreadable, undefined, true);
  reportUnreadable("get", unreadable);
  const { nodes, components } = full;
  const result: GetResult = { node: asReadNode(nodes[0]) };
  if (Object.keys(components).length > 0) result.components = components;
  registerRead(result, () => {
    const projected = project(full);
    const output: GetResult = { node: asReadNode(projectNames(projected.nodes[0] ?? projectReadNode(nodes[0], full))) };
    if (Object.keys(projected.components).length) output.components = projected.components;
    return output;
  });
  return result;
}

// ---- locate: find / findOne / selection → SlimHandle[] ----
//
// The slim shape is a SPARSE PROJECTION of `get`'s full canonical shape (Invariant 1): every sizing/layout
// leaf is the ONE core's own output, so slim and get can't drift. To get each hit its IN-CONTEXT geometry
// (a real px on an authored-fixed axis, "fill"/"hug" intent otherwise, out-of-flow position/left/top), the
// core must see the hit with its real parent — so we simplify the whole scan-root subtree ONCE and index
// every node by id, rather than simplifying each hit with its own context parent. `findAll` only ever returns
// DESCENDANTS of the scan root, so every hit is a non-root node in that index and reads in-context.
//
// v1 cost: a query find still materializes the whole scan scope to build the index. Phase 4's hybrid filter
// (declarative query pre-filters cheaply; only survivors materialize) is where that gets cut — `within`
// scopes the scan today.

const FIND_KEYS = ["type", "name", "key", "within", "hasAnnotations"] as const;
// Tie the runtime allow-list to FindQuery: a new facet on the type that isn't listed here fails typecheck,
// so the fail-loud check can't silently start rejecting a legitimate new query key.
type _FindKeysCoverFindQuery = keyof FindQuery extends (typeof FIND_KEYS)[number] ? true : never;
const _findKeysExhaustive: _FindKeysCoverFindQuery = true;
void _findKeysExhaustive;

// A locate query is agent input at a system boundary, so an unknown facet (a typo'd `tpye`) FAILS LOUD
// rather than silently matching every node — the ADR-0003 fail-loud contract, via the same closed-set gate
// (validate.rejectUnknownKeys) the authoring compilers use, just with "query key" wording. Built once.
const FIND_KEY_SET: ReadonlySet<string> = new Set(FIND_KEYS);
// The query is a deliberately TINY closed set — the facets that can pre-filter live nodes cheaply, before
// anything is materialized. Every other way to narrow a search exists, one layer along, so the refusal
// must say so: without this an agent reads "not a query key" as "flcm cannot filter on that" and gives up
// on a search the predicate answers directly.
const FIND_PREDICATE_HINT =
  "Filter text, componentId or any other read field in the predicate, find's second argument.";

// AND-combine the query facets. Empty-string facets are treated as "unset" (an empty substring would match
// everything). `type`/`key` exact; `name` case-insensitive substring.
function matchesQuery(node: SceneNode, query: FindQuery): boolean {
  if (query.hasAnnotations !== undefined && Boolean("annotations" in node && node.annotations.length) !== query.hasAnnotations) return false;
  if (query.type && node.type !== query.type) return false;
  if (query.key && readKey(node) !== query.key) return false;
  if (query.name instanceof RegExp) {
    const pattern = new RegExp(query.name.source, query.name.flags);
    if (!pattern.test(node.name)) return false;
  } else if (query.name && !node.name.toLowerCase().includes(query.name.toLowerCase())) return false;
  return true;
}

// Index every descendant so predicates receive the same full shape as get.
async function simplifiedIndex(root: ScanRoot, unreadable: UnreadableSink, categories: ReadonlyMap<string, string>): Promise<Map<string, SimplifiedNode>> {
  const { nodes } = await simplifyScene(root, unreadable, categories);
  const index = new Map<string, SimplifiedNode>();
  const walk = (node: SimplifiedNode): void => {
    index.set(node.id, node);
    node.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return index;
}

// Project a live hit + its core-simplified twin into a SlimHandle. IDENTITY (id/type/name/key/text) comes
// from the LIVE node via identityOf — deliberately, not from the simplified node: a SlimHandle IS a Handle
// (plus a layout world-model), and the whole handle family reports live identity, so slim.type is the live
// type you queried on (including VECTOR)
// and slim.text is the plain characters, a cheap locate label rather than get's rich run structure. childCount
// is live too — the truest "is this a container" signal, undimmed by any core-side child dropping. Only the
// LAYOUT WORLD-MODEL (width/height/layout.mode/position/left/top) is the core's own output — that is where
// Invariant 1's "one vocabulary" bites, and it reads exactly like the matching fields of `get`. Only the
// container mode survives from `layout`; a leaf (mode "none") drops it.
function projectSlim(node: SceneNode, simplified: SimplifiedNode, categories: ReadonlyMap<string, string>): SlimHandle {
  const slim: SlimHandle = identityOf(node);
  if (simplified.visible === false) slim.visible = false;
  const annotations = decodeAnnotations("annotations" in node ? node.annotations : undefined, categories);
  if (annotations) slim.annotations = annotations;
  if (simplified.comments) slim.comments = simplified.comments;
  if (simplified.width !== undefined) slim.width = simplified.width;
  if (simplified.height !== undefined) slim.height = simplified.height;
  if (simplified.minWidth !== undefined) slim.minWidth = simplified.minWidth;
  if (simplified.maxWidth !== undefined) slim.maxWidth = simplified.maxWidth;
  if (simplified.minHeight !== undefined) slim.minHeight = simplified.minHeight;
  if (simplified.maxHeight !== undefined) slim.maxHeight = simplified.maxHeight;

  const mode = typeof simplified.layout === "object" ? simplified.layout.mode : undefined;
  if (mode && mode !== "none") slim.layout = { mode };
  if (simplified.position === "absolute") slim.position = "absolute";
  if (simplified.left !== undefined) slim.left = simplified.left;
  if (simplified.top !== undefined) slim.top = simplified.top;
  const childCount = "children" in node ? readableChildren(node)?.length : 0;
  if (childCount) slim.childCount = childCount;
  registerRead(slim, () => slim);
  return slim;
}

// Project a set of hits into SlimHandles against ONE simplify index built over `indexRoot` (the hits'
// common ancestor, so each reads in-context). Empty stays empty without paying to materialize the scope.
async function projectHits(hits: readonly SceneNode[], indexRoot: ScanRoot, unreadable: UnreadableSink): Promise<SlimHandle[]> {
  if (!hits.length) return [];
  const categories = await readAnnotationCategoryNames();
  const index = await simplifiedIndex(indexRoot, unreadable, categories);
  return readHits(hits, index, unreadable).map(([node, simplified]) => projectSlim(node, simplified, categories));
}

// The predicate path of find (the hybrid filter). The declarative query has already pre-filtered live nodes
// cheaply; each surviving candidate now needs its FULL EXPANDED read shape to hand to the predicate. That
// shape is the same core-simplified SimplifiedNode projectHits reads for the slim projection, so ONE
// whole-scope simplify feeds both — the predicate adds no second per-candidate materialization pass. A
// candidate the core dropped (a collapsed-SVG interior with no standalone read shape) can't satisfy a
// styling predicate and is excluded rather than handed an `undefined` the closure would crash dereferencing.
async function filterByPredicate(hits: SceneNode[], root: ScanRoot, predicate: ReadPredicate, unreadable: UnreadableSink): Promise<SlimHandle[]> {
  if (hits.length > FIND_MATERIALIZE_CAP) {
    throw new Error(
      `flcm.find: the query matched ${hits.length} candidate nodes, over the ${FIND_MATERIALIZE_CAP}-node materialization cap — running the predicate would read that many full node shapes. ` +
        `Narrow the query so fewer nodes reach the predicate.`,
    );
  }
  if (!hits.length) return [];
  const categories = await readAnnotationCategoryNames();
  const index = await simplifiedIndex(root, unreadable, categories);
  const read = readHits(hits, index, unreadable);
  // Awaited because an async predicate's Promise is always truthy. Batched, so a predicate that calls flcm
  // per candidate doesn't open thousands of reads at once.
  const verdicts = await mapInBatches(read, ([, simplified]) => predicate(simplified));
  return read.filter((_, i) => verdicts[i]).map(([hit, simplified]) => projectSlim(hit, simplified, categories));
}

// A bare string is deliberately NOT accepted as a query (ruled 2026-08-08). Target resolution can
// afford one because EXISTENCE disambiguates — id, key, or neither, all checkable against the
// document, ambiguity fails loud (resolveString). A query string has no tiebreak: "TEXT" is a
// valid type, a plausible name, and a plausible key, and no amount of looking at the document
// tells you which was meant. And the failure modes aren't symmetric — a wrong target guess is a
// loud "no node found"; a wrong query guess is an EMPTY RESULT SET, a silently wrong answer.
// So: steer to the object spelling, never guess. (A query is a FILTER; the target-shaped field
// is `within` — the docs say the same.)
function rejectStringQuery(query: unknown, verb: string): void {
  if (typeof query === "string") {
    throw new Error(
      `${verb} takes a query object; got a string. Did you mean ${verb}({ type: ${JSON.stringify(query)} }) — ` +
        `or filter by name/key? The query keys are ${[...FIND_KEY_SET].map((k) => JSON.stringify(k)).join(", ")} ` +
        `(within is the target-shaped scope).`,
    );
  }
}

/**
 * flcm.find locates matching descendants as SlimHandles. Facets AND-combine; within scopes
 * the scan to a container. Hidden nodes and annotations participate. Handles carry annotations
 * alongside the layout projection.
 *
 * An optional `predicate` filters by anything in the full read shape ("every frame with a white fill"): the
 * query pre-filters live nodes, then a whole-scope simplify supplies their expanded canonical shapes.
 * A predicate-only find materializes every candidate, up to the admission cap (see FIND_MATERIALIZE_CAP).
 */
export async function find(query: FindQuery = {}, predicate?: ReadPredicate): Promise<SlimHandle[]> {
  invalidateSceneAccess();
  rejectStringQuery(query, "flcm.find");
  rejectUnknownKeys(query, FIND_KEY_SET, "flcm.find", "query key", FIND_PREDICATE_HINT);
  if (query.hasAnnotations !== undefined && typeof query.hasAnnotations !== "boolean") throw new Error("flcm.find: hasAnnotations must be a boolean.");
  for (const key of ["type", "key"] as const) {
    if (query[key] !== undefined && typeof query[key] !== "string") throw new Error("flcm.find: " + key + " must be a string.");
  }
  if (query.name !== undefined && typeof query.name !== "string" && !(query.name instanceof RegExp)) throw new Error("flcm.find: name must be a string (literal substring) or RegExp.");
  if (predicate !== undefined && typeof predicate !== "function") throw new Error("flcm.find: predicate must be a function.");
  // A present-but-nullish `within` is almost always an unset variable (`within: copy.id` off a value that has
  // no id). Falling back to the page default would answer with someone else's nodes, so only an ABSENT key
  // means "the current page".
  if ("within" in query && query.within == null) {
    throw new Error(
      `flcm.find: within is ${showValue(query.within)} — pass a container target (id, flcm/key or a handle), ` +
        "or omit within to search the current page.",
    );
  }
  const root = await resolveScanRoot(query.within);
  // findAllWithCriteria, not findAll(callback): Figma's own walk crashes the whole search when a
  // callback reads a node it lists but cannot read. Collecting first lets each node be checked.
  const unreadable: UnreadableSink = new Set();
  // A key facet narrows natively, so Figma never hands over the rest of a large page.
  const candidates = query.key ? keyedDescendants(root) : root.findAllWithCriteria({ types: [] });
  const hits = candidates.filter((node) => {
    if (isReadableSceneNode(node)) return matchesQuery(node, query);
    unreadable.add(node.id);
    return false;
  });
  const result = predicate ? await filterByPredicate(hits, root, predicate, unreadable) : await projectHits(hits, root, unreadable);
  reportUnreadable("find", unreadable);
  return result;
}

/**
 * flcm.findOne — exactly one hit or throw. The cardinality guard (naming the count) is the whole point: a
 * blind agent must never over-trust a fuzzy name and silently act on the first of several matches. Narrow
 * with type/key/within (or the predicate) when it throws on >1. Same query+predicate as `find`.
 */
export async function findOne(query: FindQuery = {}, predicate?: ReadPredicate): Promise<SlimHandle> {
  rejectStringQuery(query, "flcm.findOne");
  const hits = await find(query, predicate);
  if (hits.length !== 1) {
    throw new Error(
      `flcm.findOne: expected exactly one match for ${JSON.stringify(query)} but found ${hits.length}. ` +
        `Use flcm.find for zero-or-many, or narrow the query or predicate.`,
    );
  }
  return hits[0];
}

/**
 * flcm.selection — the user's current selection as SlimHandles (same shape as find). The primary on-ramp
 * for "edit the selected frame/button/text" tasks. Selection lives on the current page, so the page is
 * read once; selected nodes are its descendants and read in-context.
 */
export async function selection(): Promise<SlimHandle[]> {
  invalidateSceneAccess();
  const selected = figma.currentPage.selection;
  const unreadable: UnreadableSink = new Set();
  const result = await projectHits(selected, figma.currentPage, unreadable);
  reportUnreadable("selection", unreadable);
  return result;
}


// Pair each live hit with its read shape. A hit the read omitted sits inside a container Figma could
// not list; it joins the unreadable report rather than failing the whole search.
function readHits(hits: readonly SceneNode[], index: ReadonlyMap<string, SimplifiedNode>, unreadable: UnreadableSink): [SceneNode, SimplifiedNode][] {
  const read: [SceneNode, SimplifiedNode][] = [];
  for (const hit of hits) {
    const simplified = index.get(hit.id);
    if (simplified) read.push([hit, simplified]);
    else unreadable.add(hit.id);
  }
  return read;
}
