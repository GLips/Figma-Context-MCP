/**
 * Which nodes reach the wire. Projection applies it as it walks; off-tree discovery applies it so a
 * producer fetches definitions only for components a read will actually publish.
 */

/** The facts admission reads — the same on a `NodeSnapshot` and a `SimplifiedNode`. */
interface AdmissionFacts {
  type?: string;
  visible?: boolean;
  componentPropertyReferences?: Record<string, string>;
}

/**
 * A hidden node is dropped, except inside a component definition when a component property drives
 * its visibility: some instance will turn it on. The same node hidden inside an instance is simply
 * hidden.
 */
export function admittedOnWire(node: AdmissionFacts, insideDefinition: boolean): boolean {
  return !(
    node.visible === false && !(insideDefinition && node.componentPropertyReferences?.visible)
  );
}

/** Whether `node`'s children sit inside a definition: a definition opens that scope, an instance closes it. */
export function childrenInsideDefinition(node: AdmissionFacts, insideDefinition: boolean): boolean {
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") return true;
  if (node.type === "INSTANCE") return false;
  return insideDefinition;
}
