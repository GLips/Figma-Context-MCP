import { stableStringify } from "./utils.js";
import type { NodeDelta, SimplifiedComponentEntry, SimplifiedNode } from "./types.js";

/**
 * The components pass: emit each component's `children` ONCE into a sidecar, and rewrite every
 * instance as a diff against them.
 *
 * Why a post-walk pass rather than part of the walk: choosing which copy of a component's
 * children to publish needs GLOBAL knowledge the single-pass walk can't have — whether the
 * definition is in the tree at all, and which of N instances is the least-edited donor. Same
 * reason `compressDesign` runs after the walk.
 *
 * Unlike compression, this runs in BOTH expanded and compressed mode. The plugin reads expanded
 * and needs the sidecar just as much: it is the only place a plugin read can name a component,
 * and therefore the only way an instance's variant is recoverable there.
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
// Paths
// ---------------------------------------------------------------------------

/**
 * A node's COMPONENT-RELATIVE path — its id with the enclosing instance stripped, which is the
 * same string in every instance of a component and in the definition itself.
 *
 * Figma spells an instance sublayer `I<root>;<segment>;…` with exactly ONE leading `I`, however
 * deep the nesting (see the `nodeId` regex on `get_figma_data`). So three shapes collapse to one
 * path here: a plain descendant of a definition (`11:9`), a sublayer of a nested instance inside
 * a definition (`I11:9;11:14`), and a sublayer of the instance we're diffing
 * (`I11:12;11:9;11:14`).
 */
export function componentPath(id: string, rootId: string): string {
  // A nested instance's own id already carries the leading `I` (`I19:1;16:2`), a top-level
  // instance's does not (`11:12`). Both address their sublayers the same way — one `I`, then
  // the chain — so the prefix is built rather than assumed.
  const insidePrefix = rootId.startsWith("I") ? `${rootId};` : `I${rootId};`;
  if (id.startsWith(insidePrefix)) return id.slice(insidePrefix.length);
  return id.startsWith("I") ? id.slice(1) : id;
}

/**
 * The inverse, back onto the definition's own id space — what a published `children` node is
 * keyed by. One leading `I` iff the path crosses an instance boundary.
 */
export function definitionId(path: string): string {
  return path.includes(";") ? `I${path}` : path;
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
): Record<string, SimplifiedComponentEntry> {
  const definitionNodes = new Map<string, SimplifiedNode>();
  const instancesByComponent = new Map<string, SimplifiedNode[]>();
  indexTree(nodes, definitionNodes, instancesByComponent);
  for (const definition of definitions) {
    indexTree([definition], definitionNodes, instancesByComponent);
    // `indexTree` only registers COMPONENT/COMPONENT_SET-typed roots, so a fetched definition whose
    // root is neither still needs registering. First-wins there and here, for the same reason.
    if (!definitionNodes.has(definition.id)) definitionNodes.set(definition.id, definition);
  }

  // Every id anything in this read names — instances point at components the tree may not hold,
  // and the notes hold provenance for exactly those. Sorted so two runs emit the same sidecar.
  const ids = [
    ...new Set([
      ...notes.components.keys(),
      ...definitionNodes.keys(),
      ...instancesByComponent.keys(),
    ]),
  ].sort();

  // The children each entry publishes, captured BEFORE any node is rewritten — an instance that
  // donates is itself reduced afterwards (against its own donation, so its diff comes out empty).
  const sources = new Map<
    string,
    { children: SimplifiedNode[]; from?: string; unverified?: true }
  >();
  for (const id of ids) {
    const source = chooseChildren(id, definitionNodes, instancesByComponent, notes);
    if (source) sources.set(id, source);
  }

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
          reduceNode(clone(child), resolveChildren, notes.emptiedContainers),
        )
      : undefined;
    resolving.delete(id);
    resolved.set(id, children);

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
    components[id] = entry;
    return children;
  };

  for (const id of ids) resolveChildren(id);
  for (const node of nodes) reduceNode(node, resolveChildren, notes.emptiedContainers);
  return components;
}

function indexTree(
  nodes: SimplifiedNode[],
  definitionNodes: Map<string, SimplifiedNode>,
  instancesByComponent: Map<string, SimplifiedNode[]>,
): void {
  for (const node of nodes) {
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      // First wins. The tree is indexed before any adapter-supplied definition, so this is what
      // enforces priority 1 over 2: the in-tree node is the definition as THIS document has it,
      // while a fetched one is the library's current state, which the document may not have taken.
      if (!definitionNodes.has(node.id)) definitionNodes.set(node.id, node);
    } else if (node.type === "INSTANCE" && node.componentId) {
      const list = instancesByComponent.get(node.componentId);
      if (list) list.push(node);
      else instancesByComponent.set(node.componentId, [node]);
    }
    if (node.children) indexTree(node.children, definitionNodes, instancesByComponent);
  }
}

