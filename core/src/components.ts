import { stableStringify } from "./utils.js";
import type { SimplifiedComponentEntry, SimplifiedNode } from "./types.js";

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
}

export function createComponentNotes(): ComponentNotes {
  return { components: new Map(), instanceEdits: new Map() };
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
    definitionNodes.set(definition.id, definition);
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
  const sources = new Map<string, { children: SimplifiedNode[]; from?: string }>();
  for (const id of ids) {
    const source = chooseChildren(id, definitionNodes, instancesByComponent, notes.instanceEdits);
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
      ? source.children.map((child) => reduceNode(clone(child), resolveChildren))
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
    components[id] = entry;
    return children;
  };

  for (const id of ids) resolveChildren(id);
  for (const node of nodes) reduceNode(node, resolveChildren);
  return components;
}

function indexTree(
  nodes: SimplifiedNode[],
  definitionNodes: Map<string, SimplifiedNode>,
  instancesByComponent: Map<string, SimplifiedNode[]>,
): void {
  for (const node of nodes) {
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      definitionNodes.set(node.id, node);
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
  instanceEdits: Map<string, number>,
): { children: SimplifiedNode[]; from?: string } | undefined {
  const definition = definitionNodes.get(id);
  if (definition?.children?.length) {
    const children = definition.children;
    delete definition.children;
    return { children };
  }
  const donor = leastEdited(instancesByComponent.get(id), instanceEdits);
  if (!donor?.children?.length) return undefined;
  return { children: donor.children.map((child) => rekey(clone(child), donor.id)), from: donor.id };
}

/**
 * The instance whose children are closest to the component's own. Fewest override entries wins;
 * ties break on id so the choice doesn't depend on walk order. A donor with edits is still worth
 * publishing — `childrenFrom` warns the reader — because the alternative is N full subtrees.
 */
function leastEdited(
  instances: SimplifiedNode[] | undefined,
  instanceEdits: Map<string, number>,
): SimplifiedNode | undefined {
  if (!instances?.length) return undefined;
  return [...instances].sort((a, b) => {
    const byEdits = (instanceEdits.get(a.id) ?? 0) - (instanceEdits.get(b.id) ?? 0);
    return byEdits !== 0 ? byEdits : a.id.localeCompare(b.id);
  })[0];
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
): SimplifiedNode {
  if (node.children) {
    for (const child of node.children) reduceNode(child, resolveChildren);
  }
  if (node.type !== "INSTANCE" || !node.componentId || !node.children) return node;

  const reference = resolveChildren(node.componentId);
  if (!reference) return node;

  const overrides = diffChildren(reference, node.children, node.id);
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
): Record<string, SimplifiedNode> | null {
  const referenceByPath = new Map<string, SimplifiedNode>();
  for (const child of reference) referenceByPath.set(componentPath(child.id, ""), child);

  const out: Record<string, SimplifiedNode> = {};
  const matched = new Set<string>();
  for (const child of actual) {
    const path = componentPath(child.id, instanceId);
    const counterpart = referenceByPath.get(path);
    if (!counterpart) return null;
    matched.add(path);
    const delta = diffNode(counterpart, child, instanceId, out);
    if (delta) out[path] = delta;
  }

  // Present in the component, absent here: the designer hid this layer by hand. The read shape
  // drops hidden nodes, so the deviation would otherwise vanish entirely.
  for (const path of referenceByPath.keys()) {
    // The path is the key; a delta never restates it.
    if (!matched.has(path)) out[path] = { visible: false } as unknown as SimplifiedNode;
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
  out: Record<string, SimplifiedNode>,
): SimplifiedNode | undefined {
  const delta: Record<string, unknown> = {};
  const referenceRecord = reference as unknown as Record<string, unknown>;
  const actualRecord = actual as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(referenceRecord), ...Object.keys(actualRecord)])) {
    if (DIFF_SKIP_KEYS.has(key)) continue;
    const before = referenceRecord[key];
    const after = actualRecord[key];
    if (after === undefined) continue;
    if (stableStringify(before) !== stableStringify(after)) delta[key] = after;
  }

  if (actual.children) {
    const nested = reference.children
      ? diffChildren(reference.children, actual.children, instanceId)
      : null;
    if (nested === null) delta.children = actual.children;
    else Object.assign(out, nested);
  }

  if (Object.keys(delta).length === 0) return undefined;
  return delta as unknown as SimplifiedNode;
}
