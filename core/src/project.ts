import { compressDesign } from "./compress.js";
import { createComponentNotes, extractComponents } from "./components.js";
import { readContext, type ReadContext } from "./read-context.js";
import { createInlineStyleTable, createRefStyleTable } from "./style-table.js";
import { computeGridChildOrder } from "./transformers/layout.js";
import { hasAutoLayout } from "./utils.js";
import type { SimplifyResult } from "./simplify.js";
import type { NodeSnapshot } from "./snapshot.js";
import type { SimplifiedNode, StyleTable, Elision } from "./types.js";

export interface ProjectOptions {
  compress?: boolean;
  maxDepth?: number;
}

/** JSON character count is deterministic in QuickJS and bounds the cost of a fresh read. */
export function elision(id: string, field: string, value: unknown): Elision {
  return {
    $elided: {
      id,
      field,
      chars: JSON.stringify(value)?.length ?? 0,
      read: `flcm.get(${JSON.stringify(id)})`,
    },
  };
}

/** Project copies the runtime tree; cuts never mutate data an agent is still using. */
export function project(full: SimplifyResult, options: ProjectOptions = {}): SimplifyResult {
  const context = readContext(full);
  if (context.unchanged && !context.unchanged(full)) return full;
  return projectTrees(full.nodes, context, options);
}

export function projectReadNode(node: SimplifiedNode, full: SimplifyResult): SimplifiedNode {
  const context = readContext(full);
  if (context.unchanged && !context.unchanged(node)) return node;
  const result = projectTrees([node], context, {});
  return result.nodes[0] ?? { id: node.id, elided: [elision(node.id, "node", node)] };
}

export function projectIntoTable(
  full: SimplifyResult,
  table: StyleTable,
  options: ProjectOptions = {},
): SimplifyResult {
  return projectTrees(full.nodes, readContext(full), options, table);
}

function projectTrees(
  roots: SimplifiedNode[],
  context: ReadContext,
  options: ProjectOptions,
  providedTable?: StyleTable,
): SimplifyResult {
  const refs = options.compress ? createRefStyleTable() : undefined;
  const table = providedTable ?? refs ?? createInlineStyleTable();
  const notes = createComponentNotes();
  const cuts = new Map<string, Elision[]>();
  const originals = new Map<string, SimplifiedNode>();
  const cut = (node: SimplifiedNode, field: string, value: unknown) => {
    const list = cuts.get(node.id) ?? [];
    list.push(elision(node.id, field, value));
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
      originals.set(full.id, full);
      if (
        full.visible === false &&
        !(insideDefinition && full.componentPropertyReferences?.visible)
      )
        continue;
      const { children, d, vectorPaths, locked, details, ...body } = full;
      const node = JSON.parse(JSON.stringify(body)) as SimplifiedNode;
      delete node.visible;
      delete node.overrides;
      if (full.type === "VECTOR") {
        node.type = "IMAGE-SVG";
        cut(full, "type", full.type);
      }
      if (details !== undefined) cut(full, "details", details);
      if (d !== undefined) cut(full, "d", d);
      if (vectorPaths !== undefined) cut(full, "vectorPaths", vectorPaths);
      if (locked !== undefined) cut(full, "locked", locked);
      internStyles(node, snapshot, table);
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
        const nextInside =
          full.type === "COMPONENT" || full.type === "COMPONENT_SET"
            ? true
            : full.type === "INSTANCE"
              ? false
              : insideDefinition;
        const projected = walk(ordered, depth + 1, nextInside);
        if (projected.length) {
          const kept = collapseSvgContainers(snapshot, node, projected);
          if (kept.length) node.children = kept;
          else cut(full, "type", full.type);
        }
        if ((node.children?.length ?? 0) !== children.length) cut(full, "children", children);
      } else if (children?.length && atLimit) cut(full, "children", children);
      if (!atLimit && children && !node.children && node.type !== "IMAGE-SVG")
        notes.emptiedContainers.add(node.id);
      out.push(node);
    }
    return out;
  };
  const nodes = walk(roots, 0, false);
  const definitions = walk(context.definitions, 0, false);
  const components = extractComponents(nodes, notes, definitions);
  const surfaces = Object.values(components).flatMap((entry) =>
    entry.children ? [entry.children] : [],
  );
  const result = refs
    ? { ...compressDesign(nodes, surfaces, table.styles, refs.namedStyleKeys), components }
    : { nodes, styles: table.styles, templates: {}, components };
  // Markers attach after hashing/diffing so they cannot change template ids or component deltas.
  const mark = (list: SimplifiedNode[]) => {
    for (const node of list) {
      const full = originals.get(node.id);
      if (
        full?.children?.length &&
        !node.children &&
        !cuts.get(node.id)?.some((e) => e.$elided.field === "children")
      )
        cut(full, "children", full.children);
      const entries = cuts.get(node.id);
      if (entries?.length) node.elided = entries;
      if (node.children) mark(node.children);
      for (const delta of Object.values(node.overrides ?? {}))
        if (delta.children) mark(delta.children);
    }
  };
  const omittedRoots = roots.filter((root) => !nodes.some((node) => node.id === root.id));
  if (omittedRoots.length)
    (result as SimplifyResult).elided = omittedRoots.map((root) => elision(root.id, "node", root));
  mark(result.nodes);
  surfaces.forEach(mark);
  return result;
}

function internStyles(node: SimplifiedNode, snapshot: NodeSnapshot, table: StyleTable): void {
  // Match extraction order because named-style collisions and table order are observable on REST.
  if (node.layout !== undefined) node.layout = table.intern(snapshot, node.layout, [], "layout");
  if (Array.isArray(node.text))
    for (const run of node.text) {
      if (Array.isArray(run)) run[1] = table.intern(snapshot, run[1], [], "style");
    }
  if (node.textStyle !== undefined)
    node.textStyle = table.intern(snapshot, node.textStyle, ["text", "typography"], "style");
  if (node.fill !== undefined && !(node.type === "TEXT" && node.fill === "none"))
    node.fill = table.intern(snapshot, node.fill, ["fill", "fills"], "fill");
  if (node.stroke !== undefined && !(node.type === "LINE" && node.stroke === "none"))
    node.stroke = table.intern(snapshot, node.stroke, ["stroke", "strokes"], "fill");
  if (node.effects !== undefined)
    node.effects = table.intern(snapshot, node.effects, ["effect", "effects"], "effect");
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
export function isElision(value: unknown): value is Elision {
  if (!value || typeof value !== "object" || !("$elided" in value)) return false;
  const marker = value.$elided;
  return (
    !!marker &&
    typeof marker === "object" &&
    "id" in marker &&
    typeof marker.id === "string" &&
    "field" in marker &&
    typeof marker.field === "string" &&
    "chars" in marker &&
    typeof marker.chars === "number" &&
    marker.chars >= 0 &&
    "read" in marker &&
    typeof marker.read === "string"
  );
}
