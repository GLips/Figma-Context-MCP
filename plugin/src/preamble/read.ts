// read — the read-side walk that speaks figma.* (the counterpart to bridge.ts's write walk). Phase 1 seeds
// it with target resolution; the read walk + sceneNodeToSnapshot join it as the read verbs (get/find) land.
//
// resolveTarget is the ONE place a `target` becomes a live node, shared by every target-taking verb so they
// can't drift on how a string/id/key/handle resolves. It is uniform and FAIL-LOUD: not-found and ambiguous
// both throw, naming the target and (for a key clash) the count — a blind agent must never silently act on
// the wrong node.

import { Target, RawIdRef, FindQuery, SlimHandle, ReadPredicate } from "./ir.js";
import { readKey, identityOf } from "./identity.js";
import { sceneNodeToSnapshot, type SceneNodeLike, type SceneStyleResolver } from "./node-to-snapshot.js";
import { rejectUnknownKeys } from "./validate.js";
import { simplify, type SimplifiedNode } from "~/core/index.js";

// A pluginData scan searches this. Default is the current page; a verb's `within` narrows it (resolved by the
// same shape rules). PageNode and any container SceneNode both satisfy this.
type ScanRoot = BaseNode & ChildrenMixin;

function isRawIdRef(value: unknown): value is RawIdRef {
  return !!value && typeof value === "object" && typeof (value as RawIdRef).__flcmId === "string";
}

// Anything carrying a string `id` — a render Handle, a slim handle, a read POJO. Its `id` is a live-node id.
function hasId(value: unknown): value is { id: string } {
  return !!value && typeof value === "object" && typeof (value as { id: string }).id === "string";
}

// getNodeByIdAsync, treating a removed node as absent (the live API already returns null for removed; the
// guard keeps the mock and any stale reference honest). Async because the manifest declares
// `documentAccess: dynamic-page` — the sync getNodeById throws under it — which is what makes every
// target-taking verb below async. Cast to SceneNode — every resolvable target is one in practice, and the
// read/edit verbs that consume this operate on scene nodes.
async function byId(id: string): Promise<SceneNode | null> {
  const node = await figma.getNodeByIdAsync(id);
  return node && !node.removed ? (node as SceneNode) : null;
}

function scanKey(key: string, root: ScanRoot): SceneNode[] {
  return root.findAll((n) => readKey(n) === key);
}

// Resolve a target to a live node, or throw. `within` scopes the key scan (default: current page); it is
// itself a target, resolved by the same rules, so `within: 'card'` searches inside the node keyed "card".
export async function resolveTarget(target: Target, within?: Target): Promise<SceneNode> {
  if (isRawIdRef(target)) {
    const node = await byId(target.__flcmId);
    if (!node) throw new Error(`flcm: no live node with id ${JSON.stringify(target.__flcmId)} (flcm.id(...)).`);
    return node;
  }
  if (typeof target === "string") return resolveString(target, within);
  if (hasId(target)) {
    const node = await byId(target.id);
    if (!node) throw new Error(`flcm: the handle's node (id ${JSON.stringify(target.id)}) no longer exists — it may have been deleted.`);
    return node;
  }
  throw new Error(`flcm: cannot resolve target ${JSON.stringify(target)} — pass a node id, an flcm/key, flcm.id(id), or a handle.`);
}

// A bare string is resolved by what actually EXISTS, not by guessing from its shape: try it as a live id and
// as an flcm/key, then resolve by the single match. Checking both is what makes the pathological
// id-that-is-also-a-key case fail loud instead of silently picking one. (Common paths — a handle or
// flcm.id(...) — skip the key scan entirely; only a bare string pays it.)
async function resolveString(target: string, within?: Target): Promise<SceneNode> {
  if (!target.trim()) {
    throw new Error("flcm: empty target — pass a node id, an flcm/key, flcm.id(id), or a handle.");
  }
  const root = await scanRoot(within);
  const byIdNode = await byId(target);
  const byKey = scanKey(target, root);

  if (byIdNode && byKey.length) {
    throw new Error(
      `flcm: target ${JSON.stringify(target)} is ambiguous — it matches BOTH a live node id and ${byKey.length} node(s) with the flcm/key ${JSON.stringify(target)}. ` +
        `Use flcm.id(${JSON.stringify(target)}) to force the id, or rename the key.`,
    );
  }
  if (byIdNode) return byIdNode;
  if (byKey.length === 1) return byKey[0];
  if (byKey.length > 1) {
    throw new Error(
      `flcm: target ${JSON.stringify(target)} is ambiguous — ${byKey.length} nodes carry the flcm/key ${JSON.stringify(target)}. ` +
        `Keys must be unique; scope with \`within\`, or address a specific node by id or flcm.id(...).`,
    );
  }
  throw new Error(
    `flcm: no node found for target ${JSON.stringify(target)} — no live node has that id, and no node carries it as an flcm/key on the searched root.`,
  );
}

