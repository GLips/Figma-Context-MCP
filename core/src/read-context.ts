import type { ComponentNotes } from "./components.js";
import type { NodeSnapshot } from "./snapshot.js";
import type { SimplifiedNode } from "./types.js";

/** Producer facts needed by projection, kept out of the authoring vocabulary. */
export interface ReadContext {
  notes: ComponentNotes;
  snapshots: Map<SimplifiedNode, NodeSnapshot>;
  definitions: SimplifiedNode[];
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
