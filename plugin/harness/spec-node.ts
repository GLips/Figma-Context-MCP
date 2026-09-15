import type { NodeSpec } from "../src/preamble/schema.js";

/** Locate a keyed node in a verb's returned data, including instance slot content. */
export function specNode(spec: NodeSpec, key: string): NodeSpec & { id: string } {
  const visit = (value: unknown): (NodeSpec & { id: string }) | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (record.key === key && typeof record.id === "string") return record as NodeSpec & { id: string };
    for (const child of Object.values(record)) { const found = visit(child); if (found) return found; }
  };
  const found = visit(spec);
  if (!found) throw new Error("No authored node with key " + key);
  return found;
}

export function withoutIds<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(withoutIds) as T;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "id").map(([key, child]) => [key, withoutIds(child)])) as T;
}