// The live style resolver: the one snapshot lookup that isn't node-local. A style the document can't
// resolve drops the slot (null), mirroring the REST adapter's only-named-styles-survive rule.
const resolveStyle: SceneStyleResolver = (styleId) => figma.getStyleByIdAsync(styleId);

// Materialize a live node's subtree through the ONE shared read pipeline — the plugin adapter (all figma.*
// liveness) then the shared simplify core over pure data — so the output is exactly the vocabulary
// figma-mcp's REST path emits (Invariant 2). No compress flag: the result is EXPANDED (every value inline,
// no styles refs), the form in-sandbox predicates and same-run consumers read (Invariant 3). The ONE
// deliberate boundary cast lives here (shared by get and the locate index): the adapter's structural view
// narrows the plugin typings to the axes it reads (its paint union omits VideoPaint, its segment getter
// drops the field-generic overload), so tsc can't prove a live node assignable to it.
async function simplifyScene(node: BaseNode): Promise<SimplifiedNode[]> {
  const snapshot = await sceneNodeToSnapshot(node as unknown as SceneNodeLike, resolveStyle);
  const { nodes } = await simplify([snapshot]);
  return nodes;
}

/**
 * flcm.get — full inspect. Resolves the target and simplifies its subtree to the EXPANDED canonical read
 * shape (see simplifyScene). A hidden target yields no root node — the read shape covers the rendered
 * document — so throw rather than return nothing.
 */
export async function get(target: Target): Promise<SimplifiedNode> {
  const node = await resolveTarget(target);
  const [spec] = await simplifyScene(node);
  if (!spec) {
    throw new Error(
      `flcm.get: node ${JSON.stringify(node.name)} (id ${JSON.stringify(node.id)}) is hidden (visible: false) — the read shape covers the rendered document. Unhide it or target a visible node.`,
    );
  }
  return spec;
}

async function scanRoot(within: Target | undefined): Promise<ScanRoot> {
  if (within == null) return figma.currentPage;
  const node = await resolveTarget(within);
  if (!("findAll" in node)) {
    throw new Error(`flcm: \`within\` target resolved to a ${node.type} with no children to search — pass a container (frame/group/section) or a page.`);
  }
  return node as ScanRoot;
}

// ---- locate: find / findOne / selection → SlimHandle[] ----
//
// The slim shape is a SPARSE PROJECTION of `get`'s full canonical shape (Invariant 1): every sizing/layout
// leaf is the ONE core's own output, so slim and get can't drift. To get each hit its IN-CONTEXT geometry
// (a real px on an authored-fixed axis, "fill"/"hug" intent otherwise, out-of-flow position/left/top), the
// core must see the hit with its real parent — so we simplify the whole scan-root subtree ONCE and index
// every node by id, rather than rooting each hit on its own (which would make every hit "contextual" and
// strip its position, the way `get(target)` roots the requested node). `findAll` only ever returns
// DESCENDANTS of the scan root, so every hit is a non-root node in that index and reads in-context.
//
// v1 cost: a query find still materializes the whole scan scope to build the index. Phase 4's hybrid filter
// (declarative query pre-filters cheaply; only survivors materialize) is where that gets cut — `within`
// scopes the scan today.

const FIND_KEYS = ["type", "name", "key", "within"] as const;
// Tie the runtime allow-list to FindQuery: a new facet on the type that isn't listed here fails typecheck,
// so the fail-loud check can't silently start rejecting a legitimate new query key.
type _FindKeysCoverFindQuery = keyof FindQuery extends (typeof FIND_KEYS)[number] ? true : never;
const _findKeysExhaustive: _FindKeysCoverFindQuery = true;
void _findKeysExhaustive;

