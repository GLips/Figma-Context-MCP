import type { ComponentNotes } from "./components.js";
import type { NodeSnapshot } from "./snapshot.js";
import type { SimplifiedNode } from "./types.js";

/** Producer facts needed by projection, kept out of the authoring vocabulary. */
export interface ReadContext {
  notes: ComponentNotes;
  snapshots: Map<SimplifiedNode, NodeSnapshot>;
  definitions: SimplifiedNode[];
  unchanged?: (value: unknown) => boolean;
}
const contexts = new WeakMap<object, ReadContext>();
export function rememberRead(value: object, context: ReadContext): void {
  contexts.set(value, context);
}
export function readContext(value: object): ReadContext {
  const context = contexts.get(value);
  if (!context) throw new Error("project expects a simplify result.");
  return context;
}

/** Capture field identities once, in linear space. Any agent edit makes that result computed data. */
export function captureRead(value: object): (value: unknown) => boolean {
  const fields = new WeakMap<object, [string, unknown][]>();
  const capture = (item: unknown): void => {
    if (!item || typeof item !== "object" || fields.has(item)) return;
    const entries = Object.entries(item);
    fields.set(item, entries);
    for (const [, child] of entries) capture(child);
  };
  capture(value);
  return (item: unknown): boolean => {
    const seen = new Set<object>();
    const unchanged = (current: unknown): boolean => {
      if (!current || typeof current !== "object") return true;
      if (seen.has(current)) return true;
      seen.add(current);
      const before = fields.get(current);
      const after = Object.entries(current);
      return (
        !!before &&
        before.length === after.length &&
        before.every(
          ([key, original], i) =>
            key === after[i][0] && Object.is(original, after[i][1]) && unchanged(original),
        )
      );
    };
    return unchanged(item);
  };
}
