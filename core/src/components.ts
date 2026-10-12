import { stableStringify } from "./utils.js";
import { componentPath, definitionId } from "./instance-path.js";
import type { NodeDelta, SimplifiedComponentEntry, SimplifiedNode, StyleValue } from "./types.js";

/**
 * The components pass: emit each component's `children` ONCE into a sidecar, and rewrite every
 * instance as a diff against them.
 *
 * Why a post-walk pass rather than part of the walk: choosing which copy of a component's
 * children to publish needs GLOBAL knowledge the single-pass walk can't have — whether the
 * definition is in the tree at all, and which of N instances is the least-edited donor. Same
 * reason `compressDesign` runs after the walk.
 *
 * The priority for a component's children is fixed, and `childrenFrom` says which case fired:
 *   1. the definition's own node, when the read fetched it (in-tree)
 *   2. a definition supplied by the adapter (REST's off-tree fetch, the plugin's live main node)
 *   3. a donated instance — the least-edited one, marked `childrenFrom`
 * Cases 1 and 2 are the same thing to this pass: a real definition node. Case 3 is the floor,
 * and it is not a fallback we can design away — an unpublished component, a 429, or a library
 * the user can't open all land there.
 */

/**
 * What the walk records about a component as it passes an INSTANCE or a definition node. The
 * walk can see this and the pass cannot: `NodeSnapshot` carries the provenance, the emitted
 * `SimplifiedNode` deliberately does not.
 */
export interface ComponentProvenance {
  type: string;
  name: string;
  key?: string;
  componentSetId?: string;
  description?: string;
  propertyDefinitions?: SimplifiedComponentEntry["propertyDefinitions"];
}

/**
 * What the walk hands this pass. `components` is provenance merged per id — an instance and its
 * in-tree definition both contribute. `instanceEdits` is how many fields Figma reports the
 * designer changed by hand on each INSTANCE, used ONLY to pick the least-edited donor and never
 * emitted: the read shape states differences as values, not as a list of field names.
 */
export interface ComponentNotes {
  components: Map<string, ComponentProvenance>;
  instanceEdits: Map<string, number>;
  /**
   * Nodes the walk descended into whose children ALL dropped out — every one hidden by hand. Only
   * the walk can tell this apart from the two other ways a node ends up with no `children`: a
   * genuinely childless node, and a subtree the depth limit cut short. Without the distinction,
   * "hid every layer in here" and "left it alone" emit the same bytes.
   */
  emptiedContainers: Set<string>;
  /**
   * Definition ids whose subtree the producer fetched separately and cannot prove matches what this
   * document adopted (see `NodeSnapshot.definitionUnverified`). Only used when such a definition is
   * the one that actually publishes, which is why it is a note rather than a field on the node.
   */
  unverifiedDefinitions: Set<string>;
}

export function createComponentNotes(): ComponentNotes {
  return {
    components: new Map(),
    instanceEdits: new Map(),
    emptiedContainers: new Set(),
    unverifiedDefinitions: new Set(),
  };
}

/**
 * Merge one sighting of a component into the notes. Later sightings only FILL GAPS: the
 * definition node's own reading of its name/key wins over an instance's second-hand copy,
 * whichever order the walk happens to meet them in.
 */