// A locate query is agent input at a system boundary, so an unknown facet (a typo'd `tpye`) FAILS LOUD
// rather than silently matching every node — the ADR-0003 fail-loud contract, via the same closed-set gate
// (validate.rejectUnknownKeys) the authoring constructors use, just with "query key" wording. Built once.
const FIND_KEY_SET: ReadonlySet<string> = new Set(FIND_KEYS);

// AND-combine the query facets. Empty-string facets are treated as "unset" (an empty substring would match
// everything). `type`/`key` exact; `name` case-insensitive substring.
function matchesQuery(node: SceneNode, query: FindQuery): boolean {
  if (query.type && node.type !== query.type) return false;
  if (query.key && readKey(node) !== query.key) return false;
  if (query.name && !node.name.toLowerCase().includes(query.name.toLowerCase())) return false;
  return true;
}

// Whether a node renders in the document — it and every ancestor visible. The read shape covers the RENDERED
// document (`get` throws on a hidden target for exactly this reason), and the simplify core drops hidden
// nodes, so a hidden hit would otherwise slip through as an identity-only handle indistinguishable from the
// collapsed-SVG fallback. Locate excludes it up front, so find never hands back a node `get` would refuse.
function isRendered(node: SceneNode): boolean {
  for (let n: BaseNode | null = node; n && "visible" in n; n = n.parent) {
    if (n.visible === false) return false;
  }
  return true;
}

