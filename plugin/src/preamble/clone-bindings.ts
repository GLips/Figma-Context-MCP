/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// Native variant-member cloning drops bindings before placement. Capture ownership and structural
// paths before that boundary; definition display names are never used as identity.
import { definitionOwnerOf, isComponentDefinition } from "./identity.js";
import { bareName } from "./component-properties.js";
import { FlcmError } from "./flcm-error.js";

type Path = number[];
type Definition = { type: string; defaultValue: string | boolean; preferredValues?: readonly any[] };
interface Layer { path: Path; type: string; refs: Record<string, string> }
interface Owner { path: Path; source: any; definitions: Record<string, Definition>; layers: Layer[] }
interface CloneBindings { owners: Owner[] }
const supported = new Set(["TEXT", "BOOLEAN", "INSTANCE_SWAP", "SLOT"]);
// A native clone of a definition shows a slot's bound FRAME as `type: "SLOT"` wherever the binding
// survives (live-checked 2026-10-26), so the two spellings are one layer here.
function layerType(node: any): string {
  return node.type === "SLOT" ? "FRAME" : node.type;
}
function at(root: any, path: Path): any {
  return path.reduce((node, index) => node?.children?.[index], root);
}
export function captureCloneBindings(root: any): CloneBindings {
  const owners: Owner[] = [];
  function discover(node: any, path: Path): void {
    if (node.type === "INSTANCE") return;
    if (isComponentDefinition(node)) {
      const source = definitionOwnerOf(node);
      const definitions = JSON.parse(JSON.stringify(source.componentPropertyDefinitions || {}));
      for (const def of Object.values(definitions) as Definition[]) {
        if (def.type !== "VARIANT" && !supported.has(def.type)) throw new FlcmError("authoring",
          "this component declares a " + def.type + " property, which clone can't copy with its bindings. Clone an instance of it instead, or rebuild the copy with flcm.component.",
          { node: { type: source.type, name: source.name, id: source.id } },
        );
      }
      const owner: Owner = { path, source, definitions, layers: [] };
      function layers(layer: any, relative: Path): void {
        if (relative.length && isComponentDefinition(layer) && !(node.type === "COMPONENT_SET" && relative.length === 1)) {
          discover(layer, path.concat(relative)); return;
        }
        const refs = { ...(layer.componentPropertyReferences || {}) };
        for (const key of Object.values(refs) as string[]) {
          const def = definitions[key];
          if (!def || !supported.has(def.type)) throw new FlcmError("authoring",
            "this layer is bound to component property " + JSON.stringify(bareName(key)) + ", which its component doesn't declare or clone can't copy, so the binding can't be copied. " +
              "Unbind it first (componentPropertyReferences: { <field>: null }), or clone an instance of the component instead.",
            { node: { type: layer.type, name: layer.name, id: layer.id } },
          );
        }
        owner.layers.push({ path: relative, type: layerType(layer), refs });
        if (layer.type !== "INSTANCE") (layer.children || []).forEach((child: any, index: number) => layers(child, relative.concat(index)));
      }
      layers(node, []); owners.push(owner); return;
    }
    (node.children || []).forEach((child: any, index: number) => discover(child, path.concat(index)));
  }
  discover(root, []); return { owners };
}
export type CreatedCloneProperties = { owner: any; id: string }[];
export function restoreCloneBindings(copy: any, plan: CloneBindings, created: CreatedCloneProperties = []): void {
  for (const entry of plan.owners) {
    const root = at(copy, entry.path);
    if (!root) throw new FlcmError("internal", "the copy lost a component the original holds while it was being placed, so its bindings couldn't be restored.");
    const destination = definitionOwnerOf(root);
    const mapping = new Map<string, string>();
    // A duplicate variant temporarily makes the set definition getter reject. The source
    // owner was validated before cloning, and same-owner restoration needs no new definitions.
    const sameOwner = destination === entry.source;
    const defs = sameOwner ? entry.definitions : destination.componentPropertyDefinitions || {};
    for (const layer of entry.layers) {
      const node = at(root, layer.path);
      if (!node || layerType(node) !== layer.type) throw new FlcmError("internal", "a layer of the copy doesn't match the original's layer at the same position, so its bindings couldn't be restored.");
      for (const [field, sourceId] of Object.entries(layer.refs)) {
        const copiedId = node.componentPropertyReferences?.[field];
        // Native clones may already preserve independent definitions. Structural correspondence
        // supplies identity here; same display names elsewhere in the destination never do.
        if (sameOwner) mapping.set(sourceId, sourceId);
        else if (copiedId && defs[copiedId] && JSON.stringify(defs[copiedId]) === JSON.stringify(entry.definitions[sourceId])) {
          const prior = mapping.get(sourceId);
          if (prior && prior !== copiedId) throw new FlcmError("figma",
            "Figma copied one component property of the original as two different properties, so the copy's bindings can't be restored. Clone the whole component or set instead, or into another destination.",
            { node: { type: node.type, name: node.name } },
          );
          mapping.set(sourceId, copiedId);
        }
      }
    }
    for (const [sourceId, def] of Object.entries(entry.definitions)) {
      if (def.type === "VARIANT") continue;
      if (sameOwner || defs[sourceId] && JSON.stringify(defs[sourceId]) === JSON.stringify(def)) mapping.set(sourceId, sourceId);
      if (!mapping.has(sourceId)) {
        // Keep full-ID identity distinct even when multiple source definitions share a name.
        // Figma stores no default for a slot (its content is the bound frame) and takes "" for one.
        const id = destination.addComponentProperty(bareName(sourceId), def.type, def.type === "SLOT" ? "" : def.defaultValue,
          def.preferredValues?.length ? { preferredValues: def.preferredValues } : undefined);
        created.push({ owner: destination, id });
        mapping.set(sourceId, id);
      }
    }
    for (const layer of entry.layers) {
      if (!Object.keys(layer.refs).length) continue;
      const node = at(root, layer.path);
      const refs = Object.fromEntries(Object.entries(layer.refs).map(([field, id]) => [field, mapping.get(id)]));
      node.componentPropertyReferences = refs;
      for (const [field, id] of Object.entries(refs)) {
        if (!id || !samePropertyId(node.componentPropertyReferences?.[field], id)) throw new FlcmError("figma",
          "Figma didn't keep this layer's binding to component property " + JSON.stringify(bareName(id ?? layer.refs[field])) + " on the copy. Clone the whole component or set instead, or bind the copied layer afterward with flcm.edit.",
          { node: { type: node.type, name: node.name } },
        );
      }
    }
  }
}

// Native addComponentProperty can return the requested display name while the persisted
// reference has a collision-adjusted name (Label#id -> Label2#id). The # suffix is identity.
function samePropertyId(actual: unknown, expected: string): boolean {
  if (actual === expected) return true;
  if (typeof actual !== "string") return false;
  const suffix = expected.lastIndexOf("#");
  const actualSuffix = actual.lastIndexOf("#");
  return suffix >= 0 && actualSuffix >= 0 && actual.slice(actualSuffix) === expected.slice(suffix);
}

/** Compensate only nodes and definitions created by this clone; never touch prior destination controls. */
export function removeFailedClone(copy: any, created: CreatedCloneProperties): void {
  if (copy && !copy.removed) copy.remove();
  for (const { owner, id } of created.slice().reverse()) {
    if (owner.removed) continue;
    const key = Object.keys(owner.componentPropertyDefinitions).find(key => samePropertyId(key, id));
    if (key) owner.deleteComponentProperty(key);
  }
}