/**
 * Pick the children an entry publishes, and re-key them into the DEFINITION's id space so a
 * reader resolves a path the same way whatever the provenance was. A donated subtree is keyed
 * `I<donor>;<path>` on the canvas; republished it is keyed `<path>` — `childrenFrom` records
 * where it came from, but addressing never depends on that.
 */
function chooseChildren(
  id: string,
  definitionNodes: Map<string, SimplifiedNode>,
  instancesByComponent: Map<string, SimplifiedNode[]>,
  notes: ComponentNotes,
): { children: SimplifiedNode[]; from?: string; unverified?: true } | undefined {
  const definition = definitionNodes.get(id);
  if (definition?.children?.length) {
    const children = definition.children;
    delete definition.children;
    return notes.unverifiedDefinitions.has(id) ? { children, unverified: true } : { children };
  }
  // The least-edited instance first, then the next — an instance whose own sublayers were all
  // hidden has nothing to donate, and stopping at it would publish no children for a component
  // some other instance could have shown whole.
  for (const donor of byEditCount(instancesByComponent.get(id), notes.instanceEdits)) {
    if (!donor.children?.length) continue;
    return {
      children: donor.children.map((child) => rekey(clone(child), donor.id)),
      from: donor.id,
    };
  }
  return undefined;
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
): SimplifiedNode {
  if (node.children) {
    for (const child of node.children) reduceNode(child, resolveChildren, emptied);
  }
  if (node.type !== "INSTANCE" || !node.componentId) return node;
  // No children AND the walk didn't empty it: either the component has none, or the depth limit
  // stopped short of them. Neither is a difference, so there is nothing to diff.
  if (!node.children && !emptied.has(node.id)) return node;

  const reference = resolveChildren(node.componentId);
  if (!reference) return node;

  const overrides = diffChildren(reference, node.children ?? [], node.id, emptied);
  // `null` means the instance added children the diff can't express as a delta (a filled slot
  // at the top level). Keeping the full subtree is the honest answer for that instance.
  if (overrides === null) return node;
  delete node.children;
  if (Object.keys(overrides).length > 0) node.overrides = overrides;
  return node;
}

/**
 * Diff a child list against the reference's, writing every delta into one flat map keyed by
 * component-relative path. Returns null when the instance ADDS children at this level — new
 * content, not a change — which the caller answers by keeping the subtree whole.
 */
function diffChildren(
  reference: SimplifiedNode[],
  actual: SimplifiedNode[],
  instanceId: string,
  emptied: Set<string>,
): Record<string, NodeDelta> | null {
  const referenceByPath = new Map<string, SimplifiedNode>();
  for (const child of reference) referenceByPath.set(componentPath(child.id, ""), child);

  const out: Record<string, NodeDelta> = {};
  const matched = new Set<string>();
  const order: string[] = [];
  for (const child of actual) {
    const path = componentPath(child.id, instanceId);
    const counterpart = referenceByPath.get(path);
    if (!counterpart) return null;
    matched.add(path);
    order.push(path);
    const delta = diffNode(counterpart, child, instanceId, out, emptied);
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
const DIFF_SKIP_KEYS = new Set(["id", "children"]);

/**
 * The per-node delta: only the fields that differ, plus a structural answer for children. A
 * child list that gained entries is republished WHOLE on this node rather than diffed, because
 * a filled slot's content is new content rather than an edit to the component's.
 */
function diffNode(
  reference: SimplifiedNode,
  actual: SimplifiedNode,
  instanceId: string,
  out: Record<string, NodeDelta>,
  emptied: Set<string>,
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
    if (stableStringify(before) !== stableStringify(after)) delta[key] = after;
  }

  // An emptied container has no `children` to compare, but an EMPTY list is the honest actual:
  // every one of the component's children then falls out below as `visible: false`.
  const actualChildren = actual.children ?? (emptied.has(actual.id) ? [] : undefined);
  if (actualChildren) {
    const nested = reference.children
      ? diffChildren(reference.children, actualChildren, instanceId, emptied)
      : null;
    if (nested === null) delta.children = actualChildren;
    else Object.assign(out, nested);
  }

  if (Object.keys(delta).length === 0) return undefined;
  return delta as NodeDelta;
}
