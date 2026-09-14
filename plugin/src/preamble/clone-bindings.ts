// Native variant-member cloning drops bindings before placement. Capture ownership and structural
// paths before that boundary; definition display names are never used as identity.
type Path = number[];
type Definition = { type: string; defaultValue: string | boolean; preferredValues?: readonly any[] };
interface Layer { path: Path; type: string; refs: Record<string, string> }
interface Owner { path: Path; source: any; definitions: Record<string, Definition>; layers: Layer[] }
export interface CloneBindings { owners: Owner[] }
const supported = new Set(["TEXT", "BOOLEAN", "INSTANCE_SWAP"]);
function ownerOf(node: any): any { return node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET" ? node.parent : node; }
function at(root: any, path: Path): any {
  return path.reduce((node, index) => node?.children?.[index], root);
}
export function captureCloneBindings(root: any): CloneBindings {
  const owners: Owner[] = [];
  function discover(node: any, path: Path): void {
    if (node.type === "INSTANCE") return;
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      const source = ownerOf(node);
      const definitions = JSON.parse(JSON.stringify(source.componentPropertyDefinitions || {}));
      for (const def of Object.values(definitions) as Definition[]) {
        if (def.type !== "VARIANT" && !supported.has(def.type)) throw new Error("flcm.clone: unsupported component property type " + def.type + ". Nothing was applied.");
      }
      const owner: Owner = { path, source, definitions, layers: [] };
      function layers(layer: any, relative: Path): void {
        if (relative.length && (layer.type === "COMPONENT_SET" || layer.type === "COMPONENT") && !(node.type === "COMPONENT_SET" && relative.length === 1)) {
          discover(layer, path.concat(relative)); return;
        }
        const refs = { ...(layer.componentPropertyReferences || {}) };
        for (const key of Object.values(refs) as string[]) {
          const def = definitions[key];
          if (!def || !supported.has(def.type)) throw new Error("flcm.clone: cannot faithfully copy binding " + JSON.stringify(key) + "; unsupported or missing component property definition. Nothing was applied.");
        }
        owner.layers.push({ path: relative, type: layer.type, refs });
        if (layer.type !== "INSTANCE") (layer.children || []).forEach((child: any, index: number) => layers(child, relative.concat(index)));
      }
      layers(node, []); owners.push(owner); return;
    }
    (node.children || []).forEach((child: any, index: number) => discover(child, path.concat(index)));
  }
  discover(root, []); return { owners };
}
export function restoreCloneBindings(copy: any, plan: CloneBindings): void {
  for (const entry of plan.owners) {
    const root = at(copy, entry.path);
    if (!root) throw new Error("flcm.clone: copied component structure changed during placement.");
    const destination = ownerOf(root);
    const mapping = new Map<string, string>();
    const defs = destination.componentPropertyDefinitions || {};
    for (const layer of entry.layers) {
      const node = at(root, layer.path);
      if (!node || node.type !== layer.type) throw new Error("flcm.clone: copied layer structure does not match its source.");
      for (const [field, sourceId] of Object.entries(layer.refs)) {
        const copiedId = node.componentPropertyReferences?.[field];
        // Native clones may already preserve independent definitions. Structural correspondence
        // supplies identity here; same display names elsewhere in the destination never do.
        if (destination === entry.source) mapping.set(sourceId, sourceId);
        else if (copiedId && defs[copiedId] && JSON.stringify(defs[copiedId]) === JSON.stringify(entry.definitions[sourceId])) {
          const prior = mapping.get(sourceId);
          if (prior && prior !== copiedId) throw new Error("flcm.clone: inconsistent native property mapping.");
          mapping.set(sourceId, copiedId);
        }
      }
    }
    for (const [sourceId, def] of Object.entries(entry.definitions)) {
      if (def.type === "VARIANT") continue;
      if (!supported.has(def.type)) throw new Error("flcm.clone: unsupported component property type " + def.type);
      if (destination === entry.source || defs[sourceId] && JSON.stringify(defs[sourceId]) === JSON.stringify(def)) mapping.set(sourceId, sourceId);
      if (!mapping.has(sourceId)) {
        // Keep full-ID identity distinct even when multiple source definitions share a name.
        const id = destination.addComponentProperty(sourceId.replace(/#[^#]*$/, ""), def.type, def.defaultValue,
          def.preferredValues ? { preferredValues: def.preferredValues } : undefined);
        mapping.set(sourceId, id);
      }
    }
    for (const layer of entry.layers) {
      if (!Object.keys(layer.refs).length) continue;
      const node = at(root, layer.path);
      const refs = Object.fromEntries(Object.entries(layer.refs).map(([field, id]) => [field, mapping.get(id)]));
      node.componentPropertyReferences = refs;
      for (const [field, id] of Object.entries(refs)) {
        if (!id || node.componentPropertyReferences?.[field] !== id) throw new Error("flcm.clone: native binding restoration did not persist.");
      }
    }
  }
}
