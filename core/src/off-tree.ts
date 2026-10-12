import { admittedOnWire, childrenInsideDefinition } from "./admission.js";
import type { NodeSnapshot } from "./snapshot.js";

/**
 * Which slice of the snapshots a read keeps, and so whose components it needs definitions for.
 *
 * - `wire`: the projected output alone — hidden layers and anything below `maxDepth` never reach it,
 *   so a definition fetched for them is a request (and a slot of a producer's fetch budget) spent on
 *   bytes nobody sees.
 * - `runtime`: the intact simplify result the plugin hands agent code, which keeps every node.
 */
export type OffTreeScope = { read: "wire"; maxDepth?: number } | { read: "runtime" };

/**
 * The component ids `snapshots` instantiate but define nowhere among themselves — the definitions a
 * producer supplies as `componentDefinitions` so the core publishes a real definition rather than
 * donating some instance's already-edited children. A definition passed among `snapshots` counts as
 * defined, so a producer resolving nested references can call this again with what it has fetched.
 */
export function offTreeComponentIds(
  snapshots: readonly NodeSnapshot[],
  scope: OffTreeScope,
): string[] {
  const referenced = new Set<string>();
  const defined = new Set<string>();
  const maxDepth = scope.read === "wire" ? scope.maxDepth : undefined;
  const visit = (node: NodeSnapshot, depth: number, insideDefinition: boolean): void => {
    if (scope.read === "wire" && !admittedOnWire(node, insideDefinition)) return;
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") defined.add(node.id);
    if (node.type === "INSTANCE" && node.componentId) referenced.add(node.componentId);
    if (maxDepth !== undefined && depth >= maxDepth) return;
    const inside = childrenInsideDefinition(node, insideDefinition);
    for (const child of node.children ?? []) visit(child, depth + 1, inside);
  };
  for (const snapshot of snapshots) visit(snapshot, 0, false);
  return [...referenced].filter((id) => !defined.has(id));
}