export function noteComponent(
  notes: ComponentNotes,
  id: string,
  seen: Partial<ComponentProvenance> & { type: string; name: string },
): void {
  const existing = notes.components.get(id);
  if (!existing) {
    notes.components.set(id, { ...seen });
    return;
  }
  for (const [key, value] of Object.entries(seen)) {
    if (value !== undefined && existing[key as keyof ComponentProvenance] === undefined) {
      (existing as unknown as Record<string, unknown>)[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Rewrite `nodes` in place: definitions lose their `children` to the sidecar, instances lose
 * theirs to an `overrides` diff. `definitions` are extra definition subtrees the adapter
 * resolved for components that aren't in the tree (see priority 2 above).
 */
export function extractComponents(
  nodes: SimplifiedNode[],
  notes: ComponentNotes,
  definitions: SimplifiedNode[] = [],
  styles: Record<string, StyleValue> = {},
): Record<string, SimplifiedComponentEntry> {
  const index = indexComponentSources(nodes, definitions);
  const ids = componentIds(index, notes);

  // The children each entry publishes, captured BEFORE any node is rewritten — an instance that
  // donates is itself reduced afterwards (against its own donation, so its diff comes out empty).
  const sources = new Map<string, ChildrenSource>();
  for (const id of ids) {
    const source = chooseComponentSource(id, index, notes, { rekeyDonation: true });
    if (source) sources.set(id, source);
  }

  for (const definition of index.definitionNodes.values()) delete definition.children;

  const components: Record<string, SimplifiedComponentEntry> = {};
  const resolved = new Map<string, SimplifiedNode[] | undefined>();
  const resolving = new Set<string>();

  // Publish an entry's children, themselves reduced (they can hold instances of other
  // components). Memoized, and guarded against a definition that somehow contains itself —
  // Figma forbids it, but a malformed fixture must not hang the read.
  const resolveChildren = (id: string): SimplifiedNode[] | undefined => {
    if (resolved.has(id)) return resolved.get(id);
    if (resolving.has(id)) return undefined;
    resolving.add(id);
    const source = sources.get(id);
    const children = source
      ? source.children.map((child) =>
          reduceNode(clone(child), resolveChildren, notes.emptiedContainers, styles),
        )
      : undefined;
    resolving.delete(id);
    resolved.set(id, children);

    components[id] = componentEntry(id, notes, source, children);
    return children;
  };

  for (const id of ids) resolveChildren(id);
  for (const node of nodes) reduceNode(node, resolveChildren, notes.emptiedContainers, styles);
  return components;
}

interface ComponentSources {
  definitionNodes: Map<string, SimplifiedNode>;
  instancesByComponent: Map<string, SimplifiedNode[]>;
}

/** Where each component's children could come from: its definition node, or its instances. */
function indexComponentSources(
  nodes: SimplifiedNode[],
  definitions: SimplifiedNode[],
): ComponentSources {
  const index: ComponentSources = { definitionNodes: new Map(), instancesByComponent: new Map() };
  indexTree(nodes, index);
  for (const definition of definitions) {
    indexTree([definition], index);
    // `indexTree` only registers COMPONENT/COMPONENT_SET-typed roots, so a fetched definition whose
    // root is neither still needs registering. First-wins there and here, for the same reason.
    if (!index.definitionNodes.has(definition.id))
      index.definitionNodes.set(definition.id, definition);
  }
  return index;
}

/**
 * Every id anything in this read names — instances point at components the tree may not hold,
 * and the notes hold provenance for exactly those. Sorted so two runs emit the same sidecar.
 */
function componentIds(index: ComponentSources, notes: ComponentNotes): string[] {
  return [
    ...new Set([
      ...notes.components.keys(),
      ...index.definitionNodes.keys(),
      ...index.instancesByComponent.keys(),
    ]),
  ].sort();
}

function indexTree(nodes: SimplifiedNode[], index: ComponentSources): void {
  for (const node of nodes) {
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      // First wins. The tree is indexed before any adapter-supplied definition, so this is what
      // enforces priority 1 over 2: the in-tree node is the definition as THIS document has it,
      // while a fetched one is the library's current state, which the document may not have taken.
      if (!index.definitionNodes.has(node.id)) index.definitionNodes.set(node.id, node);
    } else if (node.type === "INSTANCE" && node.componentId) {
      const list = index.instancesByComponent.get(node.componentId);
      if (list) list.push(node);
      else index.instancesByComponent.set(node.componentId, [node]);
    }
    if (node.children) indexTree(node.children, index);
  }
}

interface ChildrenSource {
  children: SimplifiedNode[];
  /** The donor instance's id when the children are a donation, still keyed in its id space. */
  from?: string;
  unverified?: true;
}

/**
 * Pick the children an entry publishes — the one source policy for the runtime catalog and the wire
 * pass. They differ only in `rekeyDonation`, deliberately: the wire re-keys a donation (on a clone)
 * into the definition's id space so a reader resolves a path the same way whatever the provenance
 * was — `I<donor>;<path>` on the canvas, `<path>` once published — while the runtime keeps the live
 * subtree itself, so an agent's read holds ids it can write to.
 */
function chooseComponentSource(
  id: string,
  index: ComponentSources,
  notes: ComponentNotes,
  { rekeyDonation }: { rekeyDonation: boolean },
): ChildrenSource | undefined {
  const definition = index.definitionNodes.get(id);
  if (definition?.children?.length) {
    const children = definition.children;
    return notes.unverifiedDefinitions.has(id) ? { children, unverified: true } : { children };
  }
  // The least-edited instance first, then the next — an instance whose own sublayers were all
  // hidden has nothing to donate, and stopping at it would publish no children for a component
  // some other instance could have shown whole.
  for (const donor of byEditCount(index.instancesByComponent.get(id), notes.instanceEdits)) {
    if (!donor.children?.length) continue;
    const children = rekeyDonation
      ? donor.children.map((child) => rekey(clone(child), donor.id))
      : donor.children;
    return { children, from: donor.id };
  }
  return undefined;
}

/** One sidecar entry: the component's provenance, plus where its published children came from. */
function componentEntry(
  id: string,
  notes: ComponentNotes,
  source: ChildrenSource | undefined,
  children: SimplifiedNode[] | undefined,
): SimplifiedComponentEntry {
  const provenance = notes.components.get(id);
  const entry: SimplifiedComponentEntry = {
    type: provenance?.type ?? "COMPONENT",
    name: provenance?.name ?? id,
  };
  if (provenance?.key) entry.key = provenance.key;
  if (provenance?.componentSetId) entry.componentSetId = provenance.componentSetId;
  if (provenance?.description) entry.description = provenance.description;
  if (provenance?.propertyDefinitions) entry.propertyDefinitions = provenance.propertyDefinitions;
  if (children) entry.children = children;
  if (source?.from) entry.childrenFrom = source.from;
  if (source?.unverified) entry.childrenUnverified = true;
  return entry;
}

/**
 * Candidate donors, closest to the component's own children first. Fewest override entries wins;
 * ties break on id so the choice doesn't depend on walk order. A donor with edits is still worth
 * publishing — `childrenFrom` warns the reader — because the alternative is N full subtrees.
 *
 * Fewest-edits is a heuristic, not proof of a pristine body: Figma records a hand edit, not a
 * layout side-effect, so an instance that was merely stretched counts as clean. It is the best
 * signal available without the definition itself, which is what the fetched upgrade is for.
 */
function byEditCount(
  instances: SimplifiedNode[] | undefined,
  instanceEdits: Map<string, number>,
): SimplifiedNode[] {
  if (!instances?.length) return [];
  return [...instances].sort((a, b) => {
    const byEdits = (instanceEdits.get(a.id) ?? 0) - (instanceEdits.get(b.id) ?? 0);
    return byEdits !== 0 ? byEdits : a.id.localeCompare(b.id);
  });
}

function rekey(node: SimplifiedNode, donorId: string): SimplifiedNode {
  node.id = definitionId(componentPath(node.id, donorId));
  for (const child of node.children ?? []) rekey(child, donorId);
  return node;
}

/** JSON round-trip, not `structuredClone`: the core also runs in QuickJS, and these are plain JSON values. */
function clone(node: SimplifiedNode): SimplifiedNode {
  return JSON.parse(JSON.stringify(node)) as SimplifiedNode;
}

/**
 * Reduce one node in place, depth-first: an INSTANCE loses its children to an `overrides` diff
 * against its component's published children; everything else just recurses.
 */
function reduceNode(
  node: SimplifiedNode,
  resolveChildren: (id: string) => SimplifiedNode[] | undefined,
  emptied: Set<string>,
  styles: Record<string, StyleValue>,
): SimplifiedNode {
  if (node.children) {
    for (const child of node.children) reduceNode(child, resolveChildren, emptied, styles);
  }
  if (node.type !== "INSTANCE" || !node.componentId) return node;
  // No children AND the walk didn't empty it: either the component has none, or the depth limit
  // stopped short of them. Neither is a difference, so there is nothing to diff.
  if (!node.children && !emptied.has(node.id)) return node;

  const reference = resolveChildren(node.componentId);
  if (!reference) return node;

  const overrides = diffChildren(
    reference,
    node.children ?? [],
    { instanceId: node.id, referenceRoot: "" },
    emptied,
    styles,
  );
  // `null` means the instance added children the diff can't express as a delta (a filled slot
  // at the top level). Keeping the full subtree is the honest answer for that instance.
  if (overrides === null) return node;
  delete node.children;
  if (Object.keys(overrides).length > 0) node.overrides = overrides;
  return node;
}

/**
 * The two id spaces a diff strips down to component-relative paths: the instance being diffed, and
 * the reference's — `""` for a definition's own ids, or the donor instance whose live ids a runtime
 * donation still carries.
 */
interface DiffIds {
  instanceId: string;
  referenceRoot: string;
}

/**
 * Diff a child list against the reference's, writing every delta into one flat map keyed by
 * component-relative path. Returns null when the instance ADDS children at this level — new
 * content, not a change — which the caller answers by keeping the subtree whole.
 */
function diffChildren(
  reference: SimplifiedNode[],
  actual: SimplifiedNode[],
  ids: DiffIds,
  emptied: Set<string>,
  styles: Record<string, StyleValue> = {},
): Record<string, NodeDelta> | null {
  const referenceByPath = new Map<string, SimplifiedNode>();
  for (const child of reference)
    referenceByPath.set(componentPath(child.id, ids.referenceRoot), child);

  const out: Record<string, NodeDelta> = {};
  const matched = new Set<string>();
  const order: string[] = [];
  for (const child of actual) {
    const path = componentPath(child.id, ids.instanceId);
    const counterpart = referenceByPath.get(path);
    if (!counterpart) return null;
    matched.add(path);
    order.push(path);
    const delta = diffNode(counterpart, child, ids, out, emptied, styles);
    if (delta) out[path] = delta;
  }

  // Sibling order IS the z-order and the layout flow, and the diff states differences by path, not
  // by position — so a resequenced list (slot content the designer rearranged) would otherwise come
  // out as no difference at all. Republish this level whole rather than inventing an order word.
  const referenceOrder = [...referenceByPath.keys()].filter((path) => matched.has(path));
  if (order.some((path, index) => path !== referenceOrder[index])) return null;

  // Present in the component, absent here: the designer hid this layer by hand. The read shape
  // drops hidden nodes, so the deviation would otherwise vanish entirely.
  for (const path of referenceByPath.keys()) {
    // The path is the key; a delta never restates it.
    if (!matched.has(path)) out[path] = { visible: false };
  }
  return out;
}

/** Fields never compared: the id is implied by the path, children are compared structurally. */
const DIFF_SKIP_KEYS = new Set(["id", "children", "readOnlySource", "elided"]);

/**
 * A field's comparable form. A token reference compares by identity: the same variable resolving
 * to another value is a mode switch, not a designer's override, and would otherwise report every
 * bound field under a dark-mode instance. Interned values are looked up first, since two such
 * references intern under different names.
 */
function overrideIdentity(value: unknown, styles: Record<string, StyleValue>): string {
  const comparable = (field: unknown): unknown => {
    if (typeof field === "string")
      return Object.prototype.hasOwnProperty.call(styles, field)
        ? comparable(styles[field])
        : field;
    if (Array.isArray(field)) return field.map(comparable);
    if (!field || typeof field !== "object") return field;
    const isReference = "variable" in field || "style" in field;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(field)) {
      if (isReference && key === "value") continue;
      // A reference's identity may be a bare token name, which is never an interned-style key.
      out[key] = isReference && (key === "variable" || key === "style") ? inner : comparable(inner);
    }
    return out;
  };
  return stableStringify(comparable(value));
}

/**
 * The per-node delta: only the fields that differ, plus a structural answer for children. A
 * child list that gained entries is republished WHOLE on this node rather than diffed, because
 * a filled slot's content is new content rather than an edit to the component's.
 */
function diffNode(
  reference: SimplifiedNode,
  actual: SimplifiedNode,
  ids: DiffIds,
  out: Record<string, NodeDelta>,
  emptied: Set<string>,
  styles: Record<string, StyleValue>,
): NodeDelta | undefined {
  const delta: Record<string, unknown> = {};
  const referenceRecord = reference as unknown as Record<string, unknown>;
  const actualRecord = actual as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(referenceRecord), ...Object.keys(actualRecord)])) {
    if (DIFF_SKIP_KEYS.has(key)) continue;
    const before = referenceRecord[key];
    const after = actualRecord[key];
    // Absent on the instance but present on the component: the designer put the field back to its
    // default (opacity to 1, a radius to 0, a paint removed). The read shape omits defaults, so
    // there is no value to state — `null` is the delta's word for "this field is not here", and
    // without it the reader would rebuild the component's value on a node that lost it.
    if (after === undefined) {
      if (before !== undefined) delta[key] = null;
      continue;
    }
    if (overrideIdentity(before, styles) !== overrideIdentity(after, styles)) delta[key] = after;
  }

  // An emptied container has no `children` to compare, but an EMPTY list is the honest actual:
  // every one of the component's children then falls out below as `visible: false`.
  const actualChildren = actual.children ?? (emptied.has(actual.id) ? [] : undefined);
  if (actualChildren) {
    const nested = reference.children
      ? diffChildren(reference.children, actualChildren, ids, emptied, styles)
      : null;
    if (nested === null) delta.children = actualChildren;
    else Object.assign(out, nested);
  }

  if (Object.keys(delta).length === 0) return undefined;
  return delta as NodeDelta;
}

