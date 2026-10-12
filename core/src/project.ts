import { admittedOnWire, childrenInsideDefinition } from "./admission.js";
import { createComponentNotes, extractComponents } from "./components.js";
import { readContext, type ReadContext } from "./read-context.js";
import { computeGridChildOrder } from "./transformers/layout.js";
import { paintSlot } from "./transformers/style.js";
import { hasAutoLayout } from "./utils.js";
import { componentPath, liveSublayerId } from "./instance-path.js";
import type { SimplifyResult } from "./simplify.js";
import type { NodeSnapshot } from "./snapshot.js";
import type { SimplifiedNode, Elision } from "./types.js";

export interface ProjectOptions {
  maxDepth?: number;
}

/** Project copies the runtime tree; cuts never mutate data an agent is still using. */
export function project(full: SimplifyResult, options: ProjectOptions = {}): SimplifyResult {
  return projectTrees(full.nodes, readContext(full), options);
}

export function projectReadNode(node: SimplifiedNode, full: SimplifyResult): SimplifiedNode {
  const result = projectTrees([node], readContext(full), {});
  return (
    result.nodes[0] ?? {
      id: node.id,
      visible: false,
      elided: { node: JSON.stringify(node).length },
    }
  );
}

function projectTrees(
  roots: SimplifiedNode[],
  context: ReadContext,
  options: ProjectOptions,
): SimplifyResult {
  const notes = createComponentNotes();
  const cuts = new Map<string, Elision>();
  const cut = (node: SimplifiedNode, field: string, value: unknown) => {
    const list = cuts.get(node.id) ?? {};
    list[field] = JSON.stringify(value)?.length ?? null;
    cuts.set(node.id, list);
  };
  const walk = (
    input: SimplifiedNode[],
    depth: number,
    insideDefinition: boolean,
  ): SimplifiedNode[] => {
    const out: SimplifiedNode[] = [];
    for (const full of input) {
      const snapshot = context.snapshots.get(full);
      if (!snapshot) throw new Error("Read tree contains a node without producer metadata.");
      if (!admittedOnWire(full, insideDefinition)) continue;
      const { children, d, vectorPaths, ...body } = full;
      const node = JSON.parse(JSON.stringify(body)) as SimplifiedNode;
      for (const field of [
        "locked",
        "clip",
        "constraints",
        "mixBlendMode",
        "readOnlySource",
      ] as const)
        delete node[field];
      delete node.visible;
      delete node.overrides;
      if (full.type === "VECTOR") {
        node.type = "IMAGE-SVG";
      }
      if (d !== undefined) cut(full, "d", d);
      if (vectorPaths !== undefined) cut(full, "vectorPaths", vectorPaths);
      // The wire folds each paint slot; a slot that folds to nothing is absent.
      for (const slot of ["fill", "stroke"] as const) {
        const value = paintSlot(snapshot, slot, { fold: true });
        if (value !== undefined) node[slot] = value;
        else delete node[slot];
      }
      // Notes are collected only for nodes admitted by the wire's visibility/depth rules.
      for (const id of [full.id, full.componentId, snapshot.mainComponent?.set?.id]) {
        if (!id) continue;
        const provenance = context.notes.components.get(id);
        if (provenance) notes.components.set(id, provenance);
      }
      if (full.type === "COMPONENT_SET")
        for (const child of children ?? []) {
          const provenance = context.notes.components.get(child.id);
          if (provenance) notes.components.set(child.id, provenance);
        }
      if (context.notes.instanceEdits.has(full.id))
        notes.instanceEdits.set(full.id, context.notes.instanceEdits.get(full.id)!);
      if (context.notes.unverifiedDefinitions.has(full.id))
        notes.unverifiedDefinitions.add(full.id);
      const atLimit = options.maxDepth !== undefined && depth >= options.maxDepth;
      if (children?.length && !atLimit) {
        const order = computeGridChildOrder(snapshot) ?? children.map((_, i) => i);
        const ordered = order.map((i) => children[i]);
        const projected = walk(
          ordered,
          depth + 1,
          childrenInsideDefinition(full, insideDefinition),
        );
        if (projected.length) {
          const kept = collapseSvgContainers(snapshot, node, projected);
          if (kept.length) node.children = kept;
        }
        if ((node.children?.length ?? 0) !== children.length) cut(full, "children", children);
      } else if (children?.length && atLimit) cut(full, "children", children);
      // A depth-limited REST response can omit the child list before core ever sees it.
      if (
        children === undefined &&
        options.maxDepth !== undefined &&
        CONTAINER_TYPES.has(snapshot.type)
      )
        cut(full, "children", undefined);
      if (!atLimit && children && !node.children && node.type !== "IMAGE-SVG")
        notes.emptiedContainers.add(node.id);
      out.push(node);
    }
    return out;
  };
  const nodes = walk(roots, 0, false);
  const definitions = walk(context.definitions, 0, false);
  const components = extractComponents(nodes, notes, definitions);
  const result: SimplifyResult = { nodes, styles: {}, templates: {}, components };
  // Markers attach after diffing so they cannot change component deltas; compression keeps them
  // out of template bodies for the same reason.
  const mark = (list: SimplifiedNode[], donorId?: string) => {
    for (const node of list) {
      // A donated body is keyed in the definition's id space; its cuts were recorded on the donor.
      const fullId = donorId ? liveSublayerId(donorId, componentPath(node.id)) : node.id;
      const entries = cuts.get(fullId);
      if (entries && Object.keys(entries).length) node.elided = entries;
      if (node.children) mark(node.children, donorId);
      for (const delta of Object.values(node.overrides ?? {}))
        if (delta.children) mark(delta.children, donorId);
    }
  };
  const omittedRoots = roots.filter((root) => !nodes.some((node) => node.id === root.id));
  if (omittedRoots.length)
    result.elided = omittedRoots.map((root) => ({
      id: root.id,
      elided: { node: JSON.stringify(root).length },
    }));
  mark(result.nodes);
  for (const entry of Object.values(components))
    if (entry.children) mark(entry.children, entry.childrenFrom);
  return result;
}

