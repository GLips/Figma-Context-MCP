import type { WriteNode } from "./ir.js";

export interface ExposureWrite { node: InstanceNode; value: boolean }
export interface ExposureContext { destination?: BaseNode; componentRoot?: boolean }

function hasEditableComponentOwner(node: BaseNode | null | undefined): boolean {
  for (let parent = node; parent; parent = parent.parent) {
    if (parent.type === "INSTANCE") return false;
    if (parent.type === "COMPONENT" || parent.type === "COMPONENT_SET") return true;
  }
  return false;
}

export function assertExposureTarget(node: SceneNode, subject: string): void {
  if (node.type !== "INSTANCE" || !hasEditableComponentOwner(node.parent)) {
    throw new Error(subject + ": exposed is writable only on a primary nested instance inside a component or component set; edit that definition's nested instance.");
  }
}

export function assertExposureTree(tree: WriteNode, context: ExposureContext = {}): void {
  function visit(node: WriteNode, owner: boolean): void {
    if (node.exposed !== undefined && !owner) throw new Error("flcm: exposed needs an instance inside a component definition. Build it with flcm.component or insert it into an existing component.");
    for (const child of node.children || []) if (child && typeof child === "object") visit(child, owner && node.type !== "INSTANCE");
    for (const delta of Object.values(node.overrides || {})) {
      if (Array.isArray(delta.children)) for (const child of delta.children) if (child && typeof child === "object") visit(child as WriteNode, false);
    }
  }
  visit(tree, context.componentRoot === true || hasEditableComponentOwner(context.destination));
}

export function applyExposures(writes: readonly ExposureWrite[]): void {
  for (const { node, value } of writes) node.isExposedInstance = value;
}
