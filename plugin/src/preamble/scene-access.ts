/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
/** Native scene access for the preamble. Raw agent `figma` is never replaced.
 *
 * Figma can retain stale instance-child handles after slot placement. Its indexed
 * criteria search returns live objects, in documented preorder. Child arrays still
 * provide ordered identity edges, even when their objects cannot supply properties.
 * Keep those two responsibilities together here: indexed objects supply properties;
 * ordered edges supply public IDs, parents, siblings, and traversal.
 *
 * Only instance subtrees are indexed; stale handles occur nowhere else. Ordinary
 * containers list native children, so a node Figma lists but cannot read fails
 * alone instead of failing the index for everything around it.
 *
 * Figma breaks native moves of slot content: path-id content moved out of its instance leaves a node
 * that renders but can't be read or removed, and content moved into another slot can corrupt the
 * instance (live, 2026-10-26). So any move but a reorder in place lands a copy and removes the original.
 *
 * A reorder can re-path the layer, and the child lists keep naming the original. So a move gives the
 * moved layers their search ids and records each old id in the moved-id table; an edge naming a
 * recorded id is that retired original. A held view follows, and its old id resolves for the session.
 */
import { componentPath, isSublayerId, liveSublayerId, outermostInstanceId } from "@framelink/core";
import { FlcmError, describeNodeIdentity } from "./flcm-error.js";
import { isInheritedSlotContent, slotOwnerOf } from "./identity.js";
import { warnings } from "./warnings.js";
import { runSession } from "./run-session.js";
import { movedIdsOf } from "./session.js";
type Container = BaseNode & ChildrenMixin;

function identityOf(node: BaseNode): { type: string; name: string; id: string } {
  return { type: node.type, name: node.name, id: node.id };
}

// Figma's two listings of an instance's layers (the search and each children list) must agree for
// ids to be paired; when they don't, refusing beats reading one layer's properties as another's.
function inconsistentInstanceTree(root: BaseNode, mismatch: string): FlcmError {
  return new FlcmError(
    "figma",
    "Figma listed this instance's layers inconsistently (" + mismatch + "), so flcm can't tell which layer is which. " +
      "Reload the file in Figma, then retry.",
    { node: identityOf(root) },
  );
}
interface State {
  native: BaseNode;
  anchor?: BaseNode;
  id: string;
  view: BaseNode;
  scope?: Scope;
  ownScope?: Scope;
  record?: RecordNode;
  methods: Map<PropertyKey, (...args: unknown[]) => unknown>;
}
interface RecordNode { state: State; parent: RecordNode | null; children: RecordNode[] }
interface Scope { root: State; generation: number; records: RecordNode[]; byId: Map<string, RecordNode>; retired: Map<string, string> }

// These native operations can replace identities or change child lists. Ordinary
// geometry/style setters stay live without rebuilding a topology index.
const NODE_TOPOLOGY_METHODS = new Set([
  "appendChild", "insertChild", "remove", "clone", "swapComponent", "setProperties",
  "detachInstance", "createInstance", "addComponentProperty", "editComponentProperty",
  "deleteComponentProperty",
]);
const API_TOPOLOGY_METHODS: ReadonlySet<string> = new Set([
  "group", "ungroup", "flatten", "union", "subtract", "intersect", "exclude",
  "combineAsVariants", "createComponentFromNode", "triggerUndo",
  "createFrame", "createText", "createRectangle", "createEllipse", "createLine",
  "createVector", "createPolygon", "createStar", "createSlice", "createComponent",
  "createPage", "createSection", "createBooleanOperation", "createNodeFromSvg",
] satisfies (keyof PluginAPI)[]);

/**
 * `moved` maps each id a committed verb's placements retired to the copy that replaced it (session.ts
 * movedIdsOf). A verb's own entries wait in `pending` until it commits: its rollback restores them.
 * A null entry drops an id a move made live again: Figma re-paths a layer moved back to its slot
 * under its old id.
 */
