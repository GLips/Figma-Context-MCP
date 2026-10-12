import type { Component, ComponentSet, Node as FigmaDocumentNode } from "@figma/rest-api-spec";
import type { NodeSnapshot } from "@framelink/core/snapshot";

/**
 * The response envelope's component tables. REST is the only producer with them, and this is
 * the only place they are read: they get folded ONTO the nodes as `mainComponent` /
 * `componentKey`, which is the shape the plugin can also supply from its live main-component
 * node. Nothing table-shaped reaches the core (Invariant 2).
 */
export interface RestComponentTables {
  components?: Record<string, Component>;
  componentSets?: Record<string, ComponentSet>;
}

/** A response envelope's (or a `?ids=` entry's) tables, with an absent table read as empty. */
export function componentTablesOf(envelope: RestComponentTables): Required<RestComponentTables> {
  return { components: envelope.components ?? {}, componentSets: envelope.componentSets ?? {} };
}

/** A definition node's own table entry — a COMPONENT's, or a COMPONENT_SET's. */
export function definitionEntry(
  node: FigmaDocumentNode,
  tables: RestComponentTables,
): { key?: string; description?: string } | undefined {
  if (node.type === "COMPONENT") return tables.components?.[node.id];
  if (node.type === "COMPONENT_SET") return tables.componentSets?.[node.id];
  return undefined;
}

/** An instance's main component, joined against both tables so a variant also names its set. */
export function mainComponentOf(
  componentId: string | undefined,
  tables: RestComponentTables,
): NodeSnapshot["mainComponent"] {
  if (!componentId) return undefined;
  const component = tables.components?.[componentId];
  if (!component) return undefined;
  const ref: NonNullable<NodeSnapshot["mainComponent"]> = {
    name: component.name,
    key: component.key || undefined,
  };
  const set = component.componentSetId
    ? tables.componentSets?.[component.componentSetId]
    : undefined;
  if (component.componentSetId) {
    ref.set = {
      id: component.componentSetId,
      key: set?.key || undefined,
      name: set?.name ?? component.componentSetId,
      description: set?.description || undefined,
    };
  }
  return ref;
}