/**
 * The runtime sidecar. Unlike `extractComponents` it neither clones nor re-keys: a published
 * definition or donation is the live subtree itself, so an agent's read keeps live ids.
 */
export function componentCatalog(
  nodes: SimplifiedNode[],
  notes: ComponentNotes,
  definitions: SimplifiedNode[],
): Record<string, SimplifiedComponentEntry> {
  const index = indexComponentSources(nodes, definitions);
  const result: Record<string, SimplifiedComponentEntry> = {};
  for (const id of componentIds(index, notes)) {
    const source = chooseComponentSource(id, index, notes, { rekeyDonation: false });
    result[id] = componentEntry(id, notes, source, source?.children);
  }
  return result;
}

/** Semantic differences are useful to author an instance without moving its inherited layers. */
export function describeInstanceChanges(
  nodes: SimplifiedNode[],
  components: Record<string, SimplifiedComponentEntry>,
): void {
  for (const node of nodes) {
    if (node.children) describeInstanceChanges(node.children, components);
    const entry = node.componentId ? components[node.componentId] : undefined;
    if (node.type !== "INSTANCE" || !entry?.children) continue;
    const overrides = diffChildren(
      entry.children,
      node.children ?? [],
      { instanceId: node.id, referenceRoot: entry.childrenFrom ?? "" },
      new Set(),
    );
    if (overrides && Object.keys(overrides).length)
      node.overrides = JSON.parse(JSON.stringify(overrides));
  }
}