export function createSceneAccess(source: () => PluginAPI, moved: Record<string, string> = {}): {
  api: PluginAPI; invalidate(): void; settleMovedIds(committed: boolean): void;
} {
  let generation = 0;
  let pending: Record<string, string | null> = {};
  const copyOf = (id: string): string | undefined => (id in pending ? pending[id] : moved[id]) ?? undefined;
  const recordMove = (from: string, to: string): void => { pending[from] = to; pending[to] = null; };
  const states = new Map<string, State>();
  let views = new WeakMap<object, State>();
  let currentApi: PluginAPI | undefined;
  function nativeApi(): PluginAPI {
    const api = source();
    if (currentApi !== api) { currentApi = api; states.clear(); views = new WeakMap(); generation++; }
    return api;
  }
  const invalidate = (): void => { generation++; };
  function isNode(value: unknown): value is BaseNode {
    return !!value && typeof value === "object" && "id" in value && "parent" in value && "getPluginData" in value;
  }
  function unwrap(value: unknown): unknown {
    if (value && typeof value === "object") {
      const state = views.get(value);
      if (state) return live(state);
      if (Array.isArray(value)) return value.map(unwrap);
    }
    return value;
  }
  function wrap(value: unknown): unknown {
    if (Array.isArray(value)) {
      let changed: unknown[] | undefined;
      for (let i = 0; i < value.length; i++) {
        const item = wrap(value[i]);
        if (item !== value[i]) { changed ??= value.slice(); changed![i] = item; }
      }
      return changed ?? value;
    }
    if (isNode(value)) return stateOf(value).view;
    return value;
  }
  function stateOf(node: BaseNode, alias = node.id): State {
    const owned = views.get(node);
    if (owned) return owned;
    let state = states.get(alias) ?? states.get(node.id);
    if (!state) {
      state = { native: node, id: alias, view: node, methods: new Map() };
      state.view = makeView(state);
      views.set(state.view, state);
    }
    state.native = node;
    // Ordinary roots remain addressable after their indexed ID is remapped by a slot.
    if (!isSublayerId(node.id)) state.anchor = node;
    states.set(alias, state);
    states.set(node.id, state);
    return state;
  }
  function refresh(scope: Scope): void {
    if (scope.generation === generation) return;
    const root = scope.root.anchor ?? scope.root.native;
    if (root.removed) {
      scope.records = [];
      scope.byId.clear();
      scope.retired.clear();
      scope.generation = generation;
      return;
    }
    const api = nativeApi();
    const skip = api.skipInvisibleInstanceChildren;
    let indexed: BaseNode[];
    try {
      api.skipInvisibleInstanceChildren = false;
      // Empty types is the supported-host all-node contract. Validate complete
      // topology below on every acquisition; a host that omits nodes fails closed.
      indexed = [root, ...(root as Container).findAllWithCriteria({ types: [] })];
    } finally { api.skipInvisibleInstanceChildren = skip; }
    for (const previous of scope.records) {
      if (previous.state.scope === scope) previous.state.record = undefined;
    }
    const records: RecordNode[] = [];
    const byId = new Map<string, RecordNode>();
    const retired = new Map<string, string>();
    const stack: { record: RecordNode; ids: readonly SceneNode[]; next: number; retired: boolean }[] = [];
    const seen = new Set<string>();
    for (const node of indexed) {
      let parent: RecordNode | null = null;
      let alias = scope.root.id;
      let copied = false;
      if (records.length) {
        while (stack.length && stack[stack.length - 1].next === stack[stack.length - 1].ids.length) stack.pop();
        const edge = stack[stack.length - 1];
        if (!edge) throw inconsistentInstanceTree(root, "it searched more layers than the children lists hold");
        const child = edge.ids[edge.next++];
        if (child.type !== node.type) throw inconsistentInstanceTree(root, "a layer had a different type in the search than in its parent's children");
        // An edge naming an id a move retired names the original, and so do its descendants' edges,
        // even a plain one: Figma's copy reads it under a path id, and the plain one no longer resolves.
        copied = edge.retired || (child.id !== node.id && copyOf(child.id) !== undefined);
        if (copied) retired.set(child.id, node.id);
        alias = copied ? node.id : child.id;
        parent = edge.record;
      }
      if (seen.has(alias) || seen.has(node.id)) throw inconsistentInstanceTree(root, "two layers had the same id");
      seen.add(alias); seen.add(node.id);
      const state = stateOf(node, alias);
      const record: RecordNode = { state, parent, children: [] };
      records.push(record);
      byId.set(alias, record);
      byId.set(node.id, record);
      if (parent) parent.children.push(record);
      const children = "children" in node ? (node as Container).children : [];
      if (children.length) stack.push({ record, ids: children, next: 0, retired: copied });
    }
    if (stack.some(edge => edge.next !== edge.ids.length)) throw inconsistentInstanceTree(root, "its search left out layers the children lists hold");
    scope.records = records;
    scope.byId = byId;
    scope.retired = retired;
    scope.generation = generation;
    for (const record of records) { record.state.scope = scope; record.state.record = record; }
  }
  function live(state: State): BaseNode {
    if (state.scope) refresh(state.scope);
    return state.native;
  }
  function tree(state: State, bounded = false): RecordNode {
    if (!bounded && state.scope) {
      refresh(state.scope);
      if (state.record) return state.record;
    }
    const scope = state.ownScope ??= { root: state, generation: -1, records: [], byId: new Map(), retired: new Map() };
    refresh(scope);
    state.scope = scope;
    state.record = scope.records[0];
    return scope.records[0];
  }
  // Compound IDs mark instance descendants; a scoped state was already acquired by an index.
  function insideInstance(state: State): boolean {
    return !!state.scope || state.native.type === "INSTANCE" || isSublayerId(state.id);
  }
  function childViews(state: State): BaseNode[] {
    if (insideInstance(state)) return tree(state).children.map(child => child.state.view);
    return (state.native as Container).children.map(child => stateOf(child).view);
  }
  function descendants(state: State): BaseNode[] {
    const result: BaseNode[] = [];
    const visit = (state: State): void => {
      if (!("children" in state.native)) return;
      for (const child of childViews(state)) { result.push(child); visit(views.get(child)!); }
    };
    visit(state);
    return result;
  }
  // The children `dest` lists now, indexed from `dest` alone where handles go stale. Its own
  // place in an enclosing index is kept, so the bounded scan doesn't cut it off from its parents.
  function placedChildren(dest: State): State[] {
    if (!insideInstance(dest)) return (dest.native as Container).children.map(child => stateOf(child));
    const { scope, record } = dest;
    const children = tree(dest, true).children.map(child => child.state);
    if (scope && scope !== dest.ownScope) { dest.scope = scope; dest.record = record; }
    return children;
  }
  // Where a node lands, read before the native call: last for appendChild. Figma's insertChild
  // inserts, then drops the old entry, so an earlier sibling lands one before the index given.
  function landingOf(dest: State, key: PropertyKey, args: unknown[]): { moved: State; index: number | "end" } | undefined {
    if (key === "appendChild") { const moved = viewState(args[0]); return moved && { moved, index: "end" }; }
    if (key !== "insertChild") return undefined;
    const moved = viewState(args[1]);
    if (!moved) return undefined;
    const index = args[0] as number;
    const prior = viewState(moved.view.parent) === dest ? childViews(dest).indexOf(moved.view) : -1;
    return { moved, index: prior >= 0 && prior < index ? index - 1 : index };
  }
  // Figma decides what lands. A moved indexed root retires its compound handle, and tied slot content
  // lands as flcm's copy, or re-pathed on a reorder. So the node at the landing index
  // is the result, and the moved view, with every descendant view acquired before the move, is
  // rebound to it before callers settle layout or reuse them.
  function placed(dest: State, moved: State, index: number | "end"): void {
    const before = moved.record;
    const tied = isSublayerId(moved.id);
    const wasIndexed = !!moved.scope || !!moved.ownScope;
    const children = placedChildren(dest);
    const landed = children[index === "end" ? children.length - 1 : index];
    if (!landed || landed.native.type !== moved.native.type) {
      throw new FlcmError(
        "figma",
        "after the move Figma held no layer of this type where it should have landed, so flcm can't tell which layer it became. " +
          "Read the destination again with flcm.get before you retry.",
        { node: identityOf(moved.native) },
      );
    }
    if (landed !== moved) {
      adoptLanded(moved, landed);
      // A copy has its original's shape, so descendants pair by position, whatever their ids.
      const pair = (old: RecordNode, held: State): void => {
        const now = "children" in held.native ? childViews(held).map(view => views.get(view)!) : [];
        old.children.forEach((prior, i) => {
          if (!now[i]) return;
          if (prior.state !== now[i]) adoptLanded(prior.state, now[i]);
          pair(prior, prior.state);
        });
      };
      if (before) pair(before, moved);
    }
    // Figma copies or re-paths moved path-id content, and the child lists go on naming the original:
    // the search ids are the layers now. A plain-id root keeps its ids; they still resolve.
    if (tied && moved.record) takeSearchIds(moved.record);
    if (landed !== moved || insideInstance(dest)) return;
    moved.scope = undefined;
    moved.record = undefined;
    if (wasIndexed && "findAllWithCriteria" in moved.native) tree(moved, true);
  }
  function takeSearchIds(record: RecordNode): void {
    const { state } = record;
    if (state.id !== state.native.id) {
      recordMove(state.id, state.native.id);
      if (states.get(state.id) === state) states.delete(state.id);
      state.id = state.native.id;
    }
    record.children.forEach(takeSearchIds);
  }
  // Point a held state at the node that replaced it, so its view and cached methods follow.
  function adoptLanded(held: State, landed: State): void {
    if (landed.id !== held.id) recordMove(held.id, landed.id);
    if (states.get(held.id) === held) states.delete(held.id);
    Object.assign(held, { native: landed.native, id: landed.id, anchor: landed.anchor, scope: landed.scope, record: landed.record, ownScope: undefined });
    if (landed.record) landed.record.state = held;
    states.set(landed.id, held);
    states.set(landed.native.id, held);
  }
  // The instance, described, whose slot content a move must copy, or undefined for a native move.
  // Moved natively, path-id content leaves an unreadable node outside its instance, and any slot
  // content placed or moved in an earlier call can corrupt the instance's search when it moves to
  // another of its slots, whatever its id (live, 2026-10-26). A reorder in place is safe.
  function copiedSlotOwner(dest: State, moving: State): string | undefined {
    const node = moving.view as SceneNode;
    const owner = slotOwnerOf(node, false);
    if (!owner || viewState(node.parent) === dest) return undefined;
    const within = dest.native.type !== "PAGE" && slotOwnerOf(dest.view as SceneNode, true)?.id === owner.id;
    return within || isInheritedSlotContent(node) ? describeNodeIdentity(owner) : undefined;
  }
  function viewState(value: unknown): State | undefined {
    return value && typeof value === "object" ? views.get(value) : undefined;
  }
  function makeView(state: State): BaseNode {
    return new Proxy({} as BaseNode, {
      get(_target, key) {
        if (key === "id") return state.id;
        if (state.scope && state.scope.generation !== generation) refresh(state.scope);
        const node = state.native;
        if (key === "removed" && state.scope && !state.anchor && (!state.record || (state.scope.root.anchor ?? state.scope.root.native).removed)) return true;
        if (key === "selection" && "selection" in node) {
          const page = node as PageNode;
          // A selected instance descendant reads under its public ID and parent only once
          // its outermost instance is indexed. Ordinary selected nodes need no index.
          const outer = new Set(page.selection.map(child => outermostInstanceId(child.id)).filter(Boolean));
          if (outer.size) {
            for (const instance of page.findAllWithCriteria({ types: ["INSTANCE"] })) {
              if (outer.has(instance.id)) tree(stateOf(instance), true);
            }
          }
          return page.selection.map(child => (states.get(child.id) ?? stateOf(child)).view);
        }
        if (key === "children" && "children" in node) return childViews(state);
        if (key === "parent") {
          const record = state.record;
          if (record?.parent) return record.parent.state.view;
          return wrap((state.anchor ?? node).parent);
        }
        if (key === "findAll" && "findAll" in node) return (predicate?: (node: SceneNode) => boolean) => descendants(state).filter(n => !predicate || predicate(n as SceneNode));
        if (key === "findOne" && "findOne" in node) return (predicate: (node: SceneNode) => boolean) => descendants(state).find(n => predicate(n as SceneNode)) ?? null;
        if (key === "findChildren" && "findChildren" in node) return (predicate: (node: SceneNode) => boolean) => childViews(state).filter(n => predicate(n as SceneNode));
        const value = (node as unknown as Record<PropertyKey, unknown>)[key];
        // Native scalar/data properties already have the right shape. In particular,
        // paints, effects and text runs need no traversal or copied arrays.
        if (typeof value !== "function") return key === "mainComponent" || key === "exposedInstances" ? wrap(value) : value;
        const previous = state.methods.get(key);
        if (previous) return previous;
        const invoke = (...args: unknown[]) => {
          const current = live(state);
          const method = (current as unknown as Record<PropertyKey, unknown>)[key] as (...args: unknown[]) => unknown;
          const landing = landingOf(state, key, args);
          const native = args.map(unwrap);
          const owner = landing && copiedSlotOwner(state, landing.moved);
          const original = owner ? live(landing.moved) as SceneNode : undefined;
          // Cloned and placed before anything reads inside the copy: a subtree read before it moves
          // into a slot comes back unreadable (slot-validity ARCHAEOLOGY item 2).
          const fresh = original?.clone();
          if (fresh) native[native.length - 1] = fresh;
          let result: unknown;
          try { result = Reflect.apply(method, current, native); }
          catch (cause) {
            // The placement's failure is the one the agent needs; a loose copy the verb's undo also takes.
            try { fresh?.remove(); } catch { /* reported through cause */ }
            throw cause;
          }
          finally { if (NODE_TOPOLOGY_METHODS.has(String(key))) invalidate(); }
          if (original) { original.remove(); invalidate(); }
          if (landing) placed(state, landing.moved, landing.index);
          if (owner) {
            warnings.add({ id: landing!.moved.id, message: "This layer sat in a slot of " + owner +
              ", and Figma breaks a plugin's move of it, so flcm placed a copy here and removed the original. " +
              "Its id is now this one; the old id still reaches it in this session." });
          }
          return result instanceof Promise ? result.then(wrap) : wrap(result);
        };
        state.methods.set(key, invoke);
        return invoke;
      },
      set(_target, key, value) { const node = live(state); return Reflect.set(node, key, unwrap(value), node); },
      has(_target, key) { return key in live(state); },
      ownKeys() { return Reflect.ownKeys(live(state)); },
      getOwnPropertyDescriptor(_target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(live(state), key);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
    });
  }
  async function byId(id: string, followed = new Set<string>()): Promise<BaseNode | null> {
    const follow = (copy: string): Promise<BaseNode | null> | null => {
      if (followed.has(id)) return null;
      followed.add(id);
      return byId(copy, followed);
    };
    // Followed before Figma is asked: a committed move removed the original, so only a human undo,
    // which takes the copy too, brings the old id back. And asking Figma about an id it no longer
    // holds stalls 10s and throws (live, 2026-10-26). Short ids too: a layer of the user's own
    // inside content Figma copies to a sibling slot comes back under a path id.
    const movedTo = copyOf(id);
    if (movedTo) return follow(movedTo);
    // Compound IDs name descendants of an independently addressable instance.
    // Resolve that bounded root before asking its index for either public ID form.
    const outermost = outermostInstanceId(id);
    if (outermost) {
      const root = await nativeApi().getNodeByIdAsync(outermost);
      if (!root || root.removed) return null;
      const anchor = stateOf(root);
      tree(anchor, true);
      const scope = anchor.ownScope!;
      // Figma keeps the ordinary instance ID addressable after a slot import,
      // but after reopen its native ID may be the new compound path. Keep the
      // component-relative suffix and resolve it under that current native root.
      const currentId = liveSublayerId(root.id, componentPath(id, outermost));
      const record = scope.byId.get(currentId);
      const copy = record ? undefined : scope.retired.get(currentId);
      if (copy) return follow(copy);
      if (!record || record.state.native.removed) return null;
      record.state.scope = scope;
      record.state.record = record;
      return record.state.view;
    }
    const node = await nativeApi().getNodeByIdAsync(id);
    if (!node) return null;
    const state = stateOf(node);
    // A direct ordinary ID is its own native anchor. Earlier broad scans must not
    // turn a later single-node lookup into a page-sized refresh.
    state.scope = undefined;
    state.record = undefined;
    return state.view;
  }
  const api = new Proxy({} as PluginAPI, {
    get(_target, key) {
      if (key === "getNodeByIdAsync") return byId;
      const native = nativeApi();
      const value = (native as unknown as Record<PropertyKey, unknown>)[key];
      if (typeof value !== "function") return wrap(value);
      return (...args: unknown[]) => {
        let result: unknown;
        try { result = Reflect.apply(value, native, args.map(unwrap)); }
        finally { if (API_TOPOLOGY_METHODS.has(String(key))) invalidate(); }
        return result instanceof Promise ? result.then(wrap) : wrap(result);
      };
    },
    set(_target, key, value) { return Reflect.set(nativeApi(), key, unwrap(value), nativeApi()); },
  });
  function settleMovedIds(committed: boolean): void {
    if (committed) {
      for (const [from, to] of Object.entries(pending)) {
        if (to === null) delete moved[from];
        else moved[from] = to;
      }
    }
    pending = {};
  }
  return { api, invalidate, settleMovedIds };
}

const access = createSceneAccess(() => figma, movedIdsOf(runSession));
export const sceneFigma = access.api;
export const invalidateSceneAccess = access.invalidate;
export const settleSceneMovedIds = access.settleMovedIds;