// ---------------------------------------------------------------------------
// SVG container collapse
// ---------------------------------------------------------------------------

/**
 * Node types that can be exported as SVG images.
 * When a collapsible container holds only these types, the container can be flattened to
 * IMAGE-SVG. BOOLEAN_OPERATION is in both this set and the container set below because it's
 * both collapsible AND SVG-eligible as a child (boolean ops always produce vector output).
 *
 * Tightly coupled to the walk above, which renames VECTOR → IMAGE-SVG before this set is
 * consulted.
 */
const SVG_ELIGIBLE_TYPES = new Set([
  "IMAGE-SVG", // VECTOR nodes are converted to IMAGE-SVG, or containers that were collapsed
  "BOOLEAN_OPERATION",
  "STAR",
  "LINE",
  "ELLIPSE",
  "REGULAR_POLYGON",
  "RECTANGLE",
]);

/** Container node types eligible to collapse into a single IMAGE-SVG. */
const COLLAPSIBLE_CONTAINER_TYPES = new Set(["FRAME", "GROUP", "INSTANCE", "BOOLEAN_OPERATION"]);

/**
 * Auto-layout signals authored structure — the spacing/arrangement of children is
 * intentional, so we normally preserve the container even when all its children are
 * SVG-eligible (charts, toolbars, layout test frames, swatch grids, tile mosaics).
 * Above this many children, though, we assume the container is a decorative pattern
 * (dotted backgrounds, noise grids) where the payload cost of preserving every leaf
 * outweighs the structural value, and we collapse anyway.
 *
 * Applies to both flex (HORIZONTAL/VERTICAL) and GRID auto-layout, since both signal
 * authored intent.
 *
 * Pivot point chosen empirically: real charts and structural displays rarely exceed ~10
 * primitives; decorative patterns typically have many dozens. Tune if real-world output
 * shows either category mis-classified.
 */
const SVG_COLLAPSE_AUTOLAYOUT_THRESHOLD = 10;

/**
 * Collapse SVG-heavy containers to IMAGE-SVG. Called by the walk after a
 * node's children are processed (bottom-up), so nested containers collapse
 * innermost-first.
 *
 * Collapses when:
 *   - container is a FRAME, GROUP, INSTANCE, or BOOLEAN_OPERATION
 *   - all children are SVG-eligible types
 *   - neither the node nor any direct child has an image fill
 *   - container is NOT auto-layout, OR child count is past the decorative-pattern threshold
 *
 * The auto-layout carve-out preserves authored layouts (bar charts, button rows, swatch
 * grids) that happen to bottom out in shape primitives. The count threshold reclaims
 * payload for decorative patterns built with auto-layout (e.g., grids of dots).
 *
 * @param node - Original Figma node
 * @param result - SimplifiedNode being built
 * @param children - Processed children
 * @returns Children to include (empty array if collapsed)
 */
function collapseSvgContainers(
  node: NodeSnapshot,
  result: SimplifiedNode,
  children: SimplifiedNode[],
): SimplifiedNode[] {
  if (!COLLAPSIBLE_CONTAINER_TYPES.has(node.type)) return children;
  // `type` is optional on SimplifiedNode only because post-walk template refs
  // drop it; mid-walk every child still has a type, so the `?? ""` is a
  // type-level concession that never matches at runtime.
  if (!children.every((child) => SVG_ELIGIBLE_TYPES.has(child.type ?? ""))) return children;
  if (hasImageFillOnSelfOrDirectChildren(node)) return children;

  if (hasAutoLayout(node) && children.length < SVG_COLLAPSE_AUTOLAYOUT_THRESHOLD) {
    return children;
  }

  result.type = "IMAGE-SVG";
  return [];
}

/**
 * Check whether a node or its direct children have image fills.
 *
 * Only direct children need checking because the collapse runs bottom-up:
 * if a deeper descendant has image fills, its parent won't collapse (stays FRAME),
 * and FRAME isn't SVG-eligible, so the chain breaks naturally at each level.
 */
function hasImageFillOnSelfOrDirectChildren(node: NodeSnapshot): boolean {
  if (node.fills?.some((fill) => fill.type === "IMAGE")) {
    return true;
  }
  if (node.children) {
    return node.children.some((child) => child.fills?.some((fill) => fill.type === "IMAGE"));
  }
  return false;
}

/** Markers are metadata, including when an agent retypes one into an authored child list. */
export function isElision(value: unknown): value is { elided: Elision } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => key !== "elided")) return false;
  if (
    !("elided" in value) ||
    !value.elided ||
    typeof value.elided !== "object" ||
    Array.isArray(value.elided)
  )
    return false;
  const sizes = Object.values(value.elided);
  return (
    sizes.length > 0 &&
    sizes.every(
      (size) =>
        size === null || (typeof size === "number" && Number.isSafeInteger(size) && size >= 0),
    )
  );
}

const CONTAINER_TYPES = new Set([
  "DOCUMENT",
  "CANVAS",
  "PAGE",
  "FRAME",
  "GROUP",
  "INSTANCE",
  "COMPONENT",
  "COMPONENT_SET",
  "SECTION",
  "SLOT",
  "BOOLEAN_OPERATION",
]);
