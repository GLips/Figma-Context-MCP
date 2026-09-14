/** Native scene access for the preamble. Raw agent `figma` is never replaced.
 *
 * Figma can retain stale instance-child handles after slot placement. Its indexed
 * criteria search returns live objects, in documented preorder. Child arrays still
 * provide ordered identity edges, even when their objects cannot supply properties.
 * Keep those two responsibilities together here: indexed objects supply properties;
 * ordered edges supply public IDs, parents, siblings, and traversal.
 */
type Container = BaseNode & ChildrenMixin;
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
interface Scope { root: State; generation: number; records: RecordNode[]; byId: Map<string, RecordNode> }

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

export function createSceneAccess(source: () => PluginAPI): { api: PluginAPI; invalidate(): void } {
  let generation = 0;
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
    if (!node.id.startsWith("I")) state.anchor = node;
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
    const stack: { record: RecordNode; ids: readonly SceneNode[]; next: number }[] = [];
    const seen = new Set<string>();
    for (const node of indexed) {
      let parent: RecordNode | null = null;
      let alias = scope.root.id;
      if (records.length) {
        while (stack.length && stack[stack.length - 1].next === stack[stack.length - 1].ids.length) stack.pop();
        const edge = stack[stack.length - 1];
        if (!edge) throw new Error("flcm: indexed scene order exceeds the native child topology.");
        const child = edge.ids[edge.next++];
        if (child.type !== node.type) throw new Error("flcm: indexed scene order disagrees with native child types.");
        alias = child.id;
        parent = edge.record;
      }
      if (seen.has(alias) || seen.has(node.id)) throw new Error("flcm: indexed scene contains an ambiguous node identity.");
      seen.add(alias); seen.add(node.id);
      const state = stateOf(node, alias);
      const record: RecordNode = { state, parent, children: [] };
      records.push(record);
      byId.set(alias, record);
      byId.set(node.id, record);
      if (parent) parent.children.push(record);
      const children = "children" in node ? (node as Container).children : [];
      if (children.length) stack.push({ record, ids: children, next: 0 });
    }
    if (stack.some(edge => edge.next !== edge.ids.length)) throw new Error("flcm: this Figma host does not provide complete indexed scene access.");
    scope.records = records;
    scope.byId = byId;
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
    const scope = state.ownScope ??= { root: state, generation: -1, records: [], byId: new Map() };
    refresh(scope);
    state.scope = scope;
    state.record = scope.records[0];
    return scope.records[0];
  }
  function descendants(state: State): BaseNode[] {
    const result: BaseNode[] = [];
    const visit = (record: RecordNode): void => {
      for (const child of record.children) { result.push(child.state.view); visit(child); }
    };
    visit(tree(state));
    return result;
  }
  function makeView(state: State): BaseNode {
    return new Proxy({} as BaseNode, {
      get(_target, key) {
        if (key === "id") return state.id;
        if (state.scope && state.scope.generation !== generation) refresh(state.scope);
        const node = state.native;
        if (key === "removed" && state.scope && !state.anchor && (!state.record || (state.scope.root.anchor ?? state.scope.root.native).removed)) return true;
        if (key === "selection" && "selection" in node) {
          tree(state);
          return (node as PageNode).selection.map(child => (states.get(child.id) ?? stateOf(child)).view);
        }
        if (key === "children" && "children" in node) {
          if (node.type === "DOCUMENT" || node.type === "PAGE") return node.children.map(child => stateOf(child).view);
          return tree(state).children.map(child => child.state.view);
        }
        if (key === "parent") {
          const record = state.record;
          if (record?.parent) return record.parent.state.view;
          return wrap((state.anchor ?? node).parent);
        }
        if (key === "findAll" && "findAll" in node) return (predicate?: (node: SceneNode) => boolean) => descendants(state).filter(n => !predicate || predicate(n as SceneNode));
        if (key === "findOne" && "findOne" in node) return (predicate: (node: SceneNode) => boolean) => descendants(state).find(n => predicate(n as SceneNode)) ?? null;
        if (key === "findChildren" && "findChildren" in node) return (predicate: (node: SceneNode) => boolean) => tree(state).children.map(child => child.state.view).filter(n => predicate(n as SceneNode));
        const value = (node as unknown as Record<PropertyKey, unknown>)[key];
        // Native scalar/data properties already have the right shape. In particular,
        // paints, effects and text runs need no traversal or copied arrays.
        if (typeof value !== "function") return key === "mainComponent" || key === "exposedInstances" ? wrap(value) : value;
        const previous = state.methods.get(key);
        if (previous) return previous;
        const invoke = (...args: unknown[]) => {
          const current = live(state);
          const method = (current as unknown as Record<PropertyKey, unknown>)[key] as (...args: unknown[]) => unknown;
          let result: unknown;
          try { result = Reflect.apply(method, current, args.map(unwrap)); }
          finally { if (NODE_TOPOLOGY_METHODS.has(String(key))) invalidate(); }
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
  async function byId(id: string): Promise<BaseNode | null> {
    // Compound IDs name descendants of an independently addressable instance.
    // Resolve that bounded root before asking its index for either public ID form.
    const compound = /^I([^;]+);/.exec(id);
    if (compound) {
      const root = await nativeApi().getNodeByIdAsync(compound[1]);
      if (!root || root.removed) return null;
      const anchor = stateOf(root);
      tree(anchor, true);
      const scope = anchor.ownScope!;
      // Figma keeps the ordinary instance ID addressable after a slot import,
      // but after reopen its native ID may be the new compound path. Keep the
      // component-relative suffix and resolve it under that current native root.
      const suffix = id.slice(id.indexOf(";") + 1);
      const currentId = (root.id.startsWith("I") ? root.id : "I" + root.id) + ";" + suffix;
      const record = scope.byId.get(currentId);
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
  return { api, invalidate };
}

const access = createSceneAccess(() => figma);
export const sceneFigma = access.api;
export const invalidateSceneAccess = access.invalidate;