// Simplify the scan-root subtree through the SAME pipeline `get` uses, and index every produced node by id.
// A node the core dropped (e.g. an SVG-heavy container it collapsed) is simply absent — projectSlim falls
// back to identity-only for it.
async function simplifiedIndex(root: ScanRoot): Promise<Map<string, SimplifiedNode>> {
  const nodes = await simplifyScene(root);
  const index = new Map<string, SimplifiedNode>();
  const walk = (node: SimplifiedNode): void => {
    index.set(node.id, node);
    node.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return index;
}

// Project a live hit + its core-simplified twin into a SlimHandle. IDENTITY (id/type/name/key/text) comes
// from the LIVE node via identityOf — deliberately, not from the simplified spec: a SlimHandle IS a Handle
// (plus a layout world-model), and the whole handle family reports live identity, so slim.type is the live
// type you queried on (e.g. "VECTOR", not the egress-canonical "IMAGE-SVG" get emits for a collapsed icon)
// and slim.text is the plain characters, a cheap locate label rather than get's rich run structure. childCount
// is live too — the truest "is this a container" signal, undimmed by any core-side child dropping. Only the
// LAYOUT WORLD-MODEL (width/height/layout.mode/position/left/top) is the core's own output — that is where
// Invariant 1's "one vocabulary" bites, and it reads exactly like the matching fields of `get`. Only the
// container mode survives from `layout`; a leaf (mode "none") drops it.
function projectSlim(node: SceneNode, spec: SimplifiedNode | undefined): SlimHandle {
  const slim: SlimHandle = identityOf(node);
  if (spec) {
    if (spec.width !== undefined) slim.width = spec.width;
    if (spec.height !== undefined) slim.height = spec.height;
    const mode = typeof spec.layout === "object" ? spec.layout.mode : undefined;
    if (mode && mode !== "none") slim.layout = { mode };
    if (spec.position === "absolute") slim.position = "absolute";
    if (spec.left !== undefined) slim.left = spec.left;
    if (spec.top !== undefined) slim.top = spec.top;
  }
  const childCount = "children" in node ? node.children.length : 0;
  if (childCount) slim.childCount = childCount;
  return slim;
}

// Project a set of hits into SlimHandles against ONE simplify index built over `indexRoot` (the hits'
// common ancestor, so each reads in-context). Empty stays empty without paying to materialize the scope.
async function projectHits(hits: SceneNode[], indexRoot: ScanRoot): Promise<SlimHandle[]> {
  if (!hits.length) return [];
  const index = await simplifiedIndex(indexRoot);
  return hits.map((node) => projectSlim(node, index.get(node.id)));
}

// The predicate materialization cap (ratified decision 2). A predicate-only find makes every rendered node a
// candidate, so without a ceiling it would silently churn a whole real design; past the cap it fails loud,
// naming the number. The cap is on CANDIDATES (the query survivors the predicate must see a full read shape
// for), checked BEFORE any simplify so an over-broad find rejects without materializing anything. It is
// deliberately high and tunable — the fail-loud contract is the point, not the number. If materialization is
// too slow at that scale the fix is the ALGORITHM, not a lower cap: Figma's live-read speed is the only cost
// we don't control, so we don't paper over it by refusing to look at real designs.
const MATERIALIZE_CAP = 5000;

// The predicate path of find (the hybrid filter). The declarative query has already pre-filtered live nodes
// cheaply; each surviving candidate now needs its FULL EXPANDED read shape to hand to the predicate. That
// shape is the same core-simplified SimplifiedNode projectHits reads for the slim projection, so ONE
// whole-scope simplify feeds both — the predicate adds no second per-candidate materialization pass. A
// candidate the core dropped (a collapsed-SVG interior with no standalone read shape) can't satisfy a
// styling predicate and is excluded rather than handed an `undefined` the closure would crash dereferencing.
async function filterByPredicate(hits: SceneNode[], root: ScanRoot, predicate: ReadPredicate): Promise<SlimHandle[]> {
  if (hits.length > MATERIALIZE_CAP) {
    throw new Error(
      `flcm.find: the query matched ${hits.length} candidate nodes, over the ${MATERIALIZE_CAP}-node materialization cap — running the predicate would read that many full node shapes. ` +
        `Narrow the query (type/name/key/within) so fewer nodes reach the predicate.`,
    );
  }
  if (!hits.length) return [];
  const index = await simplifiedIndex(root);
  const survivors: SlimHandle[] = [];
  for (const hit of hits) {
    const spec = index.get(hit.id);
    if (spec && predicate(spec)) survivors.push(projectSlim(hit, spec));
  }
  return survivors;
}

/**
 * flcm.find — locate every RENDERED node matching the query, as SlimHandles (may be empty). The declarative
 * facets (type/name/key/within) AND-combine; `within` scopes the scan (default: current page). Hidden nodes
 * are excluded (the read shape covers the rendered document, like `get`). Returns the cheap layout
 * world-model, not full styling — dive into a hit with `get`.
 *
 * An optional `predicate` filters by anything in the full read shape ("every frame with a white fill"): the
 * query pre-filters cheaply, then only the survivors are materialized as the EXPANDED canonical shape (inline
 * values, so `n.fills?.[0]` is a value) and tested. A predicate-only find (no facets) materializes every
 * rendered candidate, up to a hard cap past which it fails loud (see MATERIALIZE_CAP).
 */
export async function find(query: FindQuery = {}, predicate?: ReadPredicate): Promise<SlimHandle[]> {
  rejectUnknownKeys(query, FIND_KEY_SET, "flcm.find", "query key");
  const root = await scanRoot(query.within);
  const hits = root.findAll((node) => matchesQuery(node, query) && isRendered(node));
  if (!predicate) return projectHits(hits, root);
  return filterByPredicate(hits, root, predicate);
}

/**
 * flcm.findOne — exactly one hit or throw. The cardinality guard (naming the count) is the whole point: a
 * blind agent must never over-trust a fuzzy name and silently act on the first of several matches. Narrow
 * with type/key/within (or the predicate) when it throws on >1. Same query+predicate as `find`.
 */
export async function findOne(query: FindQuery = {}, predicate?: ReadPredicate): Promise<SlimHandle> {
  const hits = await find(query, predicate);
  if (hits.length !== 1) {
    throw new Error(
      `flcm.findOne: expected exactly one match for ${JSON.stringify(query)} but found ${hits.length}. ` +
        `Use flcm.find for zero-or-many, or narrow the query (type/name/key/within).`,
    );
  }
  return hits[0];
}

/**
 * flcm.selection — the user's current selection as SlimHandles (same shape as find). The primary on-ramp
 * for "edit the selected frame/button/text" tasks. Selection lives on the current page, so the index is
 * built over the page; selected nodes are its descendants and read in-context.
 */
export async function selection(): Promise<SlimHandle[]> {
  const selected = figma.currentPage.selection.filter(isRendered);
  return projectHits(selected, figma.currentPage);
}
