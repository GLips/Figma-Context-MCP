/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
import type { WriteNode } from "./ir.js";
import { editableComponentOwnerOf } from "./identity.js";

export interface ExposureWrite { node: InstanceNode; value: boolean }
export interface ExposureContext { destination?: BaseNode; componentRoot?: boolean }

// Exposure is a definition fact: only an instance a component definition owns directly can carry it.
export function assertExposureTarget(node: SceneNode, subject: string): void {
  if (node.type !== "INSTANCE" || !editableComponentOwnerOf(node, false)) {
    throw new Error(subject + ": exposed is writable only on a primary nested instance inside a component or component set; edit that definition's nested instance.");
  }
}

export function assertExposureTree(tree: WriteNode, context: ExposureContext = {}): void {
  function visit(node: WriteNode, owner: boolean): void {
    // A live node's `exposed` is an edit word, judged against the live node (assertExposureTarget);
    // its authored children can't sit in an instance's own list (gateLiveTrees refuses that).
    if (node.liveId !== undefined) {
      for (const child of node.children || []) visit(child, owner);
      return;
    }
    if (node.exposed !== undefined && !owner) throw new Error((node.sourcePath ?? "INSTANCE") + ": exposed needs an instance inside a component definition, and this one isn't — build it with flcm.component or insert it into an existing component.");
    for (const child of node.children || []) if (child && typeof child === "object") visit(child, owner && node.type !== "INSTANCE");
    for (const delta of Object.values(node.overrides || {})) {
      if (Array.isArray(delta.children)) for (const child of delta.children) if (child && typeof child === "object") visit(child as WriteNode, false);
    }
  }
  visit(tree, context.componentRoot === true || (!!context.destination && !!editableComponentOwnerOf(context.destination, true)));
}

export function applyExposures(writes: readonly ExposureWrite[]): void {
  for (const { node, value } of writes) node.isExposedInstance = value;
}
