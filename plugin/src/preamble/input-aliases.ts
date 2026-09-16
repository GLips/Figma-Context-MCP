// Authoring input aliases shared by schema definitions and runtime normalization.
export const INPUT_ALIASES = {
  clipsContent: { path: ["clip"], types: ["FRAME", "INSTANCE", "COMPONENT", "COMPONENT_SET", "SLOT"] },
  fontSize: { path: ["textStyle", "fontSize"], types: ["TEXT"] },
} as const;
export function normalizeInputAliases(bag: Record<string, unknown>, subject: string, type?: string): Record<string, unknown> {
  const out = { ...bag };
  for (const [alias, definition] of Object.entries(INPUT_ALIASES)) {
    if (!Object.prototype.hasOwnProperty.call(out, alias)) continue;
    if (type && !(definition.types as readonly string[]).includes(type)) throw new Error(subject + ": " + alias + " is not supported on " + type + ".");
    const value = out[alias];
    delete out[alias];
    if (value === undefined) continue;
    const [root, leaf] = definition.path;
    let target = out;
    if (leaf) {
      const nested = out[root];
      if (nested !== undefined && (!nested || typeof nested !== "object" || Array.isArray(nested))) throw new Error(subject + ": " + root + " must be an object when using " + alias + ".");
      target = { ...(nested as Record<string, unknown> | undefined) };
      out[root] = target;
    }
    const key = leaf ?? root;
    if (target[key] !== undefined && !Object.is(target[key], value)) throw new Error(subject + ": conflicting " + alias + " and " + definition.path.join(".") + "; supply one value or equivalent duplicates.");
    target[key] = value;
  }
  return out;
}

import type { WriteLayout } from "./ir.js";
import type { LayoutMode } from "./layout-mode.js";

/** Stretch is a size request on the parent's cross axis, not a second alignment implementation. */
export function normalizeChildLayoutAliases(layout: WriteLayout, parent: LayoutMode, absolute: boolean, subject: string): WriteLayout {
  if (layout.alignSelf !== "stretch") return layout;
  if (absolute || parent.kind !== "flow") throw new Error(subject + ': alignSelf "stretch" requires an in-flow row/column parent.');
  const axis = parent.cross;
  if (layout.sizing?.[axis] !== undefined && layout.sizing[axis] !== "fill") throw new Error(subject + ': alignSelf "stretch" conflicts with the authored counter-axis size; use "fill".');
  const { alignSelf: _alias, ...words } = layout;
  return { ...words, sizing: { ...layout.sizing, [axis]: "fill" } };
}
